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
ALTER TABLE login_flows ADD COLUMN invite_hash TEXT;

-- Gate 0 cleared removed_at on reinstatement; recover those removals from its audit trail.
UPDATE members SET removed_at = COALESCE(removed_at, (
  SELECT MAX(at) FROM audit_log WHERE action = 'member.remove' AND json_extract(detail_json, '$.id') = members.id
));
UPDATE sessions SET revoked_at = (SELECT removed_at FROM members WHERE id = sessions.member_id)
WHERE revoked_at IS NULL AND created_at <= (SELECT removed_at FROM members WHERE id = sessions.member_id);
UPDATE api_tokens SET revoked_at = (SELECT removed_at FROM members WHERE id = api_tokens.member_id)
WHERE revoked_at IS NULL AND created_at <= (SELECT removed_at FROM members WHERE id = api_tokens.member_id);

CREATE TRIGGER revoke_member_credentials AFTER UPDATE OF status ON members
WHEN NEW.status = 'removed' AND OLD.status <> 'removed'
BEGIN
  UPDATE sessions SET revoked_at = NEW.removed_at WHERE member_id = NEW.id AND revoked_at IS NULL;
  UPDATE api_tokens SET revoked_at = NEW.removed_at WHERE member_id = NEW.id AND revoked_at IS NULL;
END;
