import type { Runtime } from '../config'
import { ArtefactError, checkSlug, requireAdmin } from './artefacts'
import { auditChange, type Member } from './index'

// Bound each relational cleanup and each R2 delete independently of artefact size.
const rowStep = 256
const blobStep = 64
const attemptLeaseMs = 15 * 60 * 1000

export function registerPurge(
  db: D1Database,
  id: string,
  { actor, slug, deletedBefore }: { actor: string | null; slug?: string; deletedBefore?: number },
) {
  const now = Date.now()
  return [
    db
      .prepare(`INSERT INTO artefact_purges (slug, artefact_id, last_attempted_at)
        SELECT slug, id, ?3 FROM artefacts WHERE id = ?1 AND deleted_at IS NOT NULL
          AND (?2 IS NULL OR slug = ?2) AND (?4 IS NULL OR deleted_at < ?4) ON CONFLICT DO NOTHING`)
      .bind(id, slug ?? null, now, deletedBefore ?? null),
    db
      .prepare(`INSERT INTO audit_log (id, at, member_id, action, artefact_id, detail_json)
        SELECT ?, ?, ?, 'artefact.purge_start', artefact_id, json_object('slug', slug)
        FROM artefact_purges WHERE artefact_id = ? AND changes() = 1`)
      .bind(crypto.randomUUID(), now, actor, id),
  ]
}

type PurgeJob = { slug: string; deleted: number }

function purgeJob(db: D1Database, id: string) {
  return db
    .prepare(`SELECT p.slug, a.id IS NULL AS deleted FROM artefact_purges p
      LEFT JOIN artefacts a ON a.id = p.artefact_id WHERE p.artefact_id = ?`)
    .bind(id)
}

/** Drive an explicit purge by stable artefact ID until `done`. A live artefact must be deleted first. */
export async function purgeArtefact(runtime: Runtime, member: Member, id: string, expectedSlug?: string) {
  requireAdmin(member)
  if (expectedSlug !== undefined) checkSlug(expectedSlug)
  const { DB: db } = runtime.env
  const [, , job] = await db.batch<PurgeJob>([
    ...registerPurge(db, id, { actor: member.id, slug: expectedSlug }),
    purgeJob(db, id),
  ])
  return runPurgeStep(runtime, id, job.results[0], member.id, expectedSlug)
}

/** Advance a registered purge only; automatic work has no human audit actor. */
export async function resumeArtefactPurge(runtime: Runtime, id: string) {
  const job = await purgeJob(runtime.env.DB, id).first<PurgeJob>()
  return runPurgeStep(runtime, id, job, null)
}

async function runPurgeStep(
  { env: { DB: db, BLOBS: blobs } }: Runtime,
  id: string,
  pending: PurgeJob | null | undefined,
  memberId: string | null,
  expectedSlug?: string,
) {
  if (expectedSlug !== undefined && pending?.slug !== expectedSlug)
    throw new ArtefactError('conflict', 'The deleted artefact has changed')
  if (!pending) {
    if (memberId !== null && (await db.prepare('SELECT 1 FROM artefacts WHERE id = ?').bind(id).first()))
      throw new ArtefactError('conflict', 'Delete the artefact before purging')
    return { done: true }
  }
  const { slug } = pending
  if (!pending.deleted) {
    const [, , , , , hardDelete] = await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO purge_candidates (slug, sha256)
          SELECT ?1, sha256 FROM (
            SELECT sha256 FROM files WHERE artefact_id = ?2 ORDER BY revision, path LIMIT ?3
          ) WHERE EXISTS (SELECT 1 FROM artefact_purges WHERE slug = ?1 AND artefact_id = ?2)`)
        .bind(slug, id, rowStep),
      db
        .prepare(`DELETE FROM files WHERE rowid IN (
          SELECT rowid FROM files WHERE artefact_id = ?1 ORDER BY revision, path LIMIT ?2
        ) AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id, rowStep),
      db
        .prepare(`DELETE FROM share_links WHERE rowid IN (
          SELECT rowid FROM share_links WHERE artefact_id = ?1 ORDER BY rowid LIMIT ?2
        ) AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id, rowStep),
      db
        .prepare(`DELETE FROM redirects WHERE rowid IN (
          SELECT rowid FROM redirects WHERE target_artefact_id = ?1 ORDER BY rowid LIMIT ?2
        ) AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id, rowStep),
      db
        .prepare(`DELETE FROM revisions WHERE rowid IN (
          SELECT rowid FROM revisions WHERE artefact_id = ?1 ORDER BY number LIMIT ?2
        ) AND NOT EXISTS (SELECT 1 FROM files WHERE artefact_id = ?1)
        AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id, rowStep),
      db
        .prepare(`DELETE FROM artefacts WHERE id = ?1 AND deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM files WHERE artefact_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM share_links WHERE artefact_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM redirects WHERE target_artefact_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM revisions WHERE artefact_id = ?1)
          AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id),
    ])
    if (hardDelete.meta.changes === 0) return { done: false }
  }

  const token = crypto.randomUUID()
  const attempt = await db
    .prepare(`INSERT INTO purge_attempts (artefact_id, token, expires_at)
      SELECT artefact_id, ?2, unixepoch('subsec') * 1000 + ?3 FROM artefact_purges WHERE artefact_id = ?1
      ON CONFLICT (artefact_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE purge_attempts.expires_at <= unixepoch('subsec') * 1000`)
    .bind(id, token, attemptLeaseMs)
    .run()
  if (attempt.meta.changes === 0) return { done: false }
  try {
    await deleteBlobPage(db, blobs, id, slug, token)
    const [finished, , remaining] = await db.batch([
      db
        .prepare(`DELETE FROM artefact_purges WHERE artefact_id = ?1
          AND EXISTS (SELECT 1 FROM purge_attempts WHERE artefact_id = ?1 AND token = ?2)
          AND NOT EXISTS (SELECT 1 FROM purge_candidates WHERE slug = artefact_purges.slug)
          AND NOT EXISTS (SELECT 1 FROM artefacts WHERE id = ?1)`)
        .bind(id, token),
      auditChange(db, Date.now, memberId, 'artefact.purge', { slug }, id),
      db.prepare('SELECT 1 FROM artefact_purges WHERE artefact_id = ?').bind(id),
    ])
    return { done: finished.meta.changes === 1 || remaining.results.length === 0 }
  } finally {
    // Keep hash claims on failure, but let the next request retry once this delete has settled.
    await db.prepare('DELETE FROM purge_attempts WHERE artefact_id = ? AND token = ?').bind(id, token).run()
  }
}

