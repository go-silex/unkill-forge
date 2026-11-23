import type { Config } from '../config'

export function checkManageOrigin(request: Request, path: string, config: Config): Response | null {
  const origin = request.headers.get('Origin')
  if (origin === config.readOrigin) return new Response('Forbidden origin', { status: 403 })
  if (path === '/mcp' && origin !== null && !config.mcpAllowedOrigins.includes(origin)) {
    return new Response('Forbidden origin', { status: 403 })
  }
  if (
    request.method === 'POST' &&
    ['/authorize', '/logout', '/admin/members', '/admin/bots'].includes(path) &&
    origin !== config.manageOrigin
  ) {
    return new Response('Forbidden origin', { status: 403 })
  }
  return null
}

export function manageHeaders(response: Response, formTarget?: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  // `no-referrer` would make browsers send `Origin: null` on same-origin form POSTs.
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'same-origin')
  // Chrome checks the POST redirect against form-action as well as the form target.
  if (!headers.has('Content-Security-Policy')) {
    const formAction = formTarget ? `; form-action 'self' ${formTarget}` : "; form-action 'self'"
    headers.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'${formAction}`,
    )
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
