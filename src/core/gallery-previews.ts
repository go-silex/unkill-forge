import type { Runtime } from '../config'

export const previewPrefix = '/_forge/preview/'

const maxPreviewSlugs = 200
type PreviewScope = 'public' | 'member'
type PreviewFile = { sha256: string; size: number; type: string }

// Start with indexed slug lookups and probe only the five allowed paths in each current revision.
const previewCandidates = `WITH preview_paths(path, type, priority) AS (
  VALUES ('og.jpg', 'image/jpeg', 1), ('og.jpeg', 'image/jpeg', 2),
         ('og.png', 'image/png', 3), ('og.webp', 'image/webp', 4), ('index.og.png', 'image/png', 5)
), candidates AS (
  SELECT a.slug, f.sha256, f.size, p.type, p.priority
  FROM artefacts AS a
  CROSS JOIN revisions AS r ON r.artefact_id = a.id AND r.number = a.current_revision
  CROSS JOIN preview_paths AS p
  CROSS JOIN files AS f ON f.artefact_id = r.artefact_id AND f.revision = r.number AND f.path = p.path
  WHERE a.slug IN (SELECT value FROM json_each(?1))
    AND a.deleted_at IS NULL AND a.current_revision > 0
    AND (?2 = 'member' OR a.visibility = 'public')
    AND f.content_type = p.type
    AND f.size > 0 AND f.size <= 1048576
)`

export async function galleryPreviewSlugs(
  { env: { DB: db } }: Runtime,
  slugs: readonly string[],
  scope: PreviewScope,
): Promise<Set<string>> {
  const matches = new Set<string>()
  if (slugs.length === 0) return matches
  const { results } = await db
    .prepare(`${previewCandidates} SELECT DISTINCT slug FROM candidates`)
    .bind(JSON.stringify(slugs.length > maxPreviewSlugs ? slugs.slice(0, maxPreviewSlugs) : slugs), scope)
    .all<{ slug: string }>()
  for (const { slug } of results) matches.add(slug)
  return matches
}

export async function galleryPreviewFiles(
  { env: { DB: db } }: Runtime,
  slug: string,
  scope: PreviewScope,
): Promise<PreviewFile[]> {
  const { results } = await db
    .prepare(`${previewCandidates} SELECT sha256, size, type FROM candidates ORDER BY priority`)
    .bind(JSON.stringify([slug]), scope)
    .all<PreviewFile>()
  return results
}
