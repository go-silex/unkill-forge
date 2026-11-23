const textTypes: Record<string, string> = {
  css: 'text/css',
  csv: 'text/csv',
  htm: 'text/html',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  mjs: 'text/javascript',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  xml: 'application/xml',
}
const binaryTypes: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  wasm: 'application/wasm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

export function contentType(path: string): string {
  const extension =
    path
      .slice(path.lastIndexOf('/') + 1)
      .match(/\.([^.]+)$/)?.[1]
      .toLowerCase() ?? ''
  if (Object.hasOwn(textTypes, extension)) return `${textTypes[extension]}; charset=utf-8`
  return Object.hasOwn(binaryTypes, extension) ? binaryTypes[extension] : 'application/octet-stream'
}

export async function storeBlob(bucket: R2Bucket, bytes: Uint8Array, stored: Set<string>): Promise<string> {
  const checksum = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (stored.has(sha256)) return sha256
  const key = `blobs/${sha256}`
  if (!(await bucket.head(key))) {
    await bucket.put(key, bytes, { sha256: checksum, onlyIf: new Headers({ 'If-None-Match': '*' }) })
  }
  stored.add(sha256)
  return sha256
}

export async function blobText(bucket: R2Bucket, file: { type: string; size: number; sha256: string }) {
  const type = file.type.split(';', 1)[0].trim().toLowerCase()
  if (!type.startsWith('text/') && !['application/json', 'application/xml', 'image/svg+xml'].includes(type))
    return { reason: 'binary' } as const
  const max = 8 * 1024 * 1024
  if (file.size > max) return { reason: 'text_too_large' } as const
  const blob = await bucket.get(`blobs/${file.sha256}`)
  if (!blob) throw new Error('Missing artefact blob')
  if (blob.size > max) {
    await blob.body.cancel()
    return { reason: 'text_too_large' } as const
  }
  const bytes = await blob.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { reason: 'non_utf8' } as const
  }
  return text.includes('\0') ? ({ reason: 'binary' } as const) : { text }
}

export function textSlice(text: string, offset: number, limit: number) {
  // Count Unicode code points without allocating a copy of the entire file as an array.
  let totalLength = text.length
  let start = offset
  let end = offset + limit
  for (const { index } of text.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) {
    if (index < start) start++
    if (index < end) end++
    totalLength--
  }
  return { totalLength, text: text.slice(start, end) }
}
