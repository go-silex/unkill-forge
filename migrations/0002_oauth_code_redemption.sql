CREATE TABLE IF NOT EXISTS oauth_code_redemptions (
  grant_id TEXT PRIMARY KEY,
  redeemed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_code_replays (
  grant_id TEXT PRIMARY KEY
);
