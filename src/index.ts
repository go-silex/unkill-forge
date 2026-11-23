import { configuration, type Env } from './config'
import { manageHandoff } from './manage/handoff'
import { loginRoute } from './manage/login'
import { localClientDocument, localClientPath, oauthFetch } from './manage/oauth'
import { checkManageOrigin, manageHeaders } from './manage/origin'
import { manageUi } from './manage/ui'
import { manageUpload } from './manage/upload'
import { read } from './read'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = configuration(env)
    if (!config) return new Response('Forge is unavailable', { status: 503 })
    const url = new URL(request.url)
    const host = request.headers.get('Host')
    if (host !== null && host.toLowerCase() !== url.host) return new Response('Not found', { status: 404 })
    const runtime = { config, env }
    if (url.origin === config.readOrigin) return read(request, url, runtime)
    if (url.origin !== config.manageOrigin) return new Response('Not found', { status: 404 })

    const path = url.pathname
    const blocked = checkManageOrigin(request, path, config)
    if (blocked) return manageHeaders(blocked)
    try {
      if (request.method === 'GET' && path === localClientPath) return localClientDocument(config)
      if (path.startsWith('/upload/')) return manageHeaders(await manageUpload(request, path, runtime))
      if (path === '/auth/handoff') return manageHeaders(await manageHandoff(request, url, runtime))
      if (
        path === '/mcp' ||
        path === '/authorize' ||
        path === '/token' ||
        path === '/register' ||
        path.startsWith('/.well-known/oauth-')
      ) {
        return manageHeaders(await oauthFetch(request, runtime, ctx))
      }
      const response =
        path.startsWith('/login/') || path === '/logout'
          ? await loginRoute(request, runtime)
          : await manageUi.fetch(request, runtime, ctx)
      return manageHeaders(response)
    } catch (error) {
      console.error('Forge request failed', error instanceof Error ? error.name : 'unknown')
      return manageHeaders(new Response('Forge is unavailable', { status: 503 }))
    }
  },
}
