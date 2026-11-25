export function assetHeaders(type?: string) {
  const headers = new Headers({
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex',
  })
  if (type) headers.set('Content-Type', type)
  if (type?.startsWith('image/svg+xml')) {
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
  }
  return headers
}

// Callers supply an allowlisted literal path and content type, never a decoded path.
export async function fetchThemeAsset(
  request: Request,
  url: URL,
  theme: Fetcher,
  file: string,
  type: string,
) {
  const { method } = request
  const headers = new Headers()
  for (const key of ['If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(key)
    if (value !== null) headers.set(key, value)
  }
  const asset = await theme.fetch(
    new Request(new URL(`/${file}`, url.origin), { method, headers, redirect: 'manual' }),
  )
  if (asset.status !== 200 && asset.status !== 304) {
    await asset.body?.cancel()
    return null
  }
  const responseHeaders = assetHeaders(type)
  for (const key of ['ETag', 'Last-Modified']) {
    const value = asset.headers.get(key)
    if (value !== null) responseHeaders.set(key, value)
  }
  return new Response(method === 'HEAD' || asset.status === 304 ? null : asset.body, {
    status: asset.status,
    headers: responseHeaders,
  })
}
