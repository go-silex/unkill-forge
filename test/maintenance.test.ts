import { createScheduledController, env } from 'cloudflare:test'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
import worker from '../src/index'
import { configuredEnv, setupStorage } from './http'

setupStorage()
const { DB: db, BLOBS: bucket } = env as typeof env & Pick<Env, 'DB' | 'BLOBS'>
const now = Date.now() - 1000
const day = 86_400_000
const revokedCutoff = now - 8 * day
const deletedCutoff = now - 30 * day
const controller = createScheduledController({ scheduledTime: now, cron: '0 3 * * *' })

function run(overrides?: Partial<Env>) {
  return worker.scheduled(controller, configuredEnv(overrides))
}

beforeEach(async () => {
  await db.batch([
    db.prepare('CREATE TABLE fixture_numbers (n INTEGER PRIMARY KEY)'),
    db.prepare(`WITH RECURSIVE numbers(n) AS (VALUES (0) UNION ALL SELECT n + 1 FROM numbers WHERE n < 130)
      INSERT INTO fixture_numbers (n) SELECT n FROM numbers`),
    db.prepare(`INSERT INTO members (id, kind, name, role, status, created_at)
      VALUES ('member', 'human', 'Member', 'admin', 'active', 0)`),
    db.prepare(`INSERT INTO identities (provider, subject, member_id, email_verified, last_login_at)
      VALUES ('team', 'subject', 'member', 1, 0)`),
    db
      .prepare(`INSERT INTO sessions
        (id_hash, member_id, provider, subject, auth_time, created_at, validated_at, expires_at, generation)
        VALUES ('active-session', 'member', 'team', 'subject', 0, 0, 0, ?, 0)`)
      .bind(now + 60_000),
    db
      .prepare(`INSERT INTO invites (token_hash, role, created_by, created_at, expires_at)
        VALUES ('active-invite', 'viewer', 'member', 0, ?)`)
      .bind(now + 60_000),
  ])
})

const expiryCases = [
  {
    table: 'login_flows',
    insert: `INSERT INTO login_flows (state_hash, browser_hash, provider, return_path, created_at, expires_at)
      SELECT n, 'browser', 'team', '/', 0, ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM login_flows',
  },
  {
    table: 'sessions',
    insert: `INSERT INTO sessions (id_hash, member_id, provider, subject, auth_time, created_at, validated_at, expires_at)
      SELECT n, 'member', 'team', 'subject', 0, 0, 0, ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM sessions',
    active: [now + 1, now + 60_000],
  },
  {
    table: 'uploads',
    insert: `INSERT INTO uploads (token_hash, upload_id, member_id, member_generation, slug, path, sha256,
      size, content_type, state, created_at, expires_at)
      SELECT n, n, 'member', 0, 'page', 'index.html', 'upload-hash', 1, 'text/html',
      CASE n % 5 WHEN 0 THEN 'pending' WHEN 1 THEN 'receiving' WHEN 2 THEN 'stored'
        WHEN 3 THEN 'consumed' ELSE 'failed' END, 0, ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM uploads',
  },
  {
    table: 'handoffs',
    insert: `INSERT INTO handoffs (code_hash, session_id_hash, state_hash, return_path, expires_at)
      SELECT n, 'active-session', 'state', '/', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM handoffs',
  },
  {
    table: 'oauth_consents',
    insert: `INSERT INTO oauth_consents (token_hash, session_hash, request_url, expires_at)
      SELECT n, 'active-session', '/authorize', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM oauth_consents',
  },
  {
    table: 'invites',
    insert: `INSERT INTO invites (token_hash, role, created_by, created_at, expires_at)
      SELECT n, 'viewer', 'member', 0, ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM invites',
    active: [now + 1, now + 60_000],
  },
  {
    table: 'invite_contexts',
    insert: `INSERT INTO invite_contexts (id, browser_hash, invite_hash, expires_at)
      SELECT n, 'browser', 'active-invite', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM invite_contexts',
  },
  {
    table: 'identity_revocations',
    cutoff: revokedCutoff,
    insert: `INSERT INTO identity_revocations (provider, jti, subject, received_at)
      SELECT 'team', n, 'subject', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT received_at AS expiry FROM identity_revocations',
  },
]

