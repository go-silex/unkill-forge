import { brandAsset, rootIcon, themeAsset, themePrefix } from './brand'
import { type Config, configuration, type Env, instanceConfiguration, type Runtime } from './config'
import { previewPrefix } from './core/gallery-previews'
import { coverCron, generateCovers, generatePublishedCover } from './core/generated-covers'
import { maintain } from './core/maintenance'
import { renderCover } from './cover-renderer'
import { galleryPreview } from './gallery-preview'
import { messages } from './i18n'
import { languagePath, setLanguage, visitorLocale } from './language'
import { manageError } from './manage/access'
import { manageHandoff } from './manage/handoff'
import { loginRoute } from './manage/login'
import { localClientDocument, localClientPath, oauthFetch } from './manage/oauth'
import { checkManageOrigin, manageHeaders } from './manage/origin'
import { manageUi } from './manage/ui'
import { manageUpload } from './manage/upload'
import { read } from './read'
import { readHeaders } from './read/headers'

function managePage(response: Response, locale: Config['locale']): Response {
  const result = manageHeaders(response)
  if (result.headers.get('Content-Type')?.startsWith('text/html'))
    result.headers.set('Content-Language', locale)
  return result
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const instance = instanceConfiguration(env)
    if (!instance) return new Response('Forge is unavailable', { status: 503 })
    const config = instance.default
    const url = new URL(request.url)
    const host = request.headers.get('Host')
    if (host !== null && host.toLowerCase() !== url.host) return new Response('Not found', { status: 404 })
    // Theme assets and browser icon fallbacks are public on both configured origins.
    if (url.origin === config.readOrigin || url.origin === config.manageOrigin) {
      if (
        url.pathname.startsWith(themePrefix) ||
        url.pathname === '/_theme' ||
        request.url.startsWith(themePrefix, url.origin.length)
      ) {
        return themeAsset(request, url, config.theme)
      }
      const icon = rootIcon(request, url, config)
      if (icon) return icon
    }
    const runtime: Runtime = { config, env }
    if (url.origin === config.readOrigin) {
      if (url.pathname.startsWith(previewPrefix)) return galleryPreview(request, url, runtime, 'public')
      if (url.pathname === languagePath) return setLanguage(request, url.origin, readHeaders())
      const asset = brandAsset(request.method, url.pathname, config)
      if (asset) return asset
      runtime.config = instance.locales[visitorLocale(request, config.locale)]
      return read(request, url, runtime, ctx)
    }
    if (url.origin !== config.manageOrigin) return new Response('Not found', { status: 404 })

    const path = url.pathname
    const blocked = checkManageOrigin(request, path, config)
    if (blocked) return manageHeaders(blocked)
    const browser = env.COVER_BROWSER
    let coverJobs: { id: string; revision: number }[] | undefined
    if (browser) {
      runtime.onRevisionCommitted = (id, revision) => {
        coverJobs ??= []
        coverJobs.push({ id, revision })
      }
    }
    try {
      if (path.startsWith(previewPrefix))
        return manageHeaders(await galleryPreview(request, url, runtime, 'member'))
      const asset = brandAsset(request.method, path, config)
      if (asset) return asset
      if (request.method === 'GET' && path === localClientPath) return localClientDocument(config)
      if (path.startsWith('/upload/')) return manageHeaders(await manageUpload(request, path, runtime))
      if (path === languagePath) return manageHeaders(await setLanguage(request, url.origin, new Headers()))
      if (path === '/authorize' && (request.method === 'GET' || request.method === 'POST')) {
        runtime.config = instance.locales[visitorLocale(request, config.locale)]
        return managePage(await oauthFetch(request, runtime, ctx), runtime.config.locale)
      }
      if (
        path === '/mcp' ||
        path === '/authorize' ||
        path === '/token' ||
        path === '/register' ||
        path.startsWith('/.well-known/oauth-')
      ) {
        return manageHeaders(await oauthFetch(request, runtime, ctx))
      }
      if (!/^\/login\/[^/]+\/backchannel-logout$/.test(path))
        runtime.config = instance.locales[visitorLocale(request, config.locale)]
      if (path === '/auth/handoff')
        return managePage(await manageHandoff(request, url, runtime), runtime.config.locale)
      const response =
        path.startsWith('/login/') || path === '/logout'
          ? await loginRoute(request, runtime)
          : await manageUi.fetch(request, runtime, ctx)
      return managePage(response, runtime.config.locale)
    } catch (error) {
      console.error('Forge request failed', error instanceof Error ? error.name : 'unknown')
      const lead = messages(runtime.config).unavailable
      const browserAccess =
        (request.method === 'GET' && /^(?:\/login(?:\/[^/]+(?:\/callback)?)?|\/invite\/[^/]+)$/.test(path)) ||
        (path === '/authorize' && (request.method === 'GET' || request.method === 'POST'))
      return browserAccess
        ? managePage(manageError(runtime.config, 503, lead), runtime.config.locale)
        : manageHeaders(new Response(lead, { status: 503 }))
    } finally {
      // Leave receipt-dependent D1 writes ahead of cover work, including for browser restores.
      if (browser && coverJobs) {
        for (const { id, revision } of coverJobs) {
          try {
            ctx.waitUntil(
              generatePublishedCover(
                env,
                id,
                revision,
                (entryPath, files) => renderCover(browser, env.BLOBS, entryPath, files),
                Date.now(),
              ).catch(() => console.error('Forge cover dispatch failed')),
            )
          } catch {
            console.error('Forge cover registration failed')
          }
        }
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const config = configuration(env)
    if (!config) return
    const runtime = { config, env }
    if (controller.cron === coverCron) {
      const binding = env.COVER_BROWSER
      if (binding) {
        try {
          await generateCovers(
            runtime,
            (entryPath, files) => renderCover(binding, env.BLOBS, entryPath, files),
            Date.now(),
          )
        } catch {
          throw new Error('Forge cover maintenance failed')
        }
      }
    } else if (controller.cron === '0 3 * * *') {
      await maintain(runtime, Math.min(controller.scheduledTime, Date.now()))
    }
  },
}
