import { base64url } from 'jose'
import { z } from 'zod'
import { MAX_ARTEFACT_FILES, type Runtime } from '../config'
import { blobText, contentType, MAX_TEXT_BYTES, storeBlobs, textSlice } from './blobs'
import { auditChange, hashSecret, type Member } from './index'
import { trimLookahead } from './pagination'
import { redirectPrefix } from './read-path'
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
type InlineFile = { path: string; content: string; encoding?: 'utf8' | 'base64'; type?: string }
type Publish = {
  slug: string
  title?: string
  files: (InlineFile | { path: string; uploadId: string })[]
  mode: 'merge' | 'replace'
  delete?: string[]
  expectedRevision?: number
  message?: string
}

const listCursor = z.tuple([z.int().nonnegative(), z.uuid(), z.string()])
const fileCursor = z.tuple([z.uuid(), z.int().positive(), z.string()])
const revisionCursor = z.tuple([z.uuid(), z.int().positive()])

function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  try {
    // Forge's longest cursor is a file tuple containing a path of at most 512 UTF-16 code units.
    if (cursor.length > 4096) throw new Error('Cursor length exceeds limit')
    return schema.parse(JSON.parse(new TextDecoder().decode(base64url.decode(cursor))))
  } catch {
    throw new ArtefactError('invalid_input', 'Invalid cursor; use the cursor returned by Forge')
  }
}

export function checkMember(member: Member, write = false) {
  if (member.status !== 'active' || (write && member.role === 'viewer')) {
    throw new ArtefactError(
      'forbidden',
      write ? 'An active publisher or admin is required' : 'An active member is required',
    )
  }
}

export function requireAdmin(member: Member) {
  checkMember(member)
  if (member.role !== 'admin') throw new ArtefactError('forbidden', 'An active admin is required')
}

export function checkSlug(slug: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    throw new ArtefactError(
      'invalid_input',
      'Invalid slug; use 1–64 lowercase letters, digits or internal hyphens',
    )
  }
}

