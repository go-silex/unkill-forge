export type Role = 'viewer' | 'publisher' | 'admin'
export type Member = {
  id: string
  kind: 'human' | 'bot'
  name: string
  email: string | null
  role: Role
  status: 'pending' | 'active' | 'removed'
}
export type LoginFlow = {
  stateHash: string
  browserHash: string
  provider: string
  returnPath: string
  sessionHash: string | null
  createdAt: number
  expiresAt: number
  inviteHash: string | null
  generation: number
}
export type BrowserSession = {
  idHash: string
  provider: string
  subject: string
  sid: string | null
  authTime: number
  createdAt: number
  validatedAt: number
  expiresAt: number
  generation: number
  member: Member
}
export type Grant = {
  memberId: string
  provider: string
  subject: string
  sid: string | null
  grantedAt: number
  generation: number
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashSecret(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

export async function putFlow(db: D1Database, flow: Omit<LoginFlow, 'generation'>): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM login_flows WHERE expires_at <= ?').bind(flow.createdAt),
    db
      .prepare(`INSERT INTO login_flows
        (state_hash, browser_hash, provider, return_path, session_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        flow.stateHash,
        flow.browserHash,
        flow.provider,
        flow.returnPath,
        flow.sessionHash,
        flow.createdAt,
        flow.expiresAt,
      ),
    ...(flow.inviteHash === null
      ? []
      : [
          db
            .prepare('UPDATE login_flow_metadata SET invite_hash = ? WHERE state_hash = ?')
            .bind(flow.inviteHash, flow.stateHash),
        ]),
  ])
}

export async function consumeFlow(
  db: D1Database,
  key: Pick<LoginFlow, 'stateHash' | 'browserHash' | 'provider'> & { now: number },
): Promise<LoginFlow | null> {
  const [flow] = await db.batch<LoginFlow>([
    db
      .prepare(`SELECT f.state_hash AS stateHash, browser_hash AS browserHash, provider,
        return_path AS returnPath, session_hash AS sessionHash, created_at AS createdAt,
        expires_at AS expiresAt, invite_hash AS inviteHash, COALESCE(generation, 0) AS generation
        FROM login_flows f LEFT JOIN login_flow_metadata m USING (state_hash)
        WHERE f.state_hash = ? AND browser_hash = ? AND provider = ? AND expires_at > ?`)
      .bind(key.stateHash, key.browserHash, key.provider, key.now),
    db
      .prepare(
        `DELETE FROM login_flows WHERE state_hash = ? AND browser_hash = ? AND provider = ? AND expires_at > ?`,
      )
      .bind(key.stateHash, key.browserHash, key.provider, key.now),
  ])
  return flow.results[0] ?? null
}

type Admission = {
  provider: string
  subject: string
  name: string
  email: string | null
  emailVerified: boolean
  adminEmails: readonly string[]
  autoJoinRole?: 'viewer' | 'publisher'
  inviteHash: string | null
  now: number
}

export async function admitIdentity(db: D1Database, input: Admission): Promise<Member> {
  const { provider, subject, name, email, emailVerified, now } = input
  const id = crypto.randomUUID()
  const bootstrap = !!(emailVerified && email && input.adminEmails.includes(email.toLowerCase()))
  const queries = [
    db
      .prepare(`WITH candidate AS (
      SELECT ? AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'member.bootstrap')
        AND NOT EXISTS (SELECT 1 FROM members WHERE role = 'admin' AND status = 'active') AS bootstrap
    )
    INSERT INTO members (id, kind, name, email, role, status, created_at)
    SELECT ?, 'human', ?, ?, CASE WHEN bootstrap THEN 'admin' ELSE 'viewer' END,
      CASE WHEN bootstrap THEN 'active' ELSE 'pending' END, ?
    FROM candidate WHERE NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND subject = ?)`)
      .bind(bootstrap ? 1 : 0, id, name, email, now, provider, subject),
    db
      .prepare(`INSERT INTO identities (provider, subject, member_id, email, email_verified, last_login_at)
      SELECT ?, ?, id, ?, ?, ? FROM members WHERE id = ?`)
      .bind(provider, subject, email, emailVerified ? 1 : 0, now, id),
    db
      .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
      SELECT ?, ?, id, CASE WHEN role = 'admin' THEN 'member.bootstrap' ELSE 'member.join' END, ?
      FROM members WHERE id = ?`)
      .bind(crypto.randomUUID(), now, JSON.stringify({ provider }), id),
    ...(input.inviteHash === null
      ? []
      : [
          db
            .prepare(`UPDATE invites SET used_by = m.id, used_at = unixepoch('subsec') * 1000
              FROM identities i JOIN members m ON m.id = i.member_id
              WHERE token_hash = ? AND used_at IS NULL AND expires_at > unixepoch('subsec') * 1000
              AND i.provider = ? AND i.subject = ? AND m.status = 'pending' RETURNING role`)
            .bind(input.inviteHash, provider, subject),
          // D1 runs the batch on one connection: only the immediately preceding claim may admit.
          db
            .prepare(`UPDATE members SET status = 'active', role = (SELECT role FROM invites WHERE token_hash = ?)
              WHERE id = (SELECT used_by FROM invites WHERE token_hash = ?) AND changes() = 1`)
            .bind(input.inviteHash, input.inviteHash),
          db
            .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
              SELECT ?, used_at, used_by, 'invite.consume', json_object('id', token_hash, 'role', role)
              FROM invites WHERE token_hash = ? AND changes() = 1`)
            .bind(crypto.randomUUID(), input.inviteHash),
        ]),
    ...(input.autoJoinRole === undefined
      ? []
      : [
          db
            .prepare("UPDATE members SET role = ?, status = 'active' WHERE id = ? AND status = 'pending'")
            .bind(input.autoJoinRole, id),
        ]),
    db
      .prepare(`UPDATE identities SET email = ?, email_verified = ?, last_login_at = ?
      WHERE provider = ? AND subject = ? AND member_id IN (SELECT id FROM members WHERE status <> 'removed')`)
      .bind(email, emailVerified ? 1 : 0, now, provider, subject),
    db
      .prepare(`SELECT m.id, m.kind, m.name, m.email, m.role, m.status
      FROM identities i JOIN members m ON m.id = i.member_id WHERE i.provider = ? AND i.subject = ?`)
      .bind(provider, subject),
  ]
  const member = (await db.batch<Member>(queries)).at(-1)?.results[0]
  if (!member) throw new Error('Identity admission did not produce a member')
  return member
}

export async function createSession(
  db: D1Database,
  session: Omit<BrowserSession, 'member' | 'generation'> & {
    memberId: string
    flowCreatedAt: number
    flowGeneration: number
  },
): Promise<boolean> {
  const {
    idHash,
    memberId,
    provider,
    subject,
    sid,
    authTime,
    createdAt,
    validatedAt,
    expiresAt,
    flowCreatedAt,
    flowGeneration,
  } = session
  const [result] = await db.batch([
    db
      .prepare(`INSERT INTO sessions (id_hash, member_id, provider, subject, sid, auth_time, created_at, validated_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM identity_revocations r WHERE r.provider = ? AND r.received_at >= ?
        AND ((r.sid IS NULL AND r.subject = ?) OR (r.sid = ? AND (r.subject IS NULL OR r.subject = ?))))
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND status <> 'removed' AND generation <= ?)`)
      .bind(
        idHash,
        memberId,
        provider,
        subject,
        sid,
        authTime,
        createdAt,
        validatedAt,
        expiresAt,
        provider,
        flowCreatedAt,
        subject,
        sid,
        subject,
        memberId,
        flowGeneration,
      ),
    auditChange(db, createdAt, memberId, 'session.start', { provider }),
  ])
  return result.meta.changes === 1
}

export async function readSession(
  db: D1Database,
  idHash: string,
  now: number,
): Promise<BrowserSession | null> {
  const row = await db
    .prepare(`SELECT s.id_hash AS idHash, provider, subject, sid, auth_time AS authTime,
    s.created_at AS createdAt, validated_at AS validatedAt, expires_at AS expiresAt,
    m.id, kind, name, email, role, status, generation
    FROM sessions s JOIN members m ON s.member_id = m.id
    WHERE s.id_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL AND m.status <> 'removed'`)
    .bind(idHash, now)
    .first<Omit<BrowserSession, 'member'> & Member>()
  if (!row) return null
  const { id, kind, name, email, role, status, ...session } = row
  return { ...session, member: { id, kind, name, email, role, status } }
}

export async function revalidateSession(
  db: D1Database,
  session: Pick<BrowserSession, 'idHash' | 'provider' | 'subject' | 'sid'> & {
    now: number
    flowCreatedAt: number
  },
): Promise<boolean> {
  const { idHash, provider, subject, sid, now, flowCreatedAt } = session
  const [result] = await db.batch([
    db
      .prepare(`UPDATE sessions SET sid = COALESCE(?, sid), validated_at = ?
      WHERE id_hash = ? AND provider = ? AND subject = ? AND expires_at > ? AND revoked_at IS NULL AND validated_at <= ?
      AND NOT EXISTS (SELECT 1 FROM identity_revocations r WHERE r.provider = ? AND r.received_at >= ?
        AND ((r.sid IS NULL AND r.subject = ?) OR (r.sid = ? AND (r.subject IS NULL OR r.subject = ?))))`)
      .bind(
        sid,
        now,
        idHash,
        provider,
        subject,
        now,
        flowCreatedAt,
        provider,
        flowCreatedAt,
        subject,
        sid,
        subject,
      ),
    db
      .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
      SELECT ?, ?, member_id, 'session.revalidate', '{}' FROM sessions WHERE id_hash = ? AND changes() = 1`)
      .bind(crypto.randomUUID(), now, idHash),
  ])
  return result.meta.changes === 1
}

