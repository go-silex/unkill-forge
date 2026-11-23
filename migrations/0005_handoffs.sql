CREATE TABLE handoffs (
  code_hash TEXT PRIMARY KEY,
  session_id_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,
  return_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX handoffs_expiry ON handoffs(expires_at);
