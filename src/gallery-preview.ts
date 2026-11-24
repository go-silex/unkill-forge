import type { Runtime } from './config'
import { galleryGeneratedCover, galleryPreviewFiles, openCover, previewPrefix } from './core/gallery-previews'
import { artefactPath } from './core/read-path'
import { requireBrowserSession } from './manage/login'
import { readHeaders } from './read/headers'

export async function galleryPreview(
  request: Request,
  url: URL,
  runtime: Runtime,
  scope: 'public' | 'member',
) {
  const headers = readHeaders()
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  const notFound = () => new Response(null, { status: 404, headers })
  const head = request.method === 'HEAD'
  if ((!head && request.method !== 'GET') || (scope === 'public' && !runtime.config.publicIndex))
    return notFound()
  // The manage session can reach sibling-origin requests. Accept only images embedded by Manage itself.
  if (
    scope === 'member' &&
    (request.headers.get('Sec-Fetch-Site') !== 'same-origin' ||
      request.headers.get('Sec-Fetch-Dest') !== 'image')
  )
    return notFound()
  const target = artefactPath(`/a/${url.pathname.slice(previewPrefix.length)}`)
  if (!target || target.path !== undefined) return notFound()

  const sendImage = (type: string, size: number, body: ArrayBuffer | null) => {
    headers.set('Content-Type', type)
    headers.set('Content-Length', String(size))
    // The manage host never opens cover bytes as a document. Browsers can still embed the raster.
    if (scope === 'member') headers.set('Content-Disposition', 'attachment')
    return new Response(head ? null : body, { headers })
  }

  try {
    if (scope === 'member') {
      const session = await requireBrowserSession(request, runtime)
      if (session instanceof Response || session.member.status !== 'active') return notFound()
    }
    const candidates = await galleryPreviewFiles(runtime, target.slug, scope)
    for (const file of candidates) {
      const body = await openCover(runtime.env.BLOBS, file, head)
      if (body) return sendImage(file.type, file.size, body)
    }
    const generated = await galleryGeneratedCover(runtime, target.slug, scope, head)
    return generated ? sendImage('image/jpeg', generated.size, generated.body) : notFound()
  } catch (error) {
    console.error('Forge preview failed', error instanceof Error ? error.name : 'unknown')
    return new Response(null, { status: 503, headers })
  }
}
