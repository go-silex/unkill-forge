import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { AccessCard } from '../../access-card'
import type { Runtime } from '../../config'
import { consumeConsent, type Grant, hashSecret, putConsent, randomSecret, readSession } from '../../core'
import { readForm } from '../../http'
import { messages } from '../../i18n'
import { manageAccessResponse, manageError, PendingAccess } from '../access'
import { requireBrowserSession } from '../login'
import { manageHeaders } from '../origin'
import { Badge } from '../ui/page'

export async function authorize(
  request: Request,
  runtime: Runtime,
  helpers: OAuthHelpers,
  localClientId: string,
): Promise<Response> {
  const common = messages(runtime.config)
  const text = common.consent
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response(request.method === 'HEAD' ? null : text.methodNotAllowed, {
      status: 405,
      headers: { Allow: 'GET, POST', 'Content-Type': 'text/plain;charset=UTF-8' },
    })
  }
  const session = await requireBrowserSession(request, runtime)
  if (session instanceof Response) return session
  if (session.member.status !== 'active')
    return manageAccessResponse(<PendingAccess config={runtime.config} member={session.member} />, 403)
  const {
    config,
    env: { DB },
  } = runtime
  try {
    if (request.method === 'GET') {
      const authRequest = await helpers.parseAuthRequest(request)
      if (
        authRequest.codeChallengeMethod !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(authRequest.codeChallenge ?? '')
      ) {
        return Response.redirect(
          authorizationErrorRedirect(authRequest, 'invalid_request', 'PKCE S256 is required'),
        )
      }
      const consent = await helpers.describeConsent(authRequest)
      const local = authRequest.clientId === localClientId
      const redirect = new URL(authRequest.redirectUri)
      const token = randomSecret()
      await putConsent(DB, await hashSecret(token), session.idHash, request.url, Date.now())
      const page = (
        <AccessCard
          config={config}
          variant="consent"
          title={text.title(config.name)}
          lead={text.lead}
          note={text.note}
          homeLink
          facts={[
            [text.client, local ? text.localClient : consent.clientName],
            [
              text.domain,
              consent.clientDomain && !local ? (
                <>
                  <code>{consent.clientDomain}</code> <Badge variant="ok">{text.verified}</Badge>
                </>
              ) : (
                <Badge variant="warn">{local ? text.unverifiedLocal : text.unverified}</Badge>
              ),
            ],
            [
              text.destination,
              <>
                <code>{consent.redirectIsLoopback ? redirect.host : consent.redirectHost}</code>
                {consent.redirectIsLoopback && <p>{text.loopback}</p>}
              </>,
            ],
            [text.actingAs, `${session.member.name} (${common.roles[session.member.role]})`],
          ]}
          actions={
            <form
              class="forge-action forge-card-actions forge-card-actions--pair"
              method="post"
              action="/authorize"
            >
              <input type="hidden" name="consent" value={token} />
              <button class="forge-button" type="submit" name="decision" value="deny">
                {text.deny}
              </button>
              <button
                class="forge-button forge-button--primary"
                type="submit"
                name="decision"
                value="approve"
              >
                {text.allow}
              </button>
            </form>
          }
        />
      )
      const target =
        redirect.protocol === 'https:' || redirect.protocol === 'http:' ? redirect.origin : redirect.protocol
      return manageHeaders(
        new Response(`<!doctype html>${await page.toString()}`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
        target,
      )
    }
    const form = await readForm(request)
    if (!form) return manageError(config, 400, text.invalidForm, { home: '/artefacts' })
    const token = form.get('consent')
    const decision = form.get('decision')
    if (
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      (decision !== 'approve' && decision !== 'deny')
    ) {
      return manageError(config, 400, text.invalidForm, { home: '/artefacts' })
    }
    const stored = await consumeConsent(DB, await hashSecret(token), session.idHash, Date.now())
    if (!stored) return manageError(config, 400, text.expiredConsent, { home: '/artefacts' })
    // Reconstruct from the request bound at render time, never from editable form fields.
    const authRequest = await helpers.parseAuthRequest(new Request(stored))
    if (decision === 'deny')
      return Response.redirect(authorizationErrorRedirect(authRequest, 'access_denied'), 303)
    const grantedAt = Date.now()
    const current = await readSession(DB, session.idHash, grantedAt)
    // Check after timestamping: a concurrent back-channel event either kills this session
    // before this query, or is new enough to kill the grant on code exchange.
    if (current?.member.status !== 'active')
      return manageError(config, 401, text.signInAgain, { home: '/login' })
    const props: Grant = {
      memberId: current.member.id,
      provider: current.provider,
      subject: current.subject,
      sid: current.sid,
      grantedAt,
      generation: current.generation,
    }
    const { redirectTo } = await helpers.completeAuthorization({
      request: authRequest,
      userId: props.memberId,
      metadata: {},
      props,
      scope: authRequest.scope,
      revokeExistingGrants: false,
    })
    // KV requires one second between this grant write and the code exchange's rewrite.
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 1_000)
    await promise
    return Response.redirect(redirectTo, 303)
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return error.redirectTo
        ? Response.redirect(error.redirectTo, 303)
        : manageError(config, 400, text.invalidRequest, { home: '/artefacts' })
    }
    if (error instanceof CimdFetchError)
      return manageError(config, 503, text.metadataUnavailable, { home: '/artefacts' })
    throw error
  }
}
