import { ArtefactError, checkMember, requireAdmin } from './artefacts'
import { activeMember, auditChange, hashSecret, type Member, type Role, randomSecret } from './index'

export function isAdmin(member: Member): boolean {
  return member.status === 'active' && member.role === 'admin'
}

export async function uiActor(db: D1Database, actor: string, minimum: Role = 'viewer'): Promise<Member> {
  const member = await activeMember(db, actor)
  if (!member) throw new ArtefactError('forbidden', 'An active member is required')
  if (minimum === 'admin') requireAdmin(member)
  else checkMember(member, minimum === 'publisher')
  return member
}

export async function listMembers(db: D1Database, actor: string, after = '', botsOnly = false) {
  await uiActor(db, actor, 'admin')
  const { results } = await db
    .prepare(`SELECT m.id, m.kind, m.name, COALESCE(i.email, m.email) AS email, m.role, m.status, i.provider
    FROM members m LEFT JOIN identities i ON i.member_id = m.id
    WHERE m.id > ? AND (? = 0 OR m.kind = 'bot') ORDER BY m.id LIMIT 50`)
    .bind(after, Number(botsOnly))
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
      role = COALESCE(?, role), removed_at = CASE WHEN ? = 'remove' THEN ? ELSE removed_at END
      WHERE id = ? AND EXISTS (SELECT 1 FROM members actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'admin')
      AND (? = 'role' AND status = 'active' OR ? = 'admit' AND status = 'pending'
        OR ? = 'remove' AND status <> 'removed' OR ? = 'reinstate' AND status = 'removed')
      AND (kind = 'human' OR COALESCE(?, role) <> 'admin') RETURNING id`)
      .bind(action, role ?? null, action, now, id, actor, action, action, action, action, role ?? null),
    auditChange(db, now, actor, `member.${action}`, { id, role }),
  ])
  // D1's change count also includes credential revocations from the removal trigger.
  return result.results.length === 1
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

type TokenSummary = {
  id: string
  name: string
  prefix: string
  revokedAt: number | null
  lastUsedAt: number | null
}
async function tokenPage(db: D1Database, memberId: string, after: string, limit: number) {
  const { results } = await db
    .prepare(`SELECT id, name, prefix, revoked_at AS revokedAt, last_used_at AS lastUsedAt
      FROM api_tokens WHERE member_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(memberId, after, limit)
    .all<TokenSummary>()
  return results
}

export async function listTokens(db: D1Database, actor: string, memberId: string, after = '') {
  await uiActor(db, actor, 'admin')
  const bot = await db.prepare("SELECT id FROM members WHERE id = ? AND kind = 'bot'").bind(memberId).first()
  return bot ? tokenPage(db, memberId, after, 50) : []
}

export async function listOwnTokens(db: D1Database, actor: string, after = '') {
  await uiActor(db, actor, 'publisher')
  const tokens = await tokenPage(db, actor, after, 51)
  const more = tokens.length > 50
  if (more) tokens.pop()
  return { tokens, nextCursor: more ? tokens[49].id : undefined }
}

export async function createApiToken(
  db: D1Database,
  actor: string,
  memberId: string,
  name: string,
  now: number,
): Promise<{ token: string; ownerName: string } | null> {
  const issued = await createToken(db, actor, memberId, name, now, false)
  return issued?.ownerName != null ? { token: issued.token, ownerName: issued.ownerName } : null
}

export async function createOwnToken(db: D1Database, actor: string, name: string, now: number) {
  return (await createToken(db, actor, actor, name, now, true))?.token ?? null
}

async function createToken(
  db: D1Database,
  actor: string,
  memberId: string,
  name: string,
  now: number,
  own: boolean,
) {
  const token = `fgt_${randomSecret()}`
  const id = crypto.randomUUID()
  const [result] = await db.batch<{ ownerName: string | null }>([
    db
      .prepare(`INSERT INTO api_tokens (id, member_id, name, prefix, token_hash, created_at)
      SELECT ?1, target.id, ?2, ?3, ?4, ?5 FROM members target JOIN members actor ON actor.id = ?6
      WHERE target.id = ?7 AND target.status = 'active' AND actor.status = 'active'
      AND (?8 = 1 AND target.id = actor.id AND actor.role IN ('admin','publisher')
        OR ?8 = 0 AND target.kind = 'bot' AND actor.role = 'admin')
      RETURNING CASE WHEN ?8 = 0 THEN (SELECT name FROM members WHERE id = ?7) END AS ownerName`)
      .bind(id, name, token.slice(0, 12), await hashSecret(token), now, actor, memberId, Number(own)),
    auditChange(db, now, actor, 'token.create', { id, memberId }),
  ])
  const issued = result.results[0]
  return issued ? { token, ownerName: issued.ownerName } : null
}

export async function revokeApiToken(
  db: D1Database,
  actor: string,
  id: string,
  now: number,
): Promise<boolean> {
  return revokeToken(db, actor, id, now, false)
}

export async function revokeOwnToken(db: D1Database, actor: string, id: string, now: number) {
  return revokeToken(db, actor, id, now, true)
}

async function revokeToken(db: D1Database, actor: string, id: string, now: number, own: boolean) {
  const [result] = await db.batch([
    db
      .prepare(`UPDATE api_tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM members actor JOIN members target ON target.id = api_tokens.member_id
        WHERE actor.id = ?3 AND actor.status = 'active'
        AND (?4 = 1 AND target.id = actor.id AND actor.role IN ('admin','publisher')
          OR ?4 = 0 AND target.kind = 'bot' AND actor.role = 'admin'))`)
      .bind(now, id, actor, Number(own)),
    auditChange(db, now, actor, 'token.revoke', { id }),
  ])
  return result.meta.changes === 1
}

export async function useApiToken(db: D1Database, token: string, now: number) {
  if (!/^fgt_[A-Za-z0-9_-]{43}$/.test(token)) return null
  return db
    .prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    AND member_id IN (SELECT id FROM members WHERE status = 'active' AND (kind = 'bot' OR role <> 'viewer'))
    RETURNING member_id AS memberId, (SELECT generation FROM members WHERE id = member_id) AS generation`)
    .bind(now, await hashSecret(token))
    .first<{ memberId: string; generation: number }>()
}
