import type { Runtime } from '../config'
import { ArtefactError, requireAdmin } from './artefacts'
import type { Member } from './index'

// Each step processes at most 256 file rows or 64 hashes, irrespective of artefact size.
const fileStep = 256
const blobStep = 64

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

  const owner = crypto.randomUUID()
  const { results: page } = await db
    .prepare(`SELECT c.sha256 FROM purge_candidates c JOIN artefact_purges p USING (slug)
      WHERE p.artefact_id = ? AND NOT EXISTS (SELECT 1 FROM blob_purge_claims WHERE sha256 = c.sha256)
      ORDER BY c.sha256 LIMIT ?`)
    .bind(id, blobStep)
    .all<{ sha256: string }>()
  if (page.length > 0) {
    const hashes = JSON.stringify(page.map(({ sha256 }) => sha256))
    const [claimed] = await db.batch<{ sha256: string }>([
      // This reference check and the claim are one write. The file insert trigger protects the R2 delete.
      db
        .prepare(`INSERT INTO blob_purge_claims (sha256, owner)
          SELECT c.sha256, ?1 FROM json_each(?2) j JOIN purge_candidates c ON c.sha256 = j.value
          JOIN artefact_purges p ON p.slug = c.slug
          WHERE p.artefact_id = ?3 AND NOT EXISTS (SELECT 1 FROM referenced_blobs WHERE sha256 = c.sha256)
          ON CONFLICT DO NOTHING RETURNING sha256`)
        .bind(owner, hashes, id),
      db.prepare('UPDATE blob_purge_epoch SET epoch = epoch + 1 WHERE singleton = 1 AND changes() > 0'),
      db
        .prepare(`DELETE FROM purge_candidates WHERE slug = (SELECT slug FROM artefact_purges WHERE artefact_id = ?)
          AND sha256 IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM referenced_blobs b WHERE b.sha256 = purge_candidates.sha256)`)
        .bind(id, hashes),
    ])
    if (claimed.results.length > 0) {
      const keys = claimed.results.map(({ sha256 }) => `blobs/${sha256}`)
      // On an unknown R2 outcome, keep claims: releasing them while a delete might still run is unsafe.
      await blobs.delete(keys)
      await db.batch([
        db
          .prepare(`DELETE FROM purge_candidates WHERE slug = (SELECT slug FROM artefact_purges WHERE artefact_id = ?)
            AND sha256 IN (SELECT sha256 FROM blob_purge_claims WHERE owner = ?)`)
          .bind(id, owner),
        db.prepare('DELETE FROM blob_purge_claims WHERE owner = ?').bind(owner),
        db.prepare('UPDATE blob_purge_epoch SET epoch = epoch + 1 WHERE singleton = 1 AND changes() > 0'),
      ])
    }
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
