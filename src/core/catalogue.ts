import { base64url } from 'jose'
import { z } from 'zod'
import type { Runtime } from '../config'
import { ArtefactError, checkMember } from './artefacts'
import type { Member } from './index'
import { trimLookahead } from './pagination'

const cursorSchema = z.tuple([
  z.string(),
  z.enum(['private', 'shared', 'public']).nullable(),
  z.enum(['recent', 'slug', 'title']),
  z.union([z.string(), z.int()]),
  z.string(),
])
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
const accessOf = ({ visibility, shared }: Row): CatalogueAccess =>
  visibility === 'public' ? 'public' : shared ? 'shared' : 'private'
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const fold = (value: string) => value.replace(/[A-Z]/g, (ch) => ch.toLowerCase())

export async function searchArtefacts(
  { env: { DB: db } }: Runtime,
  member: Member,
  query: string,
  access?: CatalogueAccess,
  cursor?: string,
) {
  checkMember(member)
  const selected = access ?? null
  let after: z.infer<typeof cursorSchema> | undefined
  try {
    if (query.length > 200 || (cursor && cursor.length > 4096)) throw new Error()
    if (cursor !== undefined)
      after = cursorSchema.parse(JSON.parse(new TextDecoder().decode(base64url.decode(cursor))))
    if (
      after &&
      (after[0] !== query ||
        after[1] !== selected ||
        (query === ''
          ? after[2] !== 'recent' || typeof after[3] !== 'number'
          : after[2] === 'recent' || typeof after[3] !== 'string'))
    )
      throw new Error()
  } catch {
    throw new ArtefactError('invalid_input', 'Invalid catalogue query or cursor')
  }
  // Shared and private both read the private index; the derived state filters each scanned page.
  const scopes = access === 'public' ? ['public'] : access ? ['private'] : ['private', 'public']
  async function merge<T>(statements: D1PreparedStatement[], limit: number, order: (a: T, b: T) => number) {
    const pages = await db.batch<T>(statements)
    return pages
      .flatMap((page) => page.results)
      .sort(order)
      .slice(0, limit)
  }
  function page<T extends Row>(rows: T[], continuation: (row: T) => unknown[], keep?: (row: T) => boolean) {
    const last = trimLookahead(rows, 50)
    return {
      artefacts: rows
        .filter((row) => (keep?.(row) ?? true) && (!access || accessOf(row) === access))
        .map((row) => ({
          slug: row.slug,
          title: row.title,
          access: accessOf(row),
          revision: row.revision,
          updatedAt: row.updatedAt,
        })),
      nextCursor: last ? base64url.encode(JSON.stringify(continuation(last))) : undefined,
    }
  }
  if (!query) {
    const statement = db.prepare(`SELECT id, slug, title, visibility,
      EXISTS (SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
        WHERE artefact_id = artefacts.id AND revoked_at IS NULL) AS shared,
      current_revision AS revision, updated_at AS updatedAt
      FROM artefacts WHERE deleted_at IS NULL AND visibility = ? AND (updated_at, id) < (?, ?)
      ORDER BY updated_at DESC, id DESC LIMIT 51`)
    const rows = await merge<Row>(
      scopes.map((scope) => statement.bind(scope, after?.[3] ?? Number.MAX_SAFE_INTEGER, after?.[4] ?? '')),
      51,
      (a, b) => b.updatedAt - a.updatedAt || compare(b.id, a.id),
    )
    return page(rows, (row) => [query, selected, 'recent', row.updatedAt, row.id])
  }
  // SQLite lower() folds only ASCII; hex() keeps a literal UTF-8 prefix sortable with its ID.
  const key = fold(query)
  const start = Array.from(new TextEncoder().encode(key), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  const end = `${start}G`
  const phase = after?.[2] === 'title' ? 'title' : 'slug'
  const seek = async (column: 'slug' | 'title', limit: number, resume: boolean) => {
    // The identifier is the closed, internal union of the two indexed columns, never request data.
    const statement =
      db.prepare(`SELECT id, slug, title, visibility, current_revision AS revision, updated_at AS updatedAt,
      EXISTS (SELECT 1 FROM share_links INDEXED BY share_links_active_artefact
        WHERE artefact_id = artefacts.id AND revoked_at IS NULL) AS shared,
      hex(lower(${column})) || '!' || id AS term FROM artefacts
      WHERE deleted_at IS NULL AND visibility = ? AND term > ? AND term < ? ORDER BY term LIMIT ?`)
    const cursorTerm = resume ? after?.[3] : null
    const lower = typeof cursorTerm === 'string' && cursorTerm > start ? cursorTerm : start
    const rows = await merge<Row & { term: string }>(
      scopes.map((scope) => statement.bind(scope, lower, end, limit)),
      limit,
      (a, b) => compare(a.term, b.term),
    )
    return rows.map((row) => ({ ...row, column }))
  }
  const rows = phase === 'slug' ? await seek('slug', 51, after !== undefined) : []
  if (rows.length <= 50) rows.push(...(await seek('title', 51 - rows.length, phase === 'title')))
  // Advance past scanned candidates, even when their slugs already matched, to keep reads bounded.
  return page(
    rows,
    (row) => [query, selected, row.column, row.term, ''],
    (row) => row.column === 'slug' || !fold(row.slug).startsWith(key),
  )
}
