import { OAuthError, type OAuthHelpers, OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'
import type { Config, Env, Runtime } from '../../config'
import {
  activeMember,
  grantMember,
  type Member,
  recordAuthorizationCodeReplay,
  redeemAuthorizationCode,
  releaseAuthorizationCode,
} from '../../core'
import { useApiToken } from '../../core/admin'
import { readBoundedBody } from '../../http'
import { handleMcp } from '../mcp'
import { manageHeaders } from '../origin'
import { authorize } from './consent'

const grant = z.object({
  memberId: z.uuid(),
  provider: z.string(),
  subject: z.string(),
  sid: z.string().nullable(),
  grantedAt: z.number(),
  generation: z.number().int().nonnegative(),
  grantId: z.string().optional(),
})
const apiToken = z.object({
  memberId: z.uuid(),
  generation: z.int().nonnegative(),
  viaToken: z.literal(true),
})
type Redemption = { grantId?: string; retryableGrantWriteFailed: boolean }
type OAuthEnv = Env & { redemption?: Redemption }
const providers = new WeakMap<Config, OAuthProvider<OAuthEnv>>()
export const localClientPath = '/oauth/clients/local.json'

export function localClientDocument(config: Config): Response {
  const response = manageHeaders(
    Response.json({
      client_id: config.manageOrigin + localClientPath,
      client_name: 'Local MCP client',
      redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  )
  response.headers.set('Cache-Control', 'public, max-age=300')
  return response
}

export async function oauthFetch(
  request: Request,
  runtime: Runtime,
  ctx: ExecutionContext,
): Promise<Response> {
  const { config, env } = runtime
  let provider = providers.get(config)
  if (!provider) {
    const resource = `${config.manageOrigin}/mcp`
    provider = new OAuthProvider<OAuthEnv>({
      apiRoute: '/mcp',
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      ...(config.allowDcr ? { clientRegistrationEndpoint: '/register' } : {}),
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3_600,
      refreshTokenTTL: 7 * 24 * 3_600,
      scopesSupported: ['mcp'],
      allowPrivateUseRedirectUris: true,
      allowTokenExchangeGrant: false,
      resourceMetadata: {
        resource,
        authorization_servers: [config.manageOrigin],
        resource_name: config.name,
      },
      async tokenExchangeCallback({ grantType, grantId, props, userId, env: bindings }) {
        const parsed = grant.safeParse(props)
        if (
          !parsed.success ||
          parsed.data.memberId !== userId ||
          (parsed.data.grantId && parsed.data.grantId !== grantId)
        ) {
          throw new OAuthError('invalid_grant', { description: 'Invalid authorization grant' })
        }
        let member: Member | null
        let redeemed = true
        try {
          member = await grantMember(bindings.DB, parsed.data, grantId)
          if (member && grantType === 'authorization_code') {
            redeemed = await redeemAuthorizationCode(bindings.DB, grantId, Date.now())
            if (redeemed && bindings.redemption) bindings.redemption.grantId = grantId
          }
        } catch {
          throw new OAuthError('temporarily_unavailable', {
            description: 'Authorization unavailable',
            statusCode: 503,
          })
        }
        if (!member) throw new OAuthError('invalid_grant', { description: 'Authorization revoked' })
        if (!redeemed)
          throw new OAuthError('invalid_grant', { description: 'Authorization code already used' })
        if (!parsed.data.grantId) return { newProps: { ...parsed.data, grantId } }
      },
      async resolveExternalToken({ token, env: bindings }) {
        const credential = await useApiToken(bindings.DB, token, Date.now())
        return credential ? { props: { ...credential, viaToken: true }, audience: resource } : null
      },
      apiHandler: {
        async fetch(req, bindings, auth) {
          const external = apiToken.safeParse(auth.props)
          const oauth = grant.safeParse(auth.props)
          const credential = external.success ? external.data : oauth.data
          const member = external.success
            ? await activeMember(bindings.DB, external.data.memberId)
            : oauth.success && oauth.data.grantId
              ? await oauthMember(bindings, oauth.data, oauth.data.grantId)
              : null
          if (!member || !credential) {
            const metadata = `${config.manageOrigin}/.well-known/oauth-protected-resource/mcp`
            return new Response(null, {
              status: 401,
              headers: {
                'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${metadata}", error="invalid_token"`,
              },
            })
          }
          if (req.method === 'GET')
            return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } })
          return handleMcp(
            req,
            { config, env: bindings },
            { ...member, generation: credential.generation },
            auth,
          )
        },
      },
      defaultHandler: {
        fetch(req, bindings) {
          if (new URL(req.url).pathname !== '/authorize') return new Response('Not found', { status: 404 })
          return authorize(
            req,
            { config, env: bindings },
            bindings.OAUTH_PROVIDER as OAuthHelpers,
            config.manageOrigin + localClientPath,
          )
        },
      },
    })
    providers.set(config, provider)
  }
  const bindings: OAuthEnv = { ...env, OAUTH_PROVIDER: undefined }
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/token') {
    return provider.fetch(request, bindings, ctx)
  }
  return exchangeToken(provider, request, bindings, ctx)
}

