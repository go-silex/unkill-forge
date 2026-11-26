import { expect, it, vi } from 'vitest'
import {
  admin,
  Browser,
  configuredEnv,
  formValue,
  type Handle,
  location,
  manage,
  provider,
  read,
  runtime,
  sessionCookie,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const requestData = 'private-request-value'
const clientId = 'https://client.example.test/client.json'
const redirectUri = 'https://client.example.test/callback'
const clientName = '<strong>Test application</strong>'

async function errorCard(response: Response, status: number, referrer = 'same-origin') {
  expect(response.status).toBe(status)
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe(referrer)
  expect(response.headers.get('Content-Security-Policy')).toMatch(
    /^default-src 'none'; style-src 'self'; img-src 'self'; script-src 'sha256-[^']+' 'sha256-[^']+'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'$/,
  )
  const body = await response.text()
  expect(body).toContain('forge-panel--error')
  expect(body).not.toContain(requestData)
  return body
}

it('offers providers in configuration order with one primary sign-in button', async () => {
  const send = runtime({
    AUTH_PROVIDERS: JSON.stringify([provider, { ...provider, id: 'backup', label: 'Backup identity' }]),
    AUTH_BACKUP_CLIENT_SECRET: crypto.randomUUID(),
  })
  const response = await send('/login')
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Content-Security-Policy')).toContain("font-src 'self'")
  const html = await response.text()
  expect(html).toContain('forge-panel--sign-in')
  expect(html.match(/<a class="forge-button[^"]*" href="\/login\/[^>]+>/g)).toEqual([
    '<a class="forge-button forge-button--primary" href="/login/team?return=%2F">',
    '<a class="forge-button" href="/login/backup?return=%2F">',
  ])
})

it('does not reflect a failed login callback, unknown path or malformed form', async () => {
  const send = runtime()
  const loginError = await errorCard(
    await send(`/login/team/callback?state=${requestData}&error_description=${requestData}`),
    400,
    'no-referrer',
  )
  expect(loginError).toContain('href="/login"')
  expect(loginError).toContain('href="/">Back to home')
  await errorCard(await send(`/${requestData}?value=${requestData}`), 404)
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const formError = await errorCard(await owner.post('/admin/members', { action: requestData }), 400)
  expect(formError).toContain('href="/artefacts"')
  const viewer = await idp.signedIn(send, 'viewer')
  await errorCard(await viewer.request(`/admin/members?value=${requestData}`), 403)
  const unavailable = runtime({
    DB: new Proxy(configuredEnv().DB, {
      get(db, key) {
        if (key === 'prepare')
          return () => {
            throw new Error(requestData)
          }
        return Reflect.get(db, key, db)
      },
    }),
  })
  await errorCard(await unavailable('/artefacts', { headers: { Cookie: owner.cookieHeader() } }), 503)
})

