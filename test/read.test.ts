import { env } from 'cloudflare:test'
import { base64url } from 'jose'
import { expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
import {
  admin,
  Browser,
  createdBotId,
  flashNavigation,
  formValue,
  type Handle,
  listedId,
  location,
  manage,
  navigation,
  provider,
  read,
  runtime,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const readCookie = '__Host-forge'
const stateCookie = '__Host-forge-state'
const publicUrl = `${read}/a/public/`
const privateUrl = `${read}/a/private/`
const members = '/admin/members'

async function publisher(send: Handle, owner: Browser) {
  const name = 'Read test publisher'
  expect((await owner.post('/admin/bots', { action: 'create', name, role: 'publisher' })).status).toBe(303)
  const id = await createdBotId(name)
  const tokenResponse = await owner.post('/admin/bots', { action: 'token', id, name: 'Read tests' })
  expect(tokenResponse.status).toBe(303)
  const landing = await owner.request(location(tokenResponse), { headers: flashNavigation })
  expect(landing.status).toBe(200)
  const token = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await landing.text())?.[1]
  if (!token) throw new Error('Expected bot token')
  return async (name: string, args: object) => {
    const response = await send('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    expect(response.status).toBe(200)
    const { result } = await response.json<{
      result: { isError?: boolean; structuredContent?: { id?: string; url?: string } }
    }>()
    expect(result.isError ?? false).toBe(false)
    return result.structuredContent
  }
}

async function fixture(send: Handle = runtime()) {
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const call = await publisher(send, owner)
  expect(
    await call('publish', {
      slug: 'public',
      title: 'Public report',
      mode: 'replace',
      files: [
        { path: 'index.html', content: '<h1>Public</h1>' },
        { path: 'section', content: 'exact' },
        { path: 'section/index.html', content: 'directory' },
        { path: 'section.html', content: 'extension' },
        { path: 'only.html', content: 'extension only' },
        { path: 'a b.txt', content: 'encoded' },
        { path: 'file.txt', content: '0123456789' },
        { path: 'empty.txt', content: '' },
      ],
    }),
  ).toMatchObject({ url: publicUrl })
  await call('set_visibility', { slug: 'public', visibility: 'public' })
  expect(
    await call('publish', {
      slug: 'private',
      title: 'Private report',
      mode: 'replace',
      files: [{ path: 'index.html', content: '<h1>Private</h1>' }],
    }),
  ).toMatchObject({ url: privateUrl })
  return { send, idp, owner, call }
}

async function start(readBrowser: Browser, url = privateUrl) {
  const response = await readBrowser.request(url, { headers: navigation })
  expect(response.status).toBe(302)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.getSetCookie()[0]).toMatch(
    /^__Host-forge-state=.+; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=None$/,
  )
  const handoff = location(response)
  expect(handoff.origin + handoff.pathname).toBe(`${manage}/auth/handoff`)
  return handoff
}

type Handoff = { url: string; fields: URLSearchParams }

async function issue(manageBrowser: Browser, handoff: URL): Promise<Handoff> {
  const response = await manageBrowser.request(handoff, { headers: navigation })
  expect(response.status).toBe(200)
  expect(response.headers.has('Location')).toBe(false)
  const html = await response.text()
  const url = `${read}/_forge/session`
  expect(html).toContain(`method="post" action="${url}"`)
  const policy = response.headers.get('Content-Security-Policy')
  expect(policy).toContain(`form-action ${read}`)
  expect(policy).toContain("style-src 'self'; img-src 'self'; font-src 'self'")
  const script = /<script>([^<]+)<\/script>/.exec(html)?.[1]
  expect(script).toBeTruthy()
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script))
  expect(policy).toContain(`script-src 'sha256-${btoa(String.fromCharCode(...new Uint8Array(hash)))}'`)
  const fields = new URLSearchParams()
  for (const field of ['code', 'state', 'nonce', 'return']) fields.set(field, formValue(html, field))
  return { url, fields }
}

function submit(browser: Browser, callback: Handoff) {
  return browser.request(callback.url, { method: 'POST', body: callback.fields })
}

async function acquire(readBrowser: Browser, manageBrowser: Browser) {
  const callback = await issue(manageBrowser, await start(readBrowser))
  const result = await submit(readBrowser, callback)
  expect(result.status).toBe(303)
  expect(result.headers.get('Location')).toBe('/a/private/')
  expect(result.headers.getSetCookie()).toEqual([
    expect.stringMatching(/^__Host-forge=.+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/),
  ])
  expect(readBrowser.cookie(readCookie)).toBeTruthy()
  return callback
}

