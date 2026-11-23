CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  artefact_id TEXT NOT NULL REFERENCES artefacts(id) ON DELETE CASCADE,
  label TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  key_sealed TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX share_links_artefact ON share_links(artefact_id);
