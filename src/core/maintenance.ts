import type { Runtime } from '../config'
import { deletedRetentionMs } from './artefacts'
import { resumeArtefactPurge } from './purge'

const expiryPage = 128
const revisionPage = 64
const revisionsPerRun = 2
const deletedPage = 8
const purgeStepsPerRun = 4
// OAuth grants start their seven-day cap at code exchange, after consent. Allow another day
// for the short-lived authorization code and clock skew; logout JWTs are only valid for five minutes.
const revocationRetentionMs = 8 * 86_400_000

async function expire(db: D1Database, table: string, before: number, column = 'expires_at', guard = '') {
  // Table, column and guard only come from the fixed task definitions below.
  const { meta } = await db
    .prepare(`WITH page AS MATERIALIZED (
      SELECT rowid AS rid FROM ${table} WHERE ${column} <= ? ORDER BY ${column}, rowid LIMIT ?
    ) DELETE FROM ${table} WHERE rowid IN (SELECT rid FROM page) ${guard}`)
    .bind(before, expiryPage)
    .run()
  return { deleted: meta.changes }
}

function cursor(db: D1Database, task: string, id: string, position = 0) {
  return db
    .prepare(`INSERT INTO maintenance_cursors (task, id, position) VALUES (?, ?, ?)
      ON CONFLICT(task) DO UPDATE SET id = excluded.id, position = excluded.position
      WHERE id <> excluded.id OR position <> excluded.position`)
    .bind(task, id, position)
}

async function pruneRevisions({ env: { DB: db }, config: { revisionRetention } }: Runtime) {
  // A keyset sweep bounds lookups even when most artefacts have nothing to prune.
  const { results: page } = await db
    .prepare(`WITH page AS MATERIALIZED (
      SELECT id, current_revision, deleted_at FROM artefacts
      WHERE id > COALESCE((SELECT id FROM maintenance_cursors WHERE task = 'revisions'), '')
      ORDER BY id LIMIT ?1
    ) SELECT id, CASE WHEN deleted_at IS NULL THEN (
      SELECT number FROM revisions WHERE artefact_id = page.id AND number <= current_revision - ?2
      ORDER BY number LIMIT 1
    ) END AS number FROM page ORDER BY id`)
    .bind(revisionPage, revisionRetention)
    .all<{ id: string; number: number | null }>()
  const statements: D1PreparedStatement[] = []
  let after = ''
  for (const { id, number } of page) {
    if (number === null) continue
    statements.push(
      db
        .prepare(`DELETE FROM revisions WHERE artefact_id = ?1 AND number = ?2 AND EXISTS (
          SELECT 1 FROM artefacts WHERE id = ?1 AND deleted_at IS NULL AND ?2 <= current_revision - ?3
        )`)
        .bind(id, number, revisionRetention),
    )
    if (statements.length === revisionsPerRun) {
      after = id
      break
    }
  }
  if (statements.length < revisionsPerRun && page.length === revisionPage) after = page[revisionPage - 1].id
  statements.push(cursor(db, 'revisions', after))
  const results = await db.batch(statements)
  return { deleted: results.slice(0, -1).reduce((sum, { meta }) => sum + meta.changes, 0) }
}

async function queueDeleted(db: D1Database, before: number) {
  const { results: page } = await db
    .prepare(`SELECT id, deleted_at AS deletedAt FROM artefacts
      WHERE deleted_at IS NOT NULL AND deleted_at < ?1 AND (deleted_at, id) > (
        COALESCE((SELECT position FROM maintenance_cursors WHERE task = 'deleted'), 0),
        COALESCE((SELECT id FROM maintenance_cursors WHERE task = 'deleted'), '')
      ) ORDER BY deleted_at, id LIMIT ?2`)
    .bind(before, deletedPage)
    .all<{ id: string; deletedAt: number }>()
  const last = page.length === deletedPage ? page[deletedPage - 1] : null
  const [queued] = await db.batch([
    db
      .prepare(`INSERT INTO artefact_purges (slug, artefact_id, last_attempted_at)
        SELECT a.slug, a.id, ?3 FROM json_each(?1) p CROSS JOIN artefacts a ON a.id = p.value
        WHERE a.deleted_at < ?2 ON CONFLICT DO NOTHING`)
      .bind(JSON.stringify(page.map(({ id }) => id)), before, Date.now()),
    cursor(db, 'deleted', last?.id ?? '', last?.deletedAt ?? 0),
  ])
  return { queued: queued.meta.changes }
}

async function drainPurges(runtime: Runtime) {
  // A registered job may outlive its artefact. Rotate even on failure so one job can't block the queue.
  const { results } = await runtime.env.DB.prepare(`WITH page AS MATERIALIZED (
    SELECT artefact_id FROM artefact_purges ORDER BY last_attempted_at, artefact_id LIMIT ?2
  ) UPDATE artefact_purges SET last_attempted_at = ?1 WHERE artefact_id IN (SELECT artefact_id FROM page)
    RETURNING artefact_id AS id`)
    .bind(Date.now(), purgeStepsPerRun)
    .all<{ id: string }>()
  let done = 0
  let failed = 0
  for (const { id } of results) {
    try {
      if ((await resumeArtefactPurge(runtime, id)).done) done++
    } catch {
      failed++
    }
  }
  return { attempted: results.length, done, failed }
}

async function task(name: string, run: () => Promise<Record<string, number>>) {
  try {
    const counts = await run()
    if (counts.failed) console.error('Forge maintenance incomplete', name, counts)
    else console.log('Forge maintenance', name, counts)
  } catch {
    // Exceptions from bindings can include values or request data; log only the task name.
    console.error('Forge maintenance failed', name)
  }
}

export async function maintain(runtime: Runtime, now: number) {
  const { DB: db } = runtime.env
  await task('login flows', () => expire(db, 'login_flows', now))
  await task('handoffs', () => expire(db, 'handoffs', now))
  await task('OAuth consents', () => expire(db, 'oauth_consents', now))
  await task('sessions', () =>
    expire(
      db,
      'sessions',
      now,
      'expires_at',
      `
      AND NOT EXISTS (SELECT 1 FROM handoffs WHERE session_id_hash = sessions.id_hash)
      AND NOT EXISTS (SELECT 1 FROM oauth_consents WHERE session_hash = sessions.id_hash)`,
    ),
  )
  await task('uploads', () => expire(db, 'uploads', now))
  await task('invite contexts', () => expire(db, 'invite_contexts', now))
  await task('invites', () =>
    expire(
      db,
      'invites',
      now,
      'expires_at',
      `
      AND NOT EXISTS (SELECT 1 FROM invite_contexts WHERE invite_hash = invites.token_hash)`,
    ),
  )
  await task('identity revocations', () =>
    expire(db, 'identity_revocations', now - revocationRetentionMs, 'received_at'),
  )
  await task('revisions', () => pruneRevisions(runtime))
  await task('deleted artefacts', () => queueDeleted(db, now - deletedRetentionMs))
  await task('purges', () => drainPurges(runtime))
}
