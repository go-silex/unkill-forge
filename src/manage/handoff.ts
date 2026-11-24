import { html, raw } from 'hono/html'
import { forgePageSources } from '../brand'
import { BrandBlock } from '../brand-block'
import type { Runtime } from '../config'
import { issueHandoff, validHandoffState } from '../core/handoffs'
import { decodeReadReturnPath } from '../core/read-path'
import { DocumentHead } from '../head'
import { messages } from '../i18n'
import { requireBrowserSession } from './login'

const submitForm = 'document.getElementById("handoff").submit()'
// SHA-256 of submitForm. Keep the exact script bytes in sync with this policy.
const scriptSource = "'sha256-URepbhA+DqUVhzv7aMzRNbbiOS8Gagc0jMUfE593kVY='"

export async function manageHandoff(request: Request, url: URL, runtime: Runtime): Promise<Response> {
  const { config } = runtime
  const { locale, readOrigin } = config
  const { continueToForge: title, notFound } = messages(runtime.config)
  const mode = request.headers.get('Sec-Fetch-Mode')
  const dest = request.headers.get('Sec-Fetch-Dest')
  if (
    request.method !== 'GET' ||
    (mode !== null && mode !== 'navigate') ||
    (dest !== null && dest !== 'document')
  ) {
    return new Response(notFound, { status: 404 })
  }
  const state = url.searchParams.get('state')
  const nonce = url.searchParams.get('nonce')
  const path = decodeReadReturnPath(url.searchParams.get('return'), runtime.config.readOrigin)
  if (!validHandoffState(state) || !validHandoffState(nonce) || !path) {
    return new Response(notFound, { status: 404 })
  }
  const session = await requireBrowserSession(request, runtime)
  if (session instanceof Response) return session
  // Pending identities can complete the handoff, but cannot read private content.
  const code = await issueHandoff(runtime.env.DB, session, state, path)
  return new Response(
    html`<!doctype html><html lang="${locale}">${DocumentHead({ config, title })}<body>
<div class="forge-panel forge-panel--handoff">
<header class="forge-panel__header">${BrandBlock({ config })}</header>
<main class="forge-panel__body">
<form class="forge-action" id="handoff" method="post" action="${readOrigin}/_forge/session">
<input type="hidden" name="code" value="${code}">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="nonce" value="${nonce}">
<input type="hidden" name="return" value="${path}">
<button class="forge-button forge-button--primary" type="submit">${title}</button>
</form></main></div><script>${raw(submitForm)}</script></body></html>`.toString(),
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; ${forgePageSources}; base-uri 'none'; frame-ancestors 'none'; script-src ${scriptSource}; form-action ${readOrigin}`,
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  )
}
