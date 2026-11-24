import type { Runtime } from '../config'
import { revisionEntry } from './artefacts'
import { isJpeg, maxCoverBytes, openCover, revisionCoverFiles } from './gallery-previews'

export const coverCron = '*/5 * * * *'

const discoveryPage = 64
const inspectionsPerRun = 5
const maxRenderFiles = 128
const leaseMs = 120_000
const inactiveDelayMs = 3_600_000
const intervalMs = 300_000

type Job = { artefactId: string; revision: number; attempts: number; leaseUntil: number }
type RenderFile = { path: string; sha256: string; size: number; type: string }
type Render = (entryPath: string, files: readonly RenderFile[]) => Promise<Uint8Array<ArrayBuffer>>
type CoverStorage = Pick<Runtime['env'], 'DB' | 'BLOBS'>

export async function generatePublishedCover(
  { DB: db, BLOBS: bucket }: CoverStorage,
  artefactId: string,
  revision: number,
  render: Render,
  now: number,
) {
  // Take the same fenced lease as recovery, but never process a different head or pull from the queue.
  const job = await db
    .prepare(`INSERT INTO generated_covers (artefact_id, revision, retry_at, attempts)
      SELECT id, current_revision, ?4, 1 FROM artefacts
      WHERE id = ?1 AND current_revision = ?2 AND deleted_at IS NULL
      ON CONFLICT(artefact_id) DO UPDATE SET revision = excluded.revision, retry_at = excluded.retry_at,
        attempts = CASE WHEN generated_covers.revision = excluded.revision THEN attempts + 1 ELSE 1 END,
        jpeg = NULL
      WHERE generated_covers.revision < excluded.revision OR
        (generated_covers.revision = excluded.revision AND
          (generated_covers.retry_at <= ?3 OR (attempts = 0 AND generated_covers.retry_at IS NOT NULL)))
      RETURNING artefact_id AS artefactId, revision, attempts, retry_at AS leaseUntil`)
    .bind(artefactId, revision, now, now + leaseMs)
    .first<Job>()
  if (job) await processCover(db, bucket, job, render, now)
}

async function discover(db: D1Database, now: number) {
  // Inspect a bounded part of the catalogue even when all existing covers have been checked.
  const { results } = await db
    .prepare(`SELECT id FROM artefacts
      WHERE id > COALESCE((SELECT id FROM maintenance_cursors WHERE task = 'covers'), '')
      ORDER BY id LIMIT ?`)
    .bind(discoveryPage)
    .all<{ id: string }>()
  const advance = db
    .prepare(`INSERT INTO maintenance_cursors (task, id, position) VALUES ('covers', ?, 0)
      ON CONFLICT(task) DO UPDATE SET id = excluded.id WHERE id <> excluded.id`)
    .bind(results.length === discoveryPage ? (results.at(-1)?.id ?? '') : '')
  if (results.length === 0) {
    await advance.run()
    return
  }
  await db.batch([
    db
      .prepare(`INSERT INTO generated_covers (artefact_id, revision, retry_at)
        SELECT a.id, a.current_revision, ?1
        FROM json_each(?2) AS page CROSS JOIN artefacts AS a ON a.id = page.value
        WHERE a.deleted_at IS NULL AND a.current_revision > 0
        ON CONFLICT(artefact_id) DO UPDATE SET revision = excluded.revision,
          retry_at = excluded.retry_at, attempts = 0, jpeg = NULL
        WHERE generated_covers.revision < excluded.revision`)
      .bind(now, JSON.stringify(results.map(({ id }) => id))),
    advance,
  ])
}

const live = `EXISTS (SELECT 1 FROM artefacts AS a
  WHERE a.id = generated_covers.artefact_id AND a.deleted_at IS NULL
    AND a.current_revision = generated_covers.revision)`

const duePage = `SELECT artefact_id FROM generated_covers WHERE retry_at <= ?1
  ORDER BY retry_at, artefact_id LIMIT ${discoveryPage}`

