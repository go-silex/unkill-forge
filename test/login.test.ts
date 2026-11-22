import { base64url } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import {
  admin,
  api,
  Browser,
  issuer,
  listedId,
  location,
  manage,
  navigation,
  provider,
  read,
  runtime,
  sessionCookie,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const members = '/admin/members'
const minute = 60_000

describe('Worker boundary', () => {
  it.each([
    ['identical origins', { READ_ORIGIN: manage }],
    ['non-HTTPS origin', { READ_ORIGIN: 'http://read.forge.example' }],
    ['malformed origin', { READ_ORIGIN: 'not a URL' }],
    ['malformed issuer', { AUTH_PROVIDERS: JSON.stringify([{ ...provider, issuer: 'not a URL' }]) }],
    ['no providers', { AUTH_PROVIDERS: '[]' }],
    ['duplicate providers', { AUTH_PROVIDERS: JSON.stringify([provider, provider]) }],
    ['missing provider secret', { AUTH_TEAM_CLIENT_SECRET: undefined }],
    ['invalid cookie key', { FORGE_COOKIE_KEY: 'short' }],
  ] as const)('fails closed with %s', async (_name, overrides) => {
    expect((await runtime(overrides)('/login')).status).toBe(503)
  })

  it('exposes manage routes only on the configured manage origin', async () => {
    const send = runtime()
    expect((await send('/login')).status).toBe(200)
    for (const origin of [read, 'https://other.forge.example', 'http://manage.forge.example']) {
      expect((await send(`${origin}/login`)).status).toBe(404)
      expect((await send(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(404)
    }
    expect((await send(`${read}${members}`)).status).toBe(404)
  })
})

describe('browser sign-in', () => {
  it('uses GitHub PKCE and admits with the primary verified email', async () => {
    const send = runtime({
      AUTH_PROVIDERS: JSON.stringify([
        { id: 'github', type: 'github', label: 'GitHub', clientId: 'gh-test' },
      ]),
      AUTH_GITHUB_CLIENT_SECRET: crypto.randomUUID(),
    })
    const browser = new Browser(send)
    const auth = location(await browser.request('/login/github'))
    expect(auth.origin).toBe('https://github.com')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('scope')).toContain('user:email')
    const upstreamToken = crypto.randomUUID()
    let challenge: string | null = null
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'https://github.com/login/oauth/access_token' && init?.body instanceof URLSearchParams) {
        const verifier = init.body.get('code_verifier') ?? ''
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
        challenge = base64url.encode(hash)
        return Response.json({ access_token: upstreamToken, token_type: 'bearer' })
      }
      if (new Headers(init?.headers).get('Authorization') !== `Bearer ${upstreamToken}`)
        throw new Error('Wrong GitHub bearer')
      if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'owner' })
      if (url === 'https://api.github.com/user/emails')
        return Response.json([
          { email: 'unverified@example.test', primary: true, verified: false },
          { email: 'secondary@example.test', primary: false, verified: true },
          { email: `${admin}@example.test`, primary: true, verified: true },
        ])
      throw new Error('Unexpected GitHub request')
    })
    const params = new URLSearchParams({
      state: auth.searchParams.get('state') ?? '',
      code: crypto.randomUUID(),
    })
    expect((await browser.request(`/login/github/callback?${params}`)).status).toBe(302)
    expect(challenge).toBe(auth.searchParams.get('code_challenge'))
    expect((await browser.request(members)).status).toBe(200)
  })

  it('bootstraps the first listed admin but never auto-admits a removed listed identity', async () => {
    const alsoListed = 'listed-member'
    const send = runtime({ ADMIN_EMAILS: `${admin}@example.test,${alsoListed}@example.test` })
    const idp = mockProvider()
    const owner = await idp.signedIn(send, admin)
    expect((await owner.request(members)).status).toBe(200)

    const member = await idp.signedIn(send, alsoListed)
    expect((await member.request('/')).status).toBe(200)
    expect((await member.request(members)).status).toBe(403)
    const id = await listedId(owner, members, `${alsoListed}@example.test`)
    const crossOriginAlias = await owner.post('/admin/%6dembers', { id, action: 'remove' }, read)
    expect([403, 404]).toContain(crossOriginAlias.status)
    expect((await member.request('/')).status).toBe(200)
    expect((await owner.post(members, { id, action: 'remove' })).status).toBe(303)
    expect(location(await member.request('/', { headers: navigation })).pathname).toBe('/login')

    const retry = new Browser(send)
    const denied = await idp.login(retry, alsoListed)
    expect(denied.status).toBe(403)
    expect(retry.cookie(sessionCookie)).toBeUndefined()
  })

  it.each([
    ['required claim missing from ID token', { token: { active_member: undefined } }],
    ['required claim missing from UserInfo', { userinfo: { active_member: undefined } }],
    ['unaccepted hosted domain', { token: { hd: 'other.test' } }],
    ['different UserInfo subject', { userinfo: { sub: 'different-user' } }],
    ['wrong ID token nonce', { token: { nonce: 'not-this-flow' } }],
    ['wrong ID token authorized party', { token: { azp: 'different-client' } }],
  ] as const)('refuses %s', async (reason, identity) => {
    const send = runtime()
    const b = new Browser(send)
    const callback = await mockProvider().login(b, `bad-${reason.split(' ').at(-1)}`, identity)
    expect(callback.status).toBe(401)
    expect(b.cookie(sessionCookie)).toBeUndefined()
  })

  it('requires the original browser cookie and state and consumes the flow only once, even in a race', async () => {
    const send = runtime()
    const idp = mockProvider()
    const first = new Browser(send)
    const second = new Browser(send)
    const firstAuth = await idp.begin(first)
    const secondAuth = await idp.begin(second)
    const firstCallback = await idp.issue(firstAuth, 'right-browser')
    const wrongState = new URL(firstCallback)
    const secondState = secondAuth.searchParams.get('state')
    if (!secondState) throw new Error('Missing second OAuth state')
    wrongState.searchParams.set('state', secondState)
    const headers = { cookie: first.cookieHeader() }

    expect((await send(firstCallback)).status).toBe(400)
    expect((await send(firstCallback, { headers: { cookie: second.cookieHeader() } })).status).toBe(400)
    expect((await send(wrongState, { headers })).status).toBe(400)
    expect(idp.exchanges).toBe(0)

    const race = await Promise.all([send(firstCallback, { headers }), send(firstCallback, { headers })])
    expect(race.map((response) => response.status).sort()).toEqual([302, 400])
    expect(idp.exchanges).toBe(1)
    const success = race.find((response) => response.status === 302)
    expect(success?.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^__Host-forge-session=.+;.*HttpOnly;.*SameSite=Lax/i)]),
    )
    expect((await send(firstCallback, { headers })).status).toBe(400)
    expect(idp.exchanges).toBe(1)

    const secondCallback = await idp.issue(secondAuth, 'second-browser')
    expect((await second.request(secondCallback)).status).toBe(302)
  })

  it('rejects a read-origin POST despite a valid manage cookie', async () => {
    const send = runtime()
    const b = await mockProvider().signedIn(send, 'csrf-member')
    const original = b.cookieHeader()
    expect((await b.post('/logout', {}, read)).status).toBe(403)
    expect((await send('/', { headers: { ...navigation, cookie: original } })).status).toBe(200)
    expect((await b.post('/logout', {})).status).toBe(303)
    expect(location(await send('/', { headers: { ...navigation, cookie: original } })).pathname).toBe(
      '/login',
    )
  })

  it('replaces the previous session only after a successful sign-in', async () => {
    const send = runtime()
    const idp = mockProvider()
    const b = await idp.signedIn(send, 'prior-account')
    const original = b.cookieHeader()
    expect((await idp.login(b, 'different-account', { token: { azp: 'different-client' } })).status).toBe(401)
    expect((await send('/', { headers: { cookie: original } })).status).toBe(200)
    expect((await idp.login(b, 'different-account')).status).toBe(302)
    expect(await (await b.request('/')).text()).toContain('different-account')
    expect(location(await send('/', { headers: { cookie: original } })).pathname).toBe('/login')
  })
})

