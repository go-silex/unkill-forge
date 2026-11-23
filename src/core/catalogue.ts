import { base64url } from 'jose'
import { z } from 'zod'
import type { Runtime } from '../config'
import { ArtefactError, checkMember } from './artefacts'
import type { Member } from './index'
import { trimLookahead } from './pagination'

const cursorSchema = z.tuple([
  z.string(),
  z.enum(['private', 'public']).nullable(),
  z.enum(['recent', 'slug', 'title']),
  z.union([z.string(), z.int()]),
  z.string(),
])
type Visibility = 'private' | 'public'
type Row = {
  id: string
  slug: string
  title: string
  visibility: Visibility
  revision: number
  updatedAt: number
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const fold = (value: string) => value.replace(/[A-Z]/g, (ch) => ch.toLowerCase())

export async function searchArtefacts(
  { env: { DB: db } }: Runtime,
  member: Member,
  query: string,
  visibility?: Visibility,
  cursor?: string,
) {
  checkMember(member)
  const selected = visibility ?? null
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
  const scopes = visibility ? [visibility] : ['private', 'public']
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
      artefacts: (keep ? rows.filter(keep) : rows).map(
        ({ slug, title, visibility, revision, updatedAt }) => ({
          slug,
          title,
          visibility,
          revision,
          updatedAt,
        }),
      ),
      nextCursor: last ? base64url.encode(JSON.stringify(continuation(last))) : undefined,
    }
  }
  if (!query) {
    const statement =
      db.prepare(`SELECT id, slug, title, visibility, current_revision AS revision, updated_at AS updatedAt
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
