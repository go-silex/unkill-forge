import { base64url } from 'jose'
import { z } from 'zod'
import { MAX_ARTEFACT_FILES, type Runtime } from '../config'
import { blobText, contentType, MAX_TEXT_BYTES, storeBlobs, textSlice } from './blobs'
import { hashSecret, type Member } from './index'
import { generateShareKey, sealShareKey, unsealShareKey, validShareKey } from './share-keys'

type ErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'invalid_input' | 'too_large'
export class ArtefactError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra?: { currentRevision: number } | { matches: number },
  ) {
    super(message)
  }
}

type Visibility = 'private' | 'public'
type Artefact = {
  id: string
  slug: string
  title: string
  visibility: Visibility
  revision: number
  createdBy: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
type File = { path: string; size: number; type: string; sha256: string }
type InlineFile = { path: string; content: string; encoding?: 'utf8' | 'base64' }
type Publish = {
  slug: string
  title?: string
  files: InlineFile[]
  mode: 'merge' | 'replace'
  delete?: string[]
  expectedRevision?: number
  message?: string
}

const listCursor = z.tuple([z.int().nonnegative(), z.uuid(), z.string()])
const fileCursor = z.tuple([z.uuid(), z.int().positive(), z.string()])

function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  try {
    // Forge's longest cursor is a file tuple containing a path of at most 512 UTF-16 code units.
    if (cursor.length > 4096) throw new Error('Cursor length exceeds limit')
    return schema.parse(JSON.parse(new TextDecoder().decode(base64url.decode(cursor))))
  } catch {
    throw new ArtefactError('invalid_input', 'Invalid cursor; use the cursor returned by Forge')
  }
}

function checkMember(member: Member, write = false) {
  if (member.status !== 'active' || (write && member.role === 'viewer')) {
    throw new ArtefactError(
      'forbidden',
      write ? 'An active publisher or admin is required' : 'An active member is required',
    )
  }
}

function checkSlug(slug: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    throw new ArtefactError(
      'invalid_input',
      'Invalid slug; use 1–64 lowercase letters, digits or internal hyphens',
    )
  }
}

function checkPath(path: string) {
  if (
    !/^.{1,512}$/su.test(path) ||
    !path.isWellFormed() ||
    /[\\\p{Cc}]/u.test(path) ||
    path.split('/').some((segment) => !segment || segment.startsWith('.'))
  ) {
    throw new ArtefactError(
      'invalid_input',
      'Invalid path; use a relative POSIX path without hidden or empty segments',
    )
  }
}

function conflict(currentRevision: number) {
  return new ArtefactError('conflict', 'The artefact head has changed', { currentRevision })
}

function checkRevision(expected: number | undefined, current: number) {
  if (expected !== undefined && expected !== current) throw conflict(current)
}

function head(db: D1Database, slug: string) {
  return db
    .prepare(`SELECT id, slug, title, visibility, current_revision AS revision, created_by AS createdBy,
    created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt FROM artefacts WHERE slug = ?`)
    .bind(slug)
    .first<Artefact>()
}

async function liveHead(db: D1Database, slug: string) {
  checkSlug(slug)
  const artefact = await head(db, slug)
  if (!artefact || artefact.deletedAt !== null) throw new ArtefactError('not_found', 'Artefact not found')
  return artefact
}

type RevisionEntry = { path: string | null }

function selectRevisionEntry(db: D1Database, id: string, revision: number) {
  return db
    .prepare('SELECT entry_path AS path FROM revisions WHERE artefact_id = ? AND number = ?')
    .bind(id, revision)
}

function storeRevisionEntry(db: D1Database, id: string, revision: number) {
  return db
    .prepare(`UPDATE revisions SET entry_path = COALESCE(
      (SELECT path FROM files WHERE artefact_id = ?1 AND revision = ?2 AND path = 'index.html'),
      (SELECT path FROM files WHERE artefact_id = ?1 AND revision = ?2
       ORDER BY (lower(trim(substr(content_type, 1, instr(content_type || ';', ';') - 1), char(9) || ' '))
         = 'text/html') DESC, path LIMIT 1)
    ) WHERE artefact_id = ?1 AND number = ?2 AND entry_path IS NULL RETURNING entry_path AS path`)
    .bind(id, revision)
}

