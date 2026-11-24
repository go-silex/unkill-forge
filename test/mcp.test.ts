import { env } from 'cloudflare:test'
import { base64url } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import {
  admin,
  Browser,
  flashNavigation,
  formValue,
  type Handle,
  jsonHeaders,
  listedId,
  location,
  manage,
  mcpCall,
  read,
  runtime,
  sessionCookie,
  setupStorage,
  whoami,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const resource = `${manage}/mcp`
const redirectUri = 'https://client.example/callback'
const registerBody = {
  client_name: 'Gate 0 Test Client',
  token_endpoint_auth_method: 'none',
  redirect_uris: [redirectUri],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
}
const register = (send: Handle) =>
  send('/register', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(registerBody),
  })

// The test Worker declares these bindings in wrangler.jsonc.
const bindings = env as typeof env & { DB: D1Database; OAUTH_KV: KVNamespace }

function withKvPut(
  intercept: (key: string, write: () => Promise<void>) => Promise<void>,
  faults: { delete?: KVNamespace['delete']; db?: D1Database } = {},
) {
  const kv = bindings.OAUTH_KV
  return runtime({
    ALLOW_DCR: String(true),
    DB: faults.db ?? bindings.DB,
    OAUTH_KV: {
      get: kv.get.bind(kv),
      list: kv.list.bind(kv),
      delete: faults.delete ?? kv.delete.bind(kv),
      put: (key, value, options) => intercept(key, () => kv.put(key, value, options)),
    } as KVNamespace,
  })
}

async function token(send: Handle, params: Record<string, string>, origin?: string) {
  return send('/token', {
    method: 'POST',
    headers: origin ? { Origin: origin } : undefined,
    body: new URLSearchParams(params),
  })
}

async function tokens(response: Response) {
  expect(response.status).toBe(200)
  const body = await response.json<{
    access_token: string
    refresh_token: string
    expires_in: number
    token_type: string
  }>()
  expect(body).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
    expires_in: 3600,
  })
  expect(body.access_token).toBeTruthy()
  expect(body.refresh_token).toBeTruthy()
  expect(body.token_type.toLowerCase()).toBe('bearer')
  return body
}

async function authorize(
  send: Handle,
  b: Browser,
  verifyExplicitApproval: boolean,
  clientId?: string,
  callback = redirectUri,
) {
  if (!clientId) {
    const registered = await register(send)
    expect(registered.status).toBe(201)
    clientId = (await registered.json<{ client_id: string }>()).client_id
  }
  const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url.encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  const state = 'gate-0-client-state'
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: 'code',
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    resource,
    scope: 'mcp',
  })
  async function consent() {
    const response = await b.request(`/authorize?${query}`)
    expect(response.status).toBe(200)
    const csp = response.headers
      .get('content-security-policy')
      ?.split(';')
      .map((directive) => directive.trim())
    expect(csp).toContain(`form-action 'self' ${new URL(callback).origin}`)
    expect(csp).toContain("frame-ancestors 'none'")
    const html = await response.text()
    if (clientId === `${manage}/oauth/clients/local.json`) {
      expect(html).toContain('Unverified client (local application)')
      expect(html).not.toContain('Verified client domain:')
      expect(html).toContain(new URL(callback).host)
    }
    return formValue(html, 'consent')
  }
  if (verifyExplicitApproval) {
    const form = await consent()
    expect((await b.post('/authorize', { consent: form, decision: 'approve' }, read)).status).toBe(403)
    expect((await b.post('/authorize', { consent: form })).status).toBe(400)
  }
  const approved = await b.post('/authorize', { consent: await consent(), decision: 'approve' })
  expect([302, 303]).toContain(approved.status)
  const redirect = location(approved)
  expect(redirect.origin + redirect.pathname).toBe(callback)
  expect(redirect.searchParams.get('state')).toBe(state)
  const code = redirect.searchParams.get('code')
  if (!code) throw new Error('Expected authorization code')
  const params = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: callback,
    code_verifier: verifier,
    resource,
  }
  return {
    code,
    params,
    exchange: (origin?: string) => token(send, params, origin),
    refresh: (refreshToken: string) =>
      token(send, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource,
      }),
  }
}

async function expectInvalidGrant(response: Response) {
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
}

