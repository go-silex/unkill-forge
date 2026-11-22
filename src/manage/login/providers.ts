import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose'
import * as oauth from 'oauth4webapi'
import type { Provider } from '../../config'

type OidcProvider = Extract<Provider, { type: 'oidc' }>

const githubAuthorization = 'https://github.com/login/oauth/authorize'
const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout'
const transportTimeout = 5_000

export class ProviderUnavailable extends Error {}
export class IdentityDenied extends Error {}
export class SessionDenied extends Error {}
export class InvalidProviderResponse extends Error {}

// `error` comes verbatim from the callback query or the provider's token response; log only
// registered protocol codes (RFC 6749, OpenID Connect Core).
const knownOauthErrors: Record<string, true> = {
  invalid_request: true,
  invalid_client: true,
  invalid_grant: true,
  unauthorized_client: true,
  unsupported_grant_type: true,
  unsupported_response_type: true,
  invalid_scope: true,
  access_denied: true,
  server_error: true,
  temporarily_unavailable: true,
  interaction_required: true,
  login_required: true,
  account_selection_required: true,
  consent_required: true,
  invalid_request_uri: true,
  invalid_request_object: true,
  request_not_supported: true,
  request_uri_not_supported: true,
  registration_not_supported: true,
}

export interface Identity {
  subject: string
  name: string
  email: string | null
  emailVerified: boolean
  sid: string | null
  authTime: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function exact(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => exact(actual[index], value))
    )
  }
  if (!isObject(expected) || !isObject(actual)) return false
  const keys = Object.keys(expected)
  return (
    keys.length === Object.keys(actual).length &&
    keys.every((key) => Object.hasOwn(actual, key) && exact(actual[key], expected[key]))
  )
}

async function providerFetch(url: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(transportTimeout),
    })
  } catch {
    throw new ProviderUnavailable()
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderUnavailable()
  return response
}

const oauthTransport = { [oauth.customFetch]: providerFetch }

function httpsEndpoint(value: unknown): URL {
  if (!nonempty(value)) throw new ProviderUnavailable()
  const url = URL.parse(value)
  if (url?.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ProviderUnavailable()
  }
  return url
}

export async function discover(provider: OidcProvider): Promise<oauth.AuthorizationServer> {
  const issuer = httpsEndpoint(provider.issuer)
  try {
    const response = await oauth.discoveryRequest(issuer, oauthTransport)
    return await oauth.processDiscoveryResponse(issuer, response)
  } catch {
    throw new ProviderUnavailable()
  }
}

export async function authorizationEndpoint(provider: Provider): Promise<URL> {
  if (provider.type === 'github') return new URL(githubAuthorization)
  return httpsEndpoint((await discover(provider)).authorization_endpoint)
}

function remoteKeys(as: oauth.AuthorizationServer) {
  return createRemoteJWKSet(httpsEndpoint(as.jwks_uri), {
    [customFetch]: async (url, init) => {
      const response = await providerFetch(url, init)
      if (response.status !== 200) throw new ProviderUnavailable()
      return response
    },
  })
}

