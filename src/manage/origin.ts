import type { Config } from '../config'

export function checkManageOrigin(request: Request, path: string, config: Config): Response | null {
  const origin = request.headers.get('Origin')
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

export function manageHeaders(response: Response, consent: boolean): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  // Chrome checks the POST redirect against form-action as well as the form target.
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'" +
      (consent ? '' : "; form-action 'self'"),
  )
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