async function noReadSession(browser: Browser, callback: Handoff, status = 404) {
  const result = await submit(browser, callback)
  expect(result.status).toBe(status)
  expect(result.headers.getSetCookie()).toEqual([])
  expect(browser.cookie(readCookie)).toBeUndefined()
  return result
}

it('redirects slashless URLs and reads the current revision in exact, directory, extension order', async () => {
  const { send, call } = await fixture()
  const slash = await send(`${read}/a/public?tab=latest`)
  expect(slash.status).toBe(301)
  expect(slash.headers.get('Location')).toBe('/a/public/?tab=latest')
  const checks = [
    ['', '<h1>Public</h1>'],
    ['section', 'exact'],
    ['section/', 'directory'],
    ['only', 'extension only'],
    ['a%20b.txt', 'encoded'],
  ]
  for (const [path, body] of checks) expect(await (await send(publicUrl + path)).text()).toBe(body)
  await call('publish', { slug: 'public', mode: 'merge', files: [], delete: ['section'] })
  const directory = await send(`${publicUrl}section`)
  expect(directory.status).toBe(301)
  expect(directory.headers.get('Location')).toBe('/a/public/section/')
  expect(await (await send(`${publicUrl}section/`)).text()).toBe('directory')
  await call('publish', { slug: 'public', mode: 'merge', files: [], delete: ['section/index.html'] })
  expect(await (await send(`${publicUrl}section`)).text()).toBe('extension')
  await call('edit_file', {
    slug: 'public',
    path: 'index.html',
    expectedRevision: 3,
    oldText: 'Public',
    newText: 'Edited',
  })
  expect(await (await send(publicUrl)).text()).toBe('<h1>Edited</h1>')
})

it('gives the same 404 for unknown artefacts, unknown paths and non-read routes', async () => {
  const { send } = await fixture()
  const paths = [`${read}/a/unknown/`, `${publicUrl}missing`, `${publicUrl}%2Fhidden`, `${read}/auth/handoff`]
  const reference = await send(`${read}/missing`)
  expect(reference.status).toBe(404)
  const body = await reference.text()
  for (const path of paths) {
    const response = await send(path)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe(body)
    expect([...response.headers]).toEqual([...reference.headers])
  }
  expect((await send(`${manage}/_forge/session`)).status).toBe(404)
})

it('themes Forge-authored errors without altering served artefacts, redirects or share privacy', async () => {
  const { send, call } = await fixture()
  const share = await call('create_share_link', { slug: 'private' })
  if (!share?.url || !share.id) throw new Error('Expected a share URL and ID')
  const themed = runtime({
    THEME: { fetch: () => new Response(':root {}') },
    BRAND: '{"label":"Published Work"}',
  })
  for (const [url, status, body] of [
    [publicUrl, 200, '<h1>Public</h1>'],
    [share.url, 200, '<h1>Private</h1>'],
    [`${read}/a/public?tab=latest`, 301, ''],
    [share.url.slice(0, -1), 301, ''],
  ] as const) {
    const actual = await themed(url)
    const original = await send(url)
    expect(actual.status, url).toBe(status)
    expect(await actual.text()).toBe(body)
    expect([...actual.headers]).toEqual([...original.headers])
    expect(actual.headers.has('Content-Security-Policy')).toBe(false)
  }

  await call('revoke_share_link', { id: share.id })
  const revoked = await themed(share.url)
  const neverExisted = await themed(`${read}/s/private/never-existent-share-key/`)
  expect(revoked.status).toBe(404)
  expect(neverExisted.status).toBe(404)
  expect(Object.fromEntries(revoked.headers)).toEqual({
    'cache-control': 'private, no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
  })
  expect([...revoked.headers]).toEqual([...neverExisted.headers])
  const body = await revoked.text()
  expect(body).toContain('href="/_theme/theme.css"')
  expect(body).toContain('Published Work</div>')
  expect(body).toContain('forge-panel--error')
  expect(body).toBe(await neverExisted.text())
})

it('shows the public index only when enabled, without listing private artefacts', async () => {
  const { send, call } = await fixture()
  await call('publish', {
    slug: 'no-index',
    title: 'Alternate entry',
    mode: 'replace',
    files: [{ path: 'docs/start here.html', content: 'entry' }],
  })
  await call('set_visibility', { slug: 'no-index', visibility: 'public' })
  const landing = await (await send(read)).text()
  expect(landing).toContain('<main class="forge-panel forge-panel--landing">')
  expect(landing).toContain('<h1 class="forge-title">Gate 0 Test Forge</h1>')
  expect(landing).toContain(
    `<div class="forge-card-actions"><a class="forge-button forge-button--primary" href="${manage}/artefacts">Sign in</a></div>`,
  )
  expect(landing).not.toContain('forge-public-search')
  expect(landing).not.toContain('Public report')
  const index = await (await runtime({ PUBLIC_INDEX: 'true' })(read)).text()
  expect(index).toContain(`href="${publicUrl}"`)
  expect(index).toContain('Public report')
  expect(index).toContain(`href="${read}/a/no-index/docs/start%20here.html"`)
  expect(index).toContain('Alternate entry')
  expect(index).not.toContain('Private report')
})

