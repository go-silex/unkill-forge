export function readHeaders(isPublic = false, indexable = false): Headers {
  const headers = new Headers({
    'Cache-Control': isPublic ? 'no-cache' : 'private, no-store',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  })
  if (!indexable) headers.set('X-Robots-Tag', 'noindex')
  return headers
}
