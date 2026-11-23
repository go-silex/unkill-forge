CREATE TABLE ui_flashes (
  session_hash TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  path TEXT NOT NULL,
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  secret_sealed TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ui_flashes_expiry ON ui_flashes(expires_at);
