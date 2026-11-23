import { auditChange, hashSecret, type Role, randomSecret } from './index'

export const inviteKey = /^[A-Za-z0-9_-]{43}$/

export async function activeInviteHash(db: D1Database, token: string, now: number): Promise<string | null> {
  if (!inviteKey.test(token)) return null
  return db
    .prepare('SELECT token_hash FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(await hashSecret(token), now)
    .first<string>('token_hash')
}

export async function listInvites(db: D1Database, actor: string, now: number) {
  const { results } = await db
    .prepare(`SELECT token_hash AS id, role, expires_at AS expiresAt FROM invites
      WHERE used_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active' AND role = 'admin')
      ORDER BY created_at DESC, token_hash`)
    .bind(now, actor)
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
      .prepare(`DELETE FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active' AND role = 'admin')`)
      .bind(id, now, actor),
    auditChange(db, now, actor, 'invite.revoke', { id }),
  ])
  return result.meta.changes === 1
}
