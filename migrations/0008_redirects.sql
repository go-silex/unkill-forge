CREATE TABLE redirects (
  from_prefix TEXT PRIMARY KEY NOT NULL,
  source_slug TEXT NOT NULL,
  target_artefact_id TEXT NOT NULL REFERENCES artefacts(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id)
);
-- The primary-key index serves exact probes of the request's slash-delimited prefixes.
CREATE INDEX redirects_target ON redirects(target_artefact_id);
CREATE INDEX redirects_source ON redirects(source_slug);

CREATE TABLE artefact_purges (
  slug TEXT PRIMARY KEY NOT NULL,
  artefact_id TEXT NOT NULL UNIQUE
);

CREATE TABLE purge_attempts (
  artefact_id TEXT PRIMARY KEY NOT NULL REFERENCES artefact_purges(artefact_id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE VIEW reserved_lifecycle_slugs AS
SELECT source_slug AS slug FROM redirects
UNION ALL SELECT slug FROM artefact_purges;
CREATE TABLE purge_candidates (
  slug TEXT NOT NULL REFERENCES artefact_purges(slug) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (slug, sha256)
);
CREATE TABLE blob_purge_claims (
  sha256 TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL
);
CREATE INDEX blob_purge_claims_owner ON blob_purge_claims(owner);

CREATE INDEX uploads_stored_sha256 ON uploads(sha256, expires_at) WHERE state = 'stored';
CREATE VIEW referenced_blobs AS
SELECT sha256 FROM files
UNION ALL
SELECT sha256 FROM uploads WHERE state = 'stored' AND expires_at > unixepoch('subsec') * 1000;

CREATE TABLE blob_purge_epoch (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch INTEGER NOT NULL
);
CREATE TRIGGER files_guard_blob_purge BEFORE INSERT ON files
WHEN EXISTS (SELECT 1 FROM blob_purge_claims WHERE sha256 = NEW.sha256)
BEGIN
  SELECT RAISE(ABORT, 'forge blob purge in progress');
END;
INSERT INTO blob_purge_epoch (singleton, epoch) VALUES (1, 0);

CREATE TRIGGER stored_upload_guard_blob_purge BEFORE INSERT ON uploads
WHEN NEW.state = 'stored' AND EXISTS (SELECT 1 FROM blob_purge_claims WHERE sha256 = NEW.sha256)
BEGIN
  SELECT RAISE(ABORT, 'forge blob purge in progress');
END;

CREATE TRIGGER upload_store_guard_blob_purge BEFORE UPDATE OF state ON uploads
WHEN NEW.state = 'stored' AND EXISTS (SELECT 1 FROM blob_purge_claims WHERE sha256 = NEW.sha256)
BEGIN
  SELECT RAISE(ABORT, 'forge blob purge in progress');
END;