it.each(['en', 'fr'] as const)(
  'searches the bounded public index in %s without more SQL statements',
  async (locale) => {
    const { call } = await fixture()
    const french = locale === 'fr'
    const { DB: db } = env as typeof env & Pick<Env, 'DB'>
    const timeZone = 'America/New_York'
    const updated = Date.parse('2026-03-08T07:00:00Z')
    await db.prepare('UPDATE artefacts SET updated_at = ? WHERE slug = ?').bind(updated, 'public').run()
    const statements: string[] = []
    const indexed = runtime({
      PUBLIC_INDEX: 'true',
      LOCALE: locale,
      TIMEZONE: timeZone,
      DB: new Proxy(db, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              statements.push(sql)
              return target.prepare(sql)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    })
    async function home(params?: Record<string, string>) {
      const url = new URL(read)
      if (params) url.search = new URLSearchParams(params).toString()
      const response = await indexed(url)
      expect(response.status).toBe(200)
      return response.text()
    }
    const mockNow = vi.spyOn(Date, 'now').mockReturnValue(updated + 2 * 3_600_000)
    try {
      const single = await home()
      expect(single).toContain('<p class="forge-public-count">1 document</p>')
      expect(single).toContain(french ? 'Documents publiés' : 'Published documents')
      const language = french ? 'fr-FR' : 'en-GB'
      const absolute = new Intl.DateTimeFormat(language, {
        timeZone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
      }).format(updated)
      const relative = new Intl.RelativeTimeFormat(language, { style: 'short' }).format(-2, 'hour')
      expect(single).toContain(
        `<span class="forge-gallery__meta"><time datetime="${new Date(updated).toISOString()}" title="${absolute}">${relative}</time></span>`,
      )
    } finally {
      mockNow.mockRestore()
    }
    await call('publish', {
      slug: 'field-guide',
      title: 'Alternate entry',
      mode: 'replace',
      files: [{ path: 'index.html', content: 'entry' }],
    })
    await call('set_visibility', { slug: 'field-guide', visibility: 'public' })

    statements.length = 0
    const unfiltered = await home({ view: 'list' })
    expect(unfiltered).toContain('<p class="forge-public-count">2 documents</p>')
    const baseline = statements.splice(0)
    expect(baseline).toHaveLength(2)
    const filtered = await home({ q: '  BLIC ReP  ', view: 'list' })
    expect(statements).toEqual(baseline)
    expect(filtered).toContain(french ? '1 sur 2 documents' : '1 of 2 documents')
    expect(filtered).toContain('class="forge-gallery forge-gallery--list"')
    expect(filtered).toContain('name="view" type="hidden" value="list"')
    expect(filtered).toContain('value="BLIC ReP"')
    expect(filtered).toContain('href="/?q=BLIC+ReP"')
    expect(filtered).toContain('href="/?q=BLIC+ReP&amp;view=list" aria-current="page"')
    expect(filtered).toContain(`href="/?view=list">${french ? 'Effacer' : 'Clear'}</a>`)
    expect(filtered).toContain('Public report')
    expect(filtered).not.toContain('Alternate entry')
    expect(filtered).not.toContain('Private report')
    const slugMatch = await home({ q: 'ELD-GU' })
    expect(slugMatch).toContain('Alternate entry')
    expect(slugMatch).not.toContain('Public report')

    const long = 'a'.repeat(100)
    expect(await home({ q: `${long}extra` })).toContain(`value="${long}" maxlength="100"`)
    const unmatched = await home({ q: `"><b>&`, view: 'list' })
    expect(unmatched).toContain('value="&quot;&gt;&lt;b&gt;&amp;"')
    expect(unmatched).not.toContain('<b>')
    expect(unmatched).toContain(french ? '0 sur 2 documents' : '0 of 2 documents')
    expect(unmatched).toContain(french ? 'Aucun document ne correspond' : 'No documents match')
    expect(unmatched).not.toContain('<ul class="forge-gallery')
    expect(unmatched.match(/href="\/\?view=list">(?:Clear|Effacer)<\/a>/g)).toHaveLength(2)
  },
)

it.each(['en', 'fr'] as const)(
  'distinguishes the empty public catalogue in %s from a failed search',
  async (locale) => {
    const index = runtime({ PUBLIC_INDEX: 'true', LOCALE: locale })
    const page = await (await index(read)).text()
    expect(page).toContain(locale === 'fr' ? '0 document<' : '0 documents<')
    expect(page).toContain(
      locale === 'fr' ? 'Aucun artefact publié pour le moment.' : 'Nothing has been published yet.',
    )
    expect(page).not.toContain('<ul class="forge-gallery')
    expect(page.match(/<h1\b/g)).toHaveLength(1)
    expect(page).toContain(
      `<footer class="forge-public-footer"><span>Gate 0 Test Forge</span><a href="${manage}/artefacts">`,
    )
    const head = await index(read, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await head.text()).toBe('')
  },
)

it('serves current raster previews without exposing private artefacts or active content', async () => {
  const { send, idp, owner, call } = await fixture(
    runtime({
      PUBLIC_INDEX: 'true',
      AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]),
    }),
  )
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X+uoAAAAASUVORK5CYII='
  for (const slug of ['public', 'private'])
    await call('publish', {
      slug,
      mode: 'merge',
      files: [
        { path: 'og.png', encoding: 'base64', content: png },
        { path: 'og.jpg', content: 'Not a JPEG despite its filename' },
      ],
    })
  const viewer = await idp.signedIn(send, 'preview-viewer')
  const viewerId = await listedId(owner, members, 'preview-viewer@example.test')
  expect((await owner.post(members, { action: 'admit', id: viewerId, role: 'viewer' })).status).toBe(303)
  const pending = await idp.signedIn(send, 'preview-pending')

  const src = (markup: string, slug: string) => new RegExp(`<img[^>]+src="([^"]+/${slug})"`).exec(markup)?.[1]
  const publicGallery = await (await send(read)).text()
  expect(src(publicGallery, 'private')).toBeUndefined()
  const publicImage = new URL(src(publicGallery, 'public') ?? '/missing-image', read)
  const catalogue = await (await viewer.request('/artefacts')).text()
  const privateImage = new URL(src(catalogue, 'private') ?? '/missing-image', manage)

  const image = { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' } }
  for (const response of [await send(publicImage), await viewer.request(privateImage, image)]) {
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
    )
  }
  const head = await viewer.request(privateImage, { ...image, method: 'HEAD' })
  expect(head.status).toBe(200)
  expect((await head.arrayBuffer()).byteLength).toBe(0)
  expect(head.headers.get('Content-Length')).toBe(String(atob(png).length))
  expect(head.headers.get('Content-Disposition')).toBe('attachment')
  for (const response of [
    await viewer.request(privateImage, { headers: navigation }),
    await viewer.request(privateImage, {
      headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Dest': 'iframe' },
    }),
    await viewer.request(privateImage, {
      headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Dest': 'image' },
    }),
    await send(privateImage, image),
    await pending.request(privateImage, image),
    await send(new URL(privateImage.pathname, read)),
    await runtime()(publicImage),
  ]) {
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
  }

  await call('set_visibility', { slug: 'public', visibility: 'private' })
  expect((await send(publicImage, { headers: { 'If-None-Match': '*' } })).status).toBe(404)
  expect((await owner.post(members, { action: 'remove', id: viewerId })).status).toBe(303)
  expect((await viewer.request(privateImage, image)).status).toBe(404)
  await call('publish', {
    slug: 'private',
    mode: 'replace',
    files: [
      { path: 'index.html', content: 'Revised report' },
      { path: 'og.png', content: '<!doctype html><h1>Not an image</h1>' },
    ],
  })
  expect((await owner.request(privateImage, image)).status).toBe(404)
})

