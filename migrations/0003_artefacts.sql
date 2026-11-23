CREATE TABLE artefacts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  current_revision INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX artefacts_updated ON artefacts(deleted_at, updated_at DESC);

CREATE TABLE revisions (
  artefact_id TEXT NOT NULL REFERENCES artefacts(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY (artefact_id, number)
);

CREATE TABLE files (
  artefact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  PRIMARY KEY (artefact_id, revision, path),
  FOREIGN KEY (artefact_id, revision) REFERENCES revisions(artefact_id, number) ON DELETE CASCADE
);
CREATE INDEX files_sha256 ON files(sha256);

ALTER TABLE audit_log ADD COLUMN artefact_id TEXT;
CREATE INDEX audit_artefact_at ON audit_log(artefact_id, at);