function deferInactive(db: D1Database, now: number) {
  // Rotate stale entries out of the due page without losing jobs for soft-deleted artefacts.
  return db
    .prepare(`WITH due AS MATERIALIZED (${duePage})
      UPDATE generated_covers SET retry_at = ?2
      WHERE artefact_id IN (SELECT artefact_id FROM due) AND NOT ${live}`)
    .bind(now, now + inactiveDelayMs)
    .run()
}

function claim(db: D1Database, now: number) {
  // One atomic write; attempts is a fencing token within a revision.
  return db
    .prepare(`WITH due AS MATERIALIZED (${duePage})
      UPDATE generated_covers SET retry_at = ?2, attempts = attempts + 1
      WHERE artefact_id = (SELECT generated_covers.artefact_id FROM due
        CROSS JOIN generated_covers USING (artefact_id) WHERE ${live}
        ORDER BY retry_at, artefact_id LIMIT 1)
      RETURNING artefact_id AS artefactId, revision, attempts, retry_at AS leaseUntil`)
    .bind(now, now + leaseMs)
    .first<Job>()
}

function settle(
  db: D1Database,
  job: Job,
  retryAt: number | null,
  jpeg: Uint8Array<ArrayBuffer> | null = null,
) {
  return db
    .prepare(`UPDATE generated_covers SET retry_at = ?, jpeg = ?
      WHERE artefact_id = ? AND revision = ? AND attempts = ? AND retry_at = ? AND ${live}`)
    .bind(retryAt, jpeg, job.artefactId, job.revision, job.attempts, job.leaseUntil)
    .run()
}

async function renderInput(db: D1Database, job: Job) {
  const entry = await revisionEntry(db, job.artefactId, job.revision, { cache: false })
  if (entry === null) throw new Error('Cover entry unavailable')
  const { results: files } = await db
    .prepare(`SELECT f.path, f.sha256, f.size, f.content_type AS type FROM files AS f
      JOIN artefacts AS a ON a.id = f.artefact_id AND a.current_revision = f.revision
      WHERE f.artefact_id = ? AND f.revision = ? AND a.deleted_at IS NULL
      ORDER BY f.path LIMIT ?`)
    .bind(job.artefactId, job.revision, maxRenderFiles + 1)
    .all<RenderFile>()
  // A delete followed by a restore can temporarily hide the manifest without changing the revision.
  if (files.length === 0) throw new Error('Cover manifest unavailable')
  if (
    files.length > maxRenderFiles ||
    !files.some(
      ({ path, type }) => path === entry && type.split(';', 1)[0].trim().toLowerCase() === 'text/html',
    )
  ) {
    return null
  }
  return { entry, files }
}

export async function generateCovers(
  { env: { DB: db, BLOBS: bucket } }: Runtime,
  render: Render,
  now: number,
) {
  await discover(db, now)
  await deferInactive(db, now)
  // Checking supplied cover signatures is cheap. Acquire at most one browser per event.
  for (let i = 0; i < inspectionsPerRun; i++) {
    const job = await claim(db, now)
    if (!job) return
    if (await processCover(db, bucket, job, render, now)) return
  }
}

async function processCover(db: D1Database, bucket: R2Bucket, job: Job, render: Render, now: number) {
  let jpeg: Uint8Array<ArrayBuffer> | null = null
  let retryAt: number | null = null
  let rendered = false
  try {
    let supplied = false
    for (const file of await revisionCoverFiles(db, job.artefactId, job.revision)) {
      if (await openCover(bucket, file, true)) {
        supplied = true
        break
      }
    }
    const input = supplied ? null : await renderInput(db, job)
    if (input) {
      rendered = true
      jpeg = await render(input.entry, input.files)
      if (jpeg.byteLength > maxCoverBytes || !isJpeg(jpeg)) throw new Error('Invalid JPEG')
    }
  } catch {
    // No URLs, artefact names or provider diagnostics in logs.
    console.warn('Forge cover attempt failed; retry scheduled')
    retryAt = now + intervalMs * 2 ** Math.min(job.attempts - 1, 8)
    jpeg = null
  }
  await settle(db, job, retryAt, jpeg)
  return rendered || retryAt !== null
}
