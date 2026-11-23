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

export async function storeBlobs(
  db: D1Database,
  bucket: R2Bucket,
  pending: { bytes: Uint8Array }[],
  maxWrites: number,
): Promise<string[] | null> {
  const unique = new Map<string, { checksum: ArrayBuffer; bytes: Uint8Array }>()
  const hashes: string[] = []
  for (const { bytes } of pending) {
    const checksum = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (!unique.has(sha256)) unique.set(sha256, { checksum, bytes })
    hashes.push(sha256)
  }
  // One bind per statement; 256 SHA-256 hex strings fit in under 18 KiB.
  const keys = [...unique.keys()]
  const lookups: D1PreparedStatement[] = []
  for (let start = 0; start < keys.length; start += 256) {
    lookups.push(
      db
        .prepare(
          'SELECT value AS sha256 FROM json_each(?) WHERE EXISTS (SELECT 1 FROM files WHERE sha256 = value)',
        )
        .bind(JSON.stringify(keys.slice(start, start + 256))),
    )
  }
  for (const { results } of await db.batch<{ sha256: string }>(lookups)) {
    for (const { sha256 } of results) unique.delete(sha256)
  }
  if (unique.size > maxWrites) return null

  const onlyIf = new Headers({ 'If-None-Match': '*' })
  for (const [sha256, { bytes, checksum }] of unique) {
    await bucket.put(`blobs/${sha256}`, bytes, { sha256: checksum, onlyIf })
  }
  return hashes
}

export const MAX_TEXT_BYTES = 8 * 1024 * 1024

export async function blobText(bucket: R2Bucket, file: { type: string; size: number; sha256: string }) {
  const type = file.type.split(';', 1)[0].trim().toLowerCase()
  if (!type.startsWith('text/') && !['application/json', 'application/xml', 'image/svg+xml'].includes(type))
    return { reason: 'binary' } as const
  if (file.size > MAX_TEXT_BYTES) return { reason: 'text_too_large' } as const
  const blob = await bucket.get(`blobs/${file.sha256}`)
  if (!blob) throw new Error('Missing artefact blob')
  if (blob.size > MAX_TEXT_BYTES) {
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
