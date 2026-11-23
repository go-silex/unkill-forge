import type { Child } from 'hono/jsx'
import type { Runtime } from '../config'
import { canonicalRead, publicArtefacts } from '../core/artefacts'
import { readBoundSession, redeemHandoff } from '../core/handoffs'
import { hashSecret, randomSecret } from '../core/index'
import { artefactPath } from '../core/read-path'
import { serveFile } from './file'
import { readHeaders } from './headers'

const stateCookie = '__Host-forge-state'
const readCookie = '__Host-forge'
const callback = '/_forge/session'

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

function setCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`
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

function page(title: string, children: Child, head: boolean) {
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
  return new Response(head ? null : `<!doctype html>${html}`, { headers })
}

async function startHandoff(url: URL, runtime: Runtime) {
  const verifier = randomSecret()
  const target = new URL('/auth/handoff', runtime.config.manageOrigin)
  target.search = new URLSearchParams({
    return: url.pathname + url.search,
    state: await hashSecret(verifier),
  }).toString()
  return redirect(target.href, 302, [setCookie(stateCookie, verifier, 300)])
}

async function completeHandoff(request: Request, url: URL, runtime: Runtime) {
  if (!url.search) return notFound()
  try {
    const result = await redeemHandoff(
      runtime,
      url.searchParams.get('code'),
      url.searchParams.get('state'),
      cookie(request, stateCookie),
    )
    if (result) {
      return redirect(result.path, 302, [
        setCookie(readCookie, result.cookie, result.maxAge),
        setCookie(stateCookie, '', 0),
      ])
    }
  } catch (error) {
    console.error('Forge handoff failed', error instanceof Error ? error.name : 'unknown')
  }
  // Never leave credentials in the URL of a document visible to read-origin scripts.
  return redirect(callback)
}

export async function read(request: Request, url: URL, runtime: Runtime): Promise<Response> {
  const head = request.method === 'HEAD'
  if (request.method !== 'GET' && !head) return notFound()
  try {
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
        case 'sign-in':
          return await startHandoff(url, runtime)
        case 'revalidate':
          if (
            request.method === 'GET' &&
            request.headers.get('Sec-Fetch-Mode') === 'navigate' &&
            request.headers.get('Sec-Fetch-Dest') === 'document'
          ) {
            return await startHandoff(url, runtime)
          }
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
    if (url.pathname === callback && !head) return await completeHandoff(request, url, runtime)
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
