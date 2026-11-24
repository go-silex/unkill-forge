import type { Config } from '../config'
import { messages } from '../i18n'
import { copyScriptSource } from './ui/page'

export function checkManageOrigin(request: Request, path: string, config: Config): Response | null {
  const origin = request.headers.get('Origin')
  const forbidden = () => new Response(messages(config).forbiddenOrigin, { status: 403 })
  if (origin === config.readOrigin) return forbidden()
  if (path === '/mcp')
    return origin === null || config.mcpAllowedOrigins.includes(origin) ? null : forbidden()
  // Only protocol endpoints accept POSTs without a same-origin browser form.
  if (
    request.method === 'POST' &&
    origin !== config.manageOrigin &&
    path !== '/token' &&
    path !== '/register' &&
    !/^\/login\/[^/]+\/backchannel-logout$/.test(path)
  )
    return forbidden()
  return null
}

export function manageCsp(fonts: boolean, formTarget?: string): string {
  const formAction = formTarget ? `; form-action 'self' ${formTarget}` : "; form-action 'self'"
  const fontSource = fonts ? "; font-src 'self'" : ''
  return `default-src 'none'; style-src 'self'; img-src 'self'${fontSource}; script-src ${copyScriptSource}; base-uri 'none'; frame-ancestors 'none'${formAction}`
}

export function manageHeaders(response: Response, formTarget?: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  // `no-referrer` would make browsers send `Origin: null` on same-origin form POSTs.
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'same-origin')
  // Chrome checks the POST redirect against form-action as well as the form target.
  if (!headers.has('Content-Security-Policy')) {
    headers.set(
      'Content-Security-Policy',
      manageCsp(!!headers.get('Content-Type')?.startsWith('text/html'), formTarget),
    )
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