async function deleteBlobPage(db: D1Database, blobs: R2Bucket, id: string, slug: string, token: string) {
  const { results: page } = await db
    .prepare('SELECT sha256 FROM purge_candidates WHERE slug = ? ORDER BY sha256 LIMIT ?')
    .bind(slug, blobStep)
    .all<{ sha256: string }>()
  if (page.length === 0) return
  const hashes = JSON.stringify(page.map(({ sha256 }) => sha256))
  const liveLease = `EXISTS (
    SELECT 1 FROM purge_attempts WHERE artefact_id = ?1 AND token = ?2
    AND expires_at > unixepoch('subsec') * 1000
  )`
  const [, , , owned] = await db.batch<{ sha256: string }>([
    // Drive both reference checks from the bounded page and probe the candidates by primary key.
    db
      .prepare(`INSERT INTO blob_purge_claims (sha256, owner)
        SELECT c.sha256, ?1 FROM json_each(?3) j CROSS JOIN purge_candidates c
        WHERE c.slug = ?4 AND c.sha256 = j.value
        AND ${liveLease}
        AND NOT EXISTS (SELECT 1 FROM referenced_blobs WHERE sha256 = c.sha256)
        ON CONFLICT DO NOTHING`)
      .bind(id, token, hashes, slug),
    db.prepare('UPDATE blob_purge_epoch SET epoch = epoch + 1 WHERE singleton = 1 AND changes() > 0'),
    db
      .prepare(`DELETE FROM purge_candidates WHERE slug = ?4 AND sha256 IN (SELECT value FROM json_each(?3))
        AND ${liveLease}
        AND EXISTS (SELECT 1 FROM referenced_blobs WHERE sha256 = purge_candidates.sha256)`)
      .bind(id, token, hashes, slug),
    db
      .prepare(`SELECT c.sha256 FROM json_each(?3) j CROSS JOIN blob_purge_claims c
        WHERE c.sha256 = j.value AND c.owner = ?1 AND ${liveLease}`)
      .bind(id, token, hashes),
  ])
  if (owned.results.length === 0) return
  // Give R2 a full lease window, but never renew a lease that has already expired.
  const renewed = await db
    .prepare(`UPDATE purge_attempts SET expires_at = unixepoch('subsec') * 1000 + ?
      WHERE artefact_id = ? AND token = ? AND expires_at > unixepoch('subsec') * 1000`)
    .bind(attemptLeaseMs, id, token)
    .run()
  if (renewed.meta.changes === 0) return
  const keys = owned.results.map(({ sha256 }) => `blobs/${sha256}`)
  await blobs.delete(keys)
  const deleted = JSON.stringify(owned.results.map(({ sha256 }) => sha256))
  await db.batch([
    db
      .prepare(`DELETE FROM purge_candidates WHERE slug = ?1 AND sha256 IN (SELECT value FROM json_each(?2))
        AND EXISTS (SELECT 1 FROM purge_attempts WHERE artefact_id = ?3 AND token = ?4)`)
      .bind(slug, deleted, id, token),
    db
      .prepare(`DELETE FROM blob_purge_claims WHERE owner = ?1 AND sha256 IN (SELECT value FROM json_each(?2))
        AND EXISTS (SELECT 1 FROM purge_attempts WHERE artefact_id = ?1 AND token = ?3)`)
      .bind(id, deleted, token),
    db.prepare('UPDATE blob_purge_epoch SET epoch = epoch + 1 WHERE singleton = 1 AND changes() > 0'),
  ])
}
