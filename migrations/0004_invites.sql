CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'publisher', 'admin')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT REFERENCES members(id),
  used_at INTEGER,
  CHECK ((used_by IS NULL) = (used_at IS NULL))
);
CREATE INDEX invites_expiry ON invites(expires_at);

CREATE TABLE invite_contexts (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  invite_hash TEXT NOT NULL REFERENCES invites(token_hash) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX invite_contexts_expiry ON invite_contexts(expires_at);
CREATE INDEX invite_contexts_invite ON invite_contexts(invite_hash);

ALTER TABLE members ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN generation INTEGER;

-- Gate 0 cleared removed_at on reinstatement. Revoke legacy credentials for anyone previously removed.
UPDATE members SET generation = 1 WHERE removed_at IS NOT NULL OR id IN (
  SELECT json_extract(detail_json, '$.id') FROM audit_log WHERE action = 'member.remove'
);
CREATE INDEX members_generation ON members(generation);
UPDATE sessions SET revoked_at = unixepoch('subsec') * 1000
WHERE revoked_at IS NULL AND member_id IN (SELECT id FROM members WHERE generation > 0);
UPDATE sessions SET generation = (SELECT generation FROM members WHERE id = sessions.member_id)
WHERE revoked_at IS NULL;
UPDATE api_tokens SET revoked_at = unixepoch('subsec') * 1000
WHERE revoked_at IS NULL AND member_id IN (SELECT id FROM members WHERE generation > 0);

-- Preserve Gate 0's positional INSERT; snapshot a D1-ordered watermark for every new flow.
CREATE TABLE login_flow_metadata (
  state_hash TEXT PRIMARY KEY REFERENCES login_flows(state_hash) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  invite_hash TEXT
);
CREATE TRIGGER snapshot_login_flow_generation AFTER INSERT ON login_flows
BEGIN
  INSERT INTO login_flow_metadata (state_hash, generation)
  VALUES (NEW.state_hash, (SELECT COALESCE(MAX(generation), 0) FROM members));
END;

CREATE TRIGGER revoke_member_credentials AFTER UPDATE OF status ON members
WHEN NEW.status = 'removed' AND OLD.status <> 'removed'
BEGIN
  UPDATE members
  SET generation = (SELECT MAX(generation) + 1 FROM members)
  WHERE id = NEW.id;
  UPDATE sessions SET revoked_at = unixepoch('subsec') * 1000 WHERE member_id = NEW.id AND revoked_at IS NULL;
  UPDATE api_tokens SET revoked_at = unixepoch('subsec') * 1000 WHERE member_id = NEW.id AND revoked_at IS NULL;
END;
