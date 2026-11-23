import { expect, it, vi } from 'vitest'
import {
  admin,
  Browser,
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
  const id = await listedId(owner, members, name)
  const tokenResponse = await owner.post('/admin/bots', { action: 'token', id, name: 'Read tests' })
  const token = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await tokenResponse.text())?.[1]
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
      result: { isError?: boolean; structuredContent?: { url?: string } }
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
  const response = await readBrowser.request(url)
  expect(response.status).toBe(302)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.getSetCookie()[0]).toMatch(
    /^__Host-forge-state=.+; Path=\/; Max-Age=300; Secure; HttpOnly; SameSite=Lax$/,
  )
  const handoff = location(response)
  expect(handoff.origin + handoff.pathname).toBe(`${manage}/auth/handoff`)
  return handoff
}

async function issue(manageBrowser: Browser, handoff: URL) {
  const response = await manageBrowser.request(handoff, { headers: navigation })
  expect(response.status).toBe(302)
  const callback = location(response)
  expect(callback.origin + callback.pathname).toBe(`${read}/_forge/session`)
  expect(callback.searchParams.get('code')).toBeTruthy()
  return callback
}

async function acquire(readBrowser: Browser, manageBrowser: Browser) {
  const callback = await issue(manageBrowser, await start(readBrowser))
  const result = await readBrowser.request(callback)
  expect(result.status).toBe(302)
  expect(result.headers.get('Location')).toBe('/a/private/')
  expect(result.headers.getSetCookie()).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^__Host-forge=.+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/),
      expect.stringMatching(/^__Host-forge-state=; Path=\/; Max-Age=0;/),
    ]),
  )
  expect(readBrowser.cookie(readCookie)).toBeTruthy()
  return callback
}

async function noReadSession(browser: Browser, callback: URL) {
  const result = await browser.request(callback)
  expect(result.status).toBe(302)
  expect(result.headers.get('Location')).toBe('/_forge/session')
  expect(result.headers.getSetCookie()).toEqual([])
  expect(browser.cookie(readCookie)).toBeUndefined()
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
  expect(await (await send(`${publicUrl}section`)).text()).toBe('directory')
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
  const paths = [
    `${read}/a/unknown/`,
    `${publicUrl}missing`,
    `${privateUrl}missing`,
    `${publicUrl}%2Fhidden`,
    `${read}/auth/handoff`,
  ]
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
  expect(landing).toContain('Gate 0 Test Forge')
  expect(landing).not.toContain('Public report')
  const index = await (await runtime({ PUBLIC_INDEX: 'true' })(read)).text()
  expect(index).toContain(`href="${publicUrl}">Public report`)
  expect(index).toContain(`href="${read}/a/no-index/docs/start%20here.html">Alternate entry`)
  expect(index).not.toContain('Private report')
})

it('distinguishes anonymous, pending, viewer, publisher and removed canonical readers', async () => {
  const { send, idp, owner } = await fixture(
    runtime({ AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]) }),
  )
  const anonymous = new Browser(send)
  await start(anonymous)
  const pendingManage = await idp.signedIn(send, 'pending-reader')
  const pendingRead = new Browser(send)
  await acquire(pendingRead, pendingManage)
  const pending = await pendingRead.request(privateUrl)
  expect(pending.status).toBe(200)
  expect(await pending.text()).toContain('Pending access')

  for (const role of ['viewer', 'publisher']) {
    const identity = `${role}-reader`
    const manageBrowser = await idp.signedIn(send, identity)
    const id = await listedId(owner, members, `${identity}@example.test`)
    expect((await owner.post(members, { action: 'admit', id, role })).status).toBe(303)
    const readBrowser = new Browser(send)
    await acquire(readBrowser, manageBrowser)
    expect(await (await readBrowser.request(privateUrl)).text()).toBe('<h1>Private</h1>')
    expect(await (await readBrowser.request(publicUrl)).text()).toBe('<h1>Public</h1>')
    expect((await owner.post(members, { action: 'remove', id })).status).toBe(303)
    await start(readBrowser)
    expect(await (await readBrowser.request(publicUrl)).text()).toBe('<h1>Public</h1>')
  }
  for (const browser of [anonymous, pendingRead]) {
    expect(await (await browser.request(publicUrl)).text()).toBe('<h1>Public</h1>')
  }
})

