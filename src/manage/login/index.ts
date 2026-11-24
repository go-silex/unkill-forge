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
import { formBodyLimit, isDocumentNavigation, readBoundedBody, readCookie, writeCookie } from '../../http'
import { messages } from '../../i18n'
import { manageError } from '../access'
import {
  authorizationEndpoint,
  discover,
  githubIdentity,
  type Identity,
  IdentityDenied,
  InteractionRequired,
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

function readOpaqueCookie(request: Request, name: string): string | null {
  const value = readCookie(request, name)
  return value !== null && /^[\w-]+$/.test(value) ? value : null
}

function respond(status: number, body: string | null, location?: string, cookie?: string): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  if (location) headers.set('Location', location)
  if (cookie) headers.append('Set-Cookie', cookie)
  return new Response(body, { status, headers })
}

function loginError(runtime: Runtime, status: 400 | 401 | 403 | 404 | 503, lead: string, cookie?: string) {
  return manageError(runtime.config, status, lead, { retry: true, noReferrer: true, cookie })
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
  session: { idHash: string; loginHint: string; startedAt?: number } | null,
  inviteContext: string | null = null,
): Promise<Response> {
  const now = Date.now()
  const inviteCookie = inviteContext === null ? null : inviteCookiePrefix + inviteContext
  const inviteBrowser = inviteCookie === null ? null : readOpaqueCookie(req, inviteCookie)
  const browser = readOpaqueCookie(req, flowCookie) ?? randomSecret()
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
  if (session !== null) {
    params.set('login_hint', session.loginHint)
    if (session.startedAt === undefined) params.set('prompt', 'none')
    else params.delete('prompt')
  }

  const [stateHash, browserHash] = await Promise.all([hashSecret(state), hashSecret(browser)])
  await putFlow(runtime.env.DB, {
    stateHash,
    browserHash,
    provider: provider.id,
    returnPath: path,
    sessionHash: session?.idHash ?? null,
    retryLoginHint: session?.startedAt === undefined ? (session?.loginHint ?? null) : null,
    createdAt: session?.startedAt ?? now,
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
  const text = messages(runtime.config).login
  const state = params.get('state')
  const browser = readOpaqueCookie(req, flowCookie)
  if (!state || params.getAll('state').length !== 1 || !browser)
    return loginError(runtime, 400, text.invalidFlow)

  const now = Date.now()
  const [stateHash, browserHash] = await Promise.all([hashSecret(state), hashSecret(browser)])
  const db = runtime.env.DB
  const flow = await consumeFlow(db, { stateHash, browserHash, provider: provider.id, now })
  if (!flow) return loginError(runtime, 400, text.invalidFlow)

  let previous: BrowserSession | null = null
  if (flow.sessionHash !== null) {
    const session = readOpaqueCookie(req, sessionCookie)
    if (!session || provider.type !== 'oidc' || (await hashSecret(session)) !== flow.sessionHash) {
      return loginError(runtime, 401, text.invalidSession)
    }
    previous = await readSession(db, flow.sessionHash, now)
    if (!previous || previous.provider !== provider.id) {
      return loginError(runtime, 401, text.invalidSession)
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
    if (error instanceof InteractionRequired && previous && flow.retryLoginHint !== null) {
      return start(req, runtime, provider, flow.returnPath, {
        idHash: previous.idHash,
        loginHint: flow.retryLoginHint,
        // Revocations during the silent attempt still apply to the retry.
        startedAt: flow.createdAt,
      })
    }
    if (
      error instanceof IdentityDenied ||
      error instanceof SessionDenied ||
      error instanceof InvalidProviderResponse
    ) {
      // Reasons are claim names or library error codes, never claim values.
      console.warn('Sign-in refused', provider.id, error.constructor.name, error.message)
    }
    if (error instanceof IdentityDenied || error instanceof SessionDenied) {
      if (!previous) return loginError(runtime, 401, text.loginRefused)
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
      return loginError(runtime, 401, text.loginRequired, writeCookie(sessionCookie, '', 0))
    }
    if (error instanceof InvalidProviderResponse) return loginError(runtime, 401, text.loginRefused)
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
      const current = await readSession(db, previous.idHash, Date.now())
      if (current) {
        if (current.validatedAt >= flow.createdAt) return respond(302, null, path)
        return loginError(runtime, 401, text.invalidSession)
      }
      return loginError(runtime, 401, text.invalidSession, writeCookie(sessionCookie, '', 0))
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
  if (member.status === 'removed') return loginError(runtime, 403, text.loginRefused)
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
    return loginError(runtime, 401, text.loginRefused)
  const priorCookie = readOpaqueCookie(req, sessionCookie)
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
  if ((await readBoundedBody(req, formBodyLimit)) === null) {
    const text = messages(runtime.config).login
    return respond(413, text.logoutTooLarge)
  }
  const session = readOpaqueCookie(req, sessionCookie)
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
  const backchannelRequest = action === 'backchannel-logout'
  const notFound = () => {
    const lead = backchannelRequest ? 'Not found' : messages(runtime.config).notFound
    if (req.method === 'HEAD')
      return new Response(null, {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Type': 'text/plain;charset=UTF-8',
        },
      })
    return !backchannelRequest && req.method === 'GET' ? loginError(runtime, 404, lead) : respond(404, lead)
  }
  if (!encodedId) return notFound()
  let id: string
  try {
    id = decodeURIComponent(encodedId)
  } catch {
    return notFound()
  }
  const provider = runtime.config.providers.find((entry) => entry.id === id)
  if (!provider) return notFound()

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
    return notFound()
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      const { login } = messages(backchannelRequest ? { locale: 'en' } : runtime.config)
      return backchannelRequest
        ? respond(503, login.providerUnavailable)
        : loginError(runtime, 503, login.providerUnavailable)
    }
    throw error
  }
}

export async function requireBrowserSession(
  req: Request,
  runtime: Runtime,
): Promise<BrowserSession | Response> {
  const session = readOpaqueCookie(req, sessionCookie)
  const now = Date.now()
  const current = session ? await readSession(runtime.env.DB, await hashSecret(session), now) : null
  const provider = current && runtime.config.providers.find((entry) => entry.id === current.provider)
  const url = new URL(req.url)
  const path = returnPath(url.pathname + url.search, runtime.config.manageOrigin)
  if (!current || !provider) {
    return respond(
      302,
      null,
      `/login?${new URLSearchParams({ return: path })}`,
      session ? writeCookie(sessionCookie, '', 0) : undefined,
    )
  }
  if (sessionIsFresh(provider, current, now)) return current
  const text = messages(runtime.config).login
  if (!isDocumentNavigation(req)) {
    return respond(401, text.revalidationRequired)
  }
  try {
    return await start(req, runtime, provider, path, current)
  } catch (error) {
    if (error instanceof ProviderUnavailable) return loginError(runtime, 503, text.providerUnavailable)
    throw error
  }
}
