import { base64url } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import {
  admin,
  type Browser,
  formValue,
  type Handle,
  jsonHeaders,
  listedId,
  location,
  manage,
  mcpCall,
  read,
  runtime,
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

async function token(send: Handle, params: Record<string, string>) {
  return send('/token', { method: 'POST', body: new URLSearchParams(params) })
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

async function authorize(send: Handle, b: Browser, verifyExplicitApproval: boolean, clientId?: string) {
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
    redirect_uri: redirectUri,
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
    return formValue(await response.text(), 'consent')
  }
  if (verifyExplicitApproval) {
    const form = await consent()
    expect((await b.post('/authorize', { consent: form, decision: 'approve' }, read)).status).toBe(403)
    expect((await b.post('/authorize', { consent: form })).status).toBe(400)
  }
  const approved = await b.post('/authorize', { consent: await consent(), decision: 'approve' })
  expect([302, 303]).toContain(approved.status)
  const redirect = location(approved)
  expect(redirect.origin + redirect.pathname).toBe(redirectUri)
  expect(redirect.searchParams.get('state')).toBe(state)
  const code = redirect.searchParams.get('code')
  if (!code) throw new Error('Expected authorization code')
  return {
    exchange: () =>
      token(send, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
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

  it('authenticates a bot only on MCP, then enforces token revocation and member removal', async () => {
    const send = runtime()
    const owner = await mockProvider().signedIn(send, admin)
    const path = '/admin/bots'
    const name = 'Gate 0 Publisher Bot'
    expect((await owner.post(path, { action: 'create', name, role: 'publisher' })).status).toBe(303)
    const memberId = await listedId(owner, '/admin/members', name)

    async function mint(label: string) {
      const response = await owner.post(path, { action: 'token', id: memberId, name: label })
      expect(response.status).toBe(200)
      const credential = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await response.text())?.[1]
      if (!credential) throw new Error('Token was not returned when minted')
      return credential
    }
    const first = await mint('First token')
    const second = await mint('Second token')
    expect(second).not.toBe(first)
    expect(await whoami(send, first)).toEqual({ id: memberId, name, kind: 'bot', role: 'publisher' })
    expect((await mcpCall(send, first, read)).status).toBe(403)
    const ui = await send('/admin/bots', { headers: { authorization: `Bearer ${first}` } })
    expect(location(ui).pathname).toBe('/login')

    const rendered = await (await owner.request(path)).text()
    expect(rendered).not.toContain(first)
    expect(rendered).not.toContain(second)
    const firstRow = [...rendered.matchAll(/<li\b[^>]*>(.*?)<\/li>/gs)].find((row) =>
      row[1]?.includes('First token'),
    )
    if (!firstRow?.[1]) throw new Error('Expected a revoke form for the first token')
    expect((await owner.post(path, { action: 'revoke', id: formValue(firstRow[1], 'id') })).status).toBe(303)
    expect((await mcpCall(send, first)).status).toBe(401)
    expect((await whoami(send, second)).id).toBe(memberId)

    expect((await owner.post('/admin/members', { action: 'remove', id: memberId })).status).toBe(303)
    expect((await mcpCall(send, second)).status).toBe(401)
  })
})

describe('OAuth with DCR enabled for this runtime only', () => {
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
