import { base64url } from 'jose'
import { z } from 'zod'
import type { Runtime } from '../config'
import { isArtefactTag, unpackArtefactTags } from './artefact-tags'
import { ArtefactError, checkMember } from './artefacts'
import { gallerySearch } from './gallery-search'
import type { Member } from './index'
import { adminPageSize, trimLookahead } from './pagination'
import { cacheRevisionEntries, computeRevisionEntry, entryUrl, type RevisionEntry } from './revision-entry'

const cursorAccess = z.enum(['private', 'shared', 'public']).nullable()
const cursorTag = z.string().optional()
const recentCursor = z.tuple([z.string(), cursorAccess, z.literal('recent'), z.int(), z.string(), cursorTag])
const searchCursor = z.tuple([z.string(), cursorAccess, z.literal('slug-scan'), z.string(), cursorTag])
const prefixCursor = z.tuple([z.string(), cursorAccess, z.enum(['slug', 'title']), z.string(), z.string()])
const cursorSchema = z.union([recentCursor, searchCursor, prefixCursor])
const searchBatchSize = 100
// Merge ordered slug index seeks before LIMIT; publishing does not move the seek key.
const searchCandidates = `SELECT id, slug, title, visibility, hex(lower(slug)) || '!' || id AS term,
  EXISTS (SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
    WHERE artefact_id = artefacts.id AND revoked_at IS NULL) AS shared,
  (SELECT group_concat(tag, ',' ORDER BY tag) FROM artefact_tags WHERE artefact_id = artefacts.id) AS tagList,
  current_revision AS revision, updated_at AS updatedAt
  FROM artefacts INDEXED BY artefacts_catalogue_slug
  WHERE deleted_at IS NULL AND visibility = ? AND term > ?
  UNION ALL
  SELECT id, slug, title, visibility, hex(lower(slug)) || '!' || id AS term,
  EXISTS (SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
    WHERE artefact_id = artefacts.id AND revoked_at IS NULL) AS shared,
  (SELECT group_concat(tag, ',' ORDER BY tag) FROM artefact_tags WHERE artefact_id = artefacts.id) AS tagList,
  current_revision AS revision, updated_at AS updatedAt
  FROM artefacts INDEXED BY artefacts_catalogue_slug
  WHERE deleted_at IS NULL AND visibility = ? AND term > ?
  ORDER BY term LIMIT ?`
/** Catalogue state: stored visibility, with private artefacts that have an active share link shown as shared. */
export type CatalogueAccess = 'private' | 'shared' | 'public'
type Row = {
  id: string
  slug: string
  title: string
  tagList: string | null
  visibility: 'private' | 'public'
  /**
   * 1 when an active share link exists. INDEXED BY pins the partial active-link index so the probe never walks
   * an artefact's revocation history, whatever the planner statistics.
   */
  shared: number
  revision: number
  updatedAt: number
}
export type CatalogueEntry = Pick<Row, 'id' | 'slug' | 'title' | 'revision' | 'updatedAt'> & {
  access: CatalogueAccess
  tags: string[]
}
const accessOf = ({ visibility, shared }: Pick<Row, 'visibility' | 'shared'>): CatalogueAccess =>
  visibility === 'public' ? 'public' : shared ? 'shared' : 'private'
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const catalogueCountLimit = 1_000

export async function catalogueCounts({ env: { DB: db } }: Runtime, member: Member) {
  checkMember(member)
  // One extra live row detects overflow; never display partial counts.
  const { results } = await db
    .prepare(`SELECT visibility, shared, COUNT(*) AS total FROM (
        SELECT visibility, CASE WHEN visibility = 'private' THEN EXISTS (
          SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
          WHERE artefact_id = artefacts.id AND revoked_at IS NULL
        ) ELSE 0 END AS shared
        FROM artefacts INDEXED BY artefacts_catalogue_recent
        WHERE deleted_at IS NULL LIMIT ?
      ) GROUP BY visibility, shared`)
    .bind(catalogueCountLimit + 1)
    .all<Pick<Row, 'visibility' | 'shared'> & { total: number }>()
  const counts = { all: 0, private: 0, shared: 0, public: 0 }
  for (const row of results) {
    counts[accessOf(row)] += row.total
    counts.all += row.total
  }
  return counts.all <= catalogueCountLimit ? counts : null
}

export async function publicArtefacts({ env: { DB: db }, config }: Runtime, ctx?: ExecutionContext) {
  const { results } = await db
    .prepare(`SELECT a.id, a.slug, a.title, a.updated_at AS updatedAt, r.number AS revision, r.entry_path AS path,
      (SELECT group_concat(tag, ',' ORDER BY tag) FROM artefact_tags WHERE artefact_id = a.id) AS tagList
      FROM artefacts a JOIN revisions r ON r.artefact_id = a.id AND r.number = a.current_revision
      WHERE a.deleted_at IS NULL AND a.visibility = 'public'
      ORDER BY a.created_at DESC, a.slug LIMIT 200`)
    .all<
      RevisionEntry & {
        id: string
        slug: string
        title: string
        updatedAt: number
        revision: number
        tagList: string | null
      }
    >()
  const legacy = results.filter(({ path }) => path === null)
  if (legacy.length > 0) {
    const entries = await db.batch<RevisionEntry>(
      legacy.map(({ id, revision }) => computeRevisionEntry(db, id, revision)),
    )
    for (const [index, row] of legacy.entries()) row.path = entries[index].results[0]?.path ?? null
    await cacheRevisionEntries(db, legacy, ctx)
  }
  const artefacts = []
  for (const { slug, title, path, updatedAt, tagList } of results) {
    if (path === null) continue
    artefacts.push({
      slug,
      title,
      url: entryUrl(config.readOrigin, slug, path),
      updatedAt,
      tags: unpackArtefactTags(tagList),
    })
  }
  return artefacts
}

