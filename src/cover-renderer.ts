import puppeteer, { type Browser, type HTTPRequest } from '@cloudflare/puppeteer'
import { openBlob } from './core/blobs'

const hostname = 'forge-preview.invalid'
const origin = `https://${hostname}`
const MiB = 1024 * 1024
const deadlineMs = 15_000
const closeTimeoutMs = 1_000
const maxRequests = 256
const maxFileBytes = 4 * MiB
const maxResponseBytes = 16 * MiB // Count every fulfillment, including repeated reads of the same blob.
const maxConcurrentReads = 4 // Bound buffers and their CDP base64 copies as well as R2 calls.

// This is a response header, not a removable sandbox attribute. Same-origin is needed for local modules.
const documentPolicy = [
  'sandbox allow-scripts allow-same-origin',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Embedded Craft images and fonts need no network request.
  "img-src 'self' data:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "connect-src 'none'",
].join('; ')

const resourceTypes: Record<string, readonly string[]> = {
  document: ['text/html'],
  script: ['text/javascript', 'application/javascript'],
  stylesheet: ['text/css'],
  font: ['font/woff', 'font/woff2'],
  image: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'],
}

type CoverFile = { path: string; sha256: string; size: number; type: string }

function pathFromRequest(request: HTTPRequest) {
  if (request.method() !== 'GET') return null
  const url = URL.parse(request.url())
  if (
    url?.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    /%2f/i.test(url.pathname)
  ) {
    return null
  }
  // Parse only the path; a query never selects different content. Reject encoded path separators.
  try {
    return decodeURIComponent(url.pathname.slice(1))
  } catch {
    return null
  }
}

async function closeBrowser(browser: Browser) {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, closeTimeoutMs)
  try {
    await Promise.race([browser.close(), promise])
  } finally {
    clearTimeout(timer)
    // The service's idle timeout is the fallback if the close command could not be delivered.
    await browser.disconnect()
  }
}

