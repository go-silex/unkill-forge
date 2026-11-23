import { createScheduledController, env } from 'cloudflare:test'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
import { putConsent, readSession } from '../src/core'
import worker from '../src/index'
import { configuredEnv, setupStorage } from './http'

setupStorage()
const { DB: db, BLOBS: bucket } = env as typeof env & Pick<Env, 'DB' | 'BLOBS'>
const now = Date.now() - 1000
const day = 86_400_000
const sessionCutoff = now - day
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
    cutoff: sessionCutoff,
    insert: `INSERT INTO sessions (id_hash, member_id, provider, subject, auth_time, created_at, validated_at, expires_at)
      SELECT n, 'member', 'team', 'subject', 0, 0, 0, ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM sessions',
    active: [sessionCutoff + 1, now + 60_000],
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
    cutoff: sessionCutoff,
    table: 'handoffs',
    insert: `INSERT INTO handoffs (code_hash, session_id_hash, state_hash, return_path, expires_at)
      SELECT n, 'active-session', 'state', '/', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM handoffs',
  },
  {
    cutoff: sessionCutoff,
    table: 'oauth_consents',
    insert: `INSERT INTO oauth_consents (token_hash, session_hash, request_url, expires_at)
      SELECT n, 'active-session', '/authorize', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM oauth_consents',
  },
  {
    cutoff: sessionCutoff,
    table: 'ui_flashes',
    insert: `INSERT INTO ui_flashes (id, session_hash, path, role, message, expires_at)
      SELECT n, 'active-session', '/', 'admin', 'notice', ? + n - 129 FROM fixture_numbers`,
    read: 'SELECT expires_at AS expiry FROM ui_flashes',
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
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = 'active-session'").bind(sessionCutoff),
    db.prepare("UPDATE invites SET expires_at = ? WHERE token_hash = 'active-invite'").bind(now),
    db
      .prepare(`INSERT INTO handoffs (code_hash, session_id_hash, state_hash, return_path, expires_at)
        SELECT n, 'active-session', 'state', '/', ? FROM fixture_numbers`)
      .bind(sessionCutoff),
    db
      .prepare(`INSERT INTO ui_flashes (id, session_hash, path, role, message, expires_at)
        SELECT n, 'active-session', '/', 'admin', 'notice', ? FROM fixture_numbers`)
      .bind(sessionCutoff),
    db
      .prepare(`INSERT INTO invite_contexts (id, browser_hash, invite_hash, expires_at)
        SELECT n, 'browser', 'active-invite', ? FROM fixture_numbers`)
      .bind(now),
  ])
  await run()
  expect(await db.prepare('SELECT count(*) AS n FROM handoffs').first('n')).toBe(3)
  expect(await db.prepare('SELECT count(*) AS n FROM ui_flashes').first('n')).toBe(3)
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

it('drives at most three purge steps per run and resumes file and blob pages after hard deletion', async () => {
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
  expect(await ids()).toEqual(['a-large', 'boundary', 'd-small', 'e-small', 'live', 'recent'])
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
  const { results: audit } = await db
    .prepare(`SELECT action, member_id, json_extract(detail_json, '$.slug') AS slug
      FROM audit_log WHERE artefact_id = 'a-large' ORDER BY rowid`)
    .all()
  expect(audit).toEqual([
    { action: 'artefact.purge_start', member_id: null, slug: 'a-large' },
    { action: 'artefact.purge', member_id: null, slug: 'a-large' },
  ])
  await run()
  expect(await ids()).toEqual(['boundary', 'live', 'recent'])
  expect(
    await db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'artefact.purge'").first('n'),
  ).toBe(5)
})

function observeD1(call: (sql: string[]) => void | Promise<void>): D1Database {
  const statements = new WeakMap<D1PreparedStatement, { sql: string; original: D1PreparedStatement }>()
  function observe(sql: string, original: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(original, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => observe(sql, target.bind(...values))
        if (key === 'all' || key === 'first' || key === 'run' || key === 'raw') {
          return async (...args: unknown[]) => {
            await call([sql])
            return Reflect.apply(target[key], target, args)
          }
        }
        return Reflect.get(target, key)
      },
    })
    statements.set(wrapped, { sql, original })
    return wrapped
  }
  return {
    prepare: (sql: string) => observe(sql, db.prepare(sql)),
    async batch(batch: D1PreparedStatement[]) {
      const entries = batch.map((statement) => {
        const entry = statements.get(statement)
        if (!entry) throw new Error('Unobserved D1 statement')
        return entry
      })
      await call(entries.map(({ sql }) => sql))
      return db.batch(entries.map(({ original }) => original))
    },
  } as D1Database
}

it('reserves the whole cron below 45 D1 calls with three worst-case purge steps', async () => {
  await db.batch([
    artefact('a', deletedCutoff - 1),
    artefact('b', deletedCutoff - 1),
    artefact('c', deletedCutoff - 1),
    db.prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at)
      SELECT id, 1, 'member', 0 FROM artefacts`),
    db.prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
      SELECT id, 1, printf('%03d', n), printf('%s%063x', id, n), 1, 'text/plain'
      FROM artefacts CROSS JOIN fixture_numbers WHERE n < 65`),
  ])
  let calls = 0
  await run({
    DB: observeD1(() => {
      calls++
    }),
  })
  expect(calls).toBe(43)
  expect(calls).toBeLessThanOrEqual(45)
  expect(await db.prepare('SELECT count(*) AS n FROM purge_candidates').first('n')).toBe(3)
  expect(await db.prepare('SELECT count(*) AS n FROM artefacts').first('n')).toBe(0)
})

it('rechecks revision heads and purge eligibility between selection and D1 batch', async () => {
  await db.batch([
    artefact('history', null, 3),
    artefact('restored', deletedCutoff - 1),
    db.prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at)
      SELECT 'history', n, 'member', 0 FROM fixture_numbers WHERE n BETWEEN 1 AND 3`),
  ])
  const seen: string[] = []
  await run({
    REVISION_RETENTION: '2',
    DB: observeD1(async (sql) => {
      if (
        sql.some((statement) =>
          statement.includes('DELETE FROM revisions WHERE artefact_id = ?1 AND number = ?2'),
        )
      ) {
        seen.push('revisions')
        await db.prepare("UPDATE artefacts SET current_revision = 1 WHERE id = 'history'").run()
      }
      if (sql.some((statement) => statement.startsWith('INSERT INTO artefact_purges'))) {
        seen.push('deleted')
        await db.prepare("UPDATE artefacts SET deleted_at = NULL WHERE id = 'restored'").run()
      }
    }),
  })
  expect(seen).toEqual(['revisions', 'deleted'])
  expect(
    await db.prepare("SELECT number FROM revisions WHERE artefact_id = 'history' AND number = 1").first(),
  ).not.toBeNull()
  expect(await db.prepare("SELECT deleted_at FROM artefacts WHERE id = 'restored'").first()).toEqual({
    deleted_at: null,
  })
  expect(await db.prepare('SELECT artefact_id FROM artefact_purges').first()).toBeNull()
})