export async function searchArtefacts(
  { env: { DB: db } }: Runtime,
  member: Member,
  params: URLSearchParams,
  access?: CatalogueAccess,
  cursor?: string,
) {
  checkMember(member)
  const { query, matches } = gallerySearch(params)
  const tag = params.get('tag') || undefined
  if (tag !== undefined && !isArtefactTag(tag)) throw new ArtefactError('invalid_input', 'Invalid tag filter')
  const selected = access ?? null
  let after: z.infer<typeof recentCursor> | z.infer<typeof searchCursor> | undefined
  try {
    if (cursor !== undefined) {
      if (cursor.length > 4096) throw new Error()
      const decoded = cursorSchema.parse(JSON.parse(new TextDecoder().decode(base64url.decode(cursor))))
      // Old prefix and activity-order search cursors cannot resume this scan.
      if (decoded[2] === 'slug-scan' || (decoded[2] === 'recent' && !decoded[0])) {
        const cursorTag = decoded[2] === 'recent' ? decoded[5] : decoded[4]
        if (decoded[0] !== query || decoded[1] !== selected || cursorTag !== tag) throw new Error()
        after = decoded
      } else if (tag !== undefined) {
        throw new Error()
      }
    }
  } catch {
    throw new ArtefactError('invalid_input', 'Invalid catalogue query or cursor')
  }
  // Shared and private use the same visibility index; check the derived state after scanning.
  const scopes = access === 'public' ? ['public'] : access ? ['private'] : ['private', 'public']
  const artefacts: CatalogueEntry[] = []
  const collect = (row: Row) => {
    const state = accessOf(row)
    if (access && state !== access) return
    const tags = unpackArtefactTags(row.tagList)
    if ((tag && !tags.includes(tag)) || !matches({ slug: row.slug, title: row.title, tags })) return
    artefacts.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      tags,
      access: state,
      revision: row.revision,
      updatedAt: row.updatedAt,
    })
  }
  let nextCursor: string | undefined
  if (query) {
    const statement = db.prepare(searchCandidates)
    let term = after?.[2] === 'slug-scan' ? after[3] : ''
    let remaining = catalogueCountLimit
    while (remaining > 0) {
      const size = Math.min(searchBatchSize, remaining)
      const { results } = await statement
        .bind(scopes[0], term, scopes[1] ?? null, term, size + 1)
        .all<Row & { term: string }>()
      const candidates = Math.min(size, results.length)
      let consumed = 0
      while (consumed < candidates && artefacts.length < adminPageSize) {
        const row = results[consumed++]
        term = row.term
        collect(row)
      }
      remaining -= consumed
      if (consumed === results.length) break
      if (artefacts.length === adminPageSize || remaining === 0) {
        // Resume after the last candidate actually checked, not the end of the fetched batch.
        nextCursor = base64url.encode(
          JSON.stringify([query, selected, 'slug-scan', term, ...(tag ? [tag] : [])]),
        )
        break
      }
    }
  } else {
    const statement = db.prepare(`SELECT id, slug, title, visibility,
      EXISTS (SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
        WHERE artefact_id = artefacts.id AND revoked_at IS NULL) AS shared,
      (SELECT group_concat(tag, ',' ORDER BY tag) FROM artefact_tags WHERE artefact_id = artefacts.id) AS tagList,
      current_revision AS revision, updated_at AS updatedAt
      FROM artefacts WHERE deleted_at IS NULL AND visibility = ? AND (updated_at, id) < (?, ?)
      AND (?5 IS NULL OR EXISTS (SELECT 1 FROM artefact_tags WHERE artefact_id = artefacts.id AND tag = ?5))
      ORDER BY updated_at DESC, id DESC LIMIT ?4`)
    const pages = await db.batch<Row>(
      scopes.map((scope) =>
        statement.bind(
          scope,
          after?.[2] === 'recent' ? after[3] : Number.MAX_SAFE_INTEGER,
          after?.[2] === 'recent' ? after[4] : '',
          adminPageSize + 1,
          tag ?? null,
        ),
      ),
    )
    const rows = pages
      .flatMap((page) => page.results)
      .sort((a, b) => b.updatedAt - a.updatedAt || compare(b.id, a.id))
      .slice(0, adminPageSize + 1)
    const last = trimLookahead(rows, adminPageSize)
    for (const row of rows) collect(row)
    if (last)
      nextCursor = base64url.encode(
        JSON.stringify([query, selected, 'recent', last.updatedAt, last.id, ...(tag ? [tag] : [])]),
      )
  }
  return {
    artefacts,
    query,
    tag: tag ?? '',
    continued: after !== undefined,
    nextCursor,
  }
}