describe('session lifetime', () => {
  function freezeTime() {
    const start = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    return start
  }

  async function revalidation(b: Browser) {
    const response = await b.request('/', { headers: navigation })
    expect(response.status).toBe(302)
    const authorize = location(response)
    expect(authorize.origin).toBe(issuer)
    expect(authorize.searchParams.get('prompt')).toBe('none')
    return authorize
  }

  it('silently extends validation, but not the original hard cap', async () => {
    const start = freezeTime()
    const send = runtime()
    const idp = mockProvider()
    const b = await idp.signedIn(send, 'hard-cap')
    const original = b.cookieHeader()
    vi.setSystemTime(start + 55 * minute)
    const authorize = await revalidation(b)
    const renewed = await b.request(await idp.issue(authorize, 'hard-cap'))
    expect(renewed.status).toBe(302)
    expect(location(renewed).href).toBe(`${manage}/`)
    vi.setSystemTime(start + 59 * minute)
    expect((await b.request('/', { headers: api })).status).toBe(200)
    vi.setSystemTime(start + 61 * minute)
    const expired = await send('/', { headers: { ...navigation, cookie: original } })
    expect(location(expired)).toMatchObject({ origin: manage, pathname: '/login' })
  })

  it('returns 401 for a stale non-navigation request without contacting the provider', async () => {
    const start = freezeTime()
    const send = runtime()
    const idp = mockProvider()
    const b = await idp.signedIn(send, 'stale-api')
    const upstreamRequests = idp.requests
    vi.setSystemTime(start + 11 * minute)
    const response = await b.request('/', { headers: api })
    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
    expect(idp.requests).toBe(upstreamRequests)
  })

  it('ends the session on login_required and rejects the old cookie', async () => {
    const start = freezeTime()
    const send = runtime()
    const idp = mockProvider()
    const b = await idp.signedIn(send, 'requires-login')
    const original = b.cookieHeader()
    vi.setSystemTime(start + 5 * minute)
    const otherBrowser = await idp.signedIn(send, 'requires-login', { sid: 'other-browser' })
    vi.setSystemTime(start + 11 * minute)
    const authorize = await revalidation(b)
    const callback = await b.request(idp.callback(authorize, { error: 'login_required' }))
    expect(callback.status).toBe(401)
    expect(b.cookie(sessionCookie)).toBeUndefined()
    const expired = await send('/', { headers: { ...navigation, cookie: original } })
    expect(location(expired)).toMatchObject({ origin: manage, pathname: '/login' })
    expect((await otherBrowser.request('/', { headers: api })).status).toBe(200)
  })

  it('fails closed with 503 when silent revalidation cannot reach the provider', async () => {
    const start = freezeTime()
    const send = runtime()
    const idp = mockProvider()
    const b = await idp.signedIn(send, 'upstream-outage')
    vi.setSystemTime(start + 11 * minute)
    const authorize = await revalidation(b)
    const callback = await b.request(idp.callback(authorize, { code: 'unavailable' }))
    expect(callback.status).toBe(503)
    expect(callback.headers.get('location')).toBeNull()
    expect((await b.request('/', { headers: api })).status).toBe(401)
  })
})