it('distinguishes anonymous, pending, viewer, publisher and removed canonical readers', async () => {
  const { send, idp, owner } = await fixture(
    runtime({ AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]) }),
  )
  const anonymous = new Browser(send)
  await start(anonymous)
  await start(anonymous, `${privateUrl}missing`)
  const pendingManage = await idp.signedIn(send, 'pending-reader')
  const pendingRead = new Browser(send)
  await acquire(pendingRead, pendingManage)
  const pending = await pendingRead.request(privateUrl)
  expect(pending.status).toBe(200)
  const pendingPage = await pending.text()
  expect(pendingPage).toContain('forge-panel--pending')
  expect(pendingPage).not.toContain('forge-card-account')
  expect(pendingPage).toContain(`href="${manage}"`)
  expect(pendingPage).not.toContain('href="/_forge/session')
  const pendingMissing = await pendingRead.request(`${privateUrl}missing`)
  expect(pendingMissing.status).toBe(200)
  expect(await pendingMissing.text()).toContain('Pending access')

  for (const role of ['viewer', 'publisher']) {
    const identity = `${role}-reader`
    const manageBrowser = await idp.signedIn(send, identity)
    const id = await listedId(owner, members, `${identity}@example.test`)
    expect((await owner.post(members, { action: 'admit', id, role })).status).toBe(303)
    const readBrowser = new Browser(send)
    await acquire(readBrowser, manageBrowser)
    expect(await (await readBrowser.request(privateUrl)).text()).toBe('<h1>Private</h1>')
    expect((await readBrowser.request(`${privateUrl}missing`)).status).toBe(404)
    expect(await (await readBrowser.request(publicUrl)).text()).toBe('<h1>Public</h1>')
    expect((await owner.post(members, { action: 'remove', id })).status).toBe(303)
    await start(readBrowser)
    expect(await (await readBrowser.request(publicUrl)).text()).toBe('<h1>Public</h1>')
  }
  for (const browser of [anonymous, pendingRead]) {
    expect(await (await browser.request(publicUrl)).text()).toBe('<h1>Public</h1>')
  }
})

