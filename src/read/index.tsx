import type { Child } from 'hono/jsx'
import { base64url } from 'jose'
import type { Config, Runtime } from '../config'
import { canonicalRead, publicArtefacts, shareRead } from '../core/artefacts'
import { handoffChallenge, readBoundSession, redeemHandoff, validHandoffState } from '../core/handoffs'
import { randomSecret } from '../core/index'
import { artefactPath, maxReadReturnLength, readReturnPath, sharePath } from '../core/read-path'
import { DocumentHead } from '../head'
import { isDocumentNavigation, readBoundedBody } from '../http'
import { messages } from '../i18n'
import { serveFile } from './file'
import { readHeaders } from './headers'

const stateCookie = '__Host-forge-state'
const readCookie = '__Host-forge'
const callback = '/_forge/session'
// Form encoding can triple the bounded return value; leave room for the fixed handoff fields.
const handoffBodyLimit = 32 * 1024

function cookie(request: Request, name: string) {
  let value: string | null = null
  for (const entry of request.headers.get('Cookie')?.split(';') ?? []) {
    const part = entry.trim()
    if (!part.startsWith(`${name}=`)) continue
    if (value !== null) return null
    value = part.slice(name.length + 1)
  }
  return value
}

function setCookie(name: string, value: string, maxAge: number, sameSite: 'Lax' | 'None' = 'Lax') {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=${sameSite}`
}

function redirect(location: string, status = 302, cookies: string[] = []) {
  const headers = readHeaders()
  headers.set('Location', location)
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(null, { status, headers })
}

function notFound(config: Config, head = false) {
  return statusPage(config, messages(config).notFound, 404, head)
}

function statusPage(config: Config, title: string, status: number, head: boolean) {
  return page(config, title, <h1>{title}</h1>, head, status)
}

function page(config: Config, title: string, children: Child, head: boolean, status = 200) {
  const html = (
    <html lang={config.locale}>
      <DocumentHead title={title} />
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
  const headers = readHeaders()
  headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(head ? null : `<!doctype html>${html}`, { status, headers })
}

async function startHandoff(request: Request, url: URL, runtime: Runtime) {
  const current = cookie(request, stateCookie)
  const browser = validHandoffState(current) ? current : randomSecret()
  const nonce = randomSecret()
  const target = new URL('/auth/handoff', runtime.config.manageOrigin)
  const { pathname, search } = url
  const returnPath = pathname.length + search.length <= maxReadReturnLength ? pathname + search : pathname
  target.search = new URLSearchParams({
    return: base64url.encode(returnPath),
    state: await handoffChallenge(browser, nonce),
    nonce,
  }).toString()
  return redirect(target.href, 302, [setCookie(stateCookie, browser, 600, 'None')])
}

async function completeHandoff(request: Request, runtime: Runtime) {
  const { config } = runtime
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/x-www-form-urlencoded') {
    return notFound(config)
  }
  const body = await readBoundedBody(request, handoffBodyLimit)
  if (body === null) return new Response(null, { status: 413, headers: readHeaders() })
  const fields = new URLSearchParams(new TextDecoder().decode(body))
  const result = await redeemHandoff(
    runtime,
    fields.get('code'),
    fields.get('state'),
    fields.get('nonce'),
    cookie(request, stateCookie),
  )
  if (!result) return notFound(config)
  if (result.kind === 'retry') {
    const path = readReturnPath(fields.get('return'), config.readOrigin)
    const text = messages(config).read
    return page(
      config,
      text.incomplete,
      <>
        <h1>{text.incomplete}</h1>
        {path && (
          <p>
            <a href={path}>{text.retry}</a>
          </p>
        )}
      </>,
      false,
      400,
    )
  }
  return redirect(result.path, 303, [setCookie(readCookie, result.cookie, result.maxAge)])
}

export async function read(
  request: Request,
  url: URL,
  runtime: Runtime,
  ctx: ExecutionContext,
): Promise<Response> {
  const head = request.method === 'HEAD'
  const { config } = runtime
  const common = messages(config)
  const text = common.read
  try {
    if (request.method === 'POST' && url.pathname === callback) return await completeHandoff(request, runtime)
    if (request.method !== 'GET' && !head) return notFound(config)
    if (url.pathname.startsWith('/s/')) {
      const target = sharePath(url.pathname)
      if (!target) return notFound(config, head)
      const decision = await shareRead(runtime, target.slug, target.key, target.path, url.pathname, ctx)
      if (decision.kind === 'not-found') return notFound(config, head)
      if (decision.kind === 'slash') return redirect(`${url.pathname}/${url.search}`, 301)
      if (decision.kind === 'redirect') return redirect(`${decision.location}${url.search}`)
      if (decision.kind === 'entry') return redirect(`${url.pathname}${decision.path}${url.search}`)
      return await serveFile(request, runtime.env.BLOBS, decision.file, false, false)
    }
    const target = artefactPath(url.pathname)
    if (target) {
      if (target.path === undefined) return redirect(`${url.pathname}/${url.search}`, 301)
      const decision = await canonicalRead(runtime, target.slug, target.path, url.pathname, () =>
        readBoundSession(runtime, cookie(request, readCookie), Date.now()),
      )
      switch (decision.kind) {
        case 'serve':
          return await serveFile(
            request,
            runtime.env.BLOBS,
            decision.file,
            decision.public,
            config.allowIndexing,
          )
        case 'slash':
          return redirect(`${url.pathname}/${url.search}`, 301)
        case 'redirect':
          return redirect(`${decision.location}${url.search}`)
        case 'sign-in':
        case 'revalidate':
          if (isDocumentNavigation(request)) return await startHandoff(request, url, runtime)
          return new Response(null, { status: 401, headers: readHeaders() })
        case 'pending':
          return page(
            config,
            `${common.pending} — ${config.name}`,
            <>
              <h1>{common.pending}</h1>
              <p>{text.askAdmin}</p>
            </>,
            head,
          )
        case 'not-found':
          return notFound(config, head)
      }
    }
    if (url.pathname === '/') {
      const { name, publicIndex, brand } = config
      const entries = publicIndex ? await publicArtefacts(runtime, ctx) : null
      return page(
        config,
        name,
        <>
          <header>
            <h1 class="brand">
              <img src="/logo.svg" alt="" width="32" height="32" />
              {name}
            </h1>
          </header>
          {!publicIndex && brand.landingText && <p>{brand.landingText}</p>}
          {entries && (
            <ul aria-label={text.artefacts}>
              {entries.map(({ url, title }) => (
                <li key={url}>
                  <a href={url}>{title}</a>
                </li>
              ))}
            </ul>
          )}
        </>,
        head,
      )
    }
    return notFound(config, head)
  } catch (error) {
    console.error('Forge read failed', error instanceof Error ? error.name : 'unknown')
    return statusPage(config, common.unavailable, 503, head)
  }
}
