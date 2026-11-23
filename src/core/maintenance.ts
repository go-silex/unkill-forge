import type { Runtime } from '../config'
import { deletedRetentionMs } from './artefacts'
import { registerPurge, resumeArtefactPurge } from './purge'

const expiryPage = 128
const revisionPage = 64
const revisionsPerRun = 2
const deletedPage = 8
const d1CallCeiling = 45
// Nine expiry statements plus two calls each for revision and deleted-artefact sweeps.
const sweepD1Calls = 13
// One queue claim plus up to nine calls in the registered purge step, including lease release.
const purgeD1Calls = 10
const sessionCleanupGraceMs = 86_400_000
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
  const results = await db.batch([
    ...page.flatMap(({ id }) => registerPurge(db, id, { actor: null, deletedBefore: before })),
    cursor(db, 'deleted', last?.id ?? '', last?.deletedAt ?? 0),
  ])
  let queued = 0
  for (let i = 0; i < page.length; i++) queued += results[i * 2].meta.changes
  return { queued }
}

async function drainPurges(runtime: Runtime) {
  // Re-select after each step: a single job can make progress several times, but older jobs go first.
  const take = runtime.env.DB.prepare(`UPDATE artefact_purges
    SET last_attempted_at = max(?1, coalesce((SELECT max(last_attempted_at) + 1 FROM artefact_purges), 0))
    WHERE artefact_id = (
      SELECT artefact_id FROM artefact_purges
      WHERE artefact_id NOT IN (SELECT value FROM json_each(?2))
      ORDER BY last_attempted_at, artefact_id LIMIT 1
    ) RETURNING artefact_id AS id`)
  const failedIds: string[] = []
  let attempted = 0
  let done = 0
  let failed = 0
  for (let remaining = d1CallCeiling - sweepD1Calls; remaining >= purgeD1Calls; remaining -= purgeD1Calls) {
    const id = await take.bind(Date.now(), JSON.stringify(failedIds)).first<string>('id')
    if (id === null) break
    attempted++
    try {
      if ((await resumeArtefactPurge(runtime, id)).done) done++
    } catch {
      failed++
      failedIds.push(id)
    }
  }
  return { attempted, done, failed }
}

export async function maintain(runtime: Runtime, now: number) {
  const { DB: db } = runtime.env
  const failed: Error[] = []
  async function task(name: string, run: () => Promise<Record<string, number>>) {
    try {
      const counts = await run()
      if (!counts.failed) {
        console.log('Forge maintenance', name, counts)
        return
      }
      console.error('Forge maintenance incomplete', name, counts)
    } catch {
      // Exceptions from bindings can contain request values and must not reach Cron Events or logs.
      console.error('Forge maintenance failed', name)
    }
    failed.push(new Error(name))
  }
  const sessionCutoff = now - sessionCleanupGraceMs
  await task('login flows', () => expire(db, 'login_flows', now))
  await task('handoffs', () => expire(db, 'handoffs', sessionCutoff))
  await task('OAuth consents', () => expire(db, 'oauth_consents', sessionCutoff))
  await task('UI flashes', () => expire(db, 'ui_flashes', sessionCutoff))
  await task('sessions', () =>
    expire(
      db,
      'sessions',
      sessionCutoff,
      'expires_at',
      `
      AND NOT EXISTS (SELECT 1 FROM handoffs WHERE session_id_hash = sessions.id_hash)
      AND NOT EXISTS (SELECT 1 FROM oauth_consents WHERE session_hash = sessions.id_hash)
      AND NOT EXISTS (SELECT 1 FROM ui_flashes WHERE session_hash = sessions.id_hash)`,
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
  if (failed.length) throw new AggregateError(failed, 'Forge scheduled maintenance failed; see Workers Logs')
}
