import type { Runtime } from '../config'
import { ArtefactError, requireAdmin } from './artefacts'
import type { Member } from './index'

// Each step processes at most 256 file rows or 64 hashes, irrespective of artefact size.
const fileStep = 256
const blobStep = 64
const attemptLeaseMs = 15 * 60 * 1000

/** Drive an explicit purge by stable artefact ID until `done`. A live artefact must be deleted first. */
export async function purgeArtefact({ env: { DB: db, BLOBS: blobs } }: Runtime, member: Member, id: string) {
  requireAdmin(member)
  const [, job] = await db.batch<{ slug: string; deleted: number }>([
    db
      .prepare(`INSERT INTO artefact_purges (slug, artefact_id)
        SELECT slug, id FROM artefacts WHERE id = ? AND deleted_at IS NOT NULL ON CONFLICT DO NOTHING`)
      .bind(id),
    db
      .prepare(`SELECT p.slug, a.id IS NULL AS deleted FROM artefact_purges p
        LEFT JOIN artefacts a ON a.id = p.artefact_id WHERE p.artefact_id = ?`)
      .bind(id),
  ])
  const pending = job.results[0]
  if (!pending) {
    if (await db.prepare('SELECT 1 FROM artefacts WHERE id = ?').bind(id).first())
      throw new ArtefactError('conflict', 'Delete the artefact before purging')
    return { done: true }
  }
  const { slug } = pending
  if (!pending.deleted) {
    const [, , hardDelete] = await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO purge_candidates (slug, sha256)
          SELECT ?1, sha256 FROM (
            SELECT sha256 FROM files WHERE artefact_id = ?2 ORDER BY revision, path LIMIT ?3
          ) WHERE EXISTS (SELECT 1 FROM artefact_purges WHERE slug = ?1 AND artefact_id = ?2)`)
        .bind(slug, id, fileStep),
      db
        .prepare(`DELETE FROM files WHERE rowid IN (
          SELECT rowid FROM files WHERE artefact_id = ?1 ORDER BY revision, path LIMIT ?2
        ) AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id, fileStep),
      db
        .prepare(`DELETE FROM artefacts WHERE id = ?1 AND deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM files WHERE artefact_id = ?1)
          AND EXISTS (SELECT 1 FROM artefact_purges WHERE artefact_id = ?1)`)
        .bind(id),
      db
        .prepare(`INSERT INTO audit_log (id, at, member_id, action, artefact_id, detail_json)
          SELECT ?, ?, ?, 'artefact.purge', ?, '{}' WHERE changes() = 1`)
        .bind(crypto.randomUUID(), Date.now(), member.id, id),
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
  } finally {
    // Keep hash claims on failure, but let the next request retry once this delete has settled.
    await db.prepare('DELETE FROM purge_attempts WHERE artefact_id = ? AND token = ?').bind(id, token).run()
  }
  const finished = await db
    .prepare(`DELETE FROM artefact_purges WHERE artefact_id = ?1
      AND NOT EXISTS (SELECT 1 FROM purge_candidates WHERE slug = artefact_purges.slug)
      AND NOT EXISTS (SELECT 1 FROM artefacts WHERE id = ?1)`)
    .bind(id)
    .run()
  return {
    done:
      finished.meta.changes === 1 ||
      !(await db.prepare('SELECT 1 FROM artefact_purges WHERE artefact_id = ?').bind(id).first()),
  }
}

async function deleteBlobPage(db: D1Database, blobs: R2Bucket, id: string, slug: string, token: string) {
  const { results: page } = await db
    .prepare('SELECT sha256 FROM purge_candidates WHERE slug = ? ORDER BY sha256 LIMIT ?')
    .bind(slug, blobStep)
    .all<{ sha256: string }>()
  if (page.length === 0) return
  const hashes = JSON.stringify(page.map(({ sha256 }) => sha256))
  const [, , , owned] = await db.batch<{ sha256: string }>([
    // Drive both reference checks from the bounded page and probe the candidates by primary key.
    db
      .prepare(`INSERT INTO blob_purge_claims (sha256, owner)
        SELECT c.sha256, ?1 FROM json_each(?2) j CROSS JOIN purge_candidates c
        WHERE c.slug = ?3 AND c.sha256 = j.value
        AND NOT EXISTS (SELECT 1 FROM referenced_blobs WHERE sha256 = c.sha256)
        ON CONFLICT DO NOTHING`)
      .bind(id, hashes, slug),
    db.prepare('UPDATE blob_purge_epoch SET epoch = epoch + 1 WHERE singleton = 1 AND changes() > 0'),
    db
      .prepare(`DELETE FROM purge_candidates WHERE slug = ? AND sha256 IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM referenced_blobs WHERE sha256 = purge_candidates.sha256)`)
      .bind(slug, hashes),
    db
      .prepare(`SELECT c.sha256 FROM json_each(?) j CROSS JOIN blob_purge_claims c
        WHERE c.sha256 = j.value AND c.owner = ?`)
      .bind(hashes, id),
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