export function checkPath(path: string) {
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

function checkArtefactId(artefact: Artefact | null, expectedId?: string) {
  if (artefact && expectedId !== undefined && artefact.id !== expectedId)
    throw new ArtefactError('conflict', 'The slug now belongs to a different artefact')
}

async function liveHead(db: D1Database, slug: string, expectedId?: string) {
  checkSlug(slug)
  const artefact = await head(db, slug)
  checkArtefactId(artefact, expectedId)
  if (!artefact || artefact.deletedAt !== null) throw new ArtefactError('not_found', 'Artefact not found')
  return artefact
}

type RevisionEntry = { path: string | null }

function selectRevisionEntry(db: D1Database, id: string, revision: number) {
  return db
    .prepare('SELECT entry_path AS path FROM revisions WHERE artefact_id = ? AND number = ?')
    .bind(id, revision)
}

function computeRevisionEntry(db: D1Database, id: string, revision: number | null) {
  return db
    .prepare(`WITH target(number) AS (
      SELECT COALESCE(?2, (SELECT current_revision FROM artefacts WHERE id = ?1))
    )
    SELECT COALESCE(
      (SELECT path FROM files WHERE artefact_id = ?1 AND revision = target.number AND path = 'index.html'),
      (SELECT path FROM files WHERE artefact_id = ?1 AND revision = target.number
       ORDER BY (lower(trim(substr(content_type, 1, instr(content_type || ';', ';') - 1), char(9) || ' '))
         = 'text/html') DESC, path LIMIT 1)
    ) AS path FROM target`)
    .bind(id, revision)
}

async function cacheRevisionEntries(
  db: D1Database,
  entries: (RevisionEntry & { id: string; revision: number })[],
  ctx?: ExecutionContext,
) {
  const persist = async () => {
    const updates = []
    for (const { id, revision, path } of entries) {
      if (path === null) continue
      updates.push(
        db
          .prepare(
            'UPDATE revisions SET entry_path = ? WHERE artefact_id = ? AND number = ? AND entry_path IS NULL',
          )
          .bind(path, id, revision),
      )
    }
    if (updates.length > 0) await db.batch(updates)
  }
  const update = persist().catch(() => console.error('Forge revision entry cache write failed'))
  if (ctx) ctx.waitUntil(update)
  else await update
}

export async function revisionEntry(
  db: D1Database,
  id: string,
  revision: number,
  { ctx, cache = true }: { ctx?: ExecutionContext; cache?: boolean } = {},
) {
  const cached = await selectRevisionEntry(db, id, revision).first<string>('path')
  if (cached !== null) return cached
  const path = await computeRevisionEntry(db, id, revision).first<string>('path')
  if (cache && path !== null) await cacheRevisionEntries(db, [{ id, revision, path }], ctx)
  return path
}

function entryUrl(origin: string, slug: string, path: string) {
  const base = `${origin}/a/${slug}/`
  return path === 'index.html' ? base : base + encodeFilePath(path)
}

export function encodeFilePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

export async function publicArtefacts({ env: { DB: db }, config }: Runtime, ctx?: ExecutionContext) {
  const { results } = await db
    .prepare(`SELECT a.id, a.slug, a.title, r.number AS revision, r.entry_path AS path
      FROM artefacts a JOIN revisions r ON r.artefact_id = a.id AND r.number = a.current_revision
      WHERE a.deleted_at IS NULL AND a.visibility = 'public'
      ORDER BY a.created_at DESC, a.slug LIMIT 200`)
    .all<RevisionEntry & { id: string; slug: string; title: string; revision: number }>()
  const legacy = results.filter(({ path }) => path === null)
  if (legacy.length > 0) {
    const entries = await db.batch<RevisionEntry>(
      legacy.map(({ id, revision }) => computeRevisionEntry(db, id, revision)),
    )
    for (const [index, row] of legacy.entries()) row.path = entries[index].results[0]?.path ?? null
    await cacheRevisionEntries(db, legacy, ctx)
  }
  return results.flatMap(({ slug, title, path }) =>
    path === null ? [] : [{ slug, title, url: entryUrl(config.readOrigin, slug, path) }],
  )
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
  const last = trimLookahead(results, 50)
  return {
    artefacts: results.map(({ id: _id, ...row }) => row),
    nextCursor: last ? base64url.encode(JSON.stringify([last.updatedAt, last.id, query])) : undefined,
  }
}

export async function getArtefact(
  runtime: Runtime,
  member: Member,
  slug: string,
  cursor?: string,
  ctx?: ExecutionContext,
) {
  const { id: _id, ...artefact } = await getArtefactDetails(runtime, member, slug, cursor, ctx)
  return artefact
}

export async function getArtefactDetails(
  runtime: Runtime,
  member: Member,
  slug: string,
  cursor?: string,
  ctx?: ExecutionContext,
) {
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
    revisionEntry(db, id, revision, { ctx }),
    shareLinkMetadata(db, id),
  ])
  if (!path) throw new Error('Artefact head has no entry file')
  const files = page.results
  const last = trimLookahead(files, 200)
  const nextCursor = last ? base64url.encode(JSON.stringify([id, revision, last.path])) : undefined
  return { id, ...artefact, files, url: entryUrl(config.readOrigin, slug, path), shareLinks, nextCursor }
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

type ReadSession = () => Promise<{ member: Member; fresh: boolean } | null>
type CanonicalDecision = { kind: 'sign-in' | 'pending' | 'revalidate' }

async function deniedCanonical(isPublic: boolean, session: ReadSession): Promise<CanonicalDecision | null> {
  if (isPublic) return null
  const current = await session()
  if (!current) return { kind: 'sign-in' }
  if (!current.fresh) return { kind: 'revalidate' }
  if (current.member.status !== 'active') return { kind: 'pending' }
  return null
}

async function findRedirect(db: D1Database, slug: string, pathname: string, keyHash?: string) {
  const kind = keyHash === undefined ? 'a' : 's'
  const root = `/${kind}/${slug}/`
  const prefixes = [root]
  if (kind === 'a') {
    for (let end = pathname.indexOf('/', root.length); end !== -1; end = pathname.indexOf('/', end + 1))
      prefixes.push(pathname.slice(0, end + 1))
  }
  const target = await db
    .prepare(`SELECT r.from_prefix AS prefix, r.target_path AS path, a.slug, a.visibility, a.deleted_at
      FROM json_each(?) p JOIN redirects r ON r.from_prefix = p.value
      JOIN artefacts a ON a.id = r.target_artefact_id
      WHERE NOT EXISTS (SELECT 1 FROM artefacts WHERE slug = ?)
      AND (?3 IS NULL OR EXISTS (
        SELECT 1 FROM share_links WHERE key_hash = ?3 AND artefact_id = a.id AND revoked_at IS NULL
      ))
      ORDER BY length(r.from_prefix) DESC LIMIT 1`)
    .bind(JSON.stringify(prefixes), slug, keyHash ?? null)
    .first<{
      prefix: string
      path: string
      slug: string
      visibility: Visibility
      deleted_at: number | null
    }>()
  if (!target || target.deleted_at !== null) return null
  return {
    location: `/${kind}/${target.slug}/${target.path}${pathname.slice(target.prefix.length)}`,
    public: target.visibility === 'public',
  }
}

