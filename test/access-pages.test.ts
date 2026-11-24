import { expect, it, vi } from 'vitest'
import {
  admin,
  type Browser,
  configuredEnv,
  formValue,
  type Handle,
  location,
  manage,
  provider,
  read,
  runtime,
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
    /^default-src 'none'; style-src 'self'; img-src 'self'; script-src 'sha256-[^']+'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'$/,
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
  expect(html).toMatch(/action="\/logout" method="post"/)
  expect(await authorize.text()).toBe(html)
})

function authPath(id = clientId) {
  return `/authorize?${new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: requestData,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    resource: `${manage}/mcp`,
    scope: 'mcp',
  })}`
}

it('renders verified consent facts, escapes the client name and retains the bound Deny form', async () => {
  const owner = await mockProvider().signedIn(runtime(), admin)
  const providerFetch = fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    input === clientId
      ? Promise.resolve(
          Response.json({ client_id: clientId, client_name: clientName, redirect_uris: [redirectUri] }),
        )
      : providerFetch(input, init),
  )
  const response = await owner.request(authPath())
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
  expect(html).toMatch(
    /method="post" action="\/authorize".*name="decision" value="deny".*name="decision" value="approve"/s,
  )
  const consent = formValue(html, 'consent')
  expect(consent).toMatch(/^[\w-]{43}$/)
  await errorCard(await owner.post('/authorize', { consent, decision: requestData }), 400)
  const denied = await owner.post('/authorize', { consent, decision: 'deny', state: 'ignored' })
  expect(denied.status).toBe(303)
  expect(location(denied)).toMatchObject({ origin: 'https://client.example.test', pathname: '/callback' })
  expect(location(denied).searchParams.get('state')).toBe(requestData)
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
