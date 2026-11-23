import { expect, it } from 'vitest'
import { manage, read, runtime } from './http'

const assets = {
  '/theme.css': ['text/css; charset=utf-8', ':root { --forge-page: #eee }'],
  '/wordmark.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  '/icon.png': ['image/png', 'test PNG bytes'],
  '/fonts/ui.woff2': ['font/woff2', 'test WOFF2 bytes'],
} as const
const themeHeaders = {
  'cache-control': 'no-cache',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
}
const theme = {
  fetch(request: Request) {
    const asset = assets[new URL(request.url).pathname as keyof typeof assets]
    if (!asset) return new Response(null, { status: 404 })
    const headers = { ETag: '"theme-revision"', 'Content-Type': asset[0], 'Set-Cookie': 'unexpected=value' }
    if (request.headers.get('If-None-Match') === headers.ETag) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(request.method === 'HEAD' ? null : asset[1], { headers })
  },
}

it.each([manage, read])('serves only allowed theme assets and controlled headers on %s', async (origin) => {
  const upstream = new Array<string>()
  const send = runtime({
    THEME: {
      fetch(request: Request) {
        const url = new URL(request.url)
        expect(url.origin).toBe(origin)
        expect(request.redirect).toBe('manual')
        expect(request.headers.has('Cookie')).toBe(false)
        upstream.push(url.pathname)
        if (url.pathname === '/redirect.svg') {
          return new Response(null, { status: 302, headers: { Location: '/wordmark.svg' } })
        }
        return theme.fetch(request)
      },
    },
  })
  for (const [path, [type, body]] of Object.entries(assets)) {
    for (const method of ['GET', 'HEAD']) {
      const response = await send(`${origin}/_theme${path}?v=1`, { method, headers: { Cookie: 'test=secret' } })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(method === 'GET' ? body : '')
      expect(Object.fromEntries(response.headers)).toEqual({
        ...themeHeaders,
        'content-type': type,
        etag: '"theme-revision"',
        ...(type === 'image/svg+xml'
          ? { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox" }
          : {}),
      })
    }
  }
  const validated = await send(`${origin}/_theme/theme.css`, { headers: { 'If-None-Match': '"theme-revision"' } })
  expect(validated.status).toBe(304)
  expect(await validated.text()).toBe('')
  expect(validated.headers.get('ETag')).toBe('"theme-revision"')
  upstream.length = 0
  for (const [path, method] of [
    ['', 'GET'],
    ['/', 'GET'],
    ['/theme.css', 'POST'],
    ['/theme.css', 'OPTIONS'],
    ['/other.css', 'GET'],
    ['/file.html', 'GET'],
    ['/file.js', 'GET'],
    ['/ui.woff2', 'GET'],
    ['/fonts/ui.woff', 'GET'],
    ['/nested/wordmark.svg', 'GET'],
    ['/fonts/%2e%2e%2fwordmark.svg', 'GET'],
    ['/fonts/..%5cwordmark.svg', 'GET'],
    ['/%77ordmark.svg', 'GET'],
    ['/theme.css/', 'GET'],
    ['/absent.png', 'GET'],
    ['/redirect.svg', 'GET'],
  ]) {
    const response = await send(`${origin}/_theme${path}`, { method })
    expect(response.status, `${method} ${path}`).toBe(404)
    expect(Object.fromEntries(response.headers)).toEqual(themeHeaders)
  }
  expect(upstream).toEqual(['/absent.png', '/redirect.svg'])
  expect((await send('https://unconfigured.example/_theme/theme.css')).status).toBe(404)
  expect(upstream).toEqual(['/absent.png', '/redirect.svg'])
})

it.each(['/login', `${read}/`])('links optional CSS after built-in styles and selects configured marks on %s', async (path) => {
  const themed = runtime({ THEME: theme, BRAND: '{"logo":"wordmark.svg","favicon":"icon.png"}' })
  const response = await themed(path)
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body.match(/<link[^>]+>/g)).toEqual([
    '<link rel="icon" href="/_theme/icon.png"/>',
    '<link rel="stylesheet" href="/style.css"/>',
    '<link rel="stylesheet" href="/_theme/theme.css"/>',
  ])
  expect(body).toContain('<img class="forge-brand__logo" src="/_theme/wordmark.svg" alt=""/>')
  expect(response.headers.get('Content-Security-Policy')).toContain("font-src 'self'")

  const unthemed = runtime()
  const bundled = await unthemed(path)
  const fallback = await bundled.text()
  expect(fallback).not.toContain('/_theme/')
  expect(fallback).toContain('href="/favicon.svg"')
  expect(fallback).toContain('src="/logo.svg"')
  const missing = await unthemed(`${new URL(path, manage).origin}/_theme/theme.css`)
  expect(missing.status).toBe(404)
  expect(Object.fromEntries(missing.headers)).toEqual(themeHeaders)
})

it('keeps each unspecified bundled mark without probing the binding', async () => {
  const binding = { fetch: () => { throw new Error('Unexpected mark lookup') } }
  const logoOnly = runtime({ THEME: binding, BRAND: '{"logo":"wordmark.svg"}' })
  const logoPage = await (await logoOnly('/login')).text()
  expect(logoPage).toContain('src="/_theme/wordmark.svg"')
  expect(logoPage).toContain('href="/favicon.svg"')
  const iconOnly = runtime({ THEME: binding, BRAND: '{"favicon":"icon.png"}' })
  const iconPage = await (await iconOnly(`${read}/`)).text()
  expect(iconPage).toContain('src="/logo.svg"')
  expect(iconPage).toContain('href="/_theme/icon.png"')
})

it.each(['logo', 'favicon'])('fails closed for invalid or unbound BRAND.%s', async (mark) => {
  const unbound = runtime({ BRAND: JSON.stringify({ [mark]: 'brand.png' }) })
  expect((await unbound('/login')).status).toBe(503)
  for (const filename of ['../brand.svg', 'https://elsewhere.example/brand.png', 'mark.js', 'mark.svg?x']) {
    const invalid = runtime({ THEME: theme, BRAND: JSON.stringify({ [mark]: filename }) })
    expect((await invalid(`${read}/`)).status, filename).toBe(503)
  }
})

it('keeps font CSP out of non-page responses', async () => {
  const send = runtime({ THEME: theme })
  expect((await send('/oauth/clients/local.json')).headers.get('Content-Security-Policy')).not.toContain('font-src')
  expect((await send(`${read}/_theme/theme.css`)).headers.has('Content-Security-Policy')).toBe(false)
})