it.each(expiryCases)(
  'expires $table at the cutoff in bounded pages and leaves newer rows alone',
  async ({ insert, read, cutoff = now, active = [cutoff + 1] }) => {
    await db.prepare(insert).bind(cutoff).run()
    const remaining = async () => {
      const { results } = await db.prepare(read).all<{ expiry: number }>()
      return results.map(({ expiry }) => expiry).sort((a, b) => a - b)
    }
    await run()
    expect(await remaining()).toEqual([cutoff - 1, cutoff, ...active])
    await run()
    expect(await remaining()).toEqual(active)
    await run()
    expect(await remaining()).toEqual(active)
  },
)

it('drains child pages before deleting expired parent sessions and invites', async () => {
  await db.batch([
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = 'active-session'").bind(now),
    db.prepare("UPDATE invites SET expires_at = ? WHERE token_hash = 'active-invite'").bind(now),
    db
      .prepare(`INSERT INTO handoffs (code_hash, session_id_hash, state_hash, return_path, expires_at)
        SELECT n, 'active-session', 'state', '/', ? FROM fixture_numbers`)
      .bind(now),
    db
      .prepare(`INSERT INTO invite_contexts (id, browser_hash, invite_hash, expires_at)
        SELECT n, 'browser', 'active-invite', ? FROM fixture_numbers`)
      .bind(now),
  ])
  await run()
  expect(await db.prepare('SELECT count(*) AS n FROM handoffs').first('n')).toBe(3)
  expect(await db.prepare('SELECT count(*) AS n FROM invite_contexts').first('n')).toBe(3)
  expect(await db.prepare('SELECT id_hash FROM sessions').first('id_hash')).toBe('active-session')
  expect(await db.prepare('SELECT token_hash FROM invites').first('token_hash')).toBe('active-invite')
  await run()
  expect(await db.prepare('SELECT id_hash FROM sessions').first()).toBeNull()
  expect(await db.prepare('SELECT token_hash FROM invites').first()).toBeNull()
})

it('expires upload metadata without removing R2 objects, including verification copies', async () => {
  await db
    .prepare(`INSERT INTO uploads (token_hash, upload_id, member_id, member_generation, slug, path,
      sha256, size, content_type, state, expires_at, created_at)
      VALUES ('token', 'upload', 'member', 0, 'page', 'blob', 'upload-hash', 1, 'text/plain', 'stored', ?, 0)`)
    .bind(now)
    .run()
  await bucket.put('blobs/upload-hash', 'body')
  await bucket.put('upload-verification/upload', 'body')
  await run()
  expect(await db.prepare('SELECT upload_id FROM uploads').first()).toBeNull()
  expect(await bucket.head('blobs/upload-hash')).not.toBeNull()
  expect(await bucket.head('upload-verification/upload')).not.toBeNull()
})

function artefact(id: string, deletedAt: number | null = null, head = 1) {
  return db
    .prepare(`INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by,
      created_at, updated_at, deleted_at) VALUES (?1, ?1, ?1, 'private', ?2, 'member', 0, 0, ?3)`)
    .bind(id, head, deletedAt)
}

it('sweeps past empty revision pages, keeps the configured tail, and prunes at most two revisions per run', async () => {
  await db.batch([
    db.prepare(`INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by,
      created_at, updated_at) SELECT printf('empty-%03d', n), printf('empty-%03d', n), 'Empty',
      'private', 1, 'member', 0, 0 FROM fixture_numbers WHERE n < 128`),
    artefact('page-a', null, 4),
    artefact('page-b', null, 4),
    artefact('page-c', null, 4),
    artefact('page-deleted', now, 4),
    db.prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at)
      SELECT id, n, 'member', 0 FROM artefacts CROSS JOIN fixture_numbers
      WHERE id LIKE 'page-%' AND n BETWEEN 1 AND 4`),
    db.prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
      SELECT artefact_id, number, 'file', 'revision-hash', 1, 'text/plain' FROM revisions`),
  ])
  await bucket.put('blobs/revision-hash', 'kept')
  const rows = async () => {
    const { results } = await db
      .prepare(`SELECT artefact_id, group_concat(number ORDER BY number) AS revisions
        FROM revisions GROUP BY artefact_id ORDER BY artefact_id`)
      .all<{ revisions: string }>()
    return results.map(({ revisions }) => revisions)
  }
  const sweep = () => run({ REVISION_RETENTION: '2' })
  await sweep()
  await sweep()
  expect(await rows()).toEqual(['1,2,3,4', '1,2,3,4', '1,2,3,4', '1,2,3,4'])
  await sweep()
  expect(await rows()).toEqual(['2,3,4', '2,3,4', '1,2,3,4', '1,2,3,4'])
  for (let i = 0; i < 8; i++) await sweep()
  expect(await rows()).toEqual(['3,4', '3,4', '3,4', '1,2,3,4'])
  expect(await db.prepare('SELECT count(*) AS n FROM files').first('n')).toBe(10)
  expect(await bucket.head('blobs/revision-hash')).not.toBeNull()
})

