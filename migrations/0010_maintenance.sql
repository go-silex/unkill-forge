CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX handoffs_session ON handoffs(session_id_hash);
CREATE INDEX oauth_consents_session ON oauth_consents(session_hash);
CREATE INDEX revocations_received ON identity_revocations(received_at);
CREATE INDEX artefacts_deleted_queue ON artefacts(deleted_at, id) WHERE deleted_at IS NOT NULL;

ALTER TABLE artefact_purges ADD COLUMN last_attempted_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX artefact_purges_queue ON artefact_purges(last_attempted_at, artefact_id);

CREATE TABLE maintenance_cursors (
  task TEXT PRIMARY KEY NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  id TEXT NOT NULL DEFAULT ''
);
