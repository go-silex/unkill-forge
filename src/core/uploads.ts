import type { Runtime } from '../config'
import { ArtefactError, checkMember, checkPath, checkSlug } from './artefacts'
import { contentType, hexChecksum, putBlob, referencedBlobs } from './blobs'
import { hashSecret, type Member, randomSecret } from './index'

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
      ]
    }),
  )
  const statements = []
  for (let start = 0; start < rows.length; start += 24) {
    statements.push(
      db
        .prepare(`INSERT INTO uploads (token_hash, upload_id, member_id, slug, path, sha256, size,
        content_type, state, expires_at, created_at)
        SELECT value ->> 0, value ->> 1, ?, ?, value ->> 2, value ->> 3, value ->> 4,
          value ->> 5, value ->> 6, value ->> 7, ? FROM json_each(?)`)
        .bind(member.id, slug, now, JSON.stringify(rows.slice(start, start + 24))),
    )
  }
  await db.batch(statements)
  return { files: receipts }
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
      RETURNING size, sha256`)
    .bind(hash, Date.now())
    .first<{ size: number; sha256: string }>()
  if (!upload) return 404

  let status: number
  if (length === null) status = 411
  else if (length !== String(upload.size) || (!body && upload.size !== 0)) status = 400
  else if (upload.size > runtime.config.maxUploadBytes) status = 413
  else {
    try {
      const put = await putBlob(bucket, upload.sha256, body ?? new Uint8Array(), upload.sha256)
      if (put) status = 204
      else {
        // A conditional miss may be an orphan, not yet referenced by any file row.
        const existing = await bucket.head(`blobs/${upload.sha256}`)
        const checksum = existing?.checksums.sha256
        status =
          existing && checksum && existing.size === upload.size && hexChecksum(checksum) === upload.sha256
            ? 204
            : 409
      }
    } catch (error) {
      status = error instanceof Error && /10037|bad.?digest|checksum/i.test(error.message) ? 422 : 503
    }
  }

  if (status === 204) {
    const { meta } = await db
      .prepare(
        "UPDATE uploads SET state = 'stored', expires_at = ? WHERE token_hash = ? AND state = 'receiving'",
      )
      .bind(Date.now() + publishLifetime, hash)
      .run()
    return meta.changes === 1 ? 204 : 409
  }
  await db
    .prepare("UPDATE uploads SET state = 'failed' WHERE token_hash = ? AND state = 'receiving'")
    .bind(hash)
    .run()
  return status
}