async function capture(
  browser: Browser,
  bucket: R2Bucket,
  entryPath: string,
  files: readonly CoverFile[],
  cancellation: AbortController,
): Promise<Uint8Array<ArrayBuffer>> {
  const { signal } = cancellation
  const manifest = new Map<string, CoverFile>()
  for (const file of files) manifest.set(file.path, file)
  const entryUrl = `${origin}/${entryPath.split('/').map(encodeURIComponent).join('/')}`
  const page = await browser.newPage()
  const frame = page.mainFrame()
  const navigation = await page.createCDPSession()
  await navigation.send('Page.enable')
  let entryCommitted = false
  let entryServed = false
  let requests = 0
  let bytes = 0
  // Keep bursts queued instead of dropping legitimate assets. Each of these lanes holds one buffer at a time.
  const lanes = Array.from({ length: maxConcurrentReads }, () => Promise.resolve())
  let nextLane = 0
  const allowedRequests = new WeakSet<HTTPRequest>()

  navigation.on('Page.frameNavigated', ({ frame: navigated }) => {
    // Unlike Puppeteer's framenavigated event, this excludes History and fragment updates.
    if (navigated.parentId) return
    if (!entryCommitted && navigated.url === entryUrl) {
      entryCommitted = true
    } else if (entryCommitted || navigated.url !== 'about:blank') {
      cancellation.abort(new Error('Cover document navigated'))
    }
  })
  page.on('popup', () => cancellation.abort(new Error('Cover document opened a popup')))
  page.on('requestfailed', (request) => {
    if (allowedRequests.has(request)) cancellation.abort(new Error('Cover asset failed to load'))
  })
  page.on('request', async (request) => {
    try {
      if (request.isInterceptResolutionHandled()) return
      if (++requests > maxRequests) throw new Error('Cover request limit exceeded')
      const path = pathFromRequest(request)
      const file = path === null ? undefined : manifest.get(path)
      const resource = request.resourceType()
      const type = file?.type.split(';', 1)[0].trim().toLowerCase()
      const document = resource === 'document'
      if (
        signal.aborted ||
        !file ||
        !type ||
        !Object.hasOwn(resourceTypes, resource) ||
        !resourceTypes[resource].includes(type) ||
        request.frame() !== frame ||
        request.isNavigationRequest() !== document ||
        (document && (entryServed || request.url() !== entryUrl))
      ) {
        await request.abort()
        return
      }
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > maxFileBytes ||
        bytes + file.size > maxResponseBytes
      ) {
        throw new Error('Cover asset byte limit exceeded')
      }
      allowedRequests.add(request)
      if (document) entryServed = true
      bytes += file.size
      const lane = nextLane++ % maxConcurrentReads
      const serve = lanes[lane].then(async () => {
        signal.throwIfAborted()
        const blob = await openBlob(bucket, file.sha256)
        if (signal.aborted || blob.size !== file.size) {
          await blob.body.cancel()
          signal.throwIfAborted()
          throw new Error('Cover asset size differs from its manifest')
        }
        const body = new Uint8Array(await blob.arrayBuffer())
        signal.throwIfAborted()
        await request.respond({
          status: 200,
          contentType:
            document || resource === 'stylesheet' || resource === 'script' ? `${type}; charset=utf-8` : type,
          headers: {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            ...(document
              ? {
                  'content-security-policy': documentPolicy,
                  // Chrome 152+ also denies WebRTC and redirects by default under this policy.
                  'connection-allowlist': '(response-origin)',
                  'x-dns-prefetch-control': 'off',
                }
              : {}),
          },
          body,
        })
      })
      lanes[lane] = serve.catch(() => {})
      await serve
    } catch (error) {
      cancellation.abort(error)
      if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {})
    }
  })

  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.setBypassServiceWorker(true)
  await page.setRequestInterception(true)
  const response = await page.goto(entryUrl, { waitUntil: 'load', timeout: 8_000 })
  if (!entryServed || !entryCommitted || !response?.ok()) throw new Error('Cover entry failed to load')

  // Let local scripts initialize the first slide and let layout settle; never click or advance the deck.
  await page.waitForNetworkIdle({ idleTime: 350, timeout: 2_000, signal })
  await frame
    .isolatedRealm()
    .evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  for (const quality of [82, 60, 40]) {
    signal.throwIfAborted()
    const jpeg = await page.screenshot({ type: 'jpeg', quality })
    signal.throwIfAborted()
    const buffer = jpeg.buffer
    if (jpeg.byteLength > 0 && jpeg.byteLength <= MiB && buffer instanceof ArrayBuffer) {
      return new Uint8Array(buffer, jpeg.byteOffset, jpeg.byteLength)
    }
  }
  throw new Error('Cover screenshot exceeded the JPEG size limit')
}

export async function renderCover(
  browserBinding: BrowserRun,
  bucket: R2Bucket,
  entryPath: string,
  files: readonly CoverFile[],
): Promise<Uint8Array<ArrayBuffer>> {
  if (files.length > 128 || !files.some((file) => file.path === entryPath)) {
    throw new Error('Invalid cover manifest')
  }
  let browser: Browser | undefined
  const cancellation = new AbortController()
  const { signal } = cancellation
  const timer = setTimeout(() => cancellation.abort(new Error('Cover render deadline exceeded')), deadlineMs)
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  const render = async () => {
    const launched = await puppeteer.launch(browserBinding, { guardrails: { allowedDomains: [hostname] } })
    if (signal.aborted) {
      await closeBrowser(launched)
      signal.throwIfAborted()
    }
    browser = launched
    // Older Chromium ignores Connection-Allowlist rather than failing closed.
    const major = /^(?:Headless)?Chrome\/(\d+)\./.exec(await launched.version())?.[1]
    if (!major || Number(major) < 152) throw new Error('Cover renderer requires Chromium 152 or newer')
    signal.throwIfAborted()
    return capture(launched, bucket, entryPath, files, cancellation)
  }
  try {
    return await Promise.race([render(), aborted])
  } finally {
    clearTimeout(timer)
    cancellation.abort()
    if (browser) await closeBrowser(browser)
  }
}
