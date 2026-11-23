import { html } from 'hono/html'
import type { Runtime } from '../config'
import { issueHandoff, validHandoffState } from '../core/handoffs'
import { readReturnPath } from '../core/read-path'
import { requireBrowserSession } from './login'

const submitForm = 'document.getElementById("handoff").submit()'
// SHA-256 of submitForm. Keep the exact script bytes in sync with this policy.
const scriptSource = "'sha256-URepbhA+DqUVhzv7aMzRNbbiOS8Gagc0jMUfE593kVY='"

export async function manageHandoff(request: Request, url: URL, runtime: Runtime): Promise<Response> {
  const mode = request.headers.get('Sec-Fetch-Mode')
  const dest = request.headers.get('Sec-Fetch-Dest')
  if (
    request.method !== 'GET' ||
    (mode !== null && mode !== 'navigate') ||
    (dest !== null && dest !== 'document')
  ) {
    return new Response('Not found', { status: 404 })
  }
  const state = url.searchParams.get('state')
  const nonce = url.searchParams.get('nonce')
  const path = readReturnPath(url.searchParams.get('return'), runtime.config.readOrigin)
  if (!validHandoffState(state) || !validHandoffState(nonce) || !path) {
    return new Response('Not found', { status: 404 })
  }
  const session = await requireBrowserSession(request, runtime)
  if (session instanceof Response) return session
  // Pending identities can complete the handoff, but cannot read private content.
  const code = await issueHandoff(runtime.env.DB, session, state, path)
  const { readOrigin } = runtime.config
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Continue to Forge</title>
<form id="handoff" method="post" action="${readOrigin}/_forge/session">
<input type="hidden" name="code" value="${code}">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="nonce" value="${nonce}">
${html`<input type="hidden" name="return" value="${path}">`}
<button type="submit">Continue to Forge</button>
</form><script>${submitForm}</script></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src ${scriptSource}; form-action ${readOrigin}`,
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  )
}
