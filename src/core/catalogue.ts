import { base64url } from 'jose'
import { z } from 'zod'
import type { Runtime } from '../config'
import { ArtefactError, checkMember } from './artefacts'
import { gallerySearch } from './gallery-search'
import type { Member } from './index'
import { trimLookahead } from './pagination'

const cursorAccess = z.enum(['private', 'shared', 'public']).nullable()
const recentCursor = z.tuple([z.string(), cursorAccess, z.literal('recent'), z.int(), z.string()])
const prefixCursor = z.tuple([z.string(), cursorAccess, z.enum(['slug', 'title']), z.string(), z.string()])
const cursorSchema = z.union([recentCursor, prefixCursor])
/** Catalogue state: stored visibility, with private artefacts that have an active share link shown as shared. */
export type CatalogueAccess = 'private' | 'shared' | 'public'
type Row = {
  id: string
  slug: string
  title: string
  visibility: 'private' | 'public'
  /**
   * 1 when an active share link exists. INDEXED BY pins the partial active-link index so the probe never walks
   * an artefact's revocation history, whatever the planner statistics.
   */
  shared: number
  revision: number
  updatedAt: number
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

export async function searchArtefacts(
  { env: { DB: db } }: Runtime,
  member: Member,
  rawQuery: string,
  access?: CatalogueAccess,
  cursor?: string,
) {
  checkMember(member)
  const { query, matches } = gallerySearch(rawQuery)
  const selected = access ?? null
  let after: z.infer<typeof recentCursor> | undefined
  try {
    if (cursor !== undefined) {
      if (cursor.length > 4096) throw new Error()
      const decoded = cursorSchema.parse(JSON.parse(new TextDecoder().decode(base64url.decode(cursor))))
      // Prefix cursors cannot seek in activity order. Restart instead of skipping candidates.
      if (decoded[2] === 'recent') {
        if (decoded[0] !== query || decoded[1] !== selected) throw new Error()
        after = decoded
      }
    }
  } catch {
    throw new ArtefactError('invalid_input', 'Invalid catalogue query or cursor')
  }
  // Shared and private use the same visibility index; check the derived state after scanning.
  const scopes = access === 'public' ? ['public'] : access ? ['private'] : ['private', 'public']
  const statement = db.prepare(`SELECT id, slug, title, visibility,
    EXISTS (SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
      WHERE artefact_id = artefacts.id AND revoked_at IS NULL) AS shared,
    current_revision AS revision, updated_at AS updatedAt
    FROM artefacts WHERE deleted_at IS NULL AND visibility = ? AND (updated_at, id) < (?, ?)
    ORDER BY updated_at DESC, id DESC LIMIT 51`)
  const pages = await db.batch<Row>(
    scopes.map((scope) => statement.bind(scope, after?.[3] ?? Number.MAX_SAFE_INTEGER, after?.[4] ?? '')),
  )
  const rows = pages
    .flatMap((page) => page.results)
    .sort((a, b) => b.updatedAt - a.updatedAt || compare(b.id, a.id))
    .slice(0, 51)
  // Continue from the last scanned candidate, even if none of this page's candidates match.
  const last = trimLookahead(rows, 50)
  const artefacts = []
  for (const row of rows) {
    const state = accessOf(row)
    if ((access && state !== access) || !matches(row)) continue
    artefacts.push({
      slug: row.slug,
      title: row.title,
      access: state,
      revision: row.revision,
      updatedAt: row.updatedAt,
    })
  }
  const nextCursor = last
    ? base64url.encode(JSON.stringify([query, selected, 'recent', last.updatedAt, last.id]))
    : undefined
  return {
    artefacts,
    query,
    continued: after !== undefined,
    nextCursor,
  }
}
