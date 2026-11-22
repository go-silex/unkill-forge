import { OAuthError, type OAuthHelpers, OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'
import type { Config, Env, Runtime } from '../../config'
import { activeMember, grantMember, type Member } from '../../core'
import { useApiToken } from '../../core/admin'
import { handleMcp } from '../mcp'
import { authorize } from './consent'

const grant = z.object({
  memberId: z.uuid(),
  provider: z.string(),
  subject: z.string(),
  grantedAt: z.number(),
})
const apiToken = z.object({ memberId: z.uuid(), viaToken: z.literal(true) })
const providers = new WeakMap<Config, OAuthProvider<Env>>()

export function oauthFetch(request: Request, runtime: Runtime, ctx: ExecutionContext): Promise<Response> {
  const { config, env } = runtime
  let provider = providers.get(config)
  if (!provider) {
    const resource = `${config.manageOrigin}/mcp`
    provider = new OAuthProvider<Env>({
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
      async tokenExchangeCallback({ props, userId, env: bindings }) {
        const parsed = grant.safeParse(props)
        if (!parsed.success || parsed.data.memberId !== userId) {
          throw new OAuthError('invalid_grant', { description: 'Invalid authorization grant' })
        }
        let member: Member | null
        try {
          member = await grantMember(bindings.DB, parsed.data)
        } catch {
          throw new OAuthError('temporarily_unavailable', {
            description: 'Authorization unavailable',
            statusCode: 503,
          })
        }
        if (!member) throw new OAuthError('invalid_grant', { description: 'Authorization revoked' })
      },
      async resolveExternalToken({ token, env: bindings }) {
        const memberId = await useApiToken(bindings.DB, token, Date.now())
        return memberId ? { props: { memberId, viaToken: true }, audience: resource } : null
      },
      apiHandler: {
        async fetch(req, bindings, auth) {
          const external = apiToken.safeParse(auth.props)
          const oauth = grant.safeParse(auth.props)
          const member = external.success
            ? await activeMember(bindings.DB, external.data.memberId)
            : oauth.success
              ? await grantMember(bindings.DB, oauth.data)
              : null
          if (!member) {
            const metadata = `${config.manageOrigin}/.well-known/oauth-protected-resource/mcp`
            return new Response(null, {
              status: 401,
              headers: {
                'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${metadata}", error="invalid_token"`,
              },
            })
          }
          return handleMcp(req, config, member)
        },
      },
      defaultHandler: {
        fetch(req, bindings) {
          if (new URL(req.url).pathname !== '/authorize') return new Response('Not found', { status: 404 })
          return authorize(req, { config, env: bindings }, bindings.OAUTH_PROVIDER as OAuthHelpers)
        },
      },
    })
    providers.set(config, provider)
  }
  return provider.fetch(request, { ...env, OAUTH_PROVIDER: undefined }, ctx)
}