describe('MCP discovery and bot credentials', () => {
  it('advertises RFC 9728 and CIMD with public client authentication, but no DCR', async () => {
    const send = runtime()
    const challenge = await mcpCall(send)
    expect(challenge.status).toBe(401)
    const authenticate = challenge.headers.get('www-authenticate')
    expect(authenticate).toMatch(/^Bearer\b/i)
    const metadataUrl = /\bresource_metadata="([^"]+)"/.exec(authenticate ?? '')?.[1]
    expect(metadataUrl).toBe(`${manage}/.well-known/oauth-protected-resource/mcp`)
    if (!metadataUrl) throw new Error('Missing protected resource metadata URL')
    const resourceMetadata = await send(metadataUrl)
    expect(resourceMetadata.status).toBe(200)
    expect(await resourceMetadata.json()).toMatchObject({ resource, authorization_servers: [manage] })
    const authorizationMetadata = await send('/.well-known/oauth-authorization-server')
    expect(authorizationMetadata.status).toBe(200)
    const metadata = await authorizationMetadata.json()
    expect(metadata).toMatchObject({
      issuer: manage,
      authorization_endpoint: `${manage}/authorize`,
      token_endpoint: `${manage}/token`,
      code_challenge_methods_supported: expect.arrayContaining(['S256']),
      token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
      client_id_metadata_document_supported: true,
    })
    expect(metadata).not.toHaveProperty('registration_endpoint')
    expect((await register(send)).status).toBe(404)
  })

  it('exchanges a CIMD client code and uses MCP with DCR disabled', async () => {
    const send = runtime()
    const idp = mockProvider()
    const clientId = 'https://client.example/metadata.json'
    const fetchIdp = fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === clientId) return Promise.resolve(Response.json({ ...registerBody, client_id: clientId }))
      return fetchIdp(input, init)
    })
    const owner = await idp.signedIn(send, admin)
    const grant = await authorize(send, owner, false, clientId)
    const issued = await tokens(await grant.exchange())
    expect(await whoami(send, issued.access_token)).toMatchObject({ kind: 'human', role: 'admin' })
  })

  it('serves a local CIMD document and accepts a loopback callback with a dynamic port', async () => {
    const send = runtime()
    const idp = mockProvider()
    const clientId = `${manage}/oauth/clients/local.json`
    const document = await send(clientId)
    expect(document.status).toBe(200)
    expect(document.headers.get('content-type')).toContain('application/json')
    expect(document.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await document.json()).toEqual({
      client_id: clientId,
      client_name: 'Local MCP client',
      redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
    const fetchIdp = fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      input === clientId ? send(clientId) : fetchIdp(input, init),
    )
    const owner = await idp.signedIn(send, admin)
    const grant = await authorize(send, owner, false, clientId, 'http://127.0.0.1:41993/callback')
    const issued = await tokens(await grant.exchange())
    expect(await whoami(send, issued.access_token)).toMatchObject({ role: 'admin' })
  })

  it('validates imported share keys from an admin and never reassigns a revoked key', async () => {
    const send = runtime()
    const clientId = `${manage}/oauth/clients/local.json`
    const idp = mockProvider()
    const fetchIdp = fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      input === clientId ? send(clientId) : fetchIdp(input, init),
    )
    const owner = await idp.signedIn(send, admin)
    const grant = await authorize(send, owner, false, clientId, 'http://127.0.0.1:41993/callback')
    const issued = await tokens(await grant.exchange())
    const call = async (name: string, args: object) => {
      const response = await send('/mcp', {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${issued.access_token}`,
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      expect(response.status).toBe(200)
      const { result } = await response.json<{ result: { content: { text: string }[] } }>()
      return JSON.parse(result.content[0].text)
    }
    const slug = 'imported-share'
    expect(
      await call('publish', { slug, mode: 'replace', files: [{ path: 'index.html', content: 'Shared' }] }),
    ).toMatchObject({ revision: 1 })
    for (const key of ['a'.repeat(15), 'a'.repeat(129), 'abcdefghijklmnop/', 'abcdefghijklmnop\n']) {
      expect(await call('create_share_link', { slug, key })).toMatchObject({ error: 'invalid_input' })
    }
    for (const key of ['A1_b-cdefghijklm', 'Z'.repeat(128)]) {
      const url = `${read}/s/${slug}/${key}/`
      const { id, url: createdUrl } = await call('create_share_link', { slug, key })
      expect(createdUrl).toBe(url)
      expect(await call('create_share_link', { slug, key })).toMatchObject({ error: 'conflict' })
      expect(await (await send(url)).text()).toBe('Shared')
      expect(await call('revoke_share_link', { id })).toEqual({})
      expect(await call('create_share_link', { slug, key })).toMatchObject({ error: 'conflict' })
      expect((await send(url)).status).toBe(404)
    }
  })

  it('authenticates a bot only on MCP and does not restore old API tokens on reinstatement', async () => {
    const send = runtime()
    const owner = await mockProvider().signedIn(send, admin)
    const path = '/admin/bots'
    const name = 'Gate 0 Publisher Bot'
    expect((await owner.post(path, { action: 'create', name, role: 'publisher' })).status).toBe(303)
    const memberId = await listedId(owner, '/admin/members', name)

    async function mint(label: string) {
      const response = await owner.post(path, { action: 'token', id: memberId, name: label })
      expect(response.status).toBe(303)
      const destination = location(response)
      expect(destination.pathname).toBe(path)
      expect(destination.searchParams.get('bot')).toBe(memberId)
      expect(await response.text()).not.toContain('fgt_')
      const landing = await owner.request(destination, { headers: flashNavigation })
      expect(landing.status).toBe(200)
      expect(landing.headers.get('Cache-Control')).toBe('no-store')
      const credential = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await landing.text())?.[1]
      if (!credential) throw new Error('Token was not returned when minted')
      return credential
    }
    const first = await mint('First token')
    const second = await mint('Second token')
    expect(second).not.toBe(first)
    expect(await whoami(send, first)).toEqual({ id: memberId, name, kind: 'bot', role: 'publisher' })
    const browserStream = await send('/mcp', { headers: { authorization: `Bearer ${first}` } })
    expect(browserStream.status).toBe(405)
    expect(browserStream.headers.get('allow')).toBe('POST, DELETE')
    expect((await send('/mcp')).status).toBe(401)
    expect((await mcpCall(send, first, read)).status).toBe(403)
    const ui = await send('/admin/bots', { headers: { authorization: `Bearer ${first}` } })
    expect(location(ui).pathname).toBe('/login')

    const focusedPath = `${path}?${new URLSearchParams({ bot: memberId })}`
    const rendered = await (await owner.request(focusedPath)).text()
    expect(rendered).not.toContain(first)
    expect(rendered).not.toContain(second)
    const firstRow = [...rendered.matchAll(/<li\b[^>]*>(.*?)<\/li>/gs)].find((row) =>
      row[1]?.includes('First token'),
    )
    if (!firstRow?.[1]) throw new Error('Expected a revoke form for the first token')
    const revoked = await owner.post(focusedPath, { action: 'revoke', id: formValue(firstRow[1], 'id') })
    expect(revoked.status).toBe(303)
    expect((await mcpCall(send, first)).status).toBe(401)
    expect((await whoami(send, second)).id).toBe(memberId)

    expect((await owner.post('/admin/members', { action: 'remove', id: memberId })).status).toBe(303)
    expect((await mcpCall(send, second)).status).toBe(401)
    expect((await owner.post('/admin/members', { action: 'reinstate', id: memberId })).status).toBe(303)
    expect((await mcpCall(send, second)).status).toBe(401)
    expect((await whoami(send, await mint('Token after reinstatement'))).id).toBe(memberId)
  })
})

describe('OAuth with DCR enabled for this runtime only', () => {
  it('rejects a reused authorization code and revokes the issued grant', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const b = await mockProvider().signedIn(send, 'oauth-replayed')
    const grant = await authorize(send, b, false)
    const issued = await tokens(await grant.exchange())
    expect(await whoami(send, issued.access_token)).toMatchObject({ name: 'oauth-replayed' })
    await expectInvalidGrant(await grant.exchange())
    expect((await mcpCall(send, issued.access_token)).status).toBe(401)
    await expectInvalidGrant(await grant.refresh(issued.refresh_token))
  })

  it('records a replay only for the code the provider parsed', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const idp = mockProvider()
    const victim = await authorize(send, await idp.signedIn(send, 'oauth-victim'), false)
    const victimTokens = await tokens(await victim.exchange())
    const attacker = await authorize(send, await idp.signedIn(send, 'oauth-attacker'), false)
    await tokens(await attacker.exchange())
    const crafted = await send('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `?code=${encodeURIComponent(victim.code)}&${new URLSearchParams(attacker.params)}`,
    })
    expect(await crafted.json()).toMatchObject({ error_description: 'Authorization code already used' })
    expect(await whoami(send, victimTokens.access_token)).toMatchObject({ name: 'oauth-victim' })
    expect((await victim.refresh(victimTokens.refresh_token)).status).toBe(200)
  })

  it('refuses token requests with more than one code', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const grant = await authorize(send, await mockProvider().signedIn(send, 'oauth-duplicate'), false)
    const response = await send('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${new URLSearchParams(grant.params)}&code=${encodeURIComponent(grant.code)}`,
    })
    expect(response.status).toBe(400)
    // The provider refuses duplicates too; the description proves Forge refused before it.
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Token request has more than one code',
    })
    await tokens(await grant.exchange())
  })

  it.each([false, true])('rejects token bodies over 16 KiB (Content-Length: %s)', async (declared) => {
    const send = runtime()
    const first = new TextEncoder().encode('grant_type=authorization_code&padding=')
    const rest = new Uint8Array(16 * 1024).fill(120)
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' })
    if (declared) headers.set('Content-Length', String(first.length + rest.length))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
        controller.enqueue(rest)
        controller.close()
      },
    })
    const response = await send('/token', { method: 'POST', headers, body })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('can retry the same code after KV rejects the grant write with a rate limit', async () => {
    let fail = false
    const send = withKvPut(async (key, write) => {
      if (fail && key.startsWith('grant:')) {
        fail = false
        throw new Error('KV put() failed: 429 Too Many Requests')
      }
      await write()
    })
    const b = await mockProvider().signedIn(send, 'retry-code')
    const grant = await authorize(send, b, false)
    fail = true
    const failed = await grant.exchange()
    expect(failed.status).toBe(429)
    expect((await failed.json<{ error: string }>()).error).toBe('temporarily_unavailable')
    const issued = await tokens(await grant.exchange())
    expect(await whoami(send, issued.access_token)).toMatchObject({ name: 'retry-code' })
  })

  it.each([true, false])(
    'requires fresh authorization on uncertain or partial issuance (grant write: %s)',
    async (grantWrite) => {
      let fail = false
      const send = withKvPut(async (key, write) => {
        const [kind] = key.split(':', 1)
        if (fail && grantWrite && kind === 'grant') {
          throw new Error('KV put() failed: 503 Service Unavailable')
        }
        if (fail && !grantWrite && kind === 'token') {
          throw new Error('KV put() failed: 429 Too Many Requests')
        }
        await write()
      })
      const b = await mockProvider().signedIn(send, 'fresh-code')
      const grant = await authorize(send, b, false)
      fail = true
      const origin = new URL(redirectUri).origin
      const response = await grant.exchange(origin)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(response.headers.get('Vary')).toContain('Origin')
      await expectInvalidGrant(response)
      fail = false
      await expectInvalidGrant(await grant.exchange())
    },
  )

  it('durably revokes overlapping code exchanges before the first grant reaches KV', async () => {
    let hold = false
    const firstAtPut = Promise.withResolvers<void>()
    const resumeFirst = Promise.withResolvers<void>()
    const send = withKvPut(async (key, write) => {
      if (hold && key.startsWith('grant:')) {
        hold = false
        firstAtPut.resolve()
        await resumeFirst.promise
      }
      await write()
    })
    const b = await mockProvider().signedIn(send, 'overlap-code')
    const grant = await authorize(send, b, false)
    hold = true
    const first = grant.exchange()
    try {
      await Promise.race([
        firstAtPut.promise,
        first.then(() => {
          throw new Error('First exchange finished before committing its grant')
        }),
      ])
      await expectInvalidGrant(await grant.exchange())
    } finally {
      resumeFirst.resolve()
    }
    const issued = await tokens(await first)
    expect((await mcpCall(send, issued.access_token)).status).toBe(401)
    await expectInvalidGrant(await grant.refresh(issued.refresh_token))
  })

  it.each(['D1 replay marker', 'missing KV grant'])(
    'refuses late-overlap tokens using the %s even if the other check cannot detect replay',
    async (signal) => {
      const reached = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      let hold = false
      let failMarker = false
      let markerAttempts = 0
      let grantKey = ''
      const db = new Proxy(bindings.DB, {
        get(target, key) {
          if (key === 'prepare') {
            return (query: string) => {
              if (failMarker && query.startsWith('INSERT OR IGNORE INTO oauth_code_replays')) {
                markerAttempts += 1
                throw new Error('Injected replay marker write failure')
              }
              return target.prepare(query)
            }
          }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const send = withKvPut(
        async (key, write) => {
          const [kind] = key.split(':', 1)
          if (kind === 'grant') grantKey = key
          if (hold && kind === 'token') {
            hold = false
            reached.resolve()
            await resume.promise
          }
          await write()
        },
        {
          db,
          delete: async (key) => {
            if (signal === 'D1 replay marker' && key === grantKey) return
            await bindings.OAUTH_KV.delete(key)
          },
        },
      )
      const b = await mockProvider().signedIn(send, 'late-overlap')
      const grant = await authorize(send, b, false)
      hold = true
      const first = grant.exchange()
      try {
        await Promise.race([
          reached.promise,
          first.then(() => {
            throw new Error('First exchange issued tokens before the second exchange started')
          }),
        ])
        failMarker = signal === 'missing KV grant'
        const replay = await grant.exchange()
        expect(replay.status).toBe(400)
        expect(await replay.json()).toMatchObject({
          error: 'invalid_grant',
          error_description: 'Authorization code already used',
        })
        if (failMarker) {
          expect(markerAttempts).toBe(3)
          expect(await bindings.OAUTH_KV.get(grantKey)).toBeNull()
        } else {
          expect(await bindings.OAUTH_KV.get(grantKey)).not.toBeNull()
        }
      } finally {
        failMarker = false
        resume.resolve()
      }
      const issued = await tokens(await first)
      expect((await mcpCall(send, issued.access_token)).status).toBe(401)
      await expectInvalidGrant(await grant.refresh(issued.refresh_token))
    },
  )

  it('revokes the consent session and its grants for a logout carrying both sub and sid', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const idp = mockProvider()
    const subject = 'oauth-etheros'
    const sid = 'signed-in-session'
    const b = await idp.signedIn(send, subject, { sid })
    const other = await idp.signedIn(send, subject, { sid: 'other-session' })
    const grant = await authorize(send, b, false)
    const issued = await tokens(await grant.exchange())
    const otherGrant = await authorize(send, other, false)
    const otherIssued = await tokens(await otherGrant.exchange())
    expect((await idp.backchannel(send, 'oauth-sid-revocation', { sub: subject, sid })).status).toBe(200)
    expect(location(await b.request('/')).pathname).toBe('/login')
    expect((await mcpCall(send, issued.access_token)).status).toBe(401)
    await expectInvalidGrant(await grant.refresh(issued.refresh_token))
    expect((await other.request('/artefacts')).status).toBe(200)
    expect(await whoami(send, otherIssued.access_token)).toMatchObject({ name: subject })
  })

  it('exchanges a consented PKCE code and rotates tokens, then refuses refresh and calls after removal', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const idp = mockProvider()
    const owner = await idp.signedIn(send, admin)
    const b = await idp.signedIn(send, 'oauth-removed')
    const grant = await authorize(send, b, true)
    const issued = await tokens(await grant.exchange())
    const person = await whoami(send, issued.access_token)
    expect(person).toMatchObject({ name: 'oauth-removed', kind: 'human', role: 'viewer' })
    const rotated = await tokens(await grant.refresh(issued.refresh_token))
    expect(rotated.access_token).not.toBe(issued.access_token)
    expect(rotated.refresh_token).not.toBe(issued.refresh_token)
    expect(await whoami(send, rotated.access_token)).toEqual(person)
    const pendingGrant = await authorize(send, b, false)

    expect((await owner.post('/admin/members', { id: person.id, action: 'remove' })).status).toBe(303)
    await expectInvalidGrant(await grant.refresh(rotated.refresh_token))
    await expectInvalidGrant(await pendingGrant.exchange())
    expect((await mcpCall(send, rotated.access_token)).status).toBe(401)
  })

  it('requires fresh sign-in and OAuth approval after reinstatement and refuses a pre-removal login flow', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const idp = mockProvider()
    const owner = await idp.signedIn(send, admin)
    const member = await idp.signedIn(send, 'reinstated')
    const old = await authorize(send, member, false)
    const issued = await tokens(await old.exchange())
    const person = await whoami(send, issued.access_token)
    const approvedBeforeRemoval = await authorize(send, member, false)
    const staleBrowser = new Browser(send)
    const staleCallback = await idp.issue(await idp.begin(staleBrowser), 'reinstated')
    const viewer = await idp.signedIn(send, 'unprivileged')
    const path = '/admin/members'
    expect((await owner.post(path, { id: person.id, action: 'remove' })).status).toBe(303)
    const reinstate = { id: person.id, action: 'reinstate' }
    expect((await owner.post(path, reinstate, read)).status).toBe(403)
    expect((await viewer.post(path, reinstate)).status).toBe(403)
    expect((await idp.login(new Browser(send), 'reinstated')).status).toBe(403)
    expect((await owner.post(path, reinstate)).status).toBe(303)

    expect(location(await member.request('/')).pathname).toBe('/login')
    expect((await mcpCall(send, issued.access_token)).status).toBe(401)
    await expectInvalidGrant(await old.refresh(issued.refresh_token))
    await expectInvalidGrant(await approvedBeforeRemoval.exchange())
    expect((await staleBrowser.request(staleCallback)).status).toBe(401)
    expect(staleBrowser.cookie(sessionCookie)).toBeUndefined()

    const fresh = new Browser(send)
    expect((await idp.login(fresh, 'reinstated')).status).toBe(302)
    expect(fresh.cookie(sessionCookie)).not.toBe(member.cookie(sessionCookie))
    const freshGrant = await authorize(send, fresh, false)
    const renewed = await tokens(await freshGrant.exchange())
    expect(await whoami(send, renewed.access_token)).toEqual(person)
    expect((await freshGrant.refresh(renewed.refresh_token)).status).toBe(200)
  })

  it('rejects an approval finalized after a removal that committed after the consent read', async () => {
    const path = '/admin/members'
    const subject = 'consent-overlap'
    const idp = mockProvider()
    const owner = await idp.signedIn(runtime(), admin)
    let id: string | undefined
    let interrupted = false
    const send = withKvPut(async (key, write) => {
      if (key.startsWith('grant:') && id && !interrupted) {
        interrupted = true
        // Model the old Worker committing a removal whose clock lagged the consent Worker.
        await bindings.DB.prepare("UPDATE members SET status = 'removed', removed_at = 1 WHERE id = ?")
          .bind(id)
          .run()
        expect((await owner.post(path, { id, action: 'reinstate' })).status).toBe(303)
      }
      await write()
    })
    const member = await idp.signedIn(send, subject)
    id = await listedId(owner, path, `${subject}@example.test`)
    const overlapping = await authorize(send, member, false)
    expect(interrupted).toBe(true)
    await expectInvalidGrant(await overlapping.exchange())
  })

  it('rejects both exchange and refresh for a revoked sub as well as existing access tokens', async () => {
    const send = runtime({ ALLOW_DCR: 'true' })
    const idp = mockProvider()
    const subject = 'oauth-deactivated'
    const b = await idp.signedIn(send, subject)
    const activeGrant = await authorize(send, b, false)
    const issued = await tokens(await activeGrant.exchange())
    expect(await whoami(send, issued.access_token)).toMatchObject({ name: subject, role: 'viewer' })
    const pendingGrant = await authorize(send, b, false)

    expect((await idp.backchannel(send, 'oauth-sub-revocation', { sub: subject })).status).toBe(200)
    expect(location(await b.request('/')).pathname).toBe('/login')
    await expectInvalidGrant(await activeGrant.refresh(issued.refresh_token))
    await expectInvalidGrant(await pendingGrant.exchange())
    expect((await mcpCall(send, issued.access_token)).status).toBe(401)
  })
})
