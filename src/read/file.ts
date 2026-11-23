import { openBlob } from '../core/blobs'
import { readHeaders } from './headers'

function matchesETag(value: string | null, tag: string): boolean {
  if (!value) return false
  if (value.trim() === '*') return true
  for (const [candidate] of value.matchAll(/(?:W\/)?"[^"]*"/g)) {
    if (candidate === tag || (candidate.startsWith('W/') && candidate.slice(2) === tag)) return true
  }
  return false
}

function singleRange(value: string | null, size: number) {
  // Unknown units, malformed ranges and multipart ranges fall back to the whole file.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value?.trim() ?? '')
  if (!match || (!match[1] && !match[2])) return undefined
  if (size === 0) return null
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size)
    return length > 0 ? { offset: size - length, length } : null
  }
  const offset = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return offset <= end ? { offset, length: end - offset + 1 } : null
}

export async function serveFile(
  request: Request,
  bucket: R2Bucket,
  file: { sha256: string; size: number; type: string },
  isPublic: boolean,
  allowIndexing: boolean,
): Promise<Response> {
  const headers = readHeaders(isPublic, isPublic && allowIndexing)
  headers.set('Accept-Ranges', 'bytes')
  const tag = isPublic ? `"${file.sha256}"` : null
  if (tag) headers.set('ETag', tag)
  if (tag && matchesETag(request.headers.get('If-None-Match'), tag)) {
    return new Response(null, { status: 304, headers })
  }
  const ifRange = request.headers.get('If-Range')
  const range =
    request.method === 'GET' && (!ifRange || ifRange === tag)
      ? singleRange(request.headers.get('Range'), file.size)
      : undefined
  if (range === null) {
    headers.set('Content-Range', `bytes */${file.size}`)
    return new Response(null, { status: 416, headers })
  }
  headers.set('Content-Type', file.type)
  headers.set('Content-Length', String(range?.length ?? file.size))
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`)
  }
  const body = request.method === 'HEAD' ? null : (await openBlob(bucket, file.sha256, range)).body
  return new Response(body, { status: range ? 206 : 200, headers })
}
