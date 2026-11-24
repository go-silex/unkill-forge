import type { Child } from 'hono/jsx'
import { base64url } from 'jose'
import { AccessCard, CardLink, ErrorCard } from '../access-card'
import { forgePageSources } from '../brand'
import { BrandBlock } from '../brand-block'
import type { Config, Runtime } from '../config'
import { canonicalRead, publicArtefacts, shareRead } from '../core/artefacts'
import { galleryPreviewSlugs } from '../core/gallery-previews'
import { handoffChallenge, readBoundSession, redeemHandoff, validHandoffState } from '../core/handoffs'
import { randomSecret } from '../core/index'
import { artefactPath, maxReadReturnLength, readReturnPath, sharePath } from '../core/read-path'
import { Gallery, GalleryViews, galleryView } from '../gallery'
import { DocumentHead } from '../head'
import { isDocumentNavigation, readBoundedBody, readCookie, writeCookie } from '../http'
import { messages } from '../i18n'
import { serveFile } from './file'
import { readHeaders } from './headers'

const stateCookie = '__Host-forge-state'
const readSessionCookie = '__Host-forge'
const callback = '/_forge/session'
// Form encoding can triple the bounded return value; leave room for the fixed handoff fields.
const handoffBodyLimit = 32 * 1024

function redirect(location: string, status = 302, cookies: string[] = []) {
  const headers = readHeaders()
  headers.set('Location', location)
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(null, { status, headers })
}

function notFound(config: Config, head = false) {
  return statusPage(config, messages(config).access.notFoundLead, 404, head)
}

function statusPage(config: Config, lead: string, status: 404 | 503, head: boolean) {
  const t = messages(config)
  return documentResponse(
    <ErrorCard
      config={config}
      status={status}
      lead={lead}
      actions={
        <>
          <CardLink href="/" primary>
            {t.access.home}
          </CardLink>
          <CardLink href={new URL('/artefacts', config.manageOrigin).href}>{t.signIn}</CardLink>
        </>
      }
    />,
    head,
    status,
  )
}

function handoffStatus(config: Config, title: string, status: 404 | 503, head = false) {
  return page(config, title, 'error', <h1 class="forge-title">{title}</h1>, head, status)
}

function page(
  config: Config,
  title: string,
  panel: 'landing' | 'error',
  children: Child,
  head: boolean,
  status = 200,
  actions?: Child,
) {
  const wide = panel === 'landing' && config.publicIndex ? ' forge-panel--gallery' : ''
  const html = (
    <html lang={config.locale}>
      <DocumentHead config={config} title={title} />
      <body>
        <main class={`forge-panel forge-panel--${panel}${wide}`}>
          <header class="forge-panel__header">
            <BrandBlock config={config} variant={panel === 'landing' ? 'heading' : undefined} />
            {actions}
          </header>
          <div class="forge-panel__body">{children}</div>
        </main>
      </body>
    </html>
  )
  return documentResponse(html, head, status)
}

