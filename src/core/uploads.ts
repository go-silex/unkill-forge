import type { Runtime } from '../config'
import { ArtefactError, checkMember, checkPath, checkSlug } from './artefacts'
import { contentType, hexChecksum, putBlob, referencedBlobs } from './blobs'
import { auditChange, hashSecret, type Member, randomSecret } from './index'

const putLifetime = 15 * 60_000
const publishLifetime = 60 * 60_000

type UploadRequest = { path: string; size: number; sha256: string; contentType?: string }
type UploadReceipt = { path: string; uploadId: string } & ({ url: string } | { alreadyStored: true })

export function checkUploadCount(args: { files?: unknown }, limit: number) {
  if (Array.isArray(args.files) && args.files.length > limit) {
    throw new ArtefactError('too_large', `Upload count exceeds the configured limit of ${limit}`)
  }
}

export async function createUploads(
  { env: { DB: db }, config }: Runtime,
  member: Member,
  { slug, files }: { slug: string; files: UploadRequest[] },
) {
  checkMember(member, true)
  checkSlug(slug)
  checkUploadCount({ files }, config.maxBlobWritesPerCall)
  const issuer = await db
    .prepare(
      "SELECT generation FROM members WHERE id = ? AND status = 'active' AND role IN ('publisher', 'admin')",
    )
    .bind(member.id)
    .first<{ generation: number }>()
  if (!issuer) throw new ArtefactError('forbidden', 'An active publisher or admin is required')
  const paths = new Set<string>()
  const hashes = new Set<string>()
  for (const file of files) {
    checkPath(file.path)
    if (paths.has(file.path)) throw new ArtefactError('invalid_input', 'Upload paths must be unique')
    if (file.size > config.maxUploadBytes) {
      throw new ArtefactError(
        'too_large',
        `Upload size exceeds the configured limit of ${config.maxUploadBytes}`,
      )
    }
    paths.add(file.path)
    hashes.add(file.sha256)
  }
  const referenced = await referencedBlobs(db, [...hashes])
  for (const file of files) {
    const size = referenced.get(file.sha256)
    if (size !== undefined && size !== file.size)
      throw new ArtefactError('invalid_input', 'Size does not match the referenced blob')
  }

  const now = Date.now()
  const receipts: UploadReceipt[] = []
  const rows = await Promise.all(
    files.map(async (file) => {
      const token = randomSecret()
      const uploadId = crypto.randomUUID()
      const alreadyStored = referenced.has(file.sha256)
      receipts.push(
        alreadyStored
          ? { path: file.path, uploadId, alreadyStored }
          : { path: file.path, uploadId, url: `${config.manageOrigin}/upload/${token}` },
      )
      return [
        await hashSecret(token),
        uploadId,
        file.path,
        file.sha256,
        file.size,
        file.contentType ?? contentType(file.path),
        alreadyStored ? 'stored' : 'pending',
        now + (alreadyStored ? publishLifetime : putLifetime),
        crypto.randomUUID(),
      ]
    }),
  )
  const statements = []
  for (let start = 0; start < rows.length; start += 24) {
    const chunk = JSON.stringify(rows.slice(start, start + 24))
    statements.push(
      db
        .prepare(`INSERT INTO uploads (token_hash, upload_id, member_id, slug, path, sha256, size,
        content_type, state, expires_at, created_at, member_generation)
        SELECT value ->> 0, value ->> 1, ?, ?, value ->> 2, value ->> 3, value ->> 4,
          value ->> 5, value ->> 6, value ->> 7, ?, ? FROM json_each(?)`)
        .bind(member.id, slug, now, issuer.generation, chunk),
      db
        .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
        SELECT value ->> 8, ?1, ?2, 'upload.issue',
          json_object('slug', ?3, 'path', value ->> 2, 'sha256', value ->> 3, 'size', value ->> 4)
        FROM json_each(?4)`)
        .bind(now, member.id, slug, chunk),
    )
  }
  await db.batch(statements)
  return { files: receipts }
}

type ClaimedUpload = {
  uploadId: string
  memberId: string
  slug: string
  path: string
  size: number
  sha256: string
}

async function pumpUpload(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter,
  size: number,
) {
  let remaining = size
  let tail: Uint8Array | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > remaining) {
        remaining = -1
        break
      }
      if (value.byteLength === 0) continue
      remaining -= value.byteLength
      // Do not let R2 see the complete body until EOF rules out any trailing bytes.
      if (remaining === 0) tail = value
      else await writer.write(value)
    }
    if (remaining !== 0) {
      await writer.abort().catch(() => {})
      return 400
    }
    if (tail) await writer.write(tail)
    await writer.close()
    return 204
  } catch (error) {
    await writer.abort(error).catch(() => {})
    return 503
  }
}

async function storeUpload(bucket: R2Bucket, upload: ClaimedUpload, body: ReadableStream<Uint8Array> | null) {
  const existing = await bucket.head(`blobs/${upload.sha256}`)
  const checksum = existing?.checksums.sha256
  if (existing && (!checksum || existing.size !== upload.size || hexChecksum(checksum) !== upload.sha256)) {
    return 409
  }
  // On deduplication, verify this PUT without touching the incumbent.
  const temporaryKey = existing ? `upload-verification/${upload.uploadId}` : null
  const fixed = body && new FixedLengthStream(upload.size)
  const reader = body?.getReader()
  const writer = fixed?.writable.getWriter()
  const piping = reader && writer ? pumpUpload(reader, writer, upload.size) : null
  try {
    let failure: unknown
    let put: R2Object | null = null
    try {
      const bytes = fixed?.readable ?? new Uint8Array()
      put = temporaryKey
        ? await bucket.put(temporaryKey, bytes, { sha256: upload.sha256 })
        : await putBlob(bucket, upload.sha256, bytes, upload.sha256)
    } catch (error) {
      failure = error
    }
    if (!put && reader && writer) await Promise.allSettled([reader.cancel(), writer.abort()])
    const status = (await piping) ?? 204
    if (failure) {
      if (status === 400) return 400
      return failure instanceof Error && /10037|bad.?digest|checksum/i.test(failure.message) ? 422 : 503
    }
    if (!put) return 409
    if (status !== 204) return status
    return put.size === upload.size ? 204 : 400
  } finally {
    reader?.releaseLock()
    writer?.releaseLock()
    if (temporaryKey) await bucket.delete(temporaryKey)
  }
}

export async function receiveUpload(
  runtime: Runtime,
  token: string,
  length: string | null,
  body: ReadableStream | null,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return 404
  const { DB: db, BLOBS: bucket } = runtime.env
  const hash = await hashSecret(token)
  const upload = await db
    .prepare(`UPDATE uploads SET state = 'receiving'
      WHERE token_hash = ? AND state = 'pending' AND expires_at > ?
      AND EXISTS (SELECT 1 FROM members WHERE id = uploads.member_id AND status = 'active'
        AND role IN ('publisher', 'admin') AND generation = uploads.member_generation)
      RETURNING upload_id AS uploadId, member_id AS memberId, slug, path, size, sha256`)
    .bind(hash, Date.now())
    .first<ClaimedUpload>()
  if (!upload) return 404

  let status: number
  if (length === null) status = 411
  else if (!/^[0-9]+$/.test(length) || Number(length) !== upload.size || (!body && upload.size !== 0))
    status = 400
  else if (upload.size > runtime.config.maxUploadBytes) status = 413
  else {
    try {
      status = await storeUpload(bucket, upload, body)
    } catch {
      status = 503
    }
  }

  if (status === 204) {
    const now = Date.now()
    const { memberId, slug, path, size, sha256 } = upload
    const [stored] = await db.batch([
      db
        .prepare(
          "UPDATE uploads SET state = 'stored', expires_at = ? WHERE token_hash = ? AND state = 'receiving'",
        )
        .bind(now + publishLifetime, hash),
      auditChange(db, now, memberId, 'upload.store', { slug, path, size, sha256 }),
    ])
    return stored.meta.changes === 1 ? 204 : 409
  }
  await db
    .prepare("UPDATE uploads SET state = 'failed' WHERE token_hash = ? AND state = 'receiving'")
    .bind(hash)
    .run()
  return status
}
