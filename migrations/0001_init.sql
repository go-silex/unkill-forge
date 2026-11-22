CREATE TABLE members (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'bot')),
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'publisher', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'removed')),
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES members(id),
  removed_at INTEGER
);

CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
  email TEXT,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  last_login_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE login_flows (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  return_path TEXT NOT NULL,
  session_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_flows_expiry ON login_flows(expires_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  sid TEXT,
  auth_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  validated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (provider, subject) REFERENCES identities(provider, subject)
);
CREATE INDEX sessions_member ON sessions(member_id);
CREATE INDEX sessions_subject ON sessions(provider, subject);
CREATE INDEX sessions_sid ON sessions(provider, sid);

CREATE TABLE identity_revocations (
  provider TEXT NOT NULL,
  jti TEXT NOT NULL,
  subject TEXT,
  sid TEXT,
  received_at INTEGER NOT NULL,
  CHECK (subject IS NOT NULL OR sid IS NOT NULL),
  PRIMARY KEY (provider, jti)
);
CREATE INDEX revocations_subject ON identity_revocations(provider, subject, received_at) WHERE sid IS NULL;
CREATE INDEX revocations_sid ON identity_revocations(provider, sid, received_at) WHERE sid IS NOT NULL;

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_tokens_member ON api_tokens(member_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  member_id TEXT REFERENCES members(id),
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX audit_bootstrap_once ON audit_log(action) WHERE action = 'member.bootstrap';

CREATE TABLE oauth_consents (
  token_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  request_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_consents_expiry ON oauth_consents(expires_at);

CREATE TABLE oauth_code_redemptions (
  grant_id TEXT PRIMARY KEY,
  redeemed_at INTEGER NOT NULL
);