describe('OIDC back-channel logout', () => {
  it('targets one session by sid and refuses a replayed jti or any nonce', async () => {
    const send = runtime()
    const idp = mockProvider()
    const subject = 'sid-target'
    const first = await idp.signedIn(send, subject, { sid: 'first' })
    const second = await idp.signedIn(send, subject, { sid: 'second' })
    expect((await idp.backchannel(send, 'with-nonce', { sid: 'second', nonce: 'prohibited' })).status).toBe(
      400,
    )
    expect((await second.request('/')).status).toBe(200)
    expect((await idp.backchannel(send, 'sid-jti', { sub: subject, sid: 'first' })).status).toBe(200)
    expect(location(await first.request('/', { headers: navigation })).pathname).toBe('/login')
    expect((await second.request('/')).status).toBe(200)
    expect((await idp.backchannel(send, 'sid-jti', { sub: subject, sid: 'first' })).status).toBe(400)
    expect((await idp.backchannel(send, 'sid-jti', { sub: subject, sid: 'second' })).status).toBe(400)
    expect((await second.request('/')).status).toBe(200)
  })

  it('ends every session for a sub-only logout without affecting a different identity', async () => {
    const send = runtime()
    const idp = mockProvider()
    const subject = 'sub-target'
    const first = await idp.signedIn(send, subject, { sid: 'target-device-one' })
    const second = await idp.signedIn(send, subject, { sid: 'target-device-two' })
    const unaffected = await idp.signedIn(send, 'not-targeted')
    expect((await idp.backchannel(send, 'sub-jti', { sub: subject })).status).toBe(200)
    for (const b of [first, second]) {
      expect(location(await b.request('/', { headers: navigation })).pathname).toBe('/login')
    }
    expect((await unaffected.request('/')).status).toBe(200)
  })
})