it('signs in on manage and resumes the handoff to the original read path and query', async () => {
  const { send, idp } = await fixture()
  const readBrowser = new Browser(send)
  const manageBrowser = new Browser(send)
  const handoff = await start(readBrowser, `${privateUrl}?tab=summary`)
  const login = location(await manageBrowser.request(handoff, { headers: navigation }))
  expect(login.pathname).toBe('/login')
  const loginPage = await (await manageBrowser.request(login)).text()
  const providerHref = /href="([^"]*\/login\/team\?[^"]+)"/.exec(loginPage)?.[1]
  if (!providerHref) throw new Error('Expected the sign-in provider link')
  const upstream = location(await manageBrowser.request(providerHref))
  const signedIn = await manageBrowser.request(await idp.issue(upstream, 'new-reader'))
  expect(location(signedIn).href).toBe(handoff.href)
  const done = await readBrowser.request(await issue(manageBrowser, handoff))
  expect(done.headers.get('Location')).toBe('/a/private/?tab=summary')
  expect(await (await readBrowser.request(`${privateUrl}?tab=summary`)).text()).toBe('<h1>Private</h1>')
})

it('does not redeem codes from another browser, another state, twice, or after expiry', async () => {
  const { send, owner } = await fixture()
  const reader = new Browser(send)
  const foreignBrowser = new Browser(send)
  const handoff = await start(reader)
  const callback = await issue(owner, handoff)
  await noReadSession(foreignBrowser, callback)
  const foreignHandoff = await start(foreignBrowser)
  await noReadSession(foreignBrowser, callback)
  const mismatched = new URL(callback)
  mismatched.searchParams.set('state', foreignHandoff.searchParams.get('state') ?? '')
  await noReadSession(foreignBrowser, mismatched)
  const verifier = reader.cookie(stateCookie)
  expect(verifier).toBeTruthy()
  expect((await reader.request(callback)).headers.get('Location')).toBe('/a/private/')
  const replay = await send(callback, { headers: { Cookie: `${stateCookie}=${verifier}` } })
  expect(replay.headers.get('Location')).toBe('/_forge/session')
  expect(replay.headers.getSetCookie()).toEqual([])

  vi.useFakeTimers({ toFake: ['Date'] })
  const expired = await issue(owner, await start(foreignBrowser))
  vi.setSystemTime(Date.now() + 60_000)
  await noReadSession(foreignBrowser, expired)
})

it('refuses tampered cookies and ends read access after logout or identity revocation', async () => {
  const { send, idp, owner } = await fixture()
  const ownerRead = new Browser(send)
  await acquire(ownerRead, owner)
  const value = ownerRead.cookie(readCookie) ?? ''
  const macStart = value.lastIndexOf('.') + 1
  const tampered = `${value.slice(0, macStart)}${value[macStart] === 'A' ? 'B' : 'A'}${value.slice(macStart + 1)}`
  const refused = await send(privateUrl, { headers: { Cookie: `${readCookie}=${tampered}` } })
  expect(location(refused).pathname).toBe('/auth/handoff')
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
  expect((await reader.request(await issue(owner, handoff))).headers.get('Location')).toBe('/a/private/')
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
    invalid.searchParams.set('return', path)
    expect((await owner.request(invalid, { headers: navigation })).status).toBe(404)
  }
  for (const path of ['/authorize', '/logout', members, '/admin/bots', '/mcp', '/register', '/token']) {
    expect((await owner.post(path, {}, read)).status).toBe(403)
  }
  const subresource = await owner.request(handoff, {
    headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
  })
  expect(subresource.status).toBe(404)
  expect(await (await owner.request('/')).text()).toContain('owner (admin)')
})

it('sends the specified security and conditional cache headers only after access checks', async () => {
  const { send, call, owner } = await fixture()
  const url = `${publicUrl}file.txt`
  const tag = '"84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882"'
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
  expect(await cached.text()).toBe('')

  const indexable = runtime({ ALLOW_INDEXING: 'true', PUBLIC_INDEX: 'true' })
  expect((await indexable(url)).headers.has('X-Robots-Tag')).toBe(false)
  expect((await indexable(read)).headers.get('X-Robots-Tag')).toBe('noindex')
  const browser = new Browser(indexable)
  await acquire(browser, owner)
  await call('set_visibility', { slug: 'public', visibility: 'private' })
  expect(location(await send(url, conditional)).pathname).toBe('/auth/handoff')
  const privateFile = await browser.request(url, conditional)
  expect(privateFile.status).toBe(200)
  expect(await privateFile.text()).toBe('0123456789')
  expect(privateFile.headers.get('Cache-Control')).toBe('private, no-store')
  expect(privateFile.headers.get('X-Robots-Tag')).toBe('noindex')
  expect(privateFile.headers.has('ETag')).toBe(false)
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
  const unsatisfiable = await send(url, { headers: { Range: 'bytes=10-20' } })
  expect(unsatisfiable.status).toBe(416)
  expect(unsatisfiable.headers.get('Content-Range')).toBe('bytes */10')
  const empty = await send(`${publicUrl}empty.txt`, { headers: { Range: 'bytes=-1' } })
  expect(empty.status).toBe(416)
  expect(empty.headers.get('Content-Range')).toBe('bytes */0')
})