it('keeps protocol and machine misses plain and serves the browser HEAD without a body', async () => {
  const send = runtime()
  const browser = await send('/missing')
  const browserHeaders = Object.fromEntries(browser.headers)
  for (const path of ['/missing', '/missing/', '/oauthx']) {
    const get = path === '/missing' ? browser : await send(path)
    expect(Object.fromEntries(get.headers)).toEqual(browserHeaders)
    await errorCard(get, 404)
    const head = await send(path, { method: 'HEAD' })
    expect(head.status).toBe(404)
    expect(Object.fromEntries(head.headers)).toEqual(browserHeaders)
    expect(await head.text()).toBe('')
  }

  const { 'content-language': _language, ...plainHeaders } = browserHeaders
  const machineHeaders = { ...plainHeaders, 'content-type': 'text/plain; charset=UTF-8' }
  for (const [path, methods] of [
    ['/_forge/session', ['GET', 'HEAD']],
    ['/oauth/clients/local.json', ['OPTIONS', 'HEAD']],
    ['/OAuth/x', ['GET', 'HEAD']],
    ['/oauth%2Ftoken', ['GET', 'HEAD']],
    ['/oauth%252Ftoken', ['GET', 'HEAD']],
    ['/oauth%5Ctoken', ['GET', 'HEAD']],
    ['/mcp/', ['GET', 'HEAD']],
    ['/mcp%00', ['GET', 'HEAD']],
    ['/x%2F%2e%2e%2Foauth/token', ['GET', 'HEAD']],
    ['//oauth/token', ['GET', 'HEAD']],
    ['/LOGIN/team/backchannel-logout', ['GET', 'HEAD']],
    ['/bad%zz', ['GET', 'HEAD']],
    ['/not%20found', ['GET', 'HEAD']],
    ['/introuvée', ['GET', 'HEAD']],
    [`/${'x'.repeat(600)}`, ['GET', 'HEAD']],
  ] as const) {
    for (const method of methods) {
      const response = await send(`${manage}${path}`, { method })
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(Object.fromEntries(response.headers), `${method} ${path}`).toEqual(machineHeaders)
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Not found')
    }
  }

  const loginHeaders = {
    ...plainHeaders,
    'content-type': 'text/plain;charset=UTF-8',
    'referrer-policy': 'no-referrer',
  }
  for (const path of [
    '/login/team/backchannel-logout',
    '/login/team/backchannel-logout/',
    '/login/TEAM/BACKCHANNEL-LOGOUT',
    '/login/team%2Fbackchannel-logout',
    '/login/team%252Fbackchannel-logout',
    '/login//team//backchannel-logout',
    '/login/%zz',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await send(path, { method })
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(Object.fromEntries(response.headers), `${method} ${path}`).toEqual(loginHeaders)
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Not found')
    }
  }
  await errorCard(await send('/login/team/backchannel-logoutx'), 404, 'no-referrer')
})

it('renders login and consent storage outages but leaves the logout failure plain', async () => {
  const send = runtime()
  const idp = mockProvider()
  const guest = new Browser(send)
  const callback = await idp.issue(await idp.begin(guest), 'example-user')
  const owner = await idp.signedIn(send, admin)
  const localClientId = `${manage}/oauth/clients/local.json`
  const providerFetch = fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    input === localClientId ? send(localClientId) : providerFetch(input, init),
  )
  const localPath = new URL(authPath(localClientId), manage)
  localPath.searchParams.set('redirect_uri', 'http://127.0.0.1:7777/callback')
  const consentPage = await owner.request(localPath)
  expect(consentPage.status).toBe(200)
  const consent = formValue(await consentPage.text(), 'consent')
  let fault = /INSERT INTO login_flows/
  const unavailable = runtime({
    DB: new Proxy(configuredEnv().DB, {
      get(db, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (fault.test(sql)) throw new Error(requestData)
            return db.prepare(sql)
          }
        return Reflect.get(db, key, db)
      },
    }),
  })
  const start = await unavailable('/login/team')
  const { 'content-language': _language, ...referenceHeaders } = Object.fromEntries(start.headers)
  await errorCard(start, 503)
  fault = /DELETE FROM login_flows WHERE state_hash/
  await errorCard(await unavailable(callback, { headers: { Cookie: guest.cookieHeader() } }), 503)

  const headers = { Cookie: owner.cookieHeader(), Origin: manage }
  fault = /INSERT INTO oauth_consents/
  await errorCard(await unavailable(localPath, { headers }), 503)
  fault = /DELETE FROM oauth_consents WHERE token_hash/
  await errorCard(
    await unavailable('/authorize', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ consent, decision: 'deny' }),
    }),
    503,
  )

  fault = /sessions/
  const logout = await unavailable('/logout', { method: 'POST', headers })
  expect(logout.status).toBe(503)
  expect(Object.fromEntries(logout.headers)).toEqual({
    ...referenceHeaders,
    'content-type': 'text/plain;charset=UTF-8',
  })
  expect(await logout.text()).toBe('Forge is unavailable')
})