function documentResponse(html: Child, head: boolean, status = 200) {
  const headers = readHeaders()
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; ${forgePageSources}; base-uri 'none'; frame-ancestors 'none'`,
  )
  return new Response(head ? null : `<!doctype html>${html}`, { status, headers })
}

async function startHandoff(request: Request, url: URL, runtime: Runtime) {
  const current = readCookie(request, stateCookie)
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
  return redirect(target.href, 302, [writeCookie(stateCookie, browser, 600, 'None')])
}

async function completeHandoff(request: Request, runtime: Runtime) {
  const { config } = runtime
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/x-www-form-urlencoded') {
    return handoffStatus(config, messages(config).notFound, 404)
  }
  const body = await readBoundedBody(request, handoffBodyLimit)
  if (body === null) return new Response(null, { status: 413, headers: readHeaders() })
  const fields = new URLSearchParams(new TextDecoder().decode(body))
  const result = await redeemHandoff(
    runtime,
    fields.get('code'),
    fields.get('state'),
    fields.get('nonce'),
    readCookie(request, stateCookie),
  )
  if (!result) return handoffStatus(config, messages(config).notFound, 404)
  if (result.kind === 'retry') {
    const path = readReturnPath(fields.get('return'), config.readOrigin)
    const text = messages(config).read
    return page(
      config,
      text.incomplete,
      'error',
      <>
        <h1 class="forge-title">{text.incomplete}</h1>
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
  return redirect(result.path, 303, [writeCookie(readSessionCookie, result.cookie, result.maxAge)])
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
  try {
    if (url.pathname === callback) {
      if (request.method === 'POST') return await completeHandoff(request, runtime)
      return handoffStatus(config, common.notFound, 404, head)
    }
    if (request.method !== 'GET' && !head) return notFound(config)
    let decision: Awaited<ReturnType<typeof canonicalRead> | ReturnType<typeof shareRead>> | undefined
    if (url.pathname.startsWith('/s/')) {
      const target = sharePath(url.pathname)
      if (!target) return notFound(config, head)
      decision = await shareRead(runtime, target.slug, target.key, target.path, url.pathname, ctx)
    } else {
      const target = artefactPath(url.pathname)
      if (target) {
        if (target.path === undefined) return redirect(`${url.pathname}/${url.search}`, 301)
        decision = await canonicalRead(runtime, target.slug, target.path, url.pathname, () =>
          readBoundSession(runtime, readCookie(request, readSessionCookie), Date.now()),
        )
      }
    }
    switch (decision?.kind) {
      case 'serve': {
        const isPublic = 'public' in decision && decision.public === true
        return await serveFile(request, runtime.env.BLOBS, decision.file, isPublic, config.allowIndexing)
      }
      case 'slash':
        return redirect(`${url.pathname}/${url.search}`, 301)
      case 'redirect':
        return redirect(`${decision.location}${url.search}`)
      case 'entry':
        return redirect(`${url.pathname}${decision.path}${url.search}`)
      case 'sign-in':
      case 'revalidate':
        if (isDocumentNavigation(request)) return await startHandoff(request, url, runtime)
        return new Response(null, { status: 401, headers: readHeaders() })
      case 'pending':
        return documentResponse(
          <AccessCard
            config={config}
            variant="pending"
            title={common.pending}
            lead={common.legacy.approvalRequired}
            note={common.access.pendingNote}
            actions={
              <CardLink href={config.manageOrigin} primary>
                {common.access.account}
              </CardLink>
            }
          />,
          head,
        )
      case 'not-found':
        return notFound(config, head)
    }
    if (url.pathname === '/') {
      const { name, publicIndex, brand } = config
      const entries = publicIndex ? await publicArtefacts(runtime, ctx) : null
      const previews = entries
        ? await galleryPreviewSlugs(
            runtime,
            entries.map(({ slug }) => slug),
            'public',
          )
        : undefined
      const signIn = (
        <a class="forge-button forge-button--primary" href={new URL('/artefacts', config.manageOrigin).href}>
          {common.signIn}
        </a>
      )
      const view = galleryView(url.searchParams.get('view'))
      return page(
        config,
        name,
        'landing',
        entries ? (
          <>
            <div class="forge-toolbar">
              <GalleryViews path="/" view={view} labels={common.views} />
            </div>
            {entries.length === 0 ? (
              <p class="forge-empty">{common.read.noArtefacts}</p>
            ) : (
              <Gallery
                label={common.artefacts}
                view={view}
                items={entries.map(({ url, title, slug }) => ({
                  href: url,
                  title,
                  preview: previews?.has(slug) ? slug : undefined,
                }))}
              />
            )}
          </>
        ) : (
          <>
            {brand.landingText && <p>{brand.landingText}</p>}
            {signIn}
          </>
        ),
        head,
        200,
        entries && signIn,
      )
    }
    return notFound(config, head)
  } catch (error) {
    console.error('Forge read failed', error instanceof Error ? error.name : 'unknown')
    if (url.pathname === callback && request.method === 'POST')
      return handoffStatus(config, common.unavailable, 503)
    return statusPage(config, common.unavailable, 503, head)
  }
}