it('signs in and returns to a punctuation-heavy URL at the handoff limit without oversized redirects', async () => {
  const { send, idp } = await fixture()
  const checked: Handle = async (path, init) => {
    const response = await send(path, init)
    const redirect = response.headers.get('Location')
    if (redirect !== null) expect(redirect.length).toBeLessThan(16_384)
    return response
  }
  const readBrowser = new Browser(checked)
  const manageBrowser = new Browser(checked)
  const returnPath = '/a/private/?q='.padEnd(8192, '!')
  const handoff = await start(readBrowser, read + returnPath)
  const login = location(await manageBrowser.request(handoff, { headers: navigation }))
  expect(login.pathname).toBe('/login')
  const loginPage = await (await manageBrowser.request(login)).text()
  const providerHref = /href="([^"]*\/login\/team\?[^"]+)"/.exec(loginPage)?.[1]
  if (!providerHref) throw new Error('Expected the sign-in provider link')
  expect(providerHref.length).toBeLessThan(16_384)
  const upstream = location(await manageBrowser.request(providerHref))
  const signedIn = await manageBrowser.request(await idp.issue(upstream, 'new-reader'))
  expect(location(signedIn).href).toBe(handoff.href)
  const done = await submit(readBrowser, await issue(manageBrowser, handoff))
  expect(done.status).toBe(303)
  expect(done.headers.get('Location')).toBe(returnPath)
  expect(await (await readBrowser.request(read + returnPath)).text()).toBe('<h1>Private</h1>')
})

it('completes handoffs for a maximal Unicode filename and encoded queries at the return URL limit', async () => {
  const { send, owner, call } = await fixture()
  const filename = `${'界'.repeat(508)}.txt`
  const published = await call('publish', {
    slug: 'long-path',
    mode: 'replace',
    files: [{ path: filename, content: 'Long filename' }],
  })
  if (!published?.url) throw new Error('Expected the published artefact URL')
  const file = new URL(published.url)
  expect(file.pathname).toBe(`/a/long-path/${encodeURIComponent(filename)}`)
  const queryPrefix = '/a/private/?q='
  const nearLimit = queryPrefix.padEnd(8192, '%21')
  for (const [url, expectedPath, expectedBody] of [
    [file.href, file.pathname, 'Long filename'],
    [read + nearLimit, nearLimit, '<h1>Private</h1>'],
    [`${read}${nearLimit}x`, '/a/private/', '<h1>Private</h1>'],
  ]) {
    const browser = new Browser(send)
    const handoff = await start(browser, url)
    expect(handoff.searchParams.get('return')).toBe(base64url.encode(expectedPath))
    const result = await submit(browser, await issue(owner, handoff))
    expect(result.status).toBe(303)
    expect(result.headers.get('Location')).toBe(expectedPath)
    expect(await (await browser.request(read + expectedPath)).text()).toBe(expectedBody)
  }
  const browser = new Browser(send)
  const handoff = await start(browser)
  const callback = await issue(owner, handoff)
  handoff.searchParams.set('return', base64url.encode(`${nearLimit}x`))
  expect((await owner.request(handoff, { headers: navigation })).status).toBe(404)
  callback.fields.set('return', `${nearLimit}x`)
  callback.fields.delete('state')
  const mismatch = await noReadSession(browser, callback, 400)
  expect(await mismatch.text()).not.toContain('Try signing in again')
})

