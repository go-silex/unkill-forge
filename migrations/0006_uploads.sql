CREATE TABLE uploads (
  token_hash TEXT PRIMARY KEY NOT NULL,
  upload_id TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL REFERENCES members(id),
  member_generation INTEGER NOT NULL,
  slug TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'receiving', 'stored', 'consumed', 'failed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX uploads_expires ON uploads(expires_at);