export async function revokeSession(db: D1Database, idHash: string, now: number): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
      .bind(now, idHash),
    db
      .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
      SELECT ?, ?, member_id, 'session.end', '{}' FROM sessions WHERE id_hash = ? AND changes() = 1`)
      .bind(crypto.randomUUID(), now, idHash),
  ])
}

export async function recordRevocation(
  db: D1Database,
  input: { provider: string; jti: string; subject: string | null; sid: string | null; now: number },
): Promise<boolean> {
  const { provider, jti, subject, sid, now } = input
  const [result] = await db.batch([
    db
      .prepare(`INSERT INTO identity_revocations (provider, jti, subject, sid, received_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(provider, jti, subject, sid, now),
    auditChange(db, now, null, 'identity.revoke', { provider, by: sid === null ? 'subject' : 'sid' }),
    db
      .prepare(`UPDATE sessions SET revoked_at = ? WHERE provider = ? AND revoked_at IS NULL AND changes() = 1
      AND ((? IS NULL AND subject = ?) OR (sid = ? AND (? IS NULL OR subject = ?)))`)
      .bind(now, provider, sid, subject, sid, subject, subject),
  ])
  return result.meta.changes === 1
}

export function auditChange(
  db: D1Database,
  at: number,
  memberId: string | null,
  action: string,
  detail: object,
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (id, at, member_id, action, detail_json)
    SELECT ?, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(crypto.randomUUID(), at, memberId, action, JSON.stringify(detail))
}

