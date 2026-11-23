CREATE TABLE ui_flashes (
  id TEXT PRIMARY KEY NOT NULL,
  session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  path TEXT NOT NULL,
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  secret_sealed TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ui_flashes_expiry ON ui_flashes(expires_at);
CREATE INDEX ui_flashes_session ON ui_flashes(session_hash);

CREATE INDEX artefacts_catalogue_recent ON artefacts(visibility, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX artefacts_catalogue_slug ON artefacts(visibility, hex(lower(slug)) || '!' || id) WHERE deleted_at IS NULL;
CREATE INDEX artefacts_catalogue_title ON artefacts(visibility, hex(lower(title)) || '!' || id) WHERE deleted_at IS NULL;