function backfillEntry(db: D1Database, id: string, revision: number) {
  // The conditional write and following point read also handle concurrent backfills.
  return [storeRevisionEntry(db, id, revision), selectRevisionEntry(db, id, revision)]
}

async function revisionEntry(db: D1Database, id: string, revision: number) {
  const cached = await selectRevisionEntry(db, id, revision).first<string>('path')
  if (cached !== null) return cached
  const [, entry] = await db.batch<RevisionEntry>(backfillEntry(db, id, revision))
  return entry.results[0]?.path ?? null
}

function entryUrl(origin: string, slug: string, path: string) {
  const base = `${origin}/a/${slug}/`
  return path === 'index.html' ? base : base + encodeFilePath(path)
}

function encodeFilePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

export async function publicArtefacts({ env: { DB: db }, config }: Runtime) {
  const { results } = await db
    .prepare(`SELECT a.id, a.slug, a.title, r.number AS revision, r.entry_path AS path
      FROM artefacts a JOIN revisions r ON r.artefact_id = a.id AND r.number = a.current_revision
      WHERE a.deleted_at IS NULL AND a.visibility = 'public'
      ORDER BY a.created_at DESC, a.slug LIMIT 200`)
    .all<RevisionEntry & { id: string; slug: string; title: string; revision: number }>()
  const legacy = results.filter(({ path }) => path === null)
  if (legacy.length > 0) {
    const filled = await db.batch<RevisionEntry>(
      legacy.flatMap(({ id, revision }) => backfillEntry(db, id, revision)),
    )
    for (const [index, row] of legacy.entries()) row.path = filled[index * 2 + 1].results[0]?.path ?? null
  }
  return results.flatMap(({ slug, title, path }) =>
    path === null ? [] : [{ title, url: entryUrl(config.readOrigin, slug, path) }],
  )
}