export function activeMember(db: D1Database, memberId: string): Promise<Member | null> {
  return db
    .prepare("SELECT id, kind, name, email, role, status FROM members WHERE id = ? AND status = 'active'")
    .bind(memberId)
    .first<Member>()
}

export function grantMember(db: D1Database, grant: Grant, grantId: string): Promise<Member | null> {
  return db
    .prepare(`SELECT m.id, m.kind, m.name, m.email, m.role, m.status FROM members m
    JOIN identities i ON m.id = i.member_id WHERE m.id = ? AND i.provider = ? AND i.subject = ? AND m.status = 'active'
    AND m.generation = ?
    AND NOT EXISTS (SELECT 1 FROM identity_revocations r WHERE r.provider = i.provider AND r.received_at >= ?
      AND ((r.sid IS NULL AND r.subject = i.subject) OR (r.sid = ? AND (r.subject IS NULL OR r.subject = i.subject))))
    AND NOT EXISTS (SELECT 1 FROM oauth_code_replays WHERE grant_id = ?)`)
    .bind(
      grant.memberId,
      grant.provider,
      grant.subject,
      grant.generation,
      grant.grantedAt,
      grant.sid,
      grantId,
    )
    .first<Member>()
}

function codeReplayStatement(db: D1Database, grantId: string): D1PreparedStatement {
  return db
    .prepare(`INSERT OR IGNORE INTO oauth_code_replays (grant_id)
      SELECT grant_id FROM oauth_code_redemptions WHERE grant_id = ?`)
    .bind(grantId)
}

export async function recordAuthorizationCodeReplay(db: D1Database, grantId: string): Promise<void> {
  await codeReplayStatement(db, grantId).run()
}

export async function redeemAuthorizationCode(
  db: D1Database,
  grantId: string,
  now: number,
): Promise<boolean> {
  const [, reservation] = await db.batch([
    codeReplayStatement(db, grantId),
    db
      .prepare(`INSERT OR IGNORE INTO oauth_code_redemptions (grant_id, redeemed_at)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM oauth_code_replays WHERE grant_id = ?)`)
      .bind(grantId, now, grantId),
  ])
  return reservation?.meta.changes === 1
}

export async function releaseAuthorizationCode(db: D1Database, grantId: string): Promise<boolean> {
  const { meta } = await db
    .prepare(`DELETE FROM oauth_code_redemptions WHERE grant_id = ?
      AND NOT EXISTS (SELECT 1 FROM oauth_code_replays WHERE grant_id = ?)`)
    .bind(grantId, grantId)
    .run()
  return meta.changes === 1
}

export async function putConsent(
  db: D1Database,
  tokenHash: string,
  sessionHash: string,
  request: string,
  now: number,
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM oauth_consents WHERE expires_at <= ?').bind(now),
    db
      .prepare(
        'INSERT INTO oauth_consents (token_hash, session_hash, request_url, expires_at) VALUES (?, ?, ?, ?)',
      )
      .bind(tokenHash, sessionHash, request, now + 300_000),
  ])
}

export function consumeConsent(
  db: D1Database,
  tokenHash: string,
  sessionHash: string,
  now: number,
): Promise<string | null> {
  return db
    .prepare(
      'DELETE FROM oauth_consents WHERE token_hash = ? AND session_hash = ? AND expires_at > ? RETURNING request_url',
    )
    .bind(tokenHash, sessionHash, now)
    .first<string>('request_url')
}