export async function canonicalRead(
  { env: { DB: db } }: Runtime,
  slug: string,
  path: string,
  pathname: string,
  session: ReadSession,
) {
  const artefact = await head(db, slug)
  if (!artefact) {
    const target = await findRedirect(db, slug, pathname)
    if (!target) return { kind: 'not-found' } as const
    return (
      (await deniedCanonical(target.public, session)) ??
      ({ kind: 'redirect', location: target.location } as const)
    )
  }
  if (artefact.deletedAt !== null) return { kind: 'not-found' } as const
  const isPublic = artefact.visibility === 'public'
  const denied = await deniedCanonical(isPublic, session)
  if (denied) return denied
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
  pathname: string,
  ctx: ExecutionContext,
) {
  const keyHash = await hashSecret(key)
  const link = await db
    .prepare(`SELECT s.id, a.id AS artefactId, s.last_used_at AS lastUsedAt,
      a.current_revision AS revision FROM artefacts a LEFT JOIN share_links s
      ON s.key_hash = ? AND s.artefact_id = a.id AND s.revoked_at IS NULL AND a.deleted_at IS NULL
      WHERE a.slug = ?`)
    .bind(keyHash, slug)
    .first<{ id: string | null; artefactId: string; lastUsedAt: number | null; revision: number }>()
  if (!link) {
    const target = await findRedirect(db, slug, pathname, keyHash)
    if (target) return { kind: 'redirect', location: target.location } as const
  }
  if (!link?.id) return { kind: 'not-found' } as const
  if (path === undefined) return { kind: 'slash' } as const
  const resolved = await resolveReadFile(db, link.artefactId, link.revision, path)
  if (resolved.kind === 'not-found' && path === '') {
    const entry = await revisionEntry(db, link.artefactId, link.revision, { ctx })
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
  if (number <= artefact.revision - runtime.config.revisionRetention)
    throw new ArtefactError('not_found', 'Revision not found')
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

function diagnostic(error: unknown) {
  return error instanceof Error ? `${error.message} ${error.cause}` : ''
}

type Commit = {
  id: string
  slug: string
  current: number
  title?: string
  message?: string
  action: 'artefact.publish' | 'artefact.restore_revision'
  detail: Record<string, unknown>
  source?: number
  carry?: string[]
  newFiles?: File[]
  uploaded?: { path: string; uploadId: string }[]
  epoch?: number
}

async function commitRevision(
  { env: { DB: db }, config }: Runtime,
  member: Member,
  { id, slug, current, title, message, action, detail, source, carry, newFiles, uploaded, epoch }: Commit,
  ctx?: ExecutionContext,
) {
  const revision = current + 1
  const now = Date.now()
  const statements = []
  if (current === 0) {
    statements.push(
      db
        .prepare(`INSERT INTO artefacts
          (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
          VALUES (?1, CASE WHEN NOT EXISTS (
            SELECT 1 FROM reserved_lifecycle_slugs WHERE slug = ?2
          ) THEN ?2 END, ?3, 'private', 0, ?4, ?5, ?5)`)
        .bind(id, slug, title ?? slug, member.id, now),
    )
  }
  // A failed guard aborts the entire batch via the NOT NULL constraint, before any files are inserted.
  statements.push(
    db
      .prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at, message)
        VALUES (CASE WHEN EXISTS (
          SELECT 1 FROM artefacts WHERE id = ?1 AND slug = ?2 AND current_revision = ?3 AND deleted_at IS NULL
        ) AND (?4 IS NULL OR ?4 = (SELECT epoch FROM blob_purge_epoch WHERE singleton = 1))
        AND (?9 IS NULL OR EXISTS (SELECT 1 FROM revisions WHERE artefact_id = ?1 AND number = ?9))
        THEN ?1 END, ?5, ?6, ?7, ?8)`)
      .bind(id, slug, current, epoch ?? null, revision, member.id, now, message ?? null, source ?? null),
  )
  if (source !== undefined) {
    statements.push(
      db
        .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
          SELECT artefact_id, ?, path, sha256, size, content_type FROM files
          WHERE artefact_id = ? AND revision = ?`)
        .bind(revision, id, source),
    )
  }
  // Keep the number of statements and size of each bound JSON value bounded.
  for (let start = 0; carry && start < carry.length; start += 512) {
    statements.push(
      db
        .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
          SELECT artefact_id, ?, path, sha256, size, content_type FROM files WHERE artefact_id = ? AND revision = ?
          AND path IN (SELECT value FROM json_each(?))`)
        .bind(revision, id, current, JSON.stringify(carry.slice(start, start + 512))),
    )
  }
  for (let start = 0; newFiles && start < newFiles.length; start += 256) {
    statements.push(
      db
        .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
          SELECT ?, ?, json_extract(value, '$.path'), json_extract(value, '$.sha256'),
            json_extract(value, '$.size'), json_extract(value, '$.type') FROM json_each(?)`)
        .bind(id, revision, JSON.stringify(newFiles.slice(start, start + 256))),
    )
  }
  for (let start = 0; uploaded && start < uploaded.length; start += 256) {
    const chunk = JSON.stringify(uploaded.slice(start, start + 256))
    // Missing, expired or consumed IDs abort the entire revision, including earlier chunks.
    statements.push(
      db
        .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
          SELECT ?, ?, json_extract(entry.value, '$.path'), u.sha256, u.size, u.content_type
          FROM json_each(?) AS entry LEFT JOIN uploads AS u
          ON u.upload_id = json_extract(entry.value, '$.uploadId')
          AND u.path = json_extract(entry.value, '$.path')
          AND u.slug = ? AND u.member_id = ? AND u.state = 'stored'
          AND u.expires_at > unixepoch('subsec') * 1000`)
        .bind(id, revision, chunk, slug, member.id),
      db
        .prepare(`UPDATE uploads SET state = 'consumed'
          WHERE upload_id IN (SELECT json_extract(value, '$.uploadId') FROM json_each(?))`)
        .bind(chunk),
    )
  }
  statements.push(
    db
      .prepare(`UPDATE artefacts SET current_revision = ?, title = COALESCE(?, title),
        updated_at = MAX(?, updated_at) WHERE id = ?`)
      .bind(revision, title ?? null, now, id),
    auditChange(db, now, member.id, action, { revision, ...detail }, id),
    db
      .prepare(`DELETE FROM revisions WHERE artefact_id = ?1 AND number IN (
        SELECT number FROM revisions WHERE artefact_id = ?1 AND number <= ?2 ORDER BY number LIMIT 2
      )`)
      .bind(id, revision - config.revisionRetention),
    computeRevisionEntry(db, id, revision),
  )
  const entry = (await db.batch<RevisionEntry>(statements)).at(-1)
  const path = entry?.results[0]?.path
  if (!path) throw new Error('Committed revision has no entry file')
  await cacheRevisionEntries(db, [{ id, revision, path }], ctx)
  return { url: entryUrl(config.readOrigin, slug, path), revision }
}

function revisionCommitConflict(error: unknown) {
  return /(?:NOT NULL constraint failed: revisions\.artefact_id|forge blob purge in progress)\b/.test(
    diagnostic(error),
  )
}

export async function listRevisions(
  { env: { DB: db }, config }: Runtime,
  member: Member,
  slug: string,
  cursor?: string,
  expectedId?: string,
) {
  checkMember(member)
  const artefact = await liveHead(db, slug, expectedId)
  const after = cursor === undefined ? null : decodeCursor(cursor, revisionCursor)
  if (after && after[0] !== artefact.id)
    throw new ArtefactError('invalid_input', 'Cursor belongs to a different artefact')
  const { results } = await db
    .prepare(`SELECT r.number, CASE WHEN ?4 THEN m.name ELSE r.created_by END AS author,
      r.created_at AS createdAt, r.message FROM revisions r JOIN members m ON m.id = r.created_by
      WHERE r.artefact_id = ?1 AND r.number > ?2 AND (?3 IS NULL OR r.number < ?3)
      ORDER BY r.number DESC LIMIT 21`)
    .bind(
      artefact.id,
      artefact.revision - config.revisionRetention,
      after?.[1] ?? null,
      Number(expectedId !== undefined),
    )
    .all<{ number: number; author: string; createdAt: number; message: string | null }>()
  const last = trimLookahead(results, 20)
  return {
    revisions: results,
    nextCursor: last ? base64url.encode(JSON.stringify([artefact.id, last.number])) : undefined,
  }
}

export async function restoreRevision(
  runtime: Runtime,
  member: Member,
  slug: string,
  source: number,
  ctx?: ExecutionContext,
  expectedId?: string,
) {
  checkMember(member, true)
  const {
    env: { DB: db },
    config,
  } = runtime
  const { id, revision: current } = await liveHead(db, slug, expectedId)
  if (
    source <= current - config.revisionRetention ||
    source > current ||
    !(await db
      .prepare('SELECT 1 FROM revisions WHERE artefact_id = ? AND number = ?')
      .bind(id, source)
      .first())
  )
    throw new ArtefactError('not_found', 'Revision not found')
  try {
    const { revision } = await commitRevision(
      runtime,
      member,
      {
        id,
        slug,
        current,
        source,
        action: 'artefact.restore_revision',
        detail: { source },
      },
      ctx,
    )
    return { revision }
  } catch (error) {
    if (!revisionCommitConflict(error)) throw error
    const currentHead = await head(db, slug)
    throw conflict(currentHead?.id === id ? currentHead.revision : 0)
  }
}

export async function publish(
  runtime: Runtime,
  member: Member,
  input: Publish,
  ctx?: ExecutionContext,
  expectedArtefactId?: string,
) {
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
  const uploaded: { path: string; uploadId: string }[] = []
  let remaining = maxBytes
  for (const file of input.files) {
    checkPath(file.path)
    if (changedPaths.has(file.path) || deletes.has(file.path)) {
      throw new ArtefactError(
        'invalid_input',
        'A path cannot be published twice or published and deleted together',
      )
    }
    changedPaths.add(file.path)
    if ('uploadId' in file) {
      uploaded.push(file)
      continue
    }
    const bytes = inlineBytes(file, remaining, maxBytes)
    remaining -= bytes.length
    pending.push({ path: file.path, type: file.type ?? contentType(file.path), bytes })
  }
  const newFiles: File[] = []
  let epoch: number | undefined
  let artefact = await head(db, input.slug)
  for (let attempt = 0; ; attempt++) {
    const current = artefact?.revision ?? 0
    if (expectedArtefactId !== undefined && expectedArtefactId !== artefact?.id) throw conflict(current)
    if (artefact && artefact.deletedAt !== null) {
      throw new ArtefactError('conflict', 'This slug belongs to a deleted artefact', {
        currentRevision: current,
      })
    }
    checkRevision(input.expectedRevision, current)
    if (
      !artefact &&
      (await db
        .prepare('SELECT 1 FROM reserved_lifecycle_slugs WHERE slug = ? LIMIT 1')
        .bind(input.slug)
        .first())
    )
      throw new ArtefactError('conflict', 'Slug is unavailable', { currentRevision: 0 })
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
      // Snapshot before storage: a claim that came and went since dedup still invalidates this write.
      epoch =
        (await db.prepare('SELECT epoch FROM blob_purge_epoch WHERE singleton = 1').first<number>('epoch')) ??
        undefined
      if (epoch === undefined) throw new Error('Missing blob purge epoch')
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
    try {
      return await commitRevision(
        runtime,
        member,
        {
          id,
          slug: input.slug,
          current,
          title: input.title,
          message: input.message,
          action: 'artefact.publish',
          detail: { mode: input.mode },
          carry,
          newFiles,
          uploaded,
          epoch,
        },
        ctx,
      )
    } catch (error) {
      if (uploaded.length > 0 && /NOT NULL constraint failed: files\.sha256\b/.test(diagnostic(error))) {
        throw new ArtefactError('not_found', 'Stored upload not found for this file')
      }
      if (/(?:UNIQUE|NOT NULL) constraint failed: artefacts\.slug\b/.test(diagnostic(error))) {
        throw conflict((await head(db, input.slug))?.revision ?? 0)
      }
      if (!revisionCommitConflict(error)) throw error
      const latest = await head(db, input.slug)
      if (
        !artefact ||
        input.expectedRevision !== undefined ||
        attempt === 3 ||
        latest?.id !== id ||
        latest.deletedAt !== null ||
        latest.revision === current
      ) {
        throw conflict(latest?.revision ?? 0)
      }
      artefact = latest
    }
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
  ctx?: ExecutionContext,
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
  const content = text.replaceAll(input.oldText, () => input.newText)
  let hasCharset = false
  // Consume whole parameter values, including quoted semicolons.
  let type = file.type.replace(/;[ \t]*([^=;]+)=(?:"(?:[^"\\]|\\.)*"|[^;]*)/g, (param, name: string) => {
    if (name.toLowerCase() !== 'charset') return param
    if (hasCharset) return ''
    hasCharset = true
    return '; charset=utf-8'
  })
  if (!hasCharset) type += '; charset=utf-8'
  return publish(
    runtime,
    member,
    {
      slug: input.slug,
      files: [{ path: input.path, content, type }],
      mode: 'merge',
      expectedRevision: input.expectedRevision,
    },
    ctx,
    artefact.id,
  )
}

export async function setVisibility(
  { env: { DB: db } }: Runtime,
  member: Member,
  slug: string,
  visibility: Visibility,
  expectedId?: string,
) {
  checkMember(member, true)
  const { id } = await liveHead(db, slug, expectedId)
  const now = Date.now()
  const [result] = await db.batch([
    db
      .prepare(`UPDATE artefacts SET visibility = ?, updated_at = MAX(?, updated_at)
        WHERE id = ? AND slug = ? AND deleted_at IS NULL`)
      .bind(visibility, now, id, slug),
    auditChange(db, now, member.id, 'artefact.visibility', { visibility }, id),
  ])
  if (result.meta.changes !== 1) throw new ArtefactError('not_found', 'Artefact not found')
  return { visibility }
}

export async function renameArtefact(
  { env: { DB: db }, config }: Runtime,
  member: Member,
  slug: string,
  newSlug: string,
  expectedId?: string,
) {
  checkMember(member, true)
  checkSlug(newSlug)
  const { id, revision } = await liveHead(db, slug, expectedId)
  if (slug === newSlug) throw new ArtefactError('invalid_input', 'Choose a different slug')
  const now = Date.now()
  try {
    const [rename, , , , entry] = await db.batch<RevisionEntry>([
      db
        .prepare(`UPDATE artefacts SET slug = ?1, updated_at = MAX(?2, updated_at)
          WHERE id = ?3 AND slug = ?4 AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM artefact_purges WHERE slug = ?1)
          AND NOT EXISTS (
            SELECT 1 FROM redirects WHERE source_slug = ?1 AND target_artefact_id <> ?3
          )`)
        .bind(newSlug, now, id, slug),
      auditChange(db, now, member.id, 'artefact.rename', { from: slug, to: newSlug }, id),
      db
        .prepare(`INSERT INTO redirects (from_prefix, source_slug, target_artefact_id, target_path, created_at, created_by)
          SELECT value, ?2, ?3, '', ?4, ?5 FROM json_each(?1) WHERE changes() = 1
          ON CONFLICT(from_prefix) DO UPDATE SET target_artefact_id = excluded.target_artefact_id,
            target_path = excluded.target_path, created_at = excluded.created_at, created_by = excluded.created_by`)
        .bind(JSON.stringify([`/a/${slug}/`, `/s/${slug}/`]), slug, id, now, member.id),
      db
        .prepare(
          'DELETE FROM redirects WHERE from_prefix IN (?, ?) AND target_artefact_id = ? AND changes() = 2',
        )
        .bind(`/a/${newSlug}/`, `/s/${newSlug}/`, id),
      computeRevisionEntry(db, id, null),
    ])
    if (rename.meta.changes !== 1)
      throw new ArtefactError('conflict', 'Source slug changed or target slug is unavailable')
    const path = entry.results[0]?.path
    if (!path) throw new Error('Renamed artefact has no entry file')
    return { url: entryUrl(config.readOrigin, newSlug, path) }
  } catch (error) {
    if (/UNIQUE constraint failed: artefacts\.slug\b/.test(diagnostic(error)))
      throw new ArtefactError('conflict', 'Target slug is unavailable', { currentRevision: revision })
    throw error
  }
}

export async function deleteArtefact(
  { env: { DB: db } }: Runtime,
  member: Member,
  slug: string,
  expectedId?: string,
) {
  checkMember(member, true)
  const { id } = await liveHead(db, slug, expectedId)
  const now = Date.now()
  const [deleted] = await db.batch([
    db
      .prepare(`UPDATE artefacts SET deleted_at = ?1, updated_at = MAX(?1, updated_at)
        WHERE id = ?2 AND slug = ?3 AND deleted_at IS NULL`)
      .bind(now, id, slug),
    auditChange(db, now, member.id, 'artefact.delete', {}, id),
  ])
  if (deleted.meta.changes !== 1) throw new ArtefactError('conflict', 'Artefact changed')
  return {}
}

export const deletedRetentionMs = 30 * 24 * 60 * 60 * 1_000

export async function listDeletedArtefacts({ env: { DB: db } }: Runtime, member: Member, after = '') {
  requireAdmin(member)
  const { results: artefacts } = await db
    .prepare(`SELECT a.id, a.slug, a.title, a.deleted_at AS deletedAt,
      p.artefact_id IS NOT NULL AS purging, p.artefact_id IS NULL AND a.deleted_at > ?2 AS restorable
    FROM artefacts a LEFT JOIN artefact_purges p ON p.artefact_id = a.id
    WHERE a.deleted_at IS NOT NULL AND a.slug > ?1
    UNION ALL
    SELECT p.artefact_id, p.slug, NULL, NULL, 1, 0 FROM artefact_purges p
    WHERE p.slug > ?1 AND NOT EXISTS (SELECT 1 FROM artefacts WHERE id = p.artefact_id)
    ORDER BY slug LIMIT 51`)
    .bind(after, Date.now() - deletedRetentionMs)
    .all<{
      id: string
      slug: string
      title: string | null
      deletedAt: number | null
      purging: number
      restorable: number
    }>()
  const last = trimLookahead(artefacts, 50)
  return {
    artefacts: artefacts.map((row) => ({ ...row, purging: !!row.purging, restorable: !!row.restorable })),
    nextCursor: last?.slug,
  }
}

export async function restoreDeletedArtefact(
  { env: { DB: db } }: Runtime,
  member: Member,
  slug: string,
  expectedId?: string,
) {
  requireAdmin(member)
  checkSlug(slug)
  const artefact = await head(db, slug)
  checkArtefactId(artefact, expectedId)
  if (!artefact || artefact.deletedAt === null)
    throw new ArtefactError('not_found', 'Deleted artefact not found')
  const now = Date.now()
  const [restored] = await db.batch([
    db
      .prepare(`UPDATE artefacts SET deleted_at = NULL, updated_at = MAX(?1, updated_at)
        WHERE id = ?2 AND deleted_at = ?3 AND deleted_at > ?4 AND slug = ?5
        AND NOT EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?2)`)
      .bind(now, artefact.id, artefact.deletedAt, now - deletedRetentionMs, slug),
    auditChange(db, now, member.id, 'artefact.restore_deleted', {}, artefact.id),
  ])
  if (restored.meta.changes !== 1) throw new ArtefactError('conflict', 'The artefact is no longer restorable')
  return {}
}

export const redirectBatchLimit = 50

export async function listRedirects({ env: { DB: db } }: Runtime, member: Member, after = '') {
  requireAdmin(member)
  const { results: redirects } = await db
    .prepare(`SELECT r.from_prefix AS fromPrefix,
      substr(r.from_prefix, 1, 3) || a.slug || '/' || r.target_path AS toPrefix
    FROM redirects r JOIN artefacts a ON a.id = r.target_artefact_id
    WHERE r.from_prefix > ? ORDER BY r.from_prefix LIMIT 51`)
    .bind(after)
    .all<{ fromPrefix: string; toPrefix: string }>()
  return { redirects, nextCursor: trimLookahead(redirects, 50)?.fromPrefix }
}

export async function setRedirects(
  { env: { DB: db } }: Runtime,
  member: Member,
  { add, remove }: { add: { fromPrefix: string; toPrefix: string }[]; remove: string[] },
) {
  requireAdmin(member)
  if (add.length > redirectBatchLimit || remove.length > redirectBatchLimit)
    throw tooLarge('Redirect batch', redirectBatchLimit)
  if (add.length === 0 && remove.length === 0) return {}
  const seen = new Set<string>()
  const additions = add.map(({ fromPrefix, toPrefix }) => {
    const from = redirectPrefix(fromPrefix)
    const to = redirectPrefix(toPrefix)
    if (!from || !to || from.kind !== to.kind || from.slug === to.slug || seen.has(fromPrefix))
      throw new ArtefactError(
        'invalid_input',
        'Supply unique prefixes within one namespace and different slugs',
      )
    seen.add(fromPrefix)
    return [fromPrefix, from.slug, to.slug, toPrefix.slice(to.slug.length + 4)]
  })
  if (remove.some((prefix) => !redirectPrefix(prefix)))
    throw new ArtefactError('invalid_input', 'Invalid redirect prefix')
  const now = Date.now()
  try {
    await db.batch([
      db
        .prepare('DELETE FROM redirects WHERE from_prefix IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(remove)),
      db
        .prepare(`INSERT INTO redirects (from_prefix, source_slug, target_artefact_id, target_path, created_at, created_by)
          SELECT json_extract(p.value, '$[0]'), json_extract(p.value, '$[1]'),
            (SELECT id FROM artefacts WHERE slug = json_extract(p.value, '$[2]') AND deleted_at IS NULL),
            json_extract(p.value, '$[3]'), ?, ? FROM json_each(?) p WHERE 1
          ON CONFLICT(from_prefix) DO UPDATE SET target_artefact_id = excluded.target_artefact_id,
            target_path = excluded.target_path, created_at = excluded.created_at, created_by = excluded.created_by`)
        .bind(now, member.id, JSON.stringify(additions)),
      db
        .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
          VALUES (?, ?, ?, 'redirects.set', ?)`)
        .bind(crypto.randomUUID(), now, member.id, JSON.stringify({ add, remove })),
    ])
  } catch (error) {
    if (/NOT NULL constraint failed: redirects\.target_artefact_id\b/.test(diagnostic(error)))
      throw new ArtefactError('not_found', 'Redirect target must be a live artefact')
    throw error
  }
  return {}
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
  expectedId?: string,
) {
  checkMember(member, true)
  if (suppliedKey !== undefined && member.role !== 'admin') {
    throw new ArtefactError('forbidden', 'Only an admin can supply a share key')
  }
  if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !validShareKey(suppliedKey))) {
    throw new ArtefactError('invalid_input', 'Share keys must contain 16–128 URL-safe characters')
  }
  const artefact = await liveHead(db, slug, expectedId)
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
        SELECT ?, id, ?, ?, ?, ?, ? FROM artefacts WHERE id = ? AND slug = ? AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM share_links WHERE artefact_id = artefacts.id AND revoked_at IS NULL LIMIT 1 OFFSET ?
          )
        ON CONFLICT(key_hash) DO NOTHING`)
      .bind(id, label ?? null, keyHash, sealed, member.id, now, artefact.id, slug, maxActiveShareLinks - 1),
    auditChange(db, now, member.id, 'share.create', { id }, artefact.id),
  ])
  if (insert.meta.changes !== 1) {
    const current = await liveHead(db, slug, expectedId)
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

export async function getShareLink(
  { env: { DB: db }, config }: Runtime,
  member: Member,
  id: string,
  slug?: string,
) {
  checkMember(member, true)
  const link = await db
    .prepare(`SELECT s.artefact_id AS artefactId, s.key_sealed AS sealed, a.slug
      FROM share_links s JOIN artefacts a ON a.id = s.artefact_id
      WHERE s.id = ?1 AND s.revoked_at IS NULL AND a.deleted_at IS NULL AND (?2 IS NULL OR a.slug = ?2)`)
    .bind(id, slug ?? null)
    .first<{ artefactId: string; sealed: string; slug: string }>()
  if (!link) throw new ArtefactError('not_found', 'Share link not found')
  const key = await unsealShareKey(config.sealKey, id, link.artefactId, link.sealed)
  return { url: shareUrl(config.readOrigin, link.slug, key) }
}

export async function revokeShareLink(
  { env: { DB: db } }: Runtime,
  member: Member,
  id: string,
  slug?: string,
) {
  checkMember(member, true)
  const artefactId = await db
    .prepare('SELECT artefact_id FROM share_links WHERE id = ? AND revoked_at IS NULL')
    .bind(id)
    .first<string>('artefact_id')
  if (artefactId === null) throw new ArtefactError('not_found', 'Share link not found')
  const now = Date.now()
  const [update] = await db.batch([
    db
      .prepare(`UPDATE share_links SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM artefacts WHERE id = ?3 AND deleted_at IS NULL AND (?4 IS NULL OR slug = ?4))`)
      .bind(now, id, artefactId, slug ?? null),
    auditChange(db, now, member.id, 'share.revoke', { id }, artefactId),
  ])
  if (update.meta.changes !== 1) throw new ArtefactError('not_found', 'Share link not found')
  return {}
}