it('redeems only via POST and burns codes on success, bad state, wrong browser or expiry', async () => {
  const { send, owner } = await fixture()
  const reader = new Browser(send)
  const foreign = new Browser(send)
  const handoff = await start(reader)
  await start(foreign)
  const storedPath = '/a/private/internal-draft'
  const storedQuery = 'ticket=internal-reference'
  const wrongBrowser = await issue(owner, await start(reader, `${read}${storedPath}?${storedQuery}`))
  expect(wrongBrowser.fields.get('return')).toBe(`${storedPath}?${storedQuery}`)
  const foreignFields = new URLSearchParams(wrongBrowser.fields)
  foreignFields.set('return', '//outside.example/retry')
  const mismatch = await noReadSession(foreign, { ...wrongBrowser, fields: foreignFields }, 400)
  expect(mismatch.headers.has('Location')).toBe(false)
  const mismatchBody = await mismatch.text()
  expect(mismatchBody).toContain('Sign-in did not complete')
  expect(mismatchBody).not.toContain(storedPath)
  expect(mismatchBody).not.toContain(storedQuery)
  expect(mismatchBody).not.toContain('outside.example')
  await noReadSession(reader, wrongBrowser)

  const wrongState = await issue(owner, handoff)
  const fields = new URLSearchParams(wrongState.fields)
  fields.delete('state')
  await noReadSession(reader, { ...wrongState, fields }, 400)
  await noReadSession(reader, wrongState)

  vi.useFakeTimers({ toFake: ['Date'] })
  const expired = await issue(owner, handoff)
  vi.setSystemTime(Date.now() + 60_000)
  await noReadSession(reader, expired)

  const callback = await issue(owner, handoff)
  const get = await reader.request(`${callback.url}?${callback.fields}`)
  expect(get.status).toBe(404)
  expect(get.headers.getSetCookie()).toEqual([])
  expect(reader.cookie(readCookie)).toBeUndefined()
  expect((await submit(reader, callback)).status).toBe(303)
  const replay = await submit(reader, callback)
  expect(replay.status).toBe(404)
  expect(replay.headers.getSetCookie()).toEqual([])
})

it('bounds streamed handoff and back-channel logout bodies without Content-Length', async () => {
  const send = runtime()
  for (const [path, limit] of [
    [`${read}/_forge/session`, 32 * 1024],
    ['/login/team/backchannel-logout', 16384],
  ] as const) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(limit))
        controller.enqueue(new Uint8Array(1))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(response.headers.getSetCookie()).toEqual([])
  }
})

it('offers a manual retry when two first-time navigations race to set browser state', async () => {
  const { send, owner } = await fixture()
  const browser = new Browser(send)
  const arrivals: URL[] = []
  await Promise.all(
    ['one', 'two'].map(async (tab) => {
      arrivals.push(await start(browser, `${privateUrl}?tab=${tab}`))
    }),
  )
  const [displaced, current] = arrivals
  const [displacedCallback, currentCallback] = await Promise.all([
    issue(owner, displaced),
    issue(owner, current),
  ])
  const retry = await submit(browser, displacedCallback)
  expect(retry.status).toBe(400)
  expect(retry.headers.get('Cache-Control')).toBe('private, no-store')
  expect(retry.headers.has('Location')).toBe(false)
  expect(retry.headers.getSetCookie()).toEqual([])
  const html = await retry.text()
  expect(html).toContain('Sign-in did not complete')
  const href = /<a href="([^"]+)">Try signing in again<\/a>/.exec(html)?.[1]
  expect(href).toBe(displacedCallback.fields.get('return'))
  if (!href) throw new Error('Expected a retry link')
  const nextHandoff = await start(browser, new URL(href, read).href)
  expect((await submit(browser, await issue(owner, nextHandoff))).headers.get('Location')).toBe(href)
  const boundPath = currentCallback.fields.get('return')
  currentCallback.fields.set('return', '/a/public/?tab=unbound')
  const completed = await submit(browser, currentCallback)
  expect(completed.status).toBe(303)
  expect(completed.headers.get('Location')).toBe(boundPath)
})

it('starts anonymous HTML navigation without Fetch Metadata but not image requests', async () => {
  const { send } = await fixture()
  const accept = { Accept: 'text/html' }
  const page = await send(privateUrl, { headers: accept })
  expect(page.status).toBe(302)
  expect(location(page).pathname).toBe('/auth/handoff')
  const image = await send(privateUrl, { headers: { ...accept, 'Sec-Fetch-Dest': 'image' } })
  expect(image.status).toBe(401)
  expect(image.headers.getSetCookie()).toEqual([])
})

