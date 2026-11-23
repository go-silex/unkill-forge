import { base64url } from 'jose'
import { calculatePKCECodeChallenge } from 'oauth4webapi'
import type { Provider, Runtime } from '../../config'
import {
  admitIdentity,
  type BrowserSession,
  consumeFlow,
  createSession,
  hashSecret,
  putFlow,
  randomSecret,
  readSession,
  recordRevocation,
  revalidateSession,
  revokeSession,
  sessionIsFresh,
} from '../../core/index'
import { consumeInviteContext, createInviteContext, inviteKey } from '../../core/invites'
import { isDocumentNavigation, readBoundedBody } from '../../http'
import {
  authorizationEndpoint,
  discover,
  githubIdentity,
  type Identity,
  IdentityDenied,
  InvalidProviderResponse,
  oidcIdentity,
  ProviderUnavailable,
  parseLogoutToken,
  SessionDenied,
} from './providers'

const flowCookie = '__Host-forge-flow'
const sessionCookie = '__Host-forge-session'
const inviteCookiePrefix = '__Host-forge-invite-'
const flowSeconds = 300
const encoder = new TextEncoder()

export function returnPath(raw: string | null, origin: string): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  const url = URL.parse(raw, origin)
  // Dot-segment normalization can turn a path into a network-path reference.
  if (!url || url.origin !== origin || url.pathname.startsWith('//')) return '/'
  return url.pathname + url.search + url.hash
}

function readCookie(req: Request, name: string): string | null {
  let value: string | null = null
  for (const entry of req.headers.get('cookie')?.split(';') ?? []) {
    const part = entry.trim()
    if (!part.startsWith(`${name}=`)) continue
    const candidate = part.slice(name.length + 1)
    if (value !== null || !/^[\w-]+$/.test(candidate)) return null
    value = candidate
  }
  return value
}

function writeCookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`
}

function respond(status: number, body: string | null, location?: string, cookie?: string): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  if (location) headers.set('Location', location)
  if (cookie) headers.append('Set-Cookie', cookie)
  return new Response(body, { status, headers })
}

export async function openInvite(runtime: Runtime, token: string): Promise<Response | null> {
  const id = randomSecret()
  const browser = randomSecret()
  if (!(await createInviteContext(runtime.env.DB, token, id, browser))) return null
  return respond(303, null, `/login?invite=${id}`, writeCookie(inviteCookiePrefix + id, browser, 600))
}

function callbackUri(runtime: Runtime, provider: Provider): string {
  return `${runtime.config.manageOrigin}/login/${encodeURIComponent(provider.id)}/callback`
}

async function flowVerifier(key: string, state: string): Promise<string> {
  // State travels through the user agent; only the keyed derivation can recover its verifier.
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64url.encode(
    new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encoder.encode(`forge:pkce:${state}`))),
  )
}

function flowNonce(state: string): Promise<string> {
  // The public nonce must not disclose the state hash used as the database key.
  return hashSecret(`forge:nonce:${state}`)
}

async function start(
  req: Request,
  runtime: Runtime,
  provider: Provider,
  path: string,
  sessionHash: string | null,
  inviteContext: string | null = null,
): Promise<Response> {
  const now = Date.now()
  const inviteCookie = inviteContext === null ? null : inviteCookiePrefix + inviteContext
  const inviteBrowser = inviteCookie === null ? null : readCookie(req, inviteCookie)
  const browser = readCookie(req, flowCookie) ?? randomSecret()
  const state = randomSecret()
  const target = await authorizationEndpoint(provider)
  const verifier = await flowVerifier(runtime.config.cookieKey, state)
  const params = target.searchParams
  params.set('client_id', provider.clientId)
  params.set('redirect_uri', callbackUri(runtime, provider))
  params.set('response_type', 'code')
  const mandatoryScope = provider.type === 'oidc' ? 'openid' : 'user:email'
  const scopes = provider.scopes.includes(mandatoryScope)
    ? provider.scopes
    : [mandatoryScope, ...provider.scopes]
  params.set('scope', scopes.join(' '))
  params.set('state', state)
  params.set('code_challenge_method', 'S256')
  params.set('code_challenge', await calculatePKCECodeChallenge(verifier))
  if (provider.type === 'oidc') params.set('nonce', await flowNonce(state))
  if (sessionHash !== null) params.set('prompt', 'none')

  const [stateHash, browserHash] = await Promise.all([hashSecret(state), hashSecret(browser)])
  await putFlow(runtime.env.DB, {
    stateHash,
    browserHash,
    provider: provider.id,
    returnPath: path,
    sessionHash,
    createdAt: now,
    expiresAt: now + flowSeconds * 1_000,
    inviteHash:
      inviteContext === null || inviteBrowser === null
        ? null
        : await consumeInviteContext(runtime.env.DB, inviteContext, inviteBrowser),
  })
  const response = respond(302, null, target.href, writeCookie(flowCookie, browser, flowSeconds))
  if (inviteCookie !== null && inviteBrowser !== null)
    response.headers.append('Set-Cookie', writeCookie(inviteCookie, '', 0))
  return response
}

async function callback(
  req: Request,
  runtime: Runtime,
  provider: Provider,
  params: URLSearchParams,
): Promise<Response> {
  const state = params.get('state')
  const browser = readCookie(req, flowCookie)
  if (!state || params.getAll('state').length !== 1 || !browser) return respond(400, 'Invalid login flow')

  const now = Date.now()
  const [stateHash, browserHash] = await Promise.all([hashSecret(state), hashSecret(browser)])
  const db = runtime.env.DB
  const flow = await consumeFlow(db, { stateHash, browserHash, provider: provider.id, now })
  if (!flow) return respond(400, 'Invalid login flow')

  let previous: BrowserSession | null = null
  if (flow.sessionHash !== null) {
    const session = readCookie(req, sessionCookie)
    if (!session || provider.type !== 'oidc' || (await hashSecret(session)) !== flow.sessionHash) {
      return respond(401, 'Session no longer valid')
    }
    previous = await readSession(db, flow.sessionHash, now)
    if (!previous || previous.provider !== provider.id || previous.member.status === 'removed') {
      return respond(401, 'Session no longer valid')
    }
  }

  const exchange = {
    params,
    state,
    redirectUri: callbackUri(runtime, provider),
    verifier: await flowVerifier(runtime.config.cookieKey, state),
  }
  let identity: Identity
  try {
    identity =
      provider.type === 'oidc'
        ? await oidcIdentity(provider, exchange, await flowNonce(state), previous?.subject)
        : await githubIdentity(provider, exchange)
  } catch (error) {
    if (
      error instanceof IdentityDenied ||
      error instanceof SessionDenied ||
      error instanceof InvalidProviderResponse
    ) {
      // Reasons are claim names or library error codes, never claim values.
      console.warn('Sign-in refused', provider.id, error.constructor.name, error.message)
    }
    if (error instanceof IdentityDenied || error instanceof SessionDenied) {
      if (!previous) return respond(401, 'Sign-in refused')
      const now = Date.now()
      if (error instanceof IdentityDenied) {
        await recordRevocation(db, {
          provider: provider.id,
          jti: `revalidation:${randomSecret()}`,
          subject: previous.subject,
          sid: null,
          now,
        })
      } else {
        await revokeSession(db, previous.idHash, now)
      }
      return respond(401, 'Sign-in required', undefined, writeCookie(sessionCookie, '', 0))
    }
    if (error instanceof InvalidProviderResponse) return respond(401, 'Sign-in refused')
    throw error
  }

  const path = returnPath(flow.returnPath, runtime.config.manageOrigin)
  const validatedAt = Date.now()
  if (previous) {
    if (
      !(await revalidateSession(db, {
        idHash: previous.idHash,
        provider: provider.id,
        subject: previous.subject,
        sid: identity.sid,
        now: validatedAt,
        flowCreatedAt: flow.createdAt,
      }))
    ) {
      return respond(401, 'Session no longer valid', undefined, writeCookie(sessionCookie, '', 0))
    }
    return respond(302, null, path)
  }

  const member = await admitIdentity(db, {
    provider: provider.id,
    subject: identity.subject,
    name: identity.name,
    email: identity.email,
    emailVerified: identity.emailVerified,
    adminEmails: runtime.config.adminEmails,
    inviteHash: flow.inviteHash,
    ...(provider.type === 'oidc' &&
      provider.autoJoinRole !== undefined && { autoJoinRole: provider.autoJoinRole }),
    now: validatedAt,
  })
  if (member.status === 'removed') return respond(403, 'Sign-in refused')
  const session = randomSecret()
  const cap = provider.sessionMaxHours * 3_600_000
  if (
    !(await createSession(db, {
      idHash: await hashSecret(session),
      memberId: member.id,
      provider: provider.id,
      subject: identity.subject,
      sid: identity.sid,
      authTime: identity.authTime,
      createdAt: validatedAt,
      validatedAt,
      expiresAt: validatedAt + cap,
      flowCreatedAt: flow.createdAt,
      flowGeneration: flow.generation,
    }))
  )
    return respond(401, 'Sign-in refused')
  const priorCookie = readCookie(req, sessionCookie)
  if (priorCookie) await revokeSession(db, await hashSecret(priorCookie), validatedAt)
  return respond(302, null, path, writeCookie(sessionCookie, session, Math.floor(cap / 1_000)))
}

async function backchannel(req: Request, runtime: Runtime, provider: Provider): Promise<Response> {
  if (provider.type !== 'oidc' || provider.backchannelLogout === false) return respond(404, 'Not found')
  if (
    req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  ) {
    return respond(400, 'Invalid logout request')
  }
  const body = await readBoundedBody(req, 16 * 1024)
  if (body === null) return respond(413, 'Logout request body exceeds 16 KiB')
  const tokens = new URLSearchParams(new TextDecoder().decode(body)).getAll('logout_token')
  const token = tokens[0]
  if (tokens.length !== 1 || !token) return respond(400, 'Invalid logout token')

  const as = await discover(provider)
  try {
    const verified = await parseLogoutToken(as, provider, token)
    if (await recordRevocation(runtime.env.DB, { ...verified, provider: provider.id, now: Date.now() })) {
      return respond(200, null)
    }
    return respond(400, 'Invalid logout token')
  } catch (error) {
    if (error instanceof InvalidProviderResponse) return respond(400, 'Invalid logout token')
    throw error
  }
}

async function logout(req: Request, runtime: Runtime): Promise<Response> {
  const session = readCookie(req, sessionCookie)
  if (session) await revokeSession(runtime.env.DB, await hashSecret(session), Date.now())
  const response = respond(303, null, '/login', writeCookie(sessionCookie, '', 0))
  response.headers.append('Set-Cookie', writeCookie(flowCookie, '', 0))
  return response
}

export async function loginRoute(req: Request, runtime: Runtime): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/logout' && req.method === 'POST') return logout(req, runtime)
  const [, encodedId, action] =
    /^\/login\/([^/]+)(?:\/(callback|backchannel-logout))?$/.exec(url.pathname) ?? []
  if (!encodedId) return respond(404, 'Not found')
  let id: string
  try {
    id = decodeURIComponent(encodedId)
  } catch {
    return respond(404, 'Not found')
  }
  const provider = runtime.config.providers.find((entry) => entry.id === id)
  if (!provider) return respond(404, 'Not found')

  try {
    if (req.method === 'GET' && !action) {
      const context = url.searchParams.get('invite')
      const path = returnPath(url.searchParams.get('return'), runtime.config.manageOrigin)
      return await start(
        req,
        runtime,
        provider,
        path,
        null,
        context && inviteKey.test(context) ? context : null,
      )
    }
    if (req.method === 'GET' && action === 'callback')
      return await callback(req, runtime, provider, url.searchParams)
    if (req.method === 'POST' && action === 'backchannel-logout')
      return await backchannel(req, runtime, provider)
    return respond(404, 'Not found')
  } catch (error) {
    if (error instanceof ProviderUnavailable) return respond(503, 'Identity provider unavailable')
    throw error
  }
}

export async function requireBrowserSession(
  req: Request,
  runtime: Runtime,
): Promise<BrowserSession | Response> {
  const session = readCookie(req, sessionCookie)
  const now = Date.now()
  const current = session ? await readSession(runtime.env.DB, await hashSecret(session), now) : null
  const provider = current && runtime.config.providers.find((entry) => entry.id === current.provider)
  const url = new URL(req.url)
  const path = returnPath(url.pathname + url.search, runtime.config.manageOrigin)
  if (!current || !provider || current.member.status === 'removed') {
    return respond(
      302,
      null,
      `/login?${new URLSearchParams({ return: path })}`,
      session ? writeCookie(sessionCookie, '', 0) : undefined,
    )
  }
  if (sessionIsFresh(provider, current, now)) return current
  if (!isDocumentNavigation(req)) {
    return respond(401, 'Session revalidation required')
  }
  try {
    return await start(req, runtime, provider, path, current.idHash)
  } catch (error) {
    if (error instanceof ProviderUnavailable) return respond(503, 'Identity provider unavailable')
    throw error
  }
}
