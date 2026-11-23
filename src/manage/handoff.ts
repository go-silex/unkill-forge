import type { Runtime } from '../config'
import { issueHandoff, validHandoffState } from '../core/handoffs'
import { readReturnPath } from '../core/read-path'
import { requireBrowserSession } from './login'

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
  const path = readReturnPath(url.searchParams.get('return'), runtime.config.readOrigin)
  if (!validHandoffState(state) || !path) return new Response('Not found', { status: 404 })
  const session = await requireBrowserSession(request, runtime)
  if (session instanceof Response) return session
  // Pending identities can complete the handoff, but cannot read private content.
  const code = await issueHandoff(runtime.env.DB, session, state, path)
  const target = new URL('/_forge/session', runtime.config.readOrigin)
  target.search = new URLSearchParams({ code, state }).toString()
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, 'Referrer-Policy': 'no-referrer' },
  })
}
