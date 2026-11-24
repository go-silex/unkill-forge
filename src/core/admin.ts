import { ArtefactError, checkMember, requireAdmin } from './artefacts'
import { activeMember, auditChange, hashSecret, type Member, type Role, randomSecret } from './index'
import { adminCountLimit, adminPageSize, trimLookahead } from './pagination'

export function isAdmin(member: Member): boolean {
  return member.status === 'active' && member.role === 'admin'
}

export async function uiActor(db: D1Database, actor: string, minimum: Role): Promise<Member> {
  const member = await activeMember(db, actor)
  if (!member) throw new ArtefactError('forbidden', 'An active member is required')
  if (minimum === 'admin') requireAdmin(member)
  else checkMember(member, minimum === 'publisher')
  return member
}

export async function listMembers(
  db: D1Database,
  actor: string,
  { after = '', kind, status }: { after?: string; kind: Member['kind']; status?: Member['status'] },
) {
  await uiActor(db, actor, 'admin')
  const { results: members } = await db
    .prepare(`SELECT m.id, m.kind, m.name, COALESCE(i.email, m.email) AS email, m.role, m.status, i.provider,
      m.created_at AS createdAt, m.removed_at AS removedAt
    FROM (
      SELECT id, kind, name, email, role, status, created_at, removed_at FROM members
      WHERE id > ? AND kind = ? AND (? IS NULL OR status = ?) ORDER BY id LIMIT ?
    ) m LEFT JOIN identities i ON i.member_id = m.id
    ORDER BY m.id`)
    .bind(after, kind, status ?? null, status ?? null, adminPageSize + 1)
    .all<Member & { provider: string | null; createdAt: number; removedAt: number | null }>()
  return { members, nextCursor: trimLookahead(members, adminPageSize)?.id }
}

export async function countHumanMembers(db: D1Database, actor: string) {
  await uiActor(db, actor, 'admin')
  const { results } = await db
    .prepare(`WITH sections(status) AS (VALUES ('pending'), ('active'), ('removed'))
    SELECT status, (SELECT COUNT(*) FROM (
      SELECT 1 FROM members WHERE kind = 'human' AND members.status = sections.status LIMIT ?
    )) AS total FROM sections`)
    .bind(adminCountLimit + 1)
    .all<{ status: Member['status']; total: number }>()
  return Object.fromEntries(results.map(({ status, total }) => [status, total]))
}

export async function changeMember(
  db: D1Database,
  actor: string,
  id: string,
  action: 'admit' | 'role' | 'remove' | 'reinstate',
  role: Role | undefined,
  now: number,
  expected?: 'pending' | 'active',
): Promise<boolean> {
  const [result] = await db.batch([
    db
      .prepare(`UPDATE members SET status = CASE ? WHEN 'remove' THEN 'removed' WHEN 'role' THEN status ELSE 'active' END,
      role = COALESCE(?, role), removed_at = CASE WHEN ? = 'remove' THEN ? ELSE removed_at END
      WHERE id = ? AND EXISTS (SELECT 1 FROM members actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'admin')
      AND (? = 'role' AND status = 'active' OR ? = 'admit' AND status = 'pending'
        OR ? = 'remove' AND status <> 'removed' OR ? = 'reinstate' AND status = 'removed')
      AND (kind = 'human' OR COALESCE(?, role) <> 'admin')
      AND (?12 IS NULL OR status = ?12) RETURNING id`)
      .bind(
        action,
        role ?? null,
        action,
        now,
        id,
        actor,
        action,
        action,
        action,
        action,
        role ?? null,
        expected ?? null,
      ),
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

export const botCredentialSummaryLimit = adminCountLimit + 1

export async function summarizeBotCredentials(db: D1Database, botIds: string[]) {
  if (botIds.length === 0)
    return new Map<string, [active: number, lastUsedAt: number | null, sampled: number]>()
  // The member_id index bounds the work even when a bot has a long history of revoked credentials.
  const { results } = await db
    .prepare(`SELECT bot.value AS id, (SELECT json_array(
      COUNT(*) FILTER (WHERE revoked_at IS NULL), MAX(last_used_at), COUNT(*)
    ) FROM (
      SELECT revoked_at, last_used_at FROM api_tokens INDEXED BY api_tokens_member
      WHERE member_id = bot.value LIMIT ?
    )) AS summary FROM json_each(?) bot`)
    .bind(botCredentialSummaryLimit, JSON.stringify(botIds))
    .all<{ id: string; summary: string }>()
  return new Map(
    results.map(({ id, summary }) => [id, JSON.parse(summary) as [number, number | null, number]]),
  )
}

type TokenSummary = {
  id: string
  name: string
  prefix: string
  createdAt: number
  revokedAt: number | null
  lastUsedAt: number | null
}
async function tokenPage(db: D1Database, memberId: string, after: string, limit: number) {
  const { results } = await db
    .prepare(`SELECT id, name, prefix, created_at AS createdAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt
      FROM api_tokens WHERE member_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(memberId, after, limit)
    .all<TokenSummary>()
  return results
}

export type BotDetails = {
  bot: Pick<Member, 'id' | 'name' | 'role' | 'status'> & { createdAt: number }
  tokens: TokenSummary[]
  nextCursor: string | undefined
}

function findBot(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT id, name, role, status, created_at AS createdAt FROM members WHERE id = ? AND kind = 'bot'",
    )
    .bind(id)
    .first<BotDetails['bot']>()
}

export async function changeBot(
  db: D1Database,
  actor: string,
  id: string,
  action: 'role' | 'remove' | 'reinstate',
  role: 'viewer' | 'publisher' | undefined,
  now: number,
  expected?: 'active',
) {
  // Member kind is immutable; changeMember rechecks actor privilege and target state at write time.
  return (await findBot(db, id)) !== null && changeMember(db, actor, id, action, role, now, expected)
}

export async function getBotDetails(
  db: D1Database,
  actor: string,
  memberId: string,
  after = '',
): Promise<BotDetails | null> {
  await uiActor(db, actor, 'admin')
  const bot = await findBot(db, memberId)
  if (!bot) return null
  const tokens = await tokenPage(db, memberId, after, adminPageSize + 1)
  return { bot, tokens, nextCursor: trimLookahead(tokens, adminPageSize)?.id }
}

export async function listOwnTokens(db: D1Database, actor: string, after = '') {
  await uiActor(db, actor, 'publisher')
  const tokens = await tokenPage(db, actor, after, 51)
  return { tokens, nextCursor: trimLookahead(tokens, 50)?.id }
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