it('finishes concurrent tabs without letting a private subresource rotate browser state', async () => {
  const { send, owner } = await fixture()
  const browser = new Browser(send)
  const first = await start(browser, `${privateUrl}?tab=one`)
  const initialBrowserState = browser.cookie(stateCookie)
  const subresource = await browser.request(privateUrl, { headers: { 'Sec-Fetch-Dest': 'image' } })
  expect(subresource.status).toBe(401)
  expect(subresource.headers.get('Cache-Control')).toBe('private, no-store')
  expect(subresource.headers.getSetCookie()).toEqual([])
  expect(await subresource.text()).toBe('')
  const second = await start(browser, `${privateUrl}?tab=two`)
  expect(browser.cookie(stateCookie)).toBe(initialBrowserState)
  const [one, two] = await Promise.all([issue(owner, first), issue(owner, second)])
  expect(one.fields.get('state')).not.toBe(two.fields.get('state'))
  expect((await submit(browser, two)).headers.get('Location')).toBe('/a/private/?tab=two')
  expect((await submit(browser, one)).headers.get('Location')).toBe('/a/private/?tab=one')
  expect(browser.cookie(stateCookie)).toBe(initialBrowserState)
  expect(await (await browser.request(privateUrl)).text()).toBe('<h1>Private</h1>')
})

it('rejects changes to each signed read cookie field', async () => {
  const { send, idp, owner } = await fixture()
  const ownerRead = new Browser(send)
  const viewerRead = new Browser(send)
  await acquire(ownerRead, owner)
  await acquire(viewerRead, await idp.signedIn(send, 'other-reader'))
  const [id, exp, mac] = (ownerRead.cookie(readCookie) ?? '').split('.')
  const [otherId, , otherMac] = (viewerRead.cookie(readCookie) ?? '').split('.')
  expect(otherId).not.toBe(id)
  for (const tampered of [
    `${otherId}.${exp}.${mac}`,
    `${id}.${Number(exp) + 1}.${mac}`,
    `${id}.${exp}.${otherMac}`,
  ]) {
    const headers = { ...navigation, Cookie: `${readCookie}=${tampered}` }
    expect(location(await send(privateUrl, { headers })).pathname).toBe('/auth/handoff')
  }
  expect(await (await ownerRead.request(privateUrl)).text()).toBe('<h1>Private</h1>')
})

it('ends read access after logout or identity revocation', async () => {
  const { send, idp, owner } = await fixture()
  const ownerRead = new Browser(send)
  await acquire(ownerRead, owner)
  expect(await (await ownerRead.request(privateUrl)).text()).toBe('<h1>Private</h1>')
  expect((await owner.post('/logout', {})).status).toBe(303)
  await start(ownerRead)

  const viewer = await idp.signedIn(send, 'revoked-reader')
  const viewerRead = new Browser(send)
  await acquire(viewerRead, viewer)
  expect(await (await viewerRead.request(privateUrl)).text()).toBe('<h1>Private</h1>')
  expect((await idp.backchannel(send, 'read-revocation', { sub: 'revoked-reader' })).status).toBe(200)
  await start(viewerRead)
})

it('fails stale subresources closed and reuses silent OIDC revalidation for private navigation', async () => {
  const { send, idp, owner } = await fixture()
  const reader = new Browser(send)
  await acquire(reader, owner)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 10 * 60_000)
  const stale = await reader.request(privateUrl, { headers: { 'Sec-Fetch-Mode': 'no-cors' } })
  expect(stale.status).toBe(401)
  expect(stale.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await stale.text()).toBe('')
  const handoff = location(await reader.request(privateUrl, { headers: navigation }))
  const authorization = location(await owner.request(handoff, { headers: navigation }))
  expect(authorization.searchParams.get('prompt')).toBe('none')
  expect(location(await owner.request(await idp.issue(authorization, admin))).href).toBe(handoff.href)
  expect((await submit(reader, await issue(owner, handoff))).headers.get('Location')).toBe('/a/private/')
  expect(await (await reader.request(privateUrl)).text()).toBe('<h1>Private</h1>')

  vi.setSystemTime(Date.now() + 10 * 60_000 - 1_000)
  const lateReader = new Browser(send)
  const callback = await issue(owner, await start(lateReader))
  vi.setSystemTime(Date.now() + 1_000)
  await noReadSession(lateReader, callback)
})

it('accepts only read artefact return paths and preserves manage origin checks', async () => {
  const { send, owner } = await fixture(runtime({ MCP_ALLOWED_ORIGINS: read }))
  const browser = new Browser(send)
  const handoff = await start(browser)
  for (const path of [
    'https://elsewhere.example/a/private/',
    '//elsewhere.example/x',
    '/a/../admin/members',
    '/a/private/%2F%2Felsewhere',
    '/a/private//other',
    '/a/private/#fragment',
  ]) {
    const invalid = new URL(handoff)
    invalid.searchParams.set('return', base64url.encode(path))
    expect((await owner.request(invalid, { headers: navigation })).status).toBe(404)
  }
  for (const path of ['/authorize', '/logout', members, '/admin/bots', '/mcp', '/register', '/token']) {
    expect((await owner.post(path, {}, read)).status).toBe(403)
  }
  const subresource = await owner.request(handoff, {
    headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
  })
  expect(subresource.status).toBe(404)
  expect(await (await owner.request('/artefacts')).text()).toContain('class="forge-account__name">owner')
})

