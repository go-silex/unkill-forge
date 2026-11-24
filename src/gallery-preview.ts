import type { Runtime } from './config'
import { openBlob } from './core/blobs'
import { galleryPreviewFile, previewPrefix } from './core/gallery-previews'
import { artefactPath } from './core/read-path'
import { requireBrowserSession } from './manage/login'
import { readHeaders } from './read/headers'

const signatureLength = 12
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function hasRasterSignature(type: string, bytes: Uint8Array) {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/png') return pngSignature.every((byte, i) => bytes[i] === byte)
  return (
    type === 'image/webp' &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
}

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

  try {
    if (scope === 'member') {
      const session = await requireBrowserSession(request, runtime)
      if (session instanceof Response || session.member.status !== 'active') return notFound()
    }
    const file = await galleryPreviewFile(runtime, target.slug, scope)
    if (!file) return notFound()
    const range = head ? { offset: 0, length: Math.min(file.size, signatureLength) } : undefined
    const object = await openBlob(runtime.env.BLOBS, file.sha256, range)
    if (object.size !== file.size) {
      await object.body.cancel()
      return notFound()
    }
    const body = await object.arrayBuffer()
    if (!hasRasterSignature(file.type, new Uint8Array(body))) return notFound()

    headers.set('Content-Type', file.type)
    headers.set('Content-Length', String(file.size))
    // The manage host never opens publisher bytes as a document. Browsers can still embed the raster.
    if (scope === 'member') headers.set('Content-Disposition', 'attachment')
    return new Response(head ? null : body, { headers })
  } catch (error) {
    console.error('Forge preview failed', error instanceof Error ? error.name : 'unknown')
    return new Response(null, { status: 503, headers })
  }
}
