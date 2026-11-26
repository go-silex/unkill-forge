import type { Child } from 'hono/jsx'
import { base64url } from 'jose'
import { AccessCard, CardLink, ErrorCard } from '../access-card'
import { forgePageSources } from '../brand'
import { BrandBlock } from '../brand-block'
import type { Config, Runtime } from '../config'
import { isArtefactTag } from '../core/artefact-tags'
import { canonicalRead, shareRead } from '../core/artefacts'
import { publicArtefacts } from '../core/catalogue'
import { galleryPreviewSlugs } from '../core/gallery-previews'
import { galleryQueryLimit, gallerySearch } from '../core/gallery-search'
import { handoffChallenge, readBoundSession, redeemHandoff, validHandoffState } from '../core/handoffs'
import { randomSecret } from '../core/index'
import { artefactPath, maxReadReturnLength, readReturnPath, sharePath } from '../core/read-path'
import { time } from '../dates'
import { Gallery, GalleryViews, galleryView } from '../gallery'
import { DocumentHead } from '../head'
import { isDocumentNavigation, readBoundedBody, readCookie, writeCookie } from '../http'
import { messages } from '../i18n'
import { TagChips } from '../tag-chips'
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

function handoffStatus(
  config: Config,
  title: string,
  status: 400 | 404 | 503,
  head = false,
  children?: Child,
) {
  return documentResponse(
    <html lang={config.locale}>
      <DocumentHead config={config} title={title} />
      <body>
        <main class="forge-panel forge-panel--error">
          <header class="forge-panel__header">
            <BrandBlock config={config} />
          </header>
          <div class="forge-panel__body">
            <h1 class="forge-title">{title}</h1>
            {children}
          </div>
        </main>
      </body>
    </html>,
    head,
    status,
  )
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

async function home(runtime: Runtime, params: URLSearchParams, head: boolean, ctx: ExecutionContext) {
  const { config } = runtime
  const { name, publicIndex, brand } = config
  const t = messages(config)
  const signIn = new URL('/artefacts', config.manageOrigin).href
  if (!publicIndex) {
    return documentResponse(
      <AccessCard
        config={config}
        variant="landing"
        title={name}
        lead={brand.landingText}
        actions={
          <CardLink href={signIn} primary>
            {t.signIn}
          </CardLink>
        }
      />,
      head,
    )
  }

  const { query: q, matches: matchesQuery } = gallerySearch(params)
  const view = galleryView(params.get('view'))
  const entries = await publicArtefacts(runtime, ctx)
  const requestedTag = params.get('tag') ?? ''
  const tag = isArtefactTag(requestedTag) ? requestedTag : ''
  const publicTags = new Set<string>()
  for (const entry of entries) for (const value of entry.tags) publicTags.add(value)
  // Keep preview discovery on the same bounded set (and SQL path) for both indexed views and search.
  const previews = await galleryPreviewSlugs(
    runtime,
    entries.map(({ slug }) => slug),
    'public',
  )
  const filtered = Boolean(q || tag)
  const matches = filtered
    ? entries.filter((entry) => (!tag || entry.tags.includes(tag)) && matchesQuery(entry))
    : entries
  const viewParams = new URLSearchParams(q ? { q } : undefined)
  if (publicTags.has(tag)) viewParams.set('tag', tag)
  const clear = view === 'list' ? '/?view=list' : '/'
  return documentResponse(
    <html lang={config.locale}>
      <DocumentHead config={config} title={name} />
      <body>
        <div class="forge-panel forge-panel--landing forge-panel--gallery">
          <header class="forge-panel__header">
            <BrandBlock config={config} />
            <CardLink href={signIn} primary>
              {t.signIn}
            </CardLink>
          </header>
          <main class="forge-panel__body">
            <div class="forge-public-intro">
              <h1 class="forge-title">{name}</h1>
              <p class="forge-lead">{brand.landingText ?? t.read.landingLead}</p>
            </div>
            <div class="forge-toolbar">
              <search class="forge-public-search">
                <form action="/" method="get">
                  <label class="forge-sr-only" for="public-query">
                    {t.read.searchLabel}
                  </label>
                  <input
                    id="public-query"
                    name="q"
                    type="search"
                    value={q}
                    maxlength={galleryQueryLimit}
                    placeholder={t.read.searchLabel}
                  />
                  {publicTags.size > 0 && (
                    <select class="forge-tag-filter" name="tag" aria-label={t.read.tagFilter}>
                      <option value="">{t.read.allTags}</option>
                      {[...publicTags].sort().map((option) => (
                        <option key={option} value={option} selected={tag === option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  )}
                  {view === 'list' && <input name="view" type="hidden" value={view} />}
                  <button class="forge-button" type="submit">
                    {t.read.search}
                  </button>
                  {filtered && (
                    <a class="forge-button" href={clear}>
                      {t.read.clear}
                    </a>
                  )}
                </form>
              </search>
              <p class="forge-public-count">
                {t.read.documents(entries.length, filtered ? matches.length : undefined)}
              </p>
              <GalleryViews path="/" params={viewParams} view={view} labels={t.views} />
            </div>
            {entries.length === 0 ? (
              <p class="forge-empty">{t.read.noArtefacts}</p>
            ) : matches.length === 0 ? (
              <p class="forge-empty">
                {t.read.noMatches} <a href={clear}>{t.read.clear}</a>
              </p>
            ) : (
              <Gallery
                label={t.artefacts}
                view={view}
                linkRel="noreferrer"
                items={matches.map(({ url, title, slug, updatedAt, tags }) => ({
                  href: url,
                  title,
                  preview: previews.has(slug) ? slug : undefined,
                  detail: tags.length > 0 ? <TagChips tags={tags} /> : undefined,
                  meta: time(config, updatedAt),
                }))}
              />
            )}
          </main>
          <footer class="forge-public-footer">
            <span>{name}</span>
            <a href={signIn}>{t.signIn}</a>
          </footer>
        </div>
      </body>
    </html>,
    head,
  )
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
    return handoffStatus(
      config,
      text.incomplete,
      400,
      false,
      path && (
        <p>
          <a href={path}>{text.retry}</a>
        </p>
      ),
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
    if (url.pathname === '/') return await home(runtime, url.searchParams, head, ctx)
    return notFound(config, head)
  } catch (error) {
    console.error('Forge read failed', error instanceof Error ? error.name : 'unknown')
    if (url.pathname === callback && request.method === 'POST')
      return handoffStatus(config, common.unavailable, 503)
    return statusPage(config, common.unavailable, 503, head)
  }
}