it('sends the specified security and conditional cache headers only after access checks', async () => {
  const { send, call, owner } = await fixture()
  const url = `${publicUrl}file.txt`
  const tag = '"84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882.74df46b3"'
  const publicFile = await send(url)
  expect(publicFile.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
  expect(publicFile.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(publicFile.headers.get('Referrer-Policy')).toBe('same-origin')
  expect(publicFile.headers.get('X-Robots-Tag')).toBe('noindex')
  expect(publicFile.headers.get('Cache-Control')).toBe('no-cache')
  expect(publicFile.headers.get('ETag')).toBe(tag)
  const conditional = { headers: { 'If-None-Match': `"not-this", W/${tag}` } }
  const cached = await send(url, conditional)
  expect(cached.status).toBe(304)
  expect(cached.headers.get('ETag')).toBe(tag)
  expect(cached.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
  expect(cached.headers.get('Cache-Control')).toBe('no-cache')
  expect(await cached.text()).toBe('')

  const indexable = runtime({ ALLOW_INDEXING: 'true', PUBLIC_INDEX: 'true' })
  expect((await indexable(url)).headers.has('X-Robots-Tag')).toBe(false)
  expect((await indexable(read)).headers.get('X-Robots-Tag')).toBe('noindex')
  const browser = new Browser(indexable)
  await acquire(browser, owner)
  await call('set_visibility', { slug: 'public', visibility: 'private' })
  const anonymous = await send(url, { headers: { ...navigation, ...conditional.headers } })
  expect(location(anonymous).pathname).toBe('/auth/handoff')
  const privateFile = await browser.request(url, conditional)
  expect(privateFile.status).toBe(200)
  expect(await privateFile.text()).toBe('0123456789')
  expect(privateFile.headers.get('Cache-Control')).toBe('private, no-store')
  expect(privateFile.headers.get('X-Robots-Tag')).toBe('noindex')
  expect(privateFile.headers.has('ETag')).toBe(false)
})

it('serves 200 with the new content type when an unchanged blob resolves through a different file', async () => {
  const { send, call } = await fixture()
  const url = `${publicUrl}section`
  const tag = (await send(url)).headers.get('ETag')
  if (!tag) throw new Error('Expected a strong ETag')
  await call('publish', {
    slug: 'public',
    mode: 'merge',
    files: [{ path: 'section/index.html', content: 'exact' }],
    delete: ['section'],
  })
  const redirect = await send(url, { headers: { 'If-None-Match': tag } })
  expect(redirect.status).toBe(301)
  expect(redirect.headers.get('Location')).toBe('/a/public/section/')
  const response = await send(`${url}/`, { headers: { 'If-None-Match': tag } })
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('Cache-Control')).toBe('no-cache')
  expect(response.headers.get('ETag')).not.toBe(tag)
  expect(await response.text()).toBe('exact')
})

it('serves single R2 byte ranges and returns 416 for unsatisfiable ranges', async () => {
  const { send } = await fixture()
  const url = `${publicUrl}file.txt`
  for (const [range, contentRange, body] of [
    ['bytes=2-5', 'bytes 2-5/10', '2345'],
    ['bytes=8-', 'bytes 8-9/10', '89'],
    ['bytes=-3', 'bytes 7-9/10', '789'],
    ['bytes=8-99', 'bytes 8-9/10', '89'],
  ]) {
    const response = await send(url, { headers: { Range: range } })
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(contentRange)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await response.text()).toBe(body)
  }
  const invalid = await send(url, { headers: { Range: 'bytes=8-2' } })
  expect(invalid.status).toBe(200)
  expect(invalid.headers.has('Content-Range')).toBe(false)
  expect(await invalid.text()).toBe('0123456789')
  const unsatisfiable = await send(url, { headers: { Range: 'bytes=10-20' } })
  expect(unsatisfiable.status).toBe(416)
  expect(unsatisfiable.headers.get('Content-Range')).toBe('bytes */10')
  const empty = await send(`${publicUrl}empty.txt`, { headers: { Range: 'bytes=-1' } })
  expect(empty.status).toBe(416)
  expect(empty.headers.get('Content-Range')).toBe('bytes */0')
})
