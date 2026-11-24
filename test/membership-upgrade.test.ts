import { applyD1Migrations, type D1Migration, env, reset } from 'cloudflare:test'
import { base64url } from 'jose'
import { expect, it } from 'vitest'
import { admin, listedId, location, mcpCall, runtime, sessionCookie, whoami } from './http'
import { mockProvider, setupOidc } from './oidc'

setupOidc()

const { DB, TEST_MIGRATIONS } = env as typeof env & { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const gate0Migrations = TEST_MIGRATIONS.filter(({ name }) => name < '0004_invites.sql')
const path = '/admin/members'
const secret = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
async function hash(value: string) {
  return base64url.encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  )
}

async function gate0Session(id: string, subject: string, now: number) {
  const cookie = secret()
  const result = await DB.prepare(`INSERT INTO sessions
    (id_hash, member_id, provider, subject, sid, auth_time, created_at, validated_at, expires_at)
    SELECT ?, id, 'team', ?, NULL, ?, ?, ?, ? FROM members WHERE id = ? AND status <> 'removed'`)
    .bind(await hash(cookie), subject, now, now, now, now + 3_600_000, id)
    .run()
  expect(result.meta.changes).toBe(1)
  return { headers: { cookie: `${sessionCookie}=${cookie}` } }
}

it('rejects a session written by Gate 0 from a stale flow during rollout', async () => {
  await reset()
  await applyD1Migrations(DB, TEST_MIGRATIONS)
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const subject = 'during-rollout'
  await idp.signedIn(send, subject)
  const id = await listedId(owner, path, `${subject}@example.test`)
  const now = Date.now()
  await DB.prepare('INSERT INTO login_flows VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('old-worker-state', 'old-worker-cookie', 'team', '/', null, now, now + 300_000)
    .run()
  expect((await owner.post(path, { id, action: 'remove' })).status).toBe(303)
  expect((await owner.post(path, { id, action: 'reinstate' })).status).toBe(303)
  expect(
    await DB.prepare(`DELETE FROM login_flows WHERE state_hash = ? AND browser_hash = ? AND provider = ?
    AND expires_at > ? RETURNING return_path AS returnPath`)
      .bind('old-worker-state', 'old-worker-cookie', 'team', now)
      .first(),
  ).toEqual({ returnPath: '/' })

  const stale = await gate0Session(id, subject, Date.now())
  expect(location(await send('/', stale)).pathname).toBe('/login')
  expect(location(await send('/authorize', stale)).pathname).toBe('/login')
  const fresh = await idp.signedIn(send, subject)
  expect(await (await fresh.request('/artefacts')).text()).toContain(
    `<div class="forge-account"><span class="forge-account__name">${subject}</span><span class="forge-account__role">viewer</span>`,
  )
})

it('revokes pre-removal and replacement Gate 0 tokens while preserving unaffected credentials', async () => {
  await reset()
  await applyD1Migrations(DB, gate0Migrations)
  const send = runtime()
  const now = Date.now()
  const oldBot = crypto.randomUUID()
  const untouchedBot = crypto.randomUUID()
  const oldHuman = crypto.randomUUID()
  const untouchedHuman = crypto.randomUUID()
  for (const [id, kind, name] of [
    [oldBot, 'bot', 'reinstated-bot'],
    [untouchedBot, 'bot', 'untouched-bot'],
    [oldHuman, 'human', 'reinstated-human'],
    [untouchedHuman, 'human', 'untouched-human'],
  ]) {
    await DB.prepare(`INSERT INTO members (id, kind, name, role, status, created_at)
      VALUES (?, ?, ?, 'publisher', 'active', ?)`)
      .bind(id, kind, name, now - 3000)
      .run()
    if (kind === 'human') {
      await DB.prepare(`INSERT INTO identities (provider, subject, member_id, email_verified, last_login_at)
        VALUES ('team', ?, ?, 1, ?)`)
        .bind(name, id, now)
        .run()
    }
  }
  async function gate0Token(id: string, at: number) {
    const token = `fgt_${secret()}`
    await DB.prepare(`INSERT INTO api_tokens (id, member_id, name, prefix, token_hash, created_at)
      VALUES (?, ?, 'Gate 0 token', ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, token.slice(0, 12), await hash(token), at)
      .run()
    return token
  }
  const preRemoval = await gate0Token(oldBot, now - 2000)
  for (const id of [oldBot, oldHuman]) {
    // A Gate 0 reinstatement cleared removed_at; only the audit records historical removal.
    await DB.prepare(`INSERT INTO audit_log (id, at, action, detail_json) VALUES (?, ?, 'member.remove', ?)`)
      .bind(crypto.randomUUID(), now - 1000, JSON.stringify({ id }))
      .run()
  }
  const replacement = await gate0Token(oldBot, now)
  const unaffected = await gate0Token(untouchedBot, now)
  const replacementSession = await gate0Session(oldHuman, 'reinstated-human', now)
  const unaffectedSession = await gate0Session(untouchedHuman, 'untouched-human', now)

  await applyD1Migrations(DB, TEST_MIGRATIONS)
  expect((await mcpCall(send, preRemoval)).status).toBe(401)
  expect((await mcpCall(send, replacement)).status).toBe(401)
  expect(await whoami(send, unaffected)).toMatchObject({ id: untouchedBot })
  expect(location(await send('/', replacementSession)).pathname).toBe('/login')
  expect(await (await send('/artefacts', unaffectedSession)).text()).toContain(
    '<div class="forge-account"><span class="forge-account__name">untouched-human</span><span class="forge-account__role">publisher</span>',
  )
})
