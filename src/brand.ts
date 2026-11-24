import { favicon, logo } from '../brand/defaults'
import type { Config } from './config'

const style = `
  :root {
    color-scheme: light dark;
    --forge-font-sans: system-ui, sans-serif;
    --forge-font-mono: ui-monospace, monospace;
    --forge-page: #fafafa;
    --forge-surface: #fff;
    --forge-ink: #191d27;
    --forge-muted: #545b6b;
    --forge-hairline: #d7dae2;
    --forge-on-accent: #fff;
    --forge-danger: #aa2436;
    --forge-focus: #514dbb;
    --forge-radius: .5rem;
    --forge-control-height: 44px;
    --forge-space: .5rem;
    --forge-text-small: .875rem;
    --forge-text-base: 1rem;
    --forge-text-heading: 1.25rem;
    --forge-text-title: clamp(1.55rem, 4vw, 2rem);
    --forge-link: #423ea0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --forge-page: #14161d;
      --forge-surface: #1e212a;
      --forge-ink: #eef0f6;
      --forge-muted: #b2b7c6;
      --forge-hairline: #373d4b;
      --forge-danger: #ff9da9;
      --forge-focus: #b9b6ff;
      --forge-link: #c0beff;
    }
  }
  :where(*) { box-sizing: border-box }
  :where(body) { margin: 0; background: var(--forge-page); color: var(--forge-ink); font: var(--forge-text-base)/1.5 var(--forge-font-sans) }
  :where(a) { color: var(--forge-link); text-underline-offset: .15em }
  :where(:focus-visible) { outline: 2px solid var(--forge-focus); outline-offset: 2px }
  :where(p, ul, dl) { margin-block: var(--forge-space) calc(2 * var(--forge-space)) }
  :where(h2) { margin-block: calc(4 * var(--forge-space)) var(--forge-space); font-size: var(--forge-text-heading); line-height: 1.25 }
  :where(code, pre) { font-family: var(--forge-font-mono); overflow-wrap: anywhere }
  :where(pre) { white-space: pre-wrap; background: var(--forge-surface); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); padding: calc(2 * var(--forge-space)) }
  :where(dt) { font-size: var(--forge-text-small); color: var(--forge-muted) }
  :where(dd) { margin: 0 0 var(--forge-space) }
  .forge-shell { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 15rem) minmax(0, 1fr) }
  .forge-tray { background: var(--forge-surface); border-inline-end: 1px solid var(--forge-hairline); padding: calc(3 * var(--forge-space)); display: flex; flex-direction: column; gap: calc(3 * var(--forge-space)) }
  .forge-tray__sections { display: flex; flex-direction: column; align-items: flex-start; gap: calc(3 * var(--forge-space)) }
  :where(.forge-tray__sections .forge-nav) { width: 100% }
  .forge-drawer { display: none }
  .forge-brand { display: flex; align-items: center; gap: var(--forge-space); min-height: var(--forge-control-height); color: var(--forge-ink); font-weight: 700; text-decoration: none; overflow-wrap: anywhere }
  .forge-brand__logo { display: block; height: calc(4 * var(--forge-space)); width: auto; max-width: 50%; object-fit: contain }
  .forge-nav { display: flex; flex-direction: column; gap: calc(.5 * var(--forge-space)) }
  .forge-nav__link { display: flex; align-items: center; min-height: var(--forge-control-height); padding-inline: var(--forge-space); border-radius: var(--forge-radius); color: var(--forge-muted); text-decoration: none }
  .forge-nav__link:where(:hover, [aria-current="page"]) { background: var(--forge-page); color: var(--forge-ink); box-shadow: inset .2em 0 var(--forge-accent) }
  .forge-content { min-width: 0; width: 100%; max-width: 76rem; padding: calc(5 * var(--forge-space)) clamp(1rem, 4vw, 3rem); overflow-wrap: anywhere }
  .forge-title { margin: 0 0 calc(3 * var(--forge-space)); font-size: var(--forge-text-title); line-height: 1.15 }
  .forge-panel { width: min(100%, 42rem); margin: clamp(1rem, 8vh, 5rem) auto; padding: 0 calc(2 * var(--forge-space)) }
  .forge-panel__header { margin-bottom: calc(2 * var(--forge-space)) }
  .forge-panel__body { padding: clamp(1rem, 4vw, 2rem); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); background: var(--forge-surface); overflow-wrap: anywhere }
  .forge-panel.forge-panel--gallery { width: 100% }
  .forge-panel--gallery > :is(.forge-panel__header, .forge-panel__body) { width: min(100%, 76rem); margin-inline: auto }
  .forge-panel--gallery .forge-panel__body > .forge-button { width: auto }
  .forge-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr)); align-items: start; gap: calc(2 * var(--forge-space)); list-style: none; padding: 0 }
  .forge-gallery__item { min-width: 0; border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); background: var(--forge-surface); overflow-wrap: anywhere }
  .forge-gallery__item:has(> a:hover) { border-color: var(--forge-link) }
  .forge-gallery__card { display: block; border-radius: var(--forge-radius) }
  .forge-gallery__card:focus-visible { outline: 2px solid var(--forge-focus); outline-offset: 2px }
  .forge-gallery__preview { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: var(--forge-page); border-radius: var(--forge-radius) var(--forge-radius) 0 0 }
  .forge-gallery__caption { display: block; padding: calc(2 * var(--forge-space)); min-height: var(--forge-control-height) }
  .forge-gallery__title { font-weight: 600 }
  .forge-gallery__detail { padding: 0 calc(2 * var(--forge-space)) calc(2 * var(--forge-space)); color: var(--forge-muted); font-size: var(--forge-text-small) }
  .forge-table-scroll { max-width: 100%; overflow-x: auto; margin-block: calc(2 * var(--forge-space)) }
  .forge-table { width: 100%; border-collapse: collapse; font-size: var(--forge-text-small) }
  :where(.forge-table th, .forge-table td) { text-align: start; vertical-align: middle; padding: var(--forge-space); border-bottom: 1px solid var(--forge-hairline); overflow-wrap: normal }
  :where(.forge-table th) { color: var(--forge-muted) }
  :where(.forge-table td:has(.forge-action)) { white-space: nowrap }
  .forge-action { display: inline-flex; max-width: 100%; flex-wrap: wrap; align-items: end; gap: var(--forge-space); margin-block: calc(.5 * var(--forge-space)) }
  :where(.forge-action label) { display: flex; flex-direction: column; gap: calc(.5 * var(--forge-space)); min-width: 0; font-size: var(--forge-text-small) }
  :where(input:not([type="hidden"]), select, .forge-button) { min-height: var(--forge-control-height); max-width: 100%; padding: var(--forge-space) calc(1.5 * var(--forge-space)); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); font: inherit; color: var(--forge-ink); background: var(--forge-surface) }
  :where(.forge-action label:has(input[type="checkbox"])) { flex-direction: row; align-items: center; min-height: var(--forge-control-height) }
  :where(input[type="checkbox"]) { min-height: auto; accent-color: var(--forge-accent) }
  .forge-button { display: inline-flex; align-items: center; text-decoration: none; cursor: pointer }
  .forge-button:where(:hover) { border-color: var(--forge-accent) }
  .forge-button--primary { color: var(--forge-on-accent); background: var(--forge-accent); border-color: var(--forge-accent) }
  .forge-button--danger { color: var(--forge-danger) }
  @media (pointer: fine) and (not (any-pointer: coarse)) { :where(.forge-table .forge-button) { min-height: 2rem; padding-block: calc(.5 * var(--forge-space)) } }
  .forge-notice { margin-block: calc(2 * var(--forge-space)); padding: var(--forge-space) calc(2 * var(--forge-space)); background: var(--forge-surface); border-inline-start: .2em solid var(--forge-accent); border-radius: var(--forge-radius) }
  .forge-secret { display: flex; flex-wrap: wrap; align-items: center; gap: var(--forge-space) }
  .forge-empty { color: var(--forge-muted) }
  .forge-link-list { display: grid; gap: var(--forge-space) }
  :where(.forge-panel--sign-in .forge-link-list, .forge-panel--invite .forge-link-list) { padding: 0; list-style: none }
  @media (max-width: 45rem) {
    .forge-shell { display: block }
    .forge-tray { border-inline-end: 0; border-bottom: 1px solid var(--forge-hairline); padding: calc(2 * var(--forge-space)); gap: var(--forge-space) }
    .forge-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--forge-space) }
    .forge-tray__sections { display: none }
    .forge-drawer { display: block; max-inline-size: 56vw }
    .forge-menu { display: list-item; list-style-position: inside; width: max-content; margin-inline-start: auto; white-space: nowrap }
    .forge-drawer__panel { margin-block-start: var(--forge-space); padding: var(--forge-space); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); overflow-wrap: anywhere }
    .forge-content { padding-block: calc(3 * var(--forge-space)) }
    .forge-col--secondary, .forge-col--folded { display: none }
    .forge-fold { display: block; color: var(--forge-muted); overflow-wrap: anywhere }
    :where(.forge-table td[title], .forge-table td > span:has(+ .forge-fold)) { overflow-wrap: anywhere }
    :where(.forge-table td:has(.forge-action)) { white-space: normal }
  }
`