it('drives at most four purges per run and resumes file and blob pages after hard deletion', async () => {
  const shared = '1'.padStart(64, '0')
  const exclusive = '41'.padStart(64, '0')
  const earliest = deletedCutoff - 1
  await db.batch([
    artefact('a-large', earliest),
    artefact('b-small', earliest),
    artefact('c-small', earliest),
    artefact('d-small', earliest),
    artefact('e-small', earliest),
    artefact('boundary', deletedCutoff),
    artefact('recent', deletedCutoff + 1),
    artefact('live'),
    db.prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at)
      SELECT id, 1, 'member', 0 FROM artefacts`),
    db
      .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
        VALUES ('live', 1, 'shared', ?, 1, 'text/plain')`)
      .bind(shared),
    db.prepare(`WITH RECURSIVE numbers(n) AS (VALUES (0) UNION ALL SELECT n + 1 FROM numbers WHERE n < 256)
      INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
      SELECT 'a-large', 1, printf('%03d', n), printf('%064x', 1 + n % 65), 1, 'text/plain' FROM numbers`),
  ])
  await bucket.put(`blobs/${shared}`, 'shared')
  await bucket.put(`blobs/${exclusive}`, 'exclusive')
  const ids = async () =>
    (await db.prepare('SELECT id FROM artefacts ORDER BY id').all<{ id: string }>()).results.map(
      ({ id }) => id,
    )
  await run()
  expect(await ids()).toEqual(['a-large', 'boundary', 'e-small', 'live', 'recent'])
  expect(await db.prepare("SELECT count(*) AS n FROM files WHERE artefact_id = 'a-large'").first('n')).toBe(1)
  expect(await bucket.head(`blobs/${exclusive}`)).not.toBeNull()
  await run()
  expect(await ids()).toEqual(['boundary', 'live', 'recent'])
  expect(await db.prepare('SELECT artefact_id FROM artefact_purges').first('artefact_id')).toBe('a-large')
  expect(await bucket.head(`blobs/${exclusive}`)).not.toBeNull()
  await run()
  expect(await db.prepare('SELECT artefact_id FROM artefact_purges').first()).toBeNull()
  expect(await bucket.head(`blobs/${exclusive}`)).toBeNull()
  expect(await bucket.head(`blobs/${shared}`)).not.toBeNull()
  expect(
    await db
      .prepare("SELECT member_id FROM audit_log WHERE artefact_id = 'a-large' AND action = 'artefact.purge'")
      .first(),
  ).toEqual({ member_id: null })
  await run()
  expect(await ids()).toEqual(['boundary', 'live', 'recent'])
  expect(
    await db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'artefact.purge'").first('n'),
  ).toBe(5)
})

it('continues later tasks after a failure and does not log the binding error', async () => {
  await db.batch([
    db.prepare(`INSERT INTO login_flows (state_hash, browser_hash, provider, return_path, created_at, expires_at)
      VALUES ('flow', 'browser', 'team', '/', 0, 0)`),
    db.prepare(`CREATE TRIGGER fail_expiry BEFORE DELETE ON login_flows
      BEGIN SELECT RAISE(ABORT, 'secret-binding-message'); END`),
    artefact('purge-me', deletedCutoff - 1),
    db.prepare(`INSERT INTO handoffs (code_hash, session_id_hash, state_hash, return_path, expires_at)
      VALUES ('code', 'active-session', 'state', '/', 0)`),
  ])
  const log = vi.spyOn(console, 'error')
  try {
    await run()
    expect(log.mock.calls).toEqual([['Forge maintenance failed', 'login flows']])
  } finally {
    log.mockRestore()
  }
  expect(await db.prepare('SELECT state_hash FROM login_flows').first('state_hash')).toBe('flow')
  expect(await db.prepare('SELECT code_hash FROM handoffs').first()).toBeNull()
  expect(await db.prepare('SELECT id FROM artefacts').first()).toBeNull()
})
