import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import type { Runtime } from '../../config'
import { consumeConsent, type Grant, hashSecret, putConsent, randomSecret, readSession } from '../../core'
import { requireBrowserSession } from '../login'
import { manageHeaders } from '../origin'
import { Page } from '../ui'

export async function authorize(
  request: Request,
  runtime: Runtime,
  helpers: OAuthHelpers,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } })
  }
  const session = await requireBrowserSession(request, runtime)
  if (session instanceof Response) return session
  if (session.member.status !== 'active') return new Response('Pending access', { status: 403 })
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
      const token = randomSecret()
      await putConsent(DB, await hashSecret(token), session.idHash, request.url, Date.now())
      const page = (
        <Page config={config} title="Connect an agent">
          {consent.clientDomain ? (
            <p>
              Verified client domain: <strong>{consent.clientDomain}</strong>
            </p>
          ) : (
            <p>Unverified client</p>
          )}
          <p>Client: {consent.clientName}</p>
          <p>
            Redirect destination: <strong>{consent.redirectHost}</strong>
          </p>
          {consent.redirectIsLoopback && (
            <p>Warning: any local process could be listening on this loopback address.</p>
          )}
          <p>
            This client will act as {session.member.name} ({session.member.role}).
          </p>
          <form method="post" action="/authorize">
            <input type="hidden" name="consent" value={token} />
            <button type="submit" name="decision" value="approve">
              Allow
            </button>
            <button type="submit" name="decision" value="deny">
              Deny
            </button>
          </form>
        </Page>
      )
      const redirect = new URL(authRequest.redirectUri)
      const target =
        redirect.protocol === 'https:' || redirect.protocol === 'http:' ? redirect.origin : redirect.protocol
      return manageHeaders(
        new Response(`<!doctype html>${await page.toString()}`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
        target,
      )
    }
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return new Response('Invalid consent form', { status: 400 })
    }
    const token = form.get('consent')
    const decision = form.get('decision')
    if (
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      (decision !== 'approve' && decision !== 'deny')
    ) {
      return new Response('Invalid consent form', { status: 400 })
    }
    const stored = await consumeConsent(DB, await hashSecret(token), session.idHash, Date.now())
    if (!stored) return new Response('Expired or already used consent', { status: 400 })
    // Reconstruct from the request bound at render time, never from editable form fields.
    const authRequest = await helpers.parseAuthRequest(new Request(stored))
    if (decision === 'deny')
      return Response.redirect(authorizationErrorRedirect(authRequest, 'access_denied'), 303)
    const grantedAt = Date.now()
    const current = await readSession(DB, session.idHash, grantedAt)
    // Check after timestamping: a concurrent back-channel event either kills this session
    // before this query, or is new enough to kill the grant on code exchange.
    if (current?.member.status !== 'active') return new Response('Sign in again', { status: 401 })
    const props: Grant = {
      memberId: current.member.id,
      provider: current.provider,
      subject: current.subject,
      sid: current.sid,
      grantedAt,
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
        : new Response('Invalid authorization request', { status: 400 })
    }
    if (error instanceof CimdFetchError) return new Response('Client metadata unavailable', { status: 503 })
    throw error
  }
}
