import type { Child } from 'hono/jsx'
import { base64url } from 'jose'
import type { Runtime } from '../config'
import { canonicalRead, publicArtefacts, shareRead } from '../core/artefacts'
import { handoffChallenge, readBoundSession, redeemHandoff, validHandoffState } from '../core/handoffs'
import { randomSecret } from '../core/index'
import { artefactPath, maxReadReturnLength, readReturnPath, sharePath } from '../core/read-path'
import { isDocumentNavigation, readBoundedBody } from '../http'
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

function notFound(head = false) {
  const headers = readHeaders()
  headers.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(head ? null : 'Not found', { status: 404, headers })
}

function page(title: string, children: Child, head: boolean, status = 200) {
  const html = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{title}</title>
      </head>
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
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/x-www-form-urlencoded') {
    return notFound()
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
  if (!result) return notFound()
  if (result.kind === 'retry') {
    const path = readReturnPath(fields.get('return'), runtime.config.readOrigin)
    return page(
      'Sign-in did not complete',
      <>
        <h1>Sign-in did not complete</h1>
        {path && (
          <p>
            <a href={path}>Try signing in again</a>
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
  try {
    if (request.method === 'POST' && url.pathname === callback) return await completeHandoff(request, runtime)
    if (request.method !== 'GET' && !head) return notFound()
    if (url.pathname.startsWith('/s/')) {
      const target = sharePath(url.pathname)
      if (!target) return notFound(head)
      const decision = await shareRead(runtime, target.slug, target.key, target.path, ctx)
      if (decision.kind === 'not-found') return notFound(head)
      if (decision.kind === 'slash') return redirect(`${url.pathname}/${url.search}`, 301)
      if (decision.kind === 'entry') return redirect(`${url.pathname}${decision.path}${url.search}`)
      return await serveFile(request, runtime.env.BLOBS, decision.file, false, false)
    }
    const target = artefactPath(url.pathname)
    if (target) {
      if (target.path === undefined) return redirect(`${url.pathname}/${url.search}`, 301)
      const decision = await canonicalRead(runtime, target.slug, target.path, () =>
        readBoundSession(runtime, cookie(request, readCookie), Date.now()),
      )
      switch (decision.kind) {
        case 'serve':
          return await serveFile(
            request,
            runtime.env.BLOBS,
            decision.file,
            decision.public,
            runtime.config.allowIndexing,
          )
        case 'slash':
          return redirect(`${url.pathname}/${url.search}`, 301)
        case 'sign-in':
        case 'revalidate':
          if (isDocumentNavigation(request)) return await startHandoff(request, url, runtime)
          return new Response(null, { status: 401, headers: readHeaders() })
        case 'pending':
          return page(
            `Pending access — ${runtime.config.name}`,
            <>
              <h1>Pending access</h1>
              <p>Ask a Forge administrator to approve your membership.</p>
            </>,
            head,
          )
        case 'not-found':
          return notFound(head)
      }
    }
    if (url.pathname === '/') {
      const { name, publicIndex } = runtime.config
      const entries = publicIndex ? await publicArtefacts(runtime) : null
      return page(
        name,
        <>
          <h1>{name}</h1>
          {entries && (
            <ul aria-label="Public artefacts">
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
    return notFound(head)
  } catch (error) {
    console.error('Forge read failed', error instanceof Error ? error.name : 'unknown')
    return new Response(head ? null : 'Forge is unavailable', { status: 503, headers: readHeaders() })
  }
}
