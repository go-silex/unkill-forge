import type { Runtime } from '../config'

export const previewPrefix = '/_forge/preview/'
export const maxCoverBytes = 1_048_576

const maxPreviewSlugs = 200
type PreviewScope = 'public' | 'member'
type PreviewFile = { sha256: string; size: number; type: string }

const signatureLength = 12
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isJpeg(bytes: Uint8Array) {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function hasRasterSignature(type: string, bytes: Uint8Array) {
  if (type === 'image/jpeg') return isJpeg(bytes)
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

export async function openCover(
  bucket: R2Bucket,
  file: PreviewFile,
  head: boolean,
): Promise<ArrayBuffer | null> {
  if (file.size <= 0 || file.size > maxCoverBytes) return null
  const length = head ? Math.min(file.size, signatureLength) : file.size
  const object = await bucket.get(`blobs/${file.sha256}`, head ? { range: { offset: 0, length } } : undefined)
  if (!object) return null
  if (object.size !== file.size) {
    await object.body.cancel()
    return null
  }
  const body = await object.arrayBuffer()
  return body.byteLength === length && hasRasterSignature(file.type, new Uint8Array(body)) ? body : null
}

const previewPaths = `preview_paths(path, type, priority) AS (
  VALUES ('og.jpg', 'image/jpeg', 1), ('og.jpeg', 'image/jpeg', 2),
         ('og.png', 'image/png', 3), ('og.webp', 'image/webp', 4), ('index.og.png', 'image/png', 5)
)`

// Five indexed (artefact, revision, path) probes per head or exact revision.
const publisherFiles = `
  FROM preview_heads AS a
  CROSS JOIN preview_paths AS p
  CROSS JOIN files AS f ON f.artefact_id = a.id AND f.revision = a.current_revision AND f.path = p.path
  WHERE f.content_type = p.type AND f.size > 0 AND f.size <= ${maxCoverBytes}`

const liveAudience = `a.deleted_at IS NULL AND a.current_revision > 0 AND (?2 = 'member' OR a.visibility = 'public')`
const slugHead = `preview_heads AS (
  SELECT a.id, a.current_revision FROM artefacts AS a WHERE a.slug = ?1 AND ${liveAudience}
)`
const currentGeneratedCover = `c.artefact_id = a.id AND c.revision = a.current_revision AND c.jpeg IS NOT NULL`

export async function galleryPreviewSlugs(
  { env: { DB: db } }: Runtime,
  slugs: readonly string[],
  scope: PreviewScope,
): Promise<Set<string>> {
  const matches = new Set<string>()
  if (slugs.length === 0) return matches
  const { results } = await db
    .prepare(`WITH ${previewPaths}, preview_heads AS (
      SELECT a.id, a.current_revision, a.slug FROM artefacts AS a
      WHERE a.slug IN (SELECT value FROM json_each(?1)) AND ${liveAudience}
    )
    SELECT a.slug ${publisherFiles}
    UNION
    SELECT a.slug FROM preview_heads AS a
    CROSS JOIN generated_covers AS c ON ${currentGeneratedCover}`)
    .bind(JSON.stringify(slugs.length > maxPreviewSlugs ? slugs.slice(0, maxPreviewSlugs) : slugs), scope)
    .all<{ slug: string }>()
  for (const { slug } of results) matches.add(slug)
  return matches
}

export async function galleryPreviewFiles(
  { env: { DB: db } }: Runtime,
  slug: string,
  scope: PreviewScope,
): Promise<PreviewFile[]> {
  const { results } = await db
    .prepare(`WITH ${previewPaths}, ${slugHead}
      SELECT f.sha256, f.size, p.type ${publisherFiles} ORDER BY p.priority`)
    .bind(slug, scope)
    .all<PreviewFile>()
  return results
}

export async function revisionCoverFiles(
  db: D1Database,
  id: string,
  revision: number,
): Promise<PreviewFile[]> {
  const { results } = await db
    .prepare(`WITH ${previewPaths}, preview_heads(id, current_revision) AS (VALUES (?1, ?2))
      SELECT f.sha256, f.size, p.type ${publisherFiles} ORDER BY p.priority`)
    .bind(id, revision)
    .all<PreviewFile>()
  return results
}

export async function galleryGeneratedCover(
  { env: { DB: db } }: Runtime,
  slug: string,
  scope: PreviewScope,
  head: boolean,
): Promise<{ size: number; body: ArrayBuffer | null } | null> {
  const column = head ? 'length(c.jpeg)' : 'c.jpeg'
  const select = db
    .prepare(`WITH ${slugHead}
      SELECT ${column} AS cover FROM preview_heads AS a
      CROSS JOIN generated_covers AS c ON ${currentGeneratedCover}`)
    .bind(slug, scope)

  if (head) {
    const size = await select.first<number>('cover')
    return size === null ? null : { size, body: null }
  }

  const jpeg = await select.first<number[]>('cover')
  if (jpeg === null) return null
  const { buffer: body } = new Uint8Array(jpeg)
  return { size: body.byteLength, body }
}