it('keeps HEAD body-less and leaves machine logout and consent method errors plain', async () => {
  const send = runtime()
  for (const path of ['/missing', `${read}/missing`, '/login/team/callback']) {
    const response = await send(path, { method: 'HEAD' })
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
  }
  const head = await send('/authorize', { method: 'HEAD' })
  expect(head.status).toBe(405)
  expect(head.headers.get('Allow')).toBe('GET, POST')
  expect(await head.text()).toBe('')
  const wrongMethod = await send('/authorize', { method: 'PUT' })
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('Allow')).toBe('GET, POST')
  expect(wrongMethod.headers.get('Content-Type')).toMatch(/^text\/plain/)
  expect(await wrongMethod.text()).toBe('Method not allowed')
  const backchannel = await send('/login/team/backchannel-logout', {
    method: 'POST',
    body: new URLSearchParams({ logout_token: 'a'.repeat(17 * 1024) }),
  })
  expect(backchannel.status).toBe(413)
  expect(backchannel.headers.get('Content-Type')).toMatch(/^text\/plain/)
  expect(await backchannel.text()).toBe('Logout request body exceeds 16 KiB')
})

it('shows the same pending account and local sign-out form at home and consent', async () => {
  const send = runtime({ AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]) })
  const viewer = await mockProvider().signedIn(send, 'awaiting-approval')
  const home = await viewer.request('/')
  const authorize = await viewer.request(`/authorize?state=${requestData}`)
  expect(home.status).toBe(200)
  expect(authorize.status).toBe(403)
  expect(authorize.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  expect(authorize.headers.get('Cache-Control')).toBe('no-store')
  expect(authorize.headers.get('Referrer-Policy')).toBe('same-origin')
  const html = await home.text()
  expect(html).toContain('forge-panel--pending')
  expect(html).toContain('awaiting-approval@example.test')
  const form = html.match(/<form class="forge-action" action="([^"]+)" method="(post)">([\s\S]*?)<\/form>/)
  expect(form?.[1]).toBe('/logout')
  expect(form?.[3]).not.toContain('<input')
  expect(await authorize.text()).toBe(html)
  const signedOut = await viewer.request(form?.[1] ?? '', {
    method: form?.[2].toUpperCase(),
    headers: { Origin: manage },
  })
  expect(signedOut.status).toBe(303)
  expect(location(signedOut).pathname).toBe('/login')
  expect(viewer.cookie(sessionCookie)).toBeUndefined()
  expect(location(await viewer.request('/')).pathname).toBe('/login')
})

function authPath(id = clientId, state = requestData) {
  return `/authorize?${new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    resource: `${manage}/mcp`,
    scope: 'mcp',
  })}`
}

