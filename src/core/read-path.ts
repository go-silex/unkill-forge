import { base64url } from 'jose'

// The URL path encodes each published POSIX segment independently.
export function artefactPath(pathname: string) {
  const match = /^\/a\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\/(.*))?$/.exec(pathname)
  if (!match) return null
  const [, slug, encoded] = match
  if (encoded === undefined || encoded === '') return { slug, path: encoded }

  const directory = encoded.endsWith('/')
  const parts = (directory ? encoded.slice(0, -1) : encoded).split('/')
  try {
    const decoded = parts.map(decodeURIComponent)
    if (decoded.some((segment) => !segment || segment.startsWith('.') || /[/\\\p{Cc}]/u.test(segment))) {
      return null
    }
    const path = decoded.join('/')
    return /^.{1,512}$/su.test(path) ? { slug, path: directory ? `${path}/` : path } : null
  } catch {
    return null
  }
}

export const maxReadReturnLength = 8_192
const maxEncodedReturnLength = Math.ceil((maxReadReturnLength * 4) / 3)
const returnDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function decodeReadReturnPath(encoded: string | null, origin: string): string | null {
  if (!encoded || encoded.length > maxEncodedReturnLength || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    return readReturnPath(returnDecoder.decode(base64url.decode(encoded)), origin)
  } catch {
    return null
  }
}

export function readReturnPath(raw: string | null, origin: string): string | null {
  if (!raw?.startsWith('/a/') || /[\\\p{Cc}]/u.test(raw)) return null
  const url = URL.parse(raw, origin)
  if (!url || url.origin !== origin || url.hash) return null
  const { pathname, search } = url
  if (pathname.length + search.length > maxReadReturnLength) return null
  const target = artefactPath(pathname)
  return target && target.path !== undefined ? pathname + search : null
}
