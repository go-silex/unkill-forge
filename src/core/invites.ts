import { auditChange, hashSecret, type Role, randomSecret } from './index'

export const inviteKey = /^[A-Za-z0-9_-]{43}$/

export async function createInviteContext(db: D1Database, token: string, id: string, browser: string) {
  if (!inviteKey.test(token)) return false
  const [inviteHash, browserHash] = await Promise.all([hashSecret(token), hashSecret(browser)])
  const [, result] = await db.batch([
    db.prepare("DELETE FROM invite_contexts WHERE expires_at <= unixepoch('subsec') * 1000"),
    db
      .prepare(`INSERT INTO invite_contexts (id, browser_hash, invite_hash, expires_at)
        SELECT ?, ?, token_hash, MIN(expires_at, unixepoch('subsec') * 1000 + 600000) FROM invites
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > unixepoch('subsec') * 1000`)
      .bind(id, browserHash, inviteHash),
  ])
  return result.meta.changes === 1
}

export async function consumeInviteContext(db: D1Database, id: string, browser: string) {
  return db
    .prepare(`DELETE FROM invite_contexts WHERE id = ? AND browser_hash = ?
      AND expires_at > unixepoch('subsec') * 1000 RETURNING invite_hash`)
    .bind(id, await hashSecret(browser))
    .first<string>('invite_hash')
}

export async function listInvites(db: D1Database, actor: string, after = '') {
  const { results } = await db
    .prepare(`SELECT token_hash AS id, role, expires_at AS expiresAt FROM invites
      WHERE used_at IS NULL AND expires_at > unixepoch('subsec') * 1000
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active' AND role = 'admin')
      AND token_hash > ? ORDER BY token_hash LIMIT 50`)
    .bind(actor, after)
    .all<{ id: string; role: Role; expiresAt: number }>()
  return results
}

export async function createInvite(
  db: D1Database,
  actor: string,
  role: Role,
  now: number,
): Promise<string | null> {
  const token = randomSecret()
  const id = await hashSecret(token)
  const [result] = await db.batch([
    db
      .prepare(`INSERT INTO invites (token_hash, role, created_by, created_at, expires_at)
        SELECT ?, ?, id, ?, ? FROM members WHERE id = ? AND status = 'active' AND role = 'admin'`)
      .bind(id, role, now, now + 7 * 86_400_000, actor),
    auditChange(db, now, actor, 'invite.create', { id, role }),
  ])
  return result.meta.changes === 1 ? token : null
}

export async function revokeInvite(db: D1Database, actor: string, id: string, now: number): Promise<boolean> {
  const [result] = await db.batch([
    db
      .prepare(`DELETE FROM invites WHERE token_hash = ? AND used_at IS NULL
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active' AND role = 'admin')
        RETURNING token_hash`)
      .bind(id, actor),
    auditChange(db, now, actor, 'invite.revoke', { id }),
  ])
  return result.results.length === 1
}