export const themePrefix = '/_theme/'
export const themeStylesheet = `${themePrefix}theme.css`
export const forgePageSources = "style-src 'self'; img-src 'self'; font-src 'self'"

export function brandMark(config: Config, mark: 'logo' | 'favicon') {
  const filename = config.brand[mark]
  return filename ? `${themePrefix}${filename}` : `/${mark}.svg`
}

function assetHeaders(type?: string) {
  const headers = new Headers({
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex',
  })
  if (type) headers.set('Content-Type', type)
  if (type?.startsWith('image/svg+xml')) {
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
  }
  return headers
}

export async function themeAsset(request: Request, url: URL, theme?: Fetcher): Promise<Response> {
  const { method } = request
  const notFound = () => new Response(null, { status: 404, headers: assetHeaders() })
  if (!theme || (method !== 'GET' && method !== 'HEAD')) return notFound()

  // Reject noncanonical paths if the incoming Request still exposes them.
  const pathname = request.url.slice(url.origin.length).split(/[?#]/, 1)[0]
  if (pathname !== url.pathname || !pathname.startsWith(themePrefix)) return notFound()
  // Only pass literal, allowlisted paths to the binding; never decode or follow redirects.
  const file = pathname.slice(themePrefix.length)
  const type =
    file === 'theme.css'
      ? 'text/css; charset=utf-8'
      : /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.svg$/.test(file)
        ? 'image/svg+xml'
        : /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.png$/.test(file)
          ? 'image/png'
          : /^fonts\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.woff2$/.test(file)
            ? 'font/woff2'
            : null
  if (!type) return notFound()

  const validators = ['If-None-Match', 'If-Modified-Since'] as const
  const headers = new Headers()
  for (const key of validators) {
    const value = request.headers.get(key)
    if (value !== null) headers.set(key, value)
  }
  const asset = await theme.fetch(
    new Request(new URL(`/${file}`, url.origin), { method, headers, redirect: 'manual' }),
  )
  if (asset.status !== 200 && asset.status !== 304) {
    await asset.body?.cancel()
    return notFound()
  }
  const responseHeaders = assetHeaders(type)
  for (const key of ['ETag', 'Last-Modified']) {
    const value = asset.headers.get(key)
    if (value !== null) responseHeaders.set(key, value)
  }
  return new Response(method === 'HEAD' || asset.status === 304 ? null : asset.body, {
    status: asset.status,
    headers: responseHeaders,
  })
}

export function brandAsset(method: string, path: string, config: Config) {
  if (method !== 'GET' && method !== 'HEAD') return null
  if (path !== '/favicon.svg' && path !== '/logo.svg' && path !== '/style.css') return null
  const css = path === '/style.css'
  return new Response(
    method === 'HEAD'
      ? null
      : css
        ? `:root{--forge-accent:${config.brand.accent}}${style}`
        : path === '/logo.svg'
          ? logo
          : favicon,
    {
      headers: assetHeaders(css ? 'text/css; charset=utf-8' : 'image/svg+xml; charset=utf-8'),
    },
  )
}