function verificationError(error: unknown): never {
  if (error instanceof ProviderUnavailable || error instanceof InvalidProviderResponse) throw error
  if (
    error instanceof errors.JWKSTimeout ||
    (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  ) {
    throw new ProviderUnavailable()
  }
  const code = (error as { code?: unknown } | null)?.code
  const oauthError =
    error instanceof oauth.ResponseBodyError || error instanceof oauth.AuthorizationResponseError
      ? `:${Object.hasOwn(knownOauthErrors, error.error) ? error.error : 'unrecognized'}`
      : ''
  throw new InvalidProviderResponse((typeof code === 'string' ? code : 'invalid_response') + oauthError)
}

interface Exchange {
  params: URLSearchParams
  redirectUri: string
  state: string
  verifier: string
}

export async function oidcIdentity(
  provider: OidcProvider,
  { params, redirectUri, state, verifier }: Exchange,
  nonce: string,
  expectedSubject?: string,
): Promise<Identity> {
  const as = await discover(provider)
  httpsEndpoint(as.token_endpoint)
  httpsEndpoint(as.userinfo_endpoint)
  const client: oauth.Client = { client_id: provider.clientId }
  // Each registration accepts one method, whatever discovery advertises (Google rejects the
  // form-encoded Basic credentials of RFC 6749 §2.3.1; some Better Auth clients reject POST).
  const clientAuth =
    provider.tokenAuthMethod === 'client_secret_post'
      ? oauth.ClientSecretPost(provider.clientSecret)
      : oauth.ClientSecretBasic(provider.clientSecret)

  try {
    if (params.has('access_token') || (params.has('error') && params.has('code'))) {
      throw new InvalidProviderResponse()
    }
    const parameters = oauth.validateAuthResponse(as, client, params, state)
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuth,
      parameters,
      redirectUri,
      verifier,
      oauthTransport,
    )
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: nonce,
    })
    // oauth4webapi validates the nonce and OIDC response semantics; jose must also verify the JWS.
    if (!tokens.id_token) throw new InvalidProviderResponse()
    const keys = remoteKeys(as)
    const { payload } = await jwtVerify(tokens.id_token, keys, {
      issuer: as.issuer,
      audience: provider.clientId,
      requiredClaims: ['sub', 'iat', 'exp'],
      ...(as.id_token_signing_alg_values_supported && {
        algorithms: as.id_token_signing_alg_values_supported,
      }),
    })
    if (!nonempty(payload.sub)) throw new InvalidProviderResponse()
    if (payload.azp !== undefined && payload.azp !== provider.clientId) throw new InvalidProviderResponse()
    if (expectedSubject !== undefined && payload.sub !== expectedSubject) throw new SessionDenied()

    const responseInfo = await oauth.userInfoRequest(as, client, tokens.access_token, oauthTransport)
    const signedInfo =
      responseInfo.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/jwt'
    if (signedInfo) await jwtVerify(await responseInfo.clone().text(), keys)
    const userInfo = await oauth.processUserInfoResponse(as, client, oauth.skipSubjectCheck, responseInfo)
    if (userInfo.sub !== payload.sub) throw new SessionDenied()
    for (const [claim, expected] of Object.entries(provider.requireClaims ?? {})) {
      if (
        !Object.hasOwn(payload, claim) ||
        !Object.hasOwn(userInfo, claim) ||
        !exact(payload[claim], expected) ||
        !exact(userInfo[claim], expected)
      ) {
        throw new IdentityDenied(`required_claim:${claim}`)
      }
    }
    if (
      provider.hostedDomains?.length &&
      (!nonempty(payload.hd) || !provider.hostedDomains.includes(payload.hd))
    ) {
      throw new IdentityDenied('hosted_domain')
    }

    const emailClaims = nonempty(userInfo.email) ? userInfo : payload
    const email = nonempty(emailClaims.email) ? emailClaims.email : null
    const authTime = payload.auth_time ?? payload.iat
    if (
      typeof authTime !== 'number' ||
      !Number.isFinite(authTime) ||
      (payload.sid !== undefined && !nonempty(payload.sid))
    ) {
      throw new InvalidProviderResponse()
    }
    return {
      subject: payload.sub,
      name: nonempty(userInfo.name)
        ? userInfo.name
        : nonempty(payload.name)
          ? payload.name
          : (email ?? payload.sub),
      email,
      emailVerified: email !== null && emailClaims.email_verified === true,
      sid: nonempty(payload.sid) ? payload.sid : null,
      authTime: authTime * 1_000,
    }
  } catch (error) {
    if (error instanceof IdentityDenied || error instanceof SessionDenied) throw error
    if (
      error instanceof oauth.AuthorizationResponseError &&
      (error.error === 'login_required' ||
        error.error === 'interaction_required' ||
        error.error === 'consent_required' ||
        error.error === 'account_selection_required')
    ) {
      throw new SessionDenied()
    }
    if (
      (error instanceof oauth.AuthorizationResponseError || error instanceof oauth.ResponseBodyError) &&
      (error.error === 'server_error' || error.error === 'temporarily_unavailable')
    ) {
      throw new ProviderUnavailable()
    }
    verificationError(error)
  }
}

async function githubJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await providerFetch(url, init)
  if (!response.ok) throw new InvalidProviderResponse()
  try {
    return await response.json()
  } catch (error) {
    verificationError(error)
  }
}

export async function githubIdentity(
  provider: Provider,
  { params, redirectUri, verifier }: Exchange,
): Promise<Identity> {
  const code = params.get('code')
  if (
    !code ||
    params.getAll('code').length !== 1 ||
    params.has('error') ||
    params.has('access_token') ||
    params.has('id_token') ||
    params.has('token')
  ) {
    throw new InvalidProviderResponse()
  }
  const token = await githubJson('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  })
  if (
    !isObject(token) ||
    typeof token.token_type !== 'string' ||
    token.token_type.toLowerCase() !== 'bearer' ||
    !nonempty(token.access_token)
  ) {
    throw new InvalidProviderResponse()
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token.access_token}`,
    'User-Agent': 'unkill-forge',
  }
  const [user, emails] = await Promise.all([
    githubJson('https://api.github.com/user', { headers }),
    githubJson('https://api.github.com/user/emails', { headers }),
  ])
  if (
    !isObject(user) ||
    typeof user.id !== 'number' ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !Array.isArray(emails)
  ) {
    throw new InvalidProviderResponse()
  }
  const primary = emails.find(
    (entry): entry is Record<string, unknown> =>
      isObject(entry) && entry.primary === true && entry.verified === true && nonempty(entry.email),
  )
  const email = nonempty(primary?.email) ? primary.email : null
  const subject = String(user.id)
  return {
    subject,
    name: nonempty(user.name) ? user.name : nonempty(user.login) ? user.login : subject,
    email,
    emailVerified: email !== null,
    sid: null,
    authTime: Date.now(),
  }
}

export async function parseLogoutToken(as: oauth.AuthorizationServer, provider: Provider, token: string) {
  try {
    const now = Date.now()
    const { payload } = await jwtVerify(token, remoteKeys(as), {
      issuer: as.issuer,
      audience: provider.clientId,
      requiredClaims: ['iat', 'exp', 'jti', 'events'],
      currentDate: new Date(now),
      maxTokenAge: 300,
      ...(as.id_token_signing_alg_values_supported && {
        algorithms: as.id_token_signing_alg_values_supported,
      }),
    })
    const { sid, sub, jti, events } = payload
    if (
      !nonempty(jti) ||
      !isObject(events) ||
      !Object.hasOwn(events, logoutEvent) ||
      !isObject(events[logoutEvent]) ||
      Object.hasOwn(payload, 'nonce') ||
      (sid !== undefined && !nonempty(sid)) ||
      (sub !== undefined && !nonempty(sub)) ||
      (sid === undefined && sub === undefined)
    ) {
      throw new InvalidProviderResponse()
    }
    return { jti, subject: sub ?? null, sid: sid ?? null }
  } catch (error) {
    verificationError(error)
  }
}
