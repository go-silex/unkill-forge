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
  .forge-tray__sections { display: flex; flex: 1; flex-direction: column; gap: calc(3 * var(--forge-space)) }
  .forge-drawer { display: none }
  .forge-brand { display: flex; align-items: center; gap: var(--forge-space); min-height: var(--forge-control-height); color: var(--forge-ink); font-weight: 700; text-decoration: none; overflow-wrap: anywhere }
  .forge-brand__logo { display: block; height: calc(4 * var(--forge-space)); width: auto; max-width: 50%; object-fit: contain }
  .forge-nav { display: flex; flex-direction: column; gap: calc(2 * var(--forge-space)) }
  .forge-nav__link { display: flex; align-items: center; min-height: var(--forge-control-height); padding-inline: var(--forge-space); border-radius: var(--forge-radius); color: var(--forge-muted); text-decoration: none }
  .forge-nav__link:where(:hover, [aria-current="page"]) { background: var(--forge-page); color: var(--forge-ink); box-shadow: inset .2em 0 var(--forge-accent) }
  .forge-nav__group-label { display: block; padding-inline: var(--forge-space); font-size: var(--forge-text-small); color: var(--forge-muted); font-weight: 600 }
  .forge-account { margin-block-start: auto; padding-block-start: calc(2 * var(--forge-space)); border-block-start: 1px solid var(--forge-hairline); overflow-wrap: anywhere }
  .forge-account__name { display: block; font-weight: 600 }
  .forge-account__role { display: block; color: var(--forge-muted); font-size: var(--forge-text-small) }
  .forge-content { min-width: 0; width: 100%; max-width: 76rem; padding: calc(5 * var(--forge-space)) clamp(1rem, 4vw, 3rem); overflow-wrap: anywhere }
  .forge-title { margin: 0 0 calc(3 * var(--forge-space)); font-size: var(--forge-text-title); line-height: 1.15 }
  .forge-panel { width: min(100%, 42rem); margin: clamp(1rem, 8vh, 5rem) auto; padding: 0 calc(2 * var(--forge-space)) }
  .forge-panel__header { margin-bottom: calc(2 * var(--forge-space)) }
  .forge-panel__body { padding: clamp(1rem, 4vw, 2rem); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); background: var(--forge-surface); overflow-wrap: anywhere }
  .forge-panel.forge-panel--gallery { width: 100% }
  .forge-panel--gallery > :is(.forge-panel__header, .forge-panel__body) { width: min(100%, 76rem); margin-inline: auto }
  .forge-panel--gallery .forge-panel__header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--forge-space); overflow-wrap: anywhere }
  .forge-toolbar { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--forge-space) calc(2 * var(--forge-space)); margin-block-end: calc(2 * var(--forge-space)) }
  .forge-toolbar > .forge-views:only-child { margin-inline-start: auto }
  .forge-views { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); background: var(--forge-surface) }
  .forge-views a { display: flex; flex: 0 1 auto; align-items: center; min-width: 0; min-height: var(--forge-control-height); padding-inline: min(calc(2 * var(--forge-space)), 4vw); border-radius: var(--forge-radius); color: var(--forge-muted); text-decoration: none; overflow-wrap: anywhere }
  .forge-views a[aria-current] { background: var(--forge-accent); color: var(--forge-on-accent) }
  .forge-filters { display: flex; flex-wrap: wrap; gap: calc(.5 * var(--forge-space)); border-block-end: 1px solid var(--forge-hairline) }
  .forge-filters__link { display: inline-flex; align-items: center; gap: calc(.5 * var(--forge-space)); min-height: var(--forge-control-height); padding-inline: calc(.75 * var(--forge-space)); color: var(--forge-muted); text-decoration: none }
  .forge-filters__link:where(:hover, [aria-current="page"]) { color: var(--forge-link); box-shadow: inset 0 -.15em var(--forge-link) }
  .forge-filters__count { padding-inline: calc(.75 * var(--forge-space)); border-radius: 1em; background: var(--forge-surface); font-size: var(--forge-text-small); font-variant-numeric: tabular-nums }
  .forge-badge { display: inline-flex; align-items: center; gap: calc(.5 * var(--forge-space)); padding-inline: var(--forge-space); border: 1px solid var(--forge-hairline); border-radius: 1em; font-size: var(--forge-text-small); white-space: nowrap }
  .forge-badge:where(:not(:empty))::before { content: ''; inline-size: .42em; block-size: .42em; border-radius: 50%; background: currentColor }
  .forge-badge--private { color: var(--forge-muted) }
  .forge-badge--shared, .forge-badge--current { color: var(--forge-link) }
  .forge-badge--public { color: var(--forge-ink) }
  .forge-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr)); align-items: start; gap: calc(2 * var(--forge-space)); list-style: none; padding: 0 }
  .forge-gallery__item { min-width: 0; border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); background: var(--forge-surface); overflow-wrap: anywhere }
  .forge-gallery__item:has(> a:hover) { border-color: var(--forge-link) }
  .forge-gallery__card { display: block; border-radius: var(--forge-radius) }
  .forge-gallery__card:focus-visible { outline: 2px solid var(--forge-focus); outline-offset: 2px }
  .forge-gallery__preview { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: var(--forge-page); border-radius: var(--forge-radius) var(--forge-radius) 0 0 }
  .forge-gallery__caption { display: block; padding: calc(2 * var(--forge-space)); min-height: var(--forge-control-height) }
  .forge-gallery__title { font-weight: 600 }
  .forge-gallery__detail { padding: 0 calc(2 * var(--forge-space)) calc(2 * var(--forge-space)); color: var(--forge-muted); font-size: var(--forge-text-small) }
  .forge-catalogue-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--forge-space) }
  :where(.forge-catalogue-meta > span:first-child) { flex: 1 1 7rem; min-inline-size: 0 }
  .forge-gallery--list { grid-template-columns: minmax(0, 1fr); gap: 0 }
  .forge-gallery--list .forge-gallery__item { border-width: 0 0 1px; border-radius: 0; background: none }
  .forge-gallery--list .forge-gallery__item:has(> a:hover) { border-color: var(--forge-hairline); background: var(--forge-page) }
  .forge-gallery--list .forge-gallery__card { display: grid; grid-template-columns: min(7.5rem, 30%) minmax(0, 1fr); align-items: center; gap: min(calc(2 * var(--forge-space)), 4vw); min-height: var(--forge-control-height); padding-block: var(--forge-space) }
  .forge-gallery--list .forge-gallery__preview { grid-column: 1; border-radius: calc(var(--forge-radius) / 2) }
  .forge-gallery--list .forge-gallery__caption { grid-column: 2; padding: 0; min-height: 0 }
  .forge-thumb { display: block; flex: none; width: 4rem; aspect-ratio: 16 / 9; object-fit: contain; background: var(--forge-page); border-radius: calc(var(--forge-radius) / 2) }
  .forge-table td > a:has(> .forge-thumb) { display: flex; align-items: center; gap: var(--forge-space) }
  .forge-catalogue-link { display: flex; align-items: center; min-height: var(--forge-control-height) }
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
  .forge-button--danger-solid { background: var(--forge-danger); color: var(--forge-surface); border-color: var(--forge-danger) }
  .forge-sheet { margin: auto; width: min(28rem, calc(100vw - 2rem)); padding: calc(3 * var(--forge-space)); border: 1px solid var(--forge-hairline); border-radius: calc(1.5 * var(--forge-radius)); background: var(--forge-surface); color: var(--forge-ink); font: inherit; white-space: normal; text-align: start; overflow-wrap: break-word }
  :where(.forge-sheet)::backdrop { background: color-mix(in srgb, var(--forge-ink) 45%, transparent) }
  .forge-sheet__title { margin: 0; font-size: var(--forge-text-heading) }
  .forge-sheet__body { color: var(--forge-muted) }
  .forge-sheet__actions { display: flex; justify-content: end; flex-wrap: wrap; gap: var(--forge-space); margin: 0 }
  :where(.forge-sheet__actions) .forge-button { min-height: var(--forge-control-height); padding-block: var(--forge-space) }
  @supports not selector(:popover-open) {
    .forge-sheet { max-width: 100%; margin: var(--forge-space) 0 }
    .forge-button[popovertarget] { display: none }
  }
  .forge-copy { display: flex; flex-wrap: wrap; align-items: start; gap: var(--forge-space) }
  :where(.forge-copy) > code { min-width: 0; overflow-wrap: anywhere }
  :where(.forge-copy) > .forge-button { flex: none }
  .forge-copy--block { flex-direction: column; align-items: stretch; gap: calc(.5 * var(--forge-space)); margin-block: calc(2 * var(--forge-space)) }
  :where(.forge-copy--block) > pre { margin: 0 }
  :where(.forge-copy--block) > .forge-button { align-self: end }
  .forge-button:where([data-copy][hidden]) { display: none }
  .forge-notice { margin-block: calc(2 * var(--forge-space)); padding: var(--forge-space) calc(2 * var(--forge-space)); background: var(--forge-surface); border-inline-start: .2em solid var(--forge-accent); border-radius: var(--forge-radius) }
  .forge-secret { display: flex; flex-wrap: wrap; align-items: center; gap: var(--forge-space) }
  .forge-empty { color: var(--forge-muted) }
  .forge-link-list { display: grid; gap: var(--forge-space) }
  :where(.forge-panel--sign-in .forge-link-list, .forge-panel--invite .forge-link-list) { padding: 0; list-style: none }
  .forge-breadcrumb { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--forge-space); margin-block-end: var(--forge-space); color: var(--forge-muted); font-size: var(--forge-text-small) }
  :where(.forge-breadcrumb) > a { display: inline-flex; align-items: center; min-block-size: var(--forge-control-height) }
  .forge-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 30%); gap: calc(3 * var(--forge-space)); margin-block-start: calc(3 * var(--forge-space)) }
  .forge-detail__main:only-child { grid-column: 1 / -1 }
  .forge-detail__aside { display: grid; align-content: start; gap: calc(2 * var(--forge-space)) }
  .forge-detail__meta { color: var(--forge-muted); font-size: var(--forge-text-small) }
  .forge-detail__meta:where(div), .forge-detail__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--forge-space) }
  :where(div.forge-detail__meta) { margin-block-end: var(--forge-space) }
  .forge-detail__preview { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: contain; background: var(--forge-surface); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius) }
  :where(.forge-detail__main .forge-table td) { overflow-wrap: anywhere }
  :where(.forge-detail__main .forge-table td > a) { display: inline-flex; align-items: center; min-block-size: var(--forge-control-height); max-inline-size: 100%; vertical-align: middle }
  :where(.forge-detail__main > p > a) { display: inline-flex; align-items: center; min-block-size: var(--forge-control-height) }
  .forge-versions, .forge-share-links { display: grid; padding: 0; margin: var(--forge-space) 0; list-style: none }
  .forge-version { display: flex; flex-wrap: wrap; align-items: start; gap: var(--forge-space); padding: var(--forge-space) 0 var(--forge-space) calc(2 * var(--forge-space)); position: relative; border-inline-start: 1px solid var(--forge-hairline) }
  :where(.forge-version)::before { content: ''; position: absolute; inset: calc(2 * var(--forge-space)) auto auto -.25rem; width: .5rem; height: .5rem; border-radius: 50%; background: var(--forge-muted) }
  :where(.forge-version:has(.forge-badge--current))::before { background: var(--forge-accent) }
  :where(.forge-version) > div { min-width: 0; flex: 1 0 min(100%, 15rem) }
  :where(.forge-version p, .forge-share-links p) { margin-block: calc(.5 * var(--forge-space)) }
  :where(.forge-version summary, .forge-panel-card summary) { cursor: pointer; min-block-size: var(--forge-control-height); padding-block: var(--forge-space) }
  .forge-panel-card { min-width: 0; padding: calc(2 * var(--forge-space)); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); background: var(--forge-surface) }
  :where(.forge-panel-card) > h2 { margin-block: 0 var(--forge-space) }
  :where(.forge-panel-card) > p { margin-block: var(--forge-space); color: var(--forge-muted) }
  :where(.forge-panel-card .forge-action) > label { flex: 1 0 100% }
  :where(.forge-share-links) > li { padding-block: var(--forge-space); border-block-start: 1px solid var(--forge-hairline) }
  .forge-access__options { display: grid; gap: var(--forge-space); min-inline-size: 0; flex: 1 0 100%; border: 0; padding: 0; margin: 0 }
  :where(.forge-access__options) > label { display: flex; flex-direction: row; align-items: start; gap: var(--forge-space); min-block-size: var(--forge-control-height); padding: var(--forge-space); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); cursor: pointer }
  :where(.forge-access__options) > label:where(:has(:checked)) { border-color: var(--forge-link) }
  :where(.forge-access__options) input[type="radio"] { flex: none; min-block-size: 0; margin: .25em 0; accent-color: var(--forge-accent) }
  :where(.forge-access__options) small { display: block; font: inherit; color: var(--forge-muted) }
  @supports selector(:popover-open) and selector(:has(*)) {
    :where(.forge-access:not(:has(input[type="radio"][value="private"]:checked)) > div) > .forge-button[popovertarget],
    :where(.forge-access:has(> div > button[popovertarget]):has(input[type="radio"][value="private"]:checked) > form) > .forge-button { display: none }
  }
  @media (prefers-color-scheme: dark) {
    :where(.forge-detail__aside .forge-sheet)::backdrop { background: color-mix(in srgb, var(--forge-page) 72%, transparent) }
  }
  @media (max-width: 66rem) {
    .forge-detail { grid-template-columns: minmax(0, 1fr) }
  }
  @media (max-width: 45rem) {
    .forge-shell { display: block }
    .forge-tray { border-inline-end: 0; border-bottom: 1px solid var(--forge-hairline); padding: calc(2 * var(--forge-space)); gap: var(--forge-space) }
    .forge-bar { position: relative }
    :where(.forge-bar .forge-brand) { max-inline-size: 70% }
    .forge-tray__sections { display: none }
    .forge-drawer { display: block }
    .forge-menu { display: list-item; list-style-position: inside; position: absolute; inset-block-start: 0; inset-inline-end: 0; white-space: nowrap }
    .forge-drawer__panel { margin-block-start: var(--forge-space); padding: var(--forge-space); border: 1px solid var(--forge-hairline); border-radius: var(--forge-radius); overflow-wrap: anywhere }
    :where(.forge-drawer__panel .forge-nav) { margin-block-end: calc(2 * var(--forge-space)) }
    .forge-content { padding-block: calc(3 * var(--forge-space)) }
    .forge-col--secondary, .forge-col--folded { display: none }
    .forge-fold { display: block; color: var(--forge-muted); overflow-wrap: anywhere }
    :where(.forge-table td[title], .forge-table td > span:has(+ .forge-fold)) { overflow-wrap: anywhere }
    :where(.forge-table td:has(.forge-action)) { white-space: normal }
  }
  @media (max-width: 30rem) {
    .forge-copy { flex-direction: column }
    :where(.forge-sheet__actions) > .forge-button { flex: 1 1 100%; justify-content: center }
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
