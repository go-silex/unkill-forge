import { auditChange, hashSecret, type Member, type Role, randomSecret } from './index'

export function isAdmin(member: Member): boolean {
  return member.status === 'active' && member.role === 'admin'
}

export async function listMembers(db: D1Database): Promise<(Member & { provider: string | null })[]> {
  const { results } = await db
    .prepare(`SELECT m.id, m.kind, m.name, COALESCE(i.email, m.email) AS email, m.role, m.status, i.provider
    FROM members m LEFT JOIN identities i ON i.member_id = m.id ORDER BY m.created_at, m.id`)
    .all<Member & { provider: string | null }>()
  return results
}

export async function changeMember(
  db: D1Database,
  actor: string,
  id: string,
  action: 'admit' | 'role' | 'remove' | 'reinstate',
  role: Role | undefined,
  now: number,
): Promise<boolean> {
  const [result] = await db.batch([
    db
      .prepare(`UPDATE members SET status = CASE ? WHEN 'remove' THEN 'removed' WHEN 'role' THEN status ELSE 'active' END,
      role = COALESCE(?, role), removed_at = CASE WHEN ? = 'remove' THEN ? ELSE NULL END
      WHERE id = ? AND EXISTS (SELECT 1 FROM members actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'admin')
      AND (? = 'role' AND status = 'active' OR ? = 'admit' AND status = 'pending'
        OR ? = 'remove' AND status <> 'removed' OR ? = 'reinstate' AND status = 'removed')
      AND (kind = 'human' OR COALESCE(?, role) <> 'admin')`)
      .bind(action, role ?? null, action, now, id, actor, action, action, action, action, role ?? null),
    auditChange(db, now, actor, `member.${action}`, { id, role }),
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL AND ? = 'remove' AND changes() = 1`,
      )
      .bind(now, id, action),
  ])
  return result.meta.changes === 1
}

export async function createBot(
  db: D1Database,
  actor: string,
  name: string,
  role: 'publisher' | 'viewer',
  now: number,
): Promise<boolean> {
  const id = crypto.randomUUID()
  const [result] = await db.batch([
    db
      .prepare(`INSERT INTO members (id, kind, name, role, status, created_at, created_by)
      SELECT ?, 'bot', ?, ?, 'active', ?, ? FROM members actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'admin'`)
      .bind(id, name, role, now, actor, actor),
    auditChange(db, now, actor, 'bot.create', { id, role }),
  ])
  return result.meta.changes === 1
}

export type TokenSummary = {
  id: string
  memberId: string
  name: string
  prefix: string
  revokedAt: number | null
}
export async function listTokens(db: D1Database): Promise<TokenSummary[]> {
  const { results } = await db
    .prepare(`SELECT id, member_id AS memberId, name, prefix, revoked_at AS revokedAt
    FROM api_tokens ORDER BY created_at DESC, id`)
    .all<TokenSummary>()
  return results
}

export async function createApiToken(
  db: D1Database,
  actor: string,
  memberId: string,
  name: string,
  now: number,
): Promise<string | null> {
  const token = `fgt_${randomSecret()}`
  const id = crypto.randomUUID()
  const [result] = await db.batch([
    db
      .prepare(`INSERT INTO api_tokens (id, member_id, name, prefix, token_hash, created_at)
      SELECT ?, bot.id, ?, ?, ?, ? FROM members bot JOIN members actor ON actor.id = ?
      WHERE bot.id = ? AND bot.kind = 'bot' AND bot.status = 'active' AND actor.status = 'active' AND actor.role = 'admin'`)
      .bind(id, name, token.slice(0, 12), await hashSecret(token), now, actor, memberId),
    auditChange(db, now, actor, 'token.create', { id, memberId }),
  ])
  return result.meta.changes === 1 ? token : null
}

export async function revokeApiToken(
  db: D1Database,
  actor: string,
  id: string,
  now: number,
): Promise<boolean> {
  const [result] = await db.batch([
    db
      .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM members actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'admin')`)
      .bind(now, id, actor),
    auditChange(db, now, actor, 'token.revoke', { id }),
  ])
  return result.meta.changes === 1
}

export async function useApiToken(db: D1Database, token: string, now: number): Promise<string | null> {
  if (!/^fgt_[A-Za-z0-9_-]{43}$/.test(token)) return null
  return db
    .prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    AND member_id IN (SELECT id FROM members WHERE status = 'active') RETURNING member_id`)
    .bind(now, await hashSecret(token))
    .first<string>('member_id')
}
