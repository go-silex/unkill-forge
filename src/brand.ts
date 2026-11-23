import { favicon, logo } from '../brand/defaults'
import type { Config } from './config'

const style = `
  :root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}
  body{max-width:64rem;margin:2rem auto;padding:0 1rem}
  .brand{display:inline-flex;align-items:center;gap:.5rem;color:CanvasText;font-weight:700;text-decoration:none}
  header{border-bottom:3px solid var(--brand-accent);padding-bottom:.5rem}
  nav{display:flex;flex-wrap:wrap;gap:.75rem;margin:.5rem 0}
  h1,h2{line-height:1.2} form{display:inline-flex;gap:.4rem;margin:.2rem;flex-wrap:wrap}
  button,input,select{font:inherit} a{color:LinkText} code,pre{overflow-wrap:anywhere} pre{white-space:pre-wrap}
  table{width:100%;border-collapse:collapse} th,td{text-align:left;vertical-align:top;padding:.4rem;border-bottom:1px solid GrayText}
  aside{border-inline-start:3px solid var(--brand-accent);padding-inline:1rem} aside button{margin-inline-start:.5rem}
`

export function brandAsset(method: string, path: string, config: Config) {
  if (method !== 'GET' && method !== 'HEAD') return null
  if (path !== '/favicon.svg' && path !== '/logo.svg' && path !== '/style.css') return null
  const css = path === '/style.css'
  return new Response(
    method === 'HEAD'
      ? null
      : css
        ? `:root{--brand-accent:${config.brand.accent}}${style}`
        : path === '/logo.svg'
          ? logo
          : favicon,
    {
      headers: {
        'Content-Type': css ? 'text/css; charset=utf-8' : 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
        'X-Robots-Tag': 'noindex',
        ...(css ? {} : { 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox" }),
      },
    },
  )
}