async function oauthMember(bindings: Env, claims: z.infer<typeof grant>, grantId: string) {
  // OAuth Provider 1.2.4 refresh uses this same grant key. A token record alone is not enough.
  const key = `grant:${claims.memberId}:${grantId}`
  if ((await bindings.OAUTH_KV.get(key)) === null) return null
  return grantMember(bindings.DB, claims, grantId)
}

const tokenBodyLimit = 16 * 1024

async function exchangeToken(
  provider: OAuthProvider<OAuthEnv>,
  request: Request,
  bindings: OAuthEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const redemption: Redemption = { retryableGrantWriteFailed: false }
  const body = await readBoundedBody(request, tokenBodyLimit)
  if (body === null) {
    return Response.json(
      { error: 'invalid_request', error_description: 'Token request body exceeds 16 KiB' },
      { status: 413, headers: tokenCorsHeaders(request) },
    )
  }
  const form = await tokenForm(request, body)
  if (form && form.getAll('code').length > 1) {
    return Response.json(
      { error: 'invalid_request', error_description: 'Token request has more than one code' },
      { status: 400, headers: tokenCorsHeaders(request) },
    )
  }
  const kv = bindings.OAUTH_KV
  bindings.redemption = redemption
  bindings.OAUTH_KV = new Proxy(kv, {
    get(target, key) {
      if (key === 'put') {
        const put: KVNamespace['put'] = async (name, value, options) => {
          try {
            await kv.put(name, value, options)
          } catch (error) {
            // A rate-limited grant write was rejected before the code was consumed.
            // If an access-token write fails or the result is uncertain, do not release.
            redemption.retryableGrantWriteFailed =
              name.startsWith('grant:') &&
              error instanceof Error &&
              /429 Too Many Requests/i.test(error.message)
            throw error
          }
        }
        return put
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  let response: Response
  try {
    response = await provider.fetch(
      new Request(request.url, { method: request.method, headers: request.headers, body }),
      bindings,
      ctx,
    )
  } catch (error) {
    if (!redemption.grantId) throw error
    return restartAuthorization(request)
  }
  if (response.status === 400 && form) await recordProviderReplay(form, response, bindings.DB)
  if (!redemption.grantId || (response.status < 500 && response.status !== 429)) return response
  if (response.status === 429 && redemption.retryableGrantWriteFailed) {
    try {
      if (await releaseAuthorizationCode(bindings.DB, redemption.grantId)) return response
    } catch {
      console.warn('OAuth code reservation could not be released')
    }
  }
  return restartAuthorization(request, response)
}

// Provider 1.2.4 parses /token with Request.formData(); URLSearchParams can disagree on edge input.
async function tokenForm(request: Request, body: Uint8Array<ArrayBuffer>): Promise<FormData | null> {
  const headers = new Headers()
  const type = request.headers.get('Content-Type')
  if (type) headers.set('Content-Type', type)
  try {
    return await new Request(request.url, { method: 'POST', headers, body }).formData()
  } catch {
    return null
  }
}

async function recordProviderReplay(form: FormData, response: Response, db: D1Database): Promise<void> {
  const error = await response.clone().json<{ error?: string; error_description?: string }>()
  // Provider 1.2.4 emits this description only after checking the code hash and client.
  if (error.error !== 'invalid_grant' || error.error_description !== 'Authorization code already used') return
  const code = form.get('code')
  if (form.get('grant_type') !== 'authorization_code' || typeof code !== 'string') return
  const parts = code.split(':')
  if (parts.length !== 3 || !parts[1]) return
  for (const delay of [50, 150, 0]) {
    try {
      await recordAuthorizationCodeReplay(db, parts[1])
      return
    } catch (error) {
      if (!delay) {
        // The provider has already deleted the grant from KV; see docs/spec.md §13.
        console.warn('OAuth code replay marker could not be written', error)
        return
      }
      await scheduler.wait(delay)
    }
  }
}

function restartAuthorization(request: Request, replaced?: Response): Response {
  const headers = replaced ? new Headers() : tokenCorsHeaders(request)
  if (replaced) {
    for (const [name, value] of replaced.headers) {
      if (name.startsWith('access-control-') || name === 'vary') headers.set(name, value)
    }
  }
  return Response.json(
    { error: 'invalid_grant', error_description: 'Token issuance failed; start a new authorization' },
    { status: 400, headers },
  )
}

function tokenCorsHeaders(request: Request): Headers {
  // Errors generated outside the provider mirror its token-endpoint CORS policy.
  const origin = request.headers.get('Origin')
  return new Headers(
    origin
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': 'Authorization, *',
          'Access-Control-Max-Age': '86400',
          'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After',
          Vary: 'Origin',
        }
      : undefined,
  )
}
