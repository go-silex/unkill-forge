export type RevisionEntry = { path: string | null }

export function encodeFilePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function entryUrl(origin: string, slug: string, path: string) {
  const base = `${origin}/a/${slug}/`
  return path === 'index.html' ? base : base + encodeFilePath(path)
}

function selectRevisionEntry(db: D1Database, id: string, revision: number) {
  return db
    .prepare('SELECT entry_path AS path FROM revisions WHERE artefact_id = ? AND number = ?')
    .bind(id, revision)
}

export function computeRevisionEntry(db: D1Database, id: string, revision: number | null) {
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

export async function cacheRevisionEntries(
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
