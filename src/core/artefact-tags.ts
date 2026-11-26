export const artefactTagMaxLength = 32

export function isArtefactTag(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)
}

// Valid tags cannot contain commas. Catalogue queries project their sorted aggregate in one D1 round trip.
export function unpackArtefactTags(tags: string | null) {
  return tags === null ? [] : tags.split(',')
}

export function replaceArtefactTags(db: D1Database, id: string, slug: string, tags: string[]) {
  // Use the same identity and live-artefact guard as metadata writes, even in a batch.
  return [
    db
      .prepare(`DELETE FROM artefact_tags WHERE artefact_id = (
        SELECT id FROM artefacts WHERE id = ? AND slug = ? AND deleted_at IS NULL
      )`)
      .bind(id, slug),
    db
      .prepare(`INSERT INTO artefact_tags (artefact_id, tag)
        SELECT artefacts.id, tags.value FROM artefacts CROSS JOIN json_each(?3) AS tags
        WHERE artefacts.id = ?1 AND artefacts.slug = ?2 AND artefacts.deleted_at IS NULL`)
      .bind(id, slug, JSON.stringify(tags)),
  ]
}