it('renders verified consent facts, escapes the client name and retains the bound Deny form', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const otherSession = await idp.signedIn(send, admin)
  const providerFetch = fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    input === clientId
      ? Promise.resolve(
          Response.json({ client_id: clientId, client_name: clientName, redirect_uris: [redirectUri] }),
        )
      : providerFetch(input, init),
  )
  const state = requestData.padEnd(5_000, 'x')
  const path = authPath(clientId, state)
  expect(path.length).toBeGreaterThan(4096)
  const response = await owner.request(path)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('same-origin')
  expect(response.headers.get('Content-Security-Policy')).toContain(
    "form-action 'self' https://client.example.test",
  )
  const html = await response.text()
  expect(html).toContain('forge-facts')
  expect(html).toContain('forge-badge--ok')
  expect(html).toContain('<code>client.example.test</code>')
  expect(html).toContain(`${admin} (admin)`)
  expect(html).toContain('&lt;strong&gt;Test application&lt;/strong&gt;')
  expect(html).not.toContain(clientName)
  expect(html).not.toContain(requestData)
  const switchForm = html.match(/<form class="forge-language-switch"[^>]*>.*?<\/form>/s)?.[0] ?? ''
  const switchToken = formValue(switchForm, 'consent')
  expect(switchToken).toBe(formValue(html, 'consent'))
  expect(switchToken).toMatch(/^[\w-]{43}$/)
  const body = new URLSearchParams({ language: 'fr', consent: switchToken })
  const headers = { Origin: manage, Referer: `${manage}/` }
  const wrongSession = await otherSession.request('/_forge/language', { method: 'POST', headers, body })
  expect(wrongSession.status).toBe(400)
  expect(wrongSession.headers.has('Set-Cookie')).toBe(false)
  const changed = await owner.request('/_forge/language', { method: 'POST', headers, body })
  expect(changed.status).toBe(303)
  expect(changed.headers.get('Location')).toBe(path)
  const resumed = await owner.request(location(changed))
  expect(resumed.headers.get('Content-Language')).toBe('fr')
  const french = await resumed.text()
  expect(french).toContain('<html lang="fr">')
  expect(french).not.toContain(state)
  expect(html).toMatch(
    /method="post" action="\/authorize".*name="decision" value="deny".*name="decision" value="approve"/s,
  )
  const consent = formValue(french, 'consent')
  expect(consent).not.toBe(switchToken)
  await errorCard(await owner.post('/authorize', { consent: switchToken, decision: 'deny' }), 400)
  await errorCard(await owner.post('/authorize', { consent, decision: requestData }), 400)
  const denied = await owner.post('/authorize', { consent, decision: 'deny', state: 'ignored' })
  expect(denied.status).toBe(303)
  expect(location(denied)).toMatchObject({ origin: 'https://client.example.test', pathname: '/callback' })
  expect(location(denied).searchParams.get('state')).toBe(state)
  expect(location(denied).searchParams.get('error')).toBe('access_denied')
  await errorCard(await owner.post('/authorize', { consent, decision: 'deny' }), 400)
})

it('keeps malformed, unresolvable and unavailable authorization requests distinct', async () => {
  const send = runtime({ ALLOW_DCR: 'true' })
  const owner = await mockProvider().signedIn(send, admin)
  await errorCard(await owner.request(`/authorize?state=${requestData}`), 400)
  await errorCard(await owner.request(authPath(requestData)), 400)
  const providerFetch = fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    input === clientId
      ? Promise.resolve(new Response(requestData, { status: 503 }))
      : providerFetch(input, init),
  )
  await errorCard(await owner.request(authPath()), 503)
  // Simulate failure to resolve the client when the stored authorization is parsed again on POST.
  for (const [id, status] of [
    [requestData, 400],
    [clientId, 503],
  ] as const) {
    const consent = await registeredConsent(send, owner)
    await configuredEnv()
      .DB.prepare('UPDATE oauth_consents SET request_url = ?')
      .bind(new URL(authPath(id), manage).href)
      .run()
    await errorCard(await owner.post('/authorize', { consent, decision: 'approve' }), status)
  }
  const unsupported = await owner.request('/authorize', {
    method: 'POST',
    headers: { Origin: manage },
    body: requestData,
  })
  await errorCard(unsupported, 400)
})

async function registeredConsent(send: Handle, owner: Browser) {
  const registered = await send('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  })
  expect(registered.status).toBe(201)
  const { client_id } = await registered.json<{ client_id: string }>()
  const response = await owner.request(authPath(client_id))
  expect(response.status).toBe(200)
  return formValue(await response.text(), 'consent')
}

it('requires a fresh login if the session is revoked while consuming approval', async () => {
  const send = runtime({ ALLOW_DCR: 'true' })
  const owner = await mockProvider().signedIn(send, admin)
  const consent = await registeredConsent(send, owner)
  // Interleave revocation after the first session lookup, at the real consent-consumption seam.
  const db = configuredEnv().DB
  await db
    .prepare(`
    CREATE TRIGGER revoke_after_consent AFTER DELETE ON oauth_consents
    BEGIN UPDATE sessions SET revoked_at = unixepoch('subsec') * 1000 WHERE id_hash = OLD.session_hash; END
  `)
    .run()
  try {
    const body = await errorCard(await owner.post('/authorize', { consent, decision: 'approve' }), 401)
    expect(body).toContain('href="/login"')
  } finally {
    await db.prepare('DROP TRIGGER revoke_after_consent').run()
  }
})
