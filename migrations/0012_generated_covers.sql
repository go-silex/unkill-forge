CREATE TABLE generated_covers (
  artefact_id TEXT PRIMARY KEY NOT NULL REFERENCES artefacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  retry_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  jpeg BLOB CHECK (jpeg IS NULL OR (retry_at IS NULL AND length(jpeg) BETWEEN 3 AND 1048576))
) STRICT;

CREATE INDEX generated_covers_due
  ON generated_covers(retry_at, artefact_id, revision) WHERE retry_at IS NOT NULL;