function audit(db: D1Database, at: number, member: Member, id: string, action: string, detail: object) {
  return db
    .prepare(`INSERT INTO audit_log (id, at, member_id, action, artefact_id, detail_json)
    SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(crypto.randomUUID(), at, member.id, action, id, JSON.stringify(detail))
}

export async function listArtefacts(
  { env: { DB: db } }: Runtime,
  member: Member,
  query = '',
  cursor?: string,
) {
  checkMember(member)
  const after = cursor === undefined ? null : decodeCursor(cursor, listCursor)
  if (after && after[2] !== query)
    throw new ArtefactError('invalid_input', 'Cursor belongs to a different query')
  const like = `%${query.replace(/[!%_]/g, '!$&')}%`
  // D1 caps LIKE patterns at 50 bytes; use the equivalent literal search for longer patterns.
  const pattern = new TextEncoder().encode(like).length <= 50 ? like : null
  const { results } = await db
    .prepare(`SELECT id, slug, title, visibility, current_revision AS revision, updated_at AS updatedAt
    FROM artefacts WHERE deleted_at IS NULL AND CASE WHEN ?1 IS NOT NULL
      THEN slug LIKE ?1 ESCAPE '!' OR title LIKE ?1 ESCAPE '!'
      ELSE instr(lower(slug), lower(?4)) > 0 OR instr(lower(title), lower(?4)) > 0 END
    AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
    ORDER BY updated_at DESC, id LIMIT 51`)
    .bind(pattern, after?.[0] ?? null, after?.[1] ?? null, query)
    .all<Pick<Artefact, 'id' | 'slug' | 'title' | 'visibility' | 'revision' | 'updatedAt'>>()
  const more = results.length > 50
  if (more) results.pop()
  const last = results.at(-1)
  return {
    artefacts: results.map(({ id: _id, ...row }) => row),
    nextCursor: more && last ? base64url.encode(JSON.stringify([last.updatedAt, last.id, query])) : undefined,
  }
}

export async function getArtefact(runtime: Runtime, member: Member, slug: string, cursor?: string) {
  checkMember(member)
  const {
    env: { DB: db },
    config,
  } = runtime
  const { id, deletedAt: _deletedAt, ...artefact } = await liveHead(db, slug)
  const { revision } = artefact
  const after = cursor === undefined ? null : decodeCursor(cursor, fileCursor)
  if (after && after[0] !== id)
    throw new ArtefactError('invalid_input', 'Cursor belongs to a different artefact')
  if (after) checkRevision(after[1], revision)
  const [page, path, shareLinks] = await Promise.all([
    db
      .prepare(`SELECT path, size, content_type AS type FROM files
        WHERE artefact_id = ? AND revision = ? AND path > ? ORDER BY path LIMIT 201`)
      .bind(id, revision, after?.[2] ?? '')
      .all<Pick<File, 'path' | 'size' | 'type'>>(),
    revisionEntry(db, id, revision),
    shareLinkMetadata(db, id),
  ])
  if (!path) throw new Error('Artefact head has no entry file')
  const files = page.results
  const more = files.length > 200
  if (more) files.pop()
  const nextCursor = more
    ? base64url.encode(JSON.stringify([id, revision, files[files.length - 1].path]))
    : undefined
  return { ...artefact, files, url: entryUrl(config.readOrigin, slug, path), shareLinks, nextCursor }
}

async function findFile(db: D1Database, id: string, revision: number, path: string) {
  const file = await db
    .prepare(`SELECT path, size, content_type AS type, sha256 FROM files
    WHERE artefact_id = ? AND revision = ? AND path = ?`)
    .bind(id, revision, path)
    .first<File>()
  // Files reference their revision, so a hit proves that the revision exists too.
  if (!file) throw new ArtefactError('not_found', 'File not found at that revision')
  return file
}

type CanonicalRead =
  | { kind: 'serve'; file: File; public: boolean }
  | { kind: 'not-found' | 'sign-in' | 'pending' | 'revalidate' | 'slash' }

export async function canonicalRead(
  { env: { DB: db } }: Runtime,
  slug: string,
  path: string,
  session: () => Promise<{ member: Member; fresh: boolean } | null>,
): Promise<CanonicalRead> {
  const artefact = await head(db, slug)
  if (!artefact || artefact.deletedAt !== null) return { kind: 'not-found' }
  const isPublic = artefact.visibility === 'public'
  if (!isPublic) {
    const current = await session()
    if (!current) return { kind: 'sign-in' }
    if (!current.fresh) return { kind: 'revalidate' }
    if (current.member.status !== 'active') return { kind: 'pending' }
  }
  const resolved = await resolveReadFile(db, artefact.id, artefact.revision, path)
  return resolved.kind === 'serve' ? { ...resolved, public: isPublic } : resolved
}

async function resolveReadFile(db: D1Database, artefactId: string, revision: number, path: string) {
  const directory = path === '' || path.endsWith('/')
  const index = directory ? `${path}index.html` : `${path}/index.html`
  const file = await db
    .prepare(`SELECT path, size, content_type AS type, sha256 FROM files
      WHERE artefact_id = ?1 AND revision = ?2 AND path IN (?3, ?4, ?5)
      ORDER BY CASE path WHEN ?3 THEN 0 WHEN ?4 THEN 1 ELSE 2 END LIMIT 1`)
    .bind(artefactId, revision, directory ? null : path, index, directory ? null : `${path}.html`)
    .first<File>()
  if (!file) return { kind: 'not-found' } as const
  if (!directory && file.path === index) return { kind: 'slash' } as const
  return { kind: 'serve', file } as const
}

const shareUseInterval = 60_000

export async function shareRead(
  { env: { DB: db } }: Runtime,
  slug: string,
  key: string,
  path: string | undefined,
  ctx: ExecutionContext,
) {
  const link = await db
    .prepare(`SELECT s.id, s.artefact_id AS artefactId, s.last_used_at AS lastUsedAt,
      a.current_revision AS revision FROM share_links s JOIN artefacts a ON a.id = s.artefact_id
      WHERE s.key_hash = ? AND a.slug = ? AND s.revoked_at IS NULL AND a.deleted_at IS NULL`)
    .bind(await hashSecret(key), slug)
    .first<{ id: string; artefactId: string; lastUsedAt: number | null; revision: number }>()
  if (!link) return { kind: 'not-found' } as const
  if (path === undefined) return { kind: 'slash' } as const
  const resolved = await resolveReadFile(db, link.artefactId, link.revision, path)
  if (resolved.kind === 'not-found' && path === '') {
    const entry = await revisionEntry(db, link.artefactId, link.revision)
    if (entry !== null) return { kind: 'entry', path: encodeFilePath(entry) } as const
  }
  if (resolved.kind !== 'serve') return resolved
  const now = Date.now()
  const cutoff = now - shareUseInterval
  if (link.lastUsedAt === null || link.lastUsedAt <= cutoff) {
    ctx.waitUntil(
      recordShareUse(db, link.id, now, cutoff).catch(() =>
        console.error('Forge share usage tracking failed'),
      ),
    )
  }
  return resolved
}

async function recordShareUse(db: D1Database, id: string, now: number, cutoff: number) {
  // Recheck the cutoff in D1 so parallel subresources cannot each write.
  await db
    .prepare(`UPDATE share_links SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL
      AND (last_used_at IS NULL OR last_used_at <= ?)`)
    .bind(now, id, cutoff)
    .run()
}

export async function readFile(
  runtime: Runtime,
  member: Member,
  slug: string,
  path: string,
  revision?: number,
  offset = 0,
  limit = 40_000,
) {
  checkMember(member)
  checkPath(path)
  const { DB: db, BLOBS: blobs } = runtime.env
  const artefact = await liveHead(db, slug)
  const number = revision ?? artefact.revision
  const file = await findFile(db, artefact.id, number, path)
  const result = await blobText(blobs, file)
  const { sha256: _hash, ...metadata } = file
  return result.text === undefined
    ? { ...metadata, revision: number, reason: result.reason }
    : { ...metadata, revision: number, offset, ...textSlice(result.text, offset, Math.min(limit, 100_000)) }
}

function tooLarge(field: string, limit: number) {
  return new ArtefactError('too_large', `${field} exceeds the configured limit of ${limit}`)
}

// Also used by the MCP adapter before Zod walks entries in either array.
export function checkPublishArrayLengths(args: { files?: unknown; delete?: unknown }) {
  for (const array of [args.files, args.delete]) {
    if (Array.isArray(array) && array.length > MAX_ARTEFACT_FILES) {
      throw tooLarge('Input array length', MAX_ARTEFACT_FILES)
    }
  }
}

function inlineBytes(file: InlineFile, remaining: number, limit: number): Uint8Array {
  if (file.encoding !== 'base64') {
    if (!file.content.isWellFormed())
      throw new ArtefactError('invalid_input', 'UTF-8 content contains a lone surrogate')
    if (file.content.length > remaining) throw tooLarge('Decoded inline bytes', limit)
    const bytes = new TextEncoder().encode(file.content)
    if (bytes.length > remaining) throw tooLarge('Decoded inline bytes', limit)
    return bytes
  }
  const content = file.content
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  if (Math.floor(((content.length - padding) * 3) / 4) > remaining)
    throw tooLarge('Decoded inline bytes', limit)
  let decoded: string
  try {
    if (/[^A-Za-z0-9+/=]/.test(content)) throw new Error('Invalid base64 alphabet')
    decoded = atob(content)
  } catch {
    throw new ArtefactError('invalid_input', 'Invalid base64 file content')
  }
  if (decoded.length > remaining) throw tooLarge('Decoded inline bytes', limit)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  return bytes
}

export async function publish(runtime: Runtime, member: Member, input: Publish) {
  checkMember(member, true)
  const {
    env: { DB: db, BLOBS: blobs },
    config,
  } = runtime
  checkSlug(input.slug)
  const maxFiles = config.maxFilesPerArtefact
  const maxBytes = config.maxInlineBytes
  checkPublishArrayLengths(input)

  const deletes = new Set(input.delete)
  for (const path of deletes) checkPath(path)
  const changedPaths = new Set<string>()
  const pending: { path: string; type: string; bytes: Uint8Array }[] = []
  let remaining = maxBytes
  for (const file of input.files) {
    checkPath(file.path)
    if (changedPaths.has(file.path) || deletes.has(file.path)) {
      throw new ArtefactError(
        'invalid_input',
        'A path cannot be published twice or published and deleted together',
      )
    }
    const bytes = inlineBytes(file, remaining, maxBytes)
    remaining -= bytes.length
    changedPaths.add(file.path)
    pending.push({ path: file.path, type: contentType(file.path), bytes })
  }
  const newFiles: File[] = []
  let artefact = await head(db, input.slug)
  for (let attempt = 0; ; attempt++) {
    const current = artefact?.revision ?? 0
    if (artefact && artefact.deletedAt !== null) {
      throw new ArtefactError('conflict', 'This slug belongs to a deleted artefact', {
        currentRevision: current,
      })
    }
    checkRevision(input.expectedRevision, current)
    const id = artefact?.id ?? crypto.randomUUID()
    const merge = artefact !== null && input.mode === 'merge'
    const carry: string[] = []
    if (merge || deletes.size > 0) {
      const { results } = await db
        .prepare('SELECT path FROM files WHERE artefact_id = ? AND revision = ?')
        .bind(id, current)
        .all<Pick<File, 'path'>>()
      let removed = 0
      for (const { path } of results) {
        if (deletes.has(path)) removed++
        else if (merge && !changedPaths.has(path)) carry.push(path)
      }
      if (removed !== deletes.size)
        throw new ArtefactError('invalid_input', 'Cannot delete a path absent from the head')
    }
    const count = changedPaths.size + carry.length
    if (count === 0) throw new ArtefactError('invalid_input', 'The revision must contain at least one file')
    if (count > maxFiles) throw tooLarge('File count', maxFiles)

    if (pending.length > 0) {
      const limit = config.maxBlobWritesPerCall
      const hashes = await storeBlobs(db, blobs, pending, limit)
      if (!hashes) {
        throw new ArtefactError(
          'too_large',
          `More than ${limit} new blobs would be written; split into several merge publishes`,
        )
      }
      for (const [index, { path, type, bytes }] of pending.entries()) {
        newFiles.push({ path, type, size: bytes.length, sha256: hashes[index] })
      }
      pending.length = 0
    }
    const revision = current + 1
    const now = Date.now()
    const statements = []
    if (!artefact) {
      statements.push(
        db
          .prepare(`INSERT INTO artefacts
        (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'private', 1, ?, ?, ?)`)
          .bind(id, input.slug, input.title ?? input.slug, member.id, now, now),
      )
    }
    statements.push(
      db
        .prepare(
          'INSERT INTO revisions (artefact_id, number, created_by, created_at, message) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(id, revision, member.id, now, input.message ?? null),
    )
    // A chunk of up to 512 paths stays below D1's 2 MB bound string limit.
    for (let start = 0; start < carry.length; start += 512) {
      statements.push(
        db
          .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
        SELECT artefact_id, ?, path, sha256, size, content_type FROM files WHERE artefact_id = ? AND revision = ?
        AND path IN (SELECT value FROM json_each(?))`)
          .bind(revision, id, current, JSON.stringify(carry.slice(start, start + 512))),
      )
    }
    // Chunk bound JSON to keep individual statements small at the configured file limit.
    for (let start = 0; start < newFiles.length; start += 24) {
      statements.push(
        db
          .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
        SELECT ?, ?, json_extract(value, '$.path'), json_extract(value, '$.sha256'),
          json_extract(value, '$.size'), json_extract(value, '$.type') FROM json_each(?)`)
          .bind(id, revision, JSON.stringify(newFiles.slice(start, start + 24))),
      )
    }
    statements.push(
      db
        .prepare(`UPDATE artefacts SET current_revision = ?, title = COALESCE(?, title),
        updated_at = MAX(?, updated_at) WHERE id = ?`)
        .bind(revision, input.title ?? null, now, id),
      audit(db, now, member, id, 'artefact.publish', { revision, mode: input.mode }),
      storeRevisionEntry(db, id, revision),
    )
    let entry: D1Result<RevisionEntry> | undefined
    try {
      entry = (await db.batch<RevisionEntry>(statements)).at(-1)
    } catch (error) {
      const diagnostic = error instanceof Error ? `${error.message} ${error.cause}` : ''
      if (
        !/UNIQUE constraint failed: (?:artefacts\.slug|revisions\.artefact_id, revisions\.number)\b/.test(
          diagnostic,
        )
      )
        throw error
      const latest = await head(db, input.slug)
      if (!artefact || input.expectedRevision !== undefined || attempt === 3 || !latest || latest.id !== id) {
        throw conflict(latest?.revision ?? 0)
      }
      artefact = latest
      continue
    }
    const path = entry?.results[0]?.path
    if (!path) throw new Error('Published revision has no entry file')
    return { url: entryUrl(config.readOrigin, input.slug, path), revision }
  }
}

export async function editFile(
  runtime: Runtime,
  member: Member,
  input: {
    slug: string
    path: string
    oldText: string
    newText: string
    expectedRevision: number
    replaceAll?: boolean
  },
) {
  checkMember(member, true)
  checkPath(input.path)
  const { DB: db, BLOBS: blobs } = runtime.env
  const artefact = await liveHead(db, input.slug)
  checkRevision(input.expectedRevision, artefact.revision)
  if (!input.oldText.isWellFormed() || !input.newText.isWellFormed()) {
    throw new ArtefactError('invalid_input', 'oldText and newText must not contain lone surrogates')
  }
  if (!input.oldText) throw new ArtefactError('invalid_input', 'oldText must not be empty', { matches: 0 })
  const file = await findFile(db, artefact.id, artefact.revision, input.path)
  const inlineLimit = runtime.config.maxInlineBytes
  if (file.size > inlineLimit) throw tooLarge('File size', inlineLimit)
  const result = await blobText(blobs, file)
  if (result.reason === 'text_too_large') throw tooLarge('Text file size', MAX_TEXT_BYTES)
  if (result.text === undefined)
    throw new ArtefactError('invalid_input', `File cannot be edited as text: ${result.reason}`)
  const { text } = result
  let matches = 0
  for (
    let at = text.indexOf(input.oldText);
    at !== -1;
    at = text.indexOf(input.oldText, at + input.oldText.length)
  ) {
    if (++matches > 10_000) break
  }
  if (matches > 10_000) {
    throw new ArtefactError(
      'invalid_input',
      `Found at least ${matches} matches; edit_file allows at most 10,000. Use publish instead`,
      {
        matches,
      },
    )
  }
  if (matches === 0 || (matches > 1 && !input.replaceAll)) {
    throw new ArtefactError(
      'invalid_input',
      `Found ${matches} matches; expected ${input.replaceAll ? 'at least one' : 'exactly one'}`,
      { matches },
    )
  }
  // Bound expansion before creating the replacement string; publish checks exact UTF-8 bytes.
  if (text.length + matches * (input.newText.length - input.oldText.length) > inlineLimit) {
    throw tooLarge('Decoded inline bytes', inlineLimit)
  }
  const parts: string[] = []
  let previous = 0
  for (let at = text.indexOf(input.oldText); at !== -1; at = text.indexOf(input.oldText, previous)) {
    if (at > previous) parts.push(text.slice(previous, at))
    if (input.newText) parts.push(input.newText)
    previous = at + input.oldText.length
  }
  if (previous < text.length) parts.push(text.slice(previous))
  return publish(runtime, member, {
    slug: input.slug,
    files: [{ path: input.path, content: parts.join('') }],
    mode: 'merge',
    expectedRevision: input.expectedRevision,
  })
}

export async function setVisibility(
  { env: { DB: db } }: Runtime,
  member: Member,
  slug: string,
  visibility: Visibility,
) {
  checkMember(member, true)
  const { id } = await liveHead(db, slug)
  const now = Date.now()
  const [result] = await db.batch([
    db
      .prepare(
        'UPDATE artefacts SET visibility = ?, updated_at = MAX(?, updated_at) WHERE id = ? AND deleted_at IS NULL',
      )
      .bind(visibility, now, id),
    audit(db, now, member, id, 'artefact.visibility', { visibility }),
  ])
  if (result.meta.changes !== 1) throw new ArtefactError('not_found', 'Artefact not found')
  return { visibility }
}

const maxActiveShareLinks = 100

async function shareLinkMetadata(db: D1Database, artefactId: string) {
  const { results } = await db
    .prepare(`SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM share_links
      WHERE artefact_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id LIMIT ?`)
    .bind(artefactId, maxActiveShareLinks)
    .all<{ id: string; label: string | null; createdAt: number; lastUsedAt: number | null }>()
  return results
}

function shareUrl(origin: string, slug: string, key: string) {
  return `${origin}/s/${slug}/${key}/`
}

export async function createShareLink(
  { env: { DB: db }, config }: Runtime,
  member: Member,
  { slug, label, key: suppliedKey }: { slug: string; label?: string; key?: unknown },
) {
  checkMember(member, true)
  if (suppliedKey !== undefined && member.role !== 'admin') {
    throw new ArtefactError('forbidden', 'Only an admin can supply a share key')
  }
  if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !validShareKey(suppliedKey))) {
    throw new ArtefactError('invalid_input', 'Share keys must contain 16–128 URL-safe characters')
  }
  const artefact = await liveHead(db, slug)
  const key = suppliedKey ?? generateShareKey()
  const id = crypto.randomUUID()
  const now = Date.now()
  const [keyHash, sealed] = await Promise.all([
    hashSecret(key),
    sealShareKey(config.sealKey, id, artefact.id, key),
  ])
  const [insert] = await db.batch([
    db
      .prepare(`INSERT INTO share_links (id, artefact_id, label, key_hash, key_sealed, created_by, created_at)
        SELECT ?, id, ?, ?, ?, ?, ? FROM artefacts WHERE id = ? AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM share_links WHERE artefact_id = artefacts.id AND revoked_at IS NULL LIMIT 1 OFFSET ?
          )
        ON CONFLICT(key_hash) DO NOTHING`)
      .bind(id, label ?? null, keyHash, sealed, member.id, now, artefact.id, maxActiveShareLinks - 1),
    audit(db, now, member, artefact.id, 'share.create', { id }),
  ])
  if (insert.meta.changes !== 1) {
    const current = await liveHead(db, slug)
    if (current.id !== artefact.id) throw new ArtefactError('not_found', 'Artefact not found')
    const keyExists = await db.prepare('SELECT id FROM share_links WHERE key_hash = ?').bind(keyHash).first()
    if (keyExists) throw new ArtefactError('conflict', 'Share key is unavailable')
    throw tooLarge('Active share link count', maxActiveShareLinks)
  }
  return { id, url: shareUrl(config.readOrigin, slug, key) }
}

export async function listShareLinks({ env: { DB: db } }: Runtime, member: Member, slug: string) {
  checkMember(member, true)
  const { id } = await liveHead(db, slug)
  return { shareLinks: await shareLinkMetadata(db, id) }
}

export async function getShareLink({ env: { DB: db }, config }: Runtime, member: Member, id: string) {
  checkMember(member, true)
  const link = await db
    .prepare(`SELECT s.artefact_id AS artefactId, s.key_sealed AS sealed, a.slug
      FROM share_links s JOIN artefacts a ON a.id = s.artefact_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND a.deleted_at IS NULL`)
    .bind(id)
    .first<{ artefactId: string; sealed: string; slug: string }>()
  if (!link) throw new ArtefactError('not_found', 'Share link not found')
  const key = await unsealShareKey(config.sealKey, id, link.artefactId, link.sealed)
  return { url: shareUrl(config.readOrigin, link.slug, key) }
}

export async function revokeShareLink({ env: { DB: db } }: Runtime, member: Member, id: string) {
  checkMember(member, true)
  const artefactId = await db
    .prepare('SELECT artefact_id FROM share_links WHERE id = ? AND revoked_at IS NULL')
    .bind(id)
    .first<string>('artefact_id')
  if (artefactId === null) throw new ArtefactError('not_found', 'Share link not found')
  const now = Date.now()
  const [update] = await db.batch([
    db
      .prepare(`UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM artefacts WHERE id = ? AND deleted_at IS NULL)`)
      .bind(now, id, artefactId),
    audit(db, now, member, artefactId, 'share.revoke', { id }),
  ])
  if (update.meta.changes !== 1) throw new ArtefactError('not_found', 'Share link not found')
  return {}
}