it('keeps expired sessions for in-flight writes without still authenticating them', async () => {
  await db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = 'active-session'").bind(now).run()
  const authorized = await readSession(db, 'active-session', now - 1)
  if (!authorized) throw new Error('Session did not authorize before expiration')
  await run()
  expect(await readSession(db, authorized.idHash, now)).toBeNull()
  await putConsent(db, 'in-flight', authorized.idHash, '/authorize', now)
  expect(
    await db.prepare("SELECT token_hash FROM oauth_consents WHERE token_hash = 'in-flight'").first(),
  ).not.toBeNull()
})

it('rotates a failed purge out of the invocation without hiding the failed event', async () => {
  await db.batch([
    artefact('a-failed', deletedCutoff - 1),
    artefact('b-done', deletedCutoff - 1),
    db.prepare(`CREATE TRIGGER fail_purge BEFORE DELETE ON artefacts WHEN OLD.id = 'a-failed'
      BEGIN SELECT RAISE(ABORT, 'secret-purge-error'); END`),
  ])
  const log = vi.spyOn(console, 'error')
  try {
    await expect(run()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [new Error('purges')],
    })
    expect(log.mock.calls).toEqual([
      ['Forge maintenance incomplete', 'purges', { attempted: 2, done: 1, failed: 1 }],
    ])
  } finally {
    log.mockRestore()
  }
  expect(await db.prepare('SELECT id FROM artefacts').first('id')).toBe('a-failed')
})

it('rolls back revision deletions if the cursor write fails and retries the same page', async () => {
  await db.batch([
    artefact('history', null, 3),
    db.prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at)
      SELECT 'history', n, 'member', 0 FROM fixture_numbers WHERE n BETWEEN 1 AND 3`),
    db.prepare(`CREATE TRIGGER fail_cursor BEFORE INSERT ON maintenance_cursors
      WHEN NEW.task = 'revisions' BEGIN SELECT RAISE(ABORT, 'cursor write failed'); END`),
  ])
  const revision = db.prepare("SELECT number FROM revisions WHERE artefact_id = 'history' AND number = 1")
  const cursor = db.prepare("SELECT id FROM maintenance_cursors WHERE task = 'revisions'")
  const sweep = () => run({ REVISION_RETENTION: '2' })
  await expect(sweep()).rejects.toMatchObject({ errors: [new Error('revisions')] })
  expect(await revision.first()).not.toBeNull()
  expect(await cursor.first()).toBeNull()
  await db.prepare('DROP TRIGGER fail_cursor').run()
  await sweep()
  expect(await revision.first()).toBeNull()
  expect(await cursor.first()).not.toBeNull()
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
    await expect(run()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [new Error('login flows')],
    })
    expect(log.mock.calls).toEqual([['Forge maintenance failed', 'login flows']])
  } finally {
    log.mockRestore()
  }
  expect(await db.prepare('SELECT state_hash FROM login_flows').first('state_hash')).toBe('flow')
  expect(await db.prepare('SELECT code_hash FROM handoffs').first()).toBeNull()
  expect(await db.prepare('SELECT id FROM artefacts').first()).toBeNull()
})
