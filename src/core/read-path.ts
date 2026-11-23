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

export function readReturnPath(raw: string | null, origin: string): string | null {
  if (!raw?.startsWith('/a/') || /[\\\p{Cc}]/u.test(raw)) return null
  const url = URL.parse(raw, origin)
  if (!url || url.origin !== origin || url.hash) return null
  const { pathname, search } = url
  if (pathname.length + search.length > maxReadReturnLength) return null
  const target = artefactPath(pathname)
  return target && target.path !== undefined ? pathname + search : null
}
