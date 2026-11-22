import { base64url, exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose'
import { afterEach, beforeAll, expect, vi } from 'vitest'
import { Browser, clientId, type Handle, issuer, location, manage, navigation, sessionCookie } from './http'

let signingKey: CryptoKey
let publicJwk: JWK
const kid = 'forge-test-key'
const loginPath = '/login/team'
const callbackPath = `${loginPath}/callback`
const logoutPath = `${loginPath}/backchannel-logout`
const epoch = () => Math.floor(Date.now() / 1000)

export function setupOidc() {
  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    signingKey = privateKey
    publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
}

interface IdentityOptions {
  sid?: string
  token?: Record<string, unknown>
  userinfo?: Record<string, unknown>
}

export function mockProvider() {
  const tokenReplies = new Map<string, { id_token: string; access_token: string; challenge: string }>()
  const profiles = new Map<string, JWTPayload>()
  let serial = 0
  let exchanges = 0
  let requests = 0
  const fetchMock: typeof fetch = async (input, init) => {
    requests++
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== issuer) throw new Error(`Unexpected outbound request: ${url}`)
    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/.well-known/openid-configuration':
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
            backchannel_logout_supported: true,
            backchannel_logout_session_supported: true,
          })
        case '/jwks':
          return Response.json({ keys: [publicJwk] })
        case '/userinfo': {
          const access = request.headers.get('authorization')?.replace(/^Bearer /i, '')
          const profile = access ? profiles.get(access) : undefined
          return profile ? Response.json(profile) : Response.json({ error: 'invalid_token' }, { status: 401 })
        }
      }
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      exchanges++
      const params = new URLSearchParams(await request.text())
      const code = params.get('code')
      if (code === 'unavailable') return Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
      const reply = code ? tokenReplies.get(code) : undefined
      if (!reply || !code) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      tokenReplies.delete(code)
      const verifier = new TextEncoder().encode(params.get('code_verifier') ?? '')
      const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', verifier)))
      if (challenge !== reply.challenge || params.get('redirect_uri') !== `${manage}${callbackPath}`) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return Response.json({
        id_token: reply.id_token,
        access_token: reply.access_token,
        token_type: 'Bearer',
        expires_in: 300,
      })
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${url}`)
  }
  vi.stubGlobal('fetch', fetchMock)

  function jwt(claims: JWTPayload) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(epoch())
      .setExpirationTime(epoch() + 300)
      .sign(signingKey)
  }

  function callback(authorize: URL, params: Record<string, string>) {
    const state = authorize.searchParams.get('state')
    if (!state) throw new Error('Missing OAuth state')
    const redirect = new URL(callbackPath, manage)
    redirect.search = new URLSearchParams({ state, ...params }).toString()
    return redirect
  }

  async function issue(authorize: URL, subject: string, options: IdentityOptions = {}) {
    const nonce = authorize.searchParams.get('nonce')
    const challenge = authorize.searchParams.get('code_challenge')
    if (!nonce || !challenge) throw new Error('Missing nonce or PKCE challenge')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    const profile = {
      sub: subject,
      email: `${subject}@example.test`,
      name: subject,
      email_verified: true,
      active_member: true,
      hd: 'example.test',
    }
    const access = `upstream-access-${++serial}`
    const code = `upstream-code-${serial}`
    const idToken = await jwt({
      ...profile,
      nonce,
      sid: options.sid ?? `${subject}-sid`,
      auth_time: epoch(),
      ...options.token,
    })
    tokenReplies.set(code, { id_token: idToken, access_token: access, challenge })
    profiles.set(access, { ...profile, ...options.userinfo })
    return callback(authorize, { code })
  }

  async function begin(b: Browser) {
    const response = await b.request(loginPath, { headers: navigation })
    expect(response.status).toBe(302)
    const authorize = location(response)
    expect(authorize.origin).toBe(issuer)
    return authorize
  }

  async function login(b: Browser, subject: string, options?: IdentityOptions) {
    return b.request(await issue(await begin(b), subject, options))
  }

  async function signedIn(send: Handle, subject: string, options?: IdentityOptions) {
    const b = new Browser(send)
    const result = await login(b, subject, options)
    expect(result.status).toBe(302)
    expect(b.cookie(sessionCookie)).toBeTruthy()
    return b
  }
  async function backchannel(send: Handle, jti: string, claims: JWTPayload) {
    const token = await jwt({
      jti,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      ...claims,
    })
    return send(logoutPath, { method: 'POST', body: new URLSearchParams({ logout_token: token }) })
  }

  return {
    begin,
    callback,
    issue,
    login,
    signedIn,
    backchannel,
    get exchanges() {
      return exchanges
    },
    get requests() {
      return requests
    },
  }
}
