import { env } from 'cloudflare:test'
import { Buffer } from 'node:buffer'
import { base64url } from 'jose'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { configuration, type Env } from '../src/config'
import type { Member } from '../src/core'
import { restoreDeletedArtefact, setRedirects } from '../src/core/artefacts'
import { maintain } from '../src/core/maintenance'
import { purgeArtefact } from '../src/core/purge'
import { sealShareKey, unsealShareKey } from '../src/core/share-keys'
import {
  admin,
  configuredEnv,
  flashNavigation,
  type Handle,
  listedId,
  location,
  read,
  runtime,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()
const { DB: db, BLOBS: bucket } = env as typeof env & Pick<Env, 'DB' | 'BLOBS'>

function mcpPost(send: Handle, token: string, body: BodyInit, protocolVersion = '2025-11-25') {
  return send('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': protocolVersion,
    },
    body,
  })
}

async function rpc(send: Handle, token: string, method: string, params: object) {
  const response = await mcpPost(send, token, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  expect(response.status).toBe(200)
  const envelope = await response.json<{ result?: unknown }>()
  expect(envelope).toHaveProperty('result')
  return envelope.result
}

async function bot(send: Handle, role: 'viewer' | 'publisher' = 'publisher', name = `Artefact ${role}`) {
  const owner = await mockProvider().signedIn(send, admin)
  expect((await owner.post('/admin/bots', { action: 'create', name, role })).status).toBe(303)
  const id = await listedId(owner, '/admin/members', name)
  const response = await owner.post('/admin/bots', { action: 'token', id, name: 'Artefact token' })
  expect(response.status).toBe(303)
  const tokenPage = await owner.request(location(response), { headers: flashNavigation })
  const token = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await tokenPage.text())?.[1]
  if (!token) throw new Error('Expected a bot token')
  return {
    id,
    owner,
    token,
    async call(name: string, args: object = {}, transport = send) {
      const response = (await rpc(transport, token, 'tools/call', { name, arguments: args })) as {
        content: { type: string; text: string }[]
        isError?: boolean
      }
      expect(response.content).toEqual([{ type: 'text', text: expect.any(String) }])
      const value = JSON.parse(response.content[0].text)
      expect(response.isError ?? false).toBe(typeof value.error === 'string')
      return value
    },
  }
}

const file = (path: string, content = 'hello') => ({ path, content })

it('publishes from a bot token, discovers tool hints, and reads UTF-8 and base64 content', async () => {
  const send = runtime()
  const { token, call } = await bot(send)
  expect(await rpc(send, token, 'tools/list', {})).toMatchObject({
    tools: expect.arrayContaining(
      ['list_artefacts', 'get_artefact', 'read_file'].map((name) => ({
        name,
        annotations: { readOnlyHint: true },
        description: expect.any(String),
        inputSchema: expect.any(Object),
      })),
    ),
  })
  const slug = 'demo'
  const url = `${read}/a/demo/`
  expect(
    await call('publish', {
      slug,
      title: 'First artefact',
      mode: 'replace',
      files: [
        file('index.html', '<h1>café 💡</h1>'),
        { path: 'data.txt', content: 'aMOpbGxv', encoding: 'base64' },
      ],
    }),
  ).toEqual({ revision: 1, url })
  expect(await call('get_artefact', { slug })).toMatchObject({
    revision: 1,
    url,
    title: 'First artefact',
    visibility: 'private',
    shareLinks: [],
    files: [
      { path: 'data.txt', size: 6, type: 'text/plain; charset=utf-8' },
      { path: 'index.html', size: 19, type: 'text/html; charset=utf-8' },
    ],
  })
  expect(await call('read_file', { slug, path: 'data.txt', revision: 1 })).toMatchObject({
    revision: 1,
    text: 'héllo',
  })
  expect(await call('read_file', { slug, path: 'index.html', offset: 8, limit: 2 })).toMatchObject({
    revision: 1,
    offset: 8,
    totalLength: 15,
    text: ' 💡',
  })
  expect(await call('read_file', { slug, path: 'index.html', revision: 10 })).toMatchObject({
    error: 'not_found',
  })
})

it('merges, deletes and replaces atomically and audits the visibility change', async () => {
  const { call } = await bot(runtime())
  const slug = 'lifecycle'
  expect(
    await call('publish', { slug, mode: 'merge', files: [file('docs/a b.HTM'), file('assets/plain.txt')] }),
  ).toEqual({ revision: 1, url: `${read}/a/lifecycle/docs/a%20b.HTM` })
  expect(
    await call('publish', { slug, mode: 'merge', files: [file('index.html')], expectedRevision: 1 }),
  ).toEqual({ revision: 2, url: `${read}/a/lifecycle/` })
  expect(await call('get_artefact', { slug })).toMatchObject({
    files: [{ path: 'assets/plain.txt' }, { path: 'docs/a b.HTM' }, { path: 'index.html' }],
  })
  expect(await call('publish', { slug, mode: 'merge', files: [], delete: ['index.html'] })).toEqual({
    revision: 3,
    url: `${read}/a/lifecycle/docs/a%20b.HTM`,
  })
  expect(await call('read_file', { slug, path: 'index.html' })).toMatchObject({ error: 'not_found' })
  expect(await call('read_file', { slug, path: 'index.html', revision: 2 })).toMatchObject({ text: 'hello' })
  expect(
    await call('publish', { slug, mode: 'replace', files: [file('data.txt', '')], expectedRevision: 2 }),
  ).toMatchObject({ error: 'conflict', currentRevision: 3 })
  expect(await call('publish', { slug, mode: 'replace', files: [file('data.txt', '')] })).toEqual({
    revision: 4,
    url: `${read}/a/lifecycle/data.txt`,
  })
  expect(await call('get_artefact', { slug })).toMatchObject({ files: [{ path: 'data.txt' }] })
  expect(await call('read_file', { slug, path: 'data.txt' })).toMatchObject({ text: '', totalLength: 0 })
  expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 4, visibility: 'public' })
  const audit = await db
    .prepare(`SELECT action FROM audit_log JOIN artefacts ON artefacts.id = audit_log.artefact_id
    WHERE slug = ? ORDER BY action`)
    .bind(slug)
    .all<{ action: string }>()
  expect(audit.results.map(({ action }) => action)).toEqual([
    'artefact.publish',
    'artefact.publish',
    'artefact.publish',
    'artefact.publish',
    'artefact.visibility',
  ])
})

function withBucket(
  overrides: {
    get?: R2Bucket['get']
    put?: (
      key: string,
      bytes: Uint8Array,
      options: R2PutOptions & { onlyIf: Headers | R2Conditional },
    ) => Promise<R2Object | null>
  },
  vars: Partial<Env> = {},
) {
  return runtime({
    ...vars,
    BLOBS: {
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      ...overrides,
    } as R2Bucket,
  })
}

it.each(['new', 'merge', 'replace'] as const)(
  'resolves concurrent %s publishes without partial revisions',
  async (kind) => {
    const slug = 'race'
    const { promise, resolve } = Promise.withResolvers<void>()
    let gated = false
    let entrants = 0
    const { call } = await bot(
      withBucket({
        async put(key, bytes, options) {
          // Both calls reach storage after reading and validating the same head.
          if (gated && ++entrants <= 2) {
            if (entrants === 2) resolve()
            await promise
          }
          return bucket.put(key, bytes, options)
        },
      }),
    )
    if (kind !== 'new') {
      expect(await call('publish', { slug, mode: 'replace', files: [file('index.html')] })).toMatchObject({
        revision: 1,
      })
    }
    gated = true
    const mode = kind === 'new' ? 'merge' : kind
    const revision = kind === 'new' ? 1 : 2
    const runs = await Promise.all(
      ['alpha', 'beta'].map((name) =>
        call('publish', {
          slug,
          mode,
          files: [file(`${name}.txt`, name)],
          expectedRevision: kind === 'new' ? 0 : 1,
        }),
      ),
    )
    const winner = runs.findIndex((result) => result.revision === revision)
    expect(winner).toBeGreaterThanOrEqual(0)
    expect(runs[1 - winner]).toMatchObject({ error: 'conflict', currentRevision: revision })
    const expected = winner === 0 ? 'alpha.txt' : 'beta.txt'
    const rows = await db.prepare('SELECT revision, path FROM files ORDER BY revision, path').all()
    expect(rows.results).toEqual(
      [
        ...(kind === 'new' ? [] : [{ revision: 1, path: 'index.html' }]),
        { revision, path: expected },
        ...(kind === 'merge' ? [{ revision, path: 'index.html' }] : []),
      ].sort((left, right) => left.revision - right.revision || left.path.localeCompare(right.path)),
    )
    const revisions = await db.prepare('SELECT number FROM revisions ORDER BY number').all()
    expect(revisions.results).toEqual(kind === 'new' ? [{ number: 1 }] : [{ number: 1 }, { number: 2 }])
  },
)

it.each(['merge', 'replace'] as const)(
  'retries a concurrent %s without a caller-supplied revision',
  async (mode) => {
    const slug = 'retry'
    const { promise, resolve } = Promise.withResolvers<void>()
    let entrants = 0
    let gated = false
    const { call } = await bot(
      withBucket({
        async put(key, bytes, options) {
          if (gated && ++entrants <= 2) {
            if (entrants === 2) resolve()
            await promise
          }
          return bucket.put(key, bytes, options)
        },
      }),
    )
    await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
    gated = true
    const results = await Promise.all(
      ['first', 'second'].map((name) =>
        call('publish', {
          slug,
          mode,
          files: [file(`${name}.txt`, name)],
        }),
      ),
    )
    expect(results.map(({ revision }) => revision).sort()).toEqual([2, 3])
    const { files } = await call('get_artefact', { slug })
    expect(files.map(({ path }: { path: string }) => path)).toEqual(
      mode === 'merge'
        ? ['first.txt', 'index.html', 'second.txt']
        : [results[0].revision === 3 ? 'first.txt' : 'second.txt'],
    )
  },
)

it('edits literal matches at the expected head; rejects stale, missing, repeated, and binary edits', async () => {
  const { call } = await bot(runtime())
  const slug = 'edits'
  const edit = (args: object) =>
    call('edit_file', {
      slug,
      path: 'index.html',
      oldText: 'old',
      newText: '$& new',
      expectedRevision: 1,
      ...args,
    })
  expect(
    await call('publish', {
      slug,
      mode: 'merge',
      files: [file('index.html', 'old old end'), file('image.png')],
    }),
  ).toMatchObject({ revision: 1 })
  expect(await edit({ oldText: 'missing', replaceAll: true })).toMatchObject({
    error: 'invalid_input',
    matches: 0,
  })
  expect(await edit({})).toMatchObject({ error: 'invalid_input', matches: 2 })
  expect(await edit({ path: 'image.png' })).toMatchObject({ error: 'invalid_input' })
  expect(await edit({ replaceAll: true })).toMatchObject({ revision: 2 })
  expect(await edit({ oldText: 'end' })).toMatchObject({ error: 'conflict', currentRevision: 2 })
  expect(await edit({ expectedRevision: 2, oldText: 'end', newText: 'done' })).toMatchObject({ revision: 3 })
  expect(await call('read_file', { slug, path: 'index.html' })).toMatchObject({
    revision: 3,
    text: '$& new $& new done',
  })
})

it('refuses to apply an in-flight text edit to a replacement artefact at the same slug and revision', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  const slug = 'edit-reused'
  const input = { slug, mode: 'replace', files: [file('index.html', 'original')] }
  await call('publish', input)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const paused = withBucket({
    get: (async (key: string) => {
      const object = await bucket.get(key)
      entered.resolve()
      await resume.promise
      return object
    }) as R2Bucket['get'],
  })
  const editing = call(
    'edit_file',
    { slug, path: 'index.html', oldText: 'original', newText: 'edited', expectedRevision: 1 },
    paused,
  )
  await Promise.race([
    entered.promise,
    editing.then(() => {
      throw new Error('Edit did not pause')
    }),
  ])
  try {
    expect(await call('rename_artefact', { slug, newSlug: 'edit-moved' })).toEqual({
      url: `${read}/a/edit-moved/`,
    })
    await setRedirects(core, member, { add: [], remove: [`/a/${slug}/`, `/s/${slug}/`] })
    expect(await call('publish', { ...input, files: [file('index.html', 'replacement')] })).toMatchObject({
      revision: 1,
    })
  } finally {
    resume.resolve()
  }
  expect(await editing).toMatchObject({ error: 'conflict', currentRevision: 1 })
  expect(await call('read_file', { slug, path: 'index.html' })).toMatchObject({
    revision: 1,
    text: 'replacement',
  })
  expect(await call('read_file', { slug: 'edit-moved', path: 'index.html' })).toMatchObject({
    revision: 1,
    text: 'original',
  })
})

it('applies 10,000 literal replacements and stops counting at the first excess match', async () => {
  const { call } = await bot(runtime())
  const slug = 'many-matches'
  const edit = { slug, path: 'index.html', oldText: 'a', newText: 'b', replaceAll: true }
  const write = (count: number) =>
    call('publish', { slug, mode: 'replace', files: [file(edit.path, 'a'.repeat(count))] })
  expect(await write(10_000)).toMatchObject({ revision: 1 })
  expect(await call('edit_file', { ...edit, expectedRevision: 1 })).toMatchObject({ revision: 2 })
  expect(await call('read_file', { slug, path: edit.path })).toMatchObject({
    revision: 2,
    text: 'b'.repeat(10_000),
  })
  expect(await write(10_500)).toMatchObject({ revision: 3 })
  expect(await call('edit_file', { ...edit, expectedRevision: 3 })).toMatchObject({
    error: 'invalid_input',
    matches: 10_001,
    message: expect.stringContaining('Use publish instead'),
  })
  expect(await call('read_file', { slug, path: edit.path })).toMatchObject({
    revision: 3,
    text: 'a'.repeat(10_500),
  })
})

it('allows viewer reads but refuses every write', async () => {
  const send = runtime()
  const publisher = await bot(send)
  const viewer = await bot(send, 'viewer')
  const slug = 'private-page'
  const publish = { slug, mode: 'merge', files: [file('index.html')] }
  expect(await publisher.call('publish', publish)).toMatchObject({ revision: 1 })
  expect(await viewer.call('read_file', { slug, path: 'index.html' })).toMatchObject({ text: 'hello' })
  expect(await viewer.call('publish', publish)).toMatchObject({ error: 'forbidden' })
  expect(
    await viewer.call('edit_file', {
      slug,
      path: 'index.html',
      oldText: 'hello',
      newText: 'bye',
      expectedRevision: 1,
    }),
  ).toMatchObject({ error: 'forbidden' })
  expect(await viewer.call('set_visibility', { slug, visibility: 'public' })).toMatchObject({
    error: 'forbidden',
  })
})

it('rejects invalid slugs, paths, empty revisions, missing deletes and malformed arguments', async () => {
  const { call } = await bot(runtime())
  const invalid = { error: 'invalid_input' }
  const slug = 'valid'
  for (const badSlug of ['-start', 'UPPER', 'a/b', 'v'.repeat(65)]) {
    expect(
      await call('publish', { slug: badSlug, mode: 'replace', files: [file('index.html')] }),
    ).toMatchObject(invalid)
  }
  for (const path of [
    '/root',
    '../file',
    '.hidden',
    'path/.dot/file',
    'path//file',
    'path\\file',
    'a\0b',
    'x'.repeat(513),
  ]) {
    expect(await call('publish', { slug, mode: 'replace', files: [file(path)] })).toMatchObject(invalid)
  }
  expect(await call('publish', { slug, mode: 'replace', files: [], delete: ['missing.txt'] })).toMatchObject(
    invalid,
  )
  expect(await call('publish', { slug, mode: 'replace', files: [] })).toMatchObject(invalid)
  expect(await call('publish', { slug, mode: 'typo' })).toMatchObject(invalid)
  expect(await call('edit_file', { slug, path: 'index.html', oldText: 'one', newText: 'two' })).toMatchObject(
    invalid,
  )
  expect(await call('get_artefact', { slug })).toMatchObject({ error: 'not_found' })
})

it('enforces resulting file count and summed decoded bytes, and fails closed on invalid configuration', async () => {
  const { call } = await bot(runtime({ MAX_FILES_PER_ARTEFACT: '2', MAX_INLINE_BYTES: 5 }))
  const slug = 'limits'
  expect(
    await call('publish', { slug, mode: 'replace', files: [file('a.txt', 'é'), file('b.txt', 'abc')] }),
  ).toMatchObject({ revision: 1 })
  expect(await call('publish', { slug, mode: 'merge', files: [file('c.txt', 'c')] })).toMatchObject({
    error: 'too_large',
  })
  expect(
    await call('publish', {
      slug,
      mode: 'replace',
      files: [file('a.txt', 'éé'), { path: 'b.txt', content: 'YWI=', encoding: 'base64' }],
    }),
  ).toMatchObject({ error: 'too_large' })
  expect(
    await call('publish', {
      slug,
      mode: 'replace',
      files: [file('a.txt', 'a'), { path: 'b.txt', content: 'YWJjZA==', encoding: 'base64' }],
    }),
  ).toMatchObject({ revision: 2 })
  expect((await runtime({ BLOBS: undefined })('/')).status).toBe(503)
  expect((await runtime({ MAX_INLINE_BYTES: '1.5' })('/')).status).toBe(503)
  expect((await runtime({ MAX_FILES_PER_ARTEFACT: 0 })('/')).status).toBe(503)
  expect((await runtime({ MAX_FILES_PER_ARTEFACT: 10_001 })('/')).status).toBe(503)
  expect((await runtime({ MAX_INLINE_BYTES: 8 * 1024 * 1024 + 1 })('/')).status).toBe(503)
  expect((await runtime({ MAX_BLOB_WRITES_PER_CALL: 901 })('/')).status).toBe(503)
})

it('rejects oversized publish arrays before validating their entries or touching R2', async () => {
  const put = vi.fn(bucket.put.bind(bucket))
  const { call } = await bot(withBucket({ put }, { MAX_FILES_PER_ARTEFACT: 2 }))
  const args = { slug: 'path-limit', mode: 'merge', files: [file('first.txt')] }
  const error = { error: 'too_large' }
  const oversized = Array.from({ length: 10_001 }, () => null)
  expect(await call('publish', { ...args, files: oversized })).toMatchObject(error)
  expect(await call('publish', { ...args, delete: oversized })).toMatchObject(error)
  expect(put).not.toHaveBeenCalled()
  expect(await call('publish', { ...args, files: [file('first.txt'), file('second.txt')] })).toMatchObject({
    revision: 1,
  })
  expect(await call('publish', { ...args, files: [file('third.txt')] })).toMatchObject(error)
  expect(await call('get_artefact', { slug: args.slug })).toMatchObject({
    revision: 1,
    files: [{ path: 'first.txt' }, { path: 'second.txt' }],
  })
})

it('can delete more paths than the lowered artefact limit to bring the head within it', async () => {
  const { call } = await bot(runtime())
  const slug = 'lowered-limit'
  const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
  expect(
    await call('publish', { slug, mode: 'replace', files: paths.map((path) => file(path)) }),
  ).toMatchObject({
    revision: 1,
  })
  const lower = runtime({ MAX_FILES_PER_ARTEFACT: 1 })
  expect(
    await call(
      'publish',
      { slug, mode: 'merge', files: [], delete: paths.slice(1), expectedRevision: 1 },
      lower,
    ),
  ).toMatchObject({ revision: 2 })
  expect(await call('get_artefact', { slug }, lower)).toMatchObject({
    revision: 2,
    files: [{ path: 'a.txt' }],
  })
})

it('publishes 500 distinct small files with exactly 500 real R2 puts', async () => {
  const put = vi.fn(bucket.put.bind(bucket))
  const { call } = await bot(withBucket({ put }))
  const slug = 'full-call'
  const files = Array.from({ length: 500 }, (_, index) => file(`${index}.txt`, `content ${index}`))
  expect(await call('publish', { slug, mode: 'replace', files })).toMatchObject({ revision: 1 })
  expect(put).toHaveBeenCalledTimes(500)
  expect(await call('read_file', { slug, path: '499.txt' })).toMatchObject({ text: 'content 499' })
}, 30_000)

it('rejects excess new blobs without PUTs but atomically replaces 501 files with reused content', async () => {
  const put = vi.fn(bucket.put.bind(bucket))
  const { call } = await bot(withBucket({ put }, { MAX_BLOB_WRITES_PER_CALL: 2 }))
  const slug = 'reuse'
  const files = Array.from({ length: 500 }, (_, index) => file(`${index}.txt`, 'reused'))
  expect(await call('publish', { slug, mode: 'replace', files })).toMatchObject({ revision: 1 })
  expect(put).toHaveBeenCalledTimes(1)
  put.mockClear()
  const tooMany = {
    slug,
    mode: 'replace',
    expectedRevision: 1,
    files: ['new one', 'new two', 'new three'].map((content, index) => file(`${index}.txt`, content)),
  }
  expect(await call('publish', tooMany)).toMatchObject({
    error: 'too_large',
    message: expect.stringContaining('split into several merge publishes'),
  })
  expect(put).not.toHaveBeenCalled()
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1 })
  const replacement = [...files.slice(0, 499), file('left.txt', 'new left'), file('right.txt', 'new right')]
  expect(
    await call('publish', { slug, mode: 'replace', expectedRevision: 1, files: replacement }),
  ).toMatchObject({
    revision: 2,
  })
  expect(put).toHaveBeenCalledTimes(2)
  expect(await call('read_file', { slug, path: '499.txt' })).toMatchObject({ error: 'not_found' })
  expect(await call('read_file', { slug, path: '498.txt' })).toMatchObject({
    revision: 2,
    text: 'reused',
  })
  expect(await call('read_file', { slug, path: 'right.txt' })).toMatchObject({
    revision: 2,
    text: 'new right',
  })
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM files WHERE revision = 2')
    .first<number>('count')
  expect(count).toBe(501)
})

it('rejects wide and deep JSON below the byte limit without counting syntax inside strings', async () => {
  const send = runtime({ MAX_INLINE_BYTES: 1000 })
  const { token, call } = await bot(send)
  let nested: unknown = null
  for (let i = 0; i < 33; i++) nested = [nested]
  for (const value of [Array.from({ length: 64_001 }, () => ({})), Array(64_001).fill(0), nested]) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: { value } },
    })
    expect(body.length).toBeLessThan(512 * 1024)
    const response = await mcpPost(send, token, body)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { data: { error: 'too_large' } },
    })
  }
  const slug = 'quoted-delimiters'
  const path = 'text.txt'
  const text = JSON.stringify([String.fromCharCode(34, 92), '['.repeat(100)])
  expect(await call('publish', { slug, mode: 'replace', files: [file(path, text)] })).toMatchObject({
    revision: 1,
  })
  expect(await call('read_file', { slug, path })).toMatchObject({ text })
})

it('negotiates a non-batching protocol, rejects batches, and bounds JSON-RPC envelopes', async () => {
  const send = runtime({ MAX_INLINE_BYTES: 32 })
  const { token, call } = await bot(send)
  const initialize = await mcpPost(
    send,
    token,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
    '2025-03-26',
  )
  expect(initialize.status).toBe(200)
  const { result } = await initialize.json<{ result: { protocolVersion: string } }>()
  expect(result.protocolVersion >= '2025-06-18').toBe(true)
  const slug = 'no-batch'
  const publish = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'publish', arguments: { slug, mode: 'merge', files: [file('index.html')] } },
  }
  const batch = await mcpPost(send, token, JSON.stringify([publish, { ...publish, id: 2 }]))
  expect(batch.status).toBe(400)
  expect(await batch.json()).toMatchObject({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, data: { error: 'invalid_request' } },
  })
  const bytes = 43 + 512 * 1024 // ceil(32 * 4/3) plus the transport headroom.
  const whoami = JSON.stringify({ ...publish, params: { name: 'whoami' } })
  expect((await mcpPost(send, token, whoami.padEnd(bytes))).status).toBe(200)
  const oversized = await mcpPost(send, token, JSON.stringify(publish).padEnd(bytes + 1))
  expect(oversized.status).toBe(413)
  expect(await oversized.json()).toMatchObject({
    jsonrpc: '2.0',
    id: null,
    error: { data: { error: 'too_large' } },
  })
  expect(await call('get_artefact', { slug })).toMatchObject({ error: 'not_found' })
})

it('enforces metadata lengths and rejects lone surrogates in publish and edit text', async () => {
  const { call } = await bot(runtime())
  const slug = 'input-bounds'
  const args = { slug, mode: 'replace', files: [file('index.html')] }
  const invalid = { error: 'invalid_input' }
  const loneHigh = String.fromCharCode(0xd800)
  const loneLow = String.fromCharCode(0xdc00)
  expect(await call('publish', { ...args, title: 't'.repeat(201) })).toMatchObject(invalid)
  expect(await call('publish', { ...args, message: 'm'.repeat(1_001) })).toMatchObject(invalid)
  expect(await call('list_artefacts', { query: 'q'.repeat(201) })).toMatchObject(invalid)
  expect(await call('publish', { ...args, files: [file('index.html', `broken${loneHigh}`)] })).toMatchObject(
    invalid,
  )
  const title = 't'.repeat(200)
  expect(await call('publish', { ...args, title, message: 'm'.repeat(1_000) })).toMatchObject({ revision: 1 })
  expect(await call('list_artefacts', { query: title })).toMatchObject({ artefacts: [{ slug }] })
  const edit = { slug, path: 'index.html', expectedRevision: 1, oldText: 'hello', newText: 'bye' }
  expect(await call('edit_file', { ...edit, oldText: loneLow })).toMatchObject(invalid)
  expect(await call('edit_file', { ...edit, newText: loneHigh })).toMatchObject(invalid)
  expect(await call('read_file', { slug, path: 'index.html' })).toMatchObject({ revision: 1, text: 'hello' })
})

it('refuses edits to an existing file above the configured inline byte limit', async () => {
  const { call } = await bot(runtime())
  const slug = 'edit-too-large'
  expect(await call('publish', { slug, mode: 'merge', files: [file('index.html', 'ééé')] })).toMatchObject({
    revision: 1,
  })
  const edit = { slug, path: 'index.html', oldText: 'ééé', newText: 'ok', expectedRevision: 1 }
  expect(await call('edit_file', edit, runtime({ MAX_INLINE_BYTES: 5 }))).toMatchObject({
    error: 'too_large',
  })
  expect(await call('read_file', { slug, path: 'index.html' })).toMatchObject({ revision: 1, text: 'ééé' })
})

it('a conditional put refuses the second concurrent write of the same new hash', async () => {
  const bothReached = Promise.withResolvers<void>()
  const firstStored = Promise.withResolvers<void>()
  let entrants = 0
  let blobKey: string | undefined
  const outcomes: (R2Object | null)[] = []
  const { call } = await bot(
    withBucket({
      async put(key, bytes, options) {
        const writer = ++entrants
        if (writer === 1) await bothReached.promise
        else {
          bothReached.resolve()
          await firstStored.promise
        }
        try {
          const result = await bucket.put(key, bytes, {
            ...options,
            customMetadata: { writer: String(writer) },
          })
          outcomes.push(result)
          blobKey = key
          return result
        } finally {
          if (writer === 1) firstStored.resolve()
        }
      },
    }),
  )
  const results = await Promise.all(
    ['one', 'two'].map((slug) =>
      call('publish', {
        slug,
        mode: 'replace',
        expectedRevision: 0,
        files: [file('same.txt', 'same new blob')],
      }),
    ),
  )
  expect(results.map(({ revision }) => revision)).toEqual([1, 1])
  expect(outcomes).toEqual([expect.objectContaining({ customMetadata: { writer: '1' } }), null])
  expect((await bucket.head(blobKey ?? 'unexpected'))?.customMetadata).toEqual({ writer: '1' })
})

it('reuses unchanged content without a second R2 put, with the SHA-256 checksum preserved', async () => {
  const put = vi.fn(bucket.put.bind(bucket))
  const { call } = await bot(withBucket({ put }))
  const slug = 'dedup'
  expect(await call('publish', { slug, mode: 'merge', files: [file('index.html')] })).toMatchObject({
    revision: 1,
  })
  expect(await call('publish', { slug, mode: 'merge', files: [file('same.txt')] })).toMatchObject({
    revision: 2,
  })
  expect(await call('publish', { slug, mode: 'replace', files: [file('index.html')] })).toMatchObject({
    revision: 3,
  })
  expect(put).toHaveBeenCalledTimes(1)
  const key = 'blobs/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  const object = await bucket.head(key)
  expect(object?.checksums.toJSON().sha256).toBe(key.slice(6))
})

it('returns metadata for binary, non-UTF-8 and oversized text and caps text slices', async () => {
  const { call } = await bot(runtime())
  const slug = 'byte-types'
  expect(
    await call('publish', {
      slug,
      mode: 'replace',
      files: [
        { path: 'image.png', content: '/w==', encoding: 'base64' },
        { path: 'bad.txt', content: '/w==', encoding: 'base64' },
        file('large.txt'),
        file('slice.txt', 'x'.repeat(100_001)),
      ],
    }),
  ).toMatchObject({ revision: 1 })
  // Model a large upload in D1/R2; it is above the inline cap.
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1).fill(120)
  const checksum = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('')
  await bucket.put(`blobs/${sha256}`, bytes, { sha256: checksum })
  await db
    .prepare('UPDATE files SET sha256 = ?, size = ? WHERE path = ?')
    .bind(sha256, bytes.length, 'large.txt')
    .run()
  expect(await call('read_file', { slug, path: 'image.png' })).toEqual({
    path: 'image.png',
    revision: 1,
    size: 1,
    type: 'image/png',
    reason: 'binary',
  })
  expect(await call('read_file', { slug, path: 'bad.txt' })).toMatchObject({ reason: 'non_utf8' })
  const large = await call('read_file', { slug, path: 'large.txt' })
  expect(large).toMatchObject({ reason: 'text_too_large' })
  expect(large).not.toHaveProperty('text')
  expect((await call('read_file', { slug, path: 'slice.txt' })).text).toHaveLength(40_000)
  expect((await call('read_file', { slug, path: 'slice.txt', limit: 100_001 })).text).toHaveLength(100_000)
})

it('pages 50 artefacts and 200 files without gaps, with literal search and revision-bound cursors', async () => {
  const { call } = await bot(runtime())
  const slug = 'page-00'
  const inputs = Array.from({ length: 202 }, (_, index) => file(`${String(index).padStart(3, '0')}.txt`))
  expect(
    await call('publish', { slug, title: 'Literal a%_! marker', mode: 'replace', files: inputs }),
  ).toMatchObject({ revision: 1 })
  for (let i = 1; i <= 50; i++) {
    const slug = `page-${String(i).padStart(2, '0')}`
    expect(await call('publish', { slug, mode: 'merge', files: [file('index.html')] })).toMatchObject({
      revision: 1,
    })
  }
  const first = await call('list_artefacts', { query: 'page-' })
  expect(first.artefacts).toHaveLength(50)
  const second = await call('list_artefacts', { query: 'page-', cursor: first.nextCursor })
  expect(second.artefacts).toHaveLength(1)
  expect(new Set([...first.artefacts, ...second.artefacts].map((row) => row.slug)).size).toBe(51)
  expect(second.nextCursor).toBeUndefined()
  expect((await call('list_artefacts', { query: '%_!' })).artefacts).toMatchObject([{ slug }])
  const page = await call('get_artefact', { slug })
  expect(page.files).toHaveLength(200)
  expect(await call('get_artefact', { slug, cursor: page.nextCursor })).toMatchObject({
    url: `${read}/a/page-00/000.txt`,
    files: [{ path: '200.txt' }, { path: '201.txt' }],
  })
  expect(await call('publish', { slug, mode: 'merge', files: [file('index.html')] })).toMatchObject({
    revision: 2,
  })
  expect(await call('get_artefact', { slug, cursor: page.nextCursor })).toMatchObject({
    error: 'conflict',
    currentRevision: 2,
  })
})

const uploadHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const textUpload = { path: 'body.txt', size: 5, sha256: uploadHash }

async function uploadUrl(
  call: (name: string, args: object) => Promise<unknown>,
  slug: string,
  file: typeof textUpload & { contentType?: string } = textUpload,
) {
  const response = await call('create_uploads', { slug, files: [file] })
  const { files } = z
    .object({
      files: z.tuple([z.object({ path: z.literal(file.path), url: z.url(), uploadId: z.uuid() })]),
    })
    .parse(response)
  return files[0]
}

function putUpload(
  send: Handle,
  url: string,
  body: BodyInit = 'hello',
  length: number | string = 5,
  origin?: string,
) {
  const headers = new Headers({ 'content-length': String(length), 'content-type': 'image/png' })
  if (origin) headers.set('origin', origin)
  return send(url, { method: 'PUT', headers, body })
}

it('finishes an in-flight PUT after maintenance crosses its original capability cutoff', async () => {
  const { call } = await bot(runtime())
  const { core } = await coreAdmin()
  const slug = 'receiving-cleanup-race'
  const { path, url, uploadId } = await uploadUrl(call, slug)
  const receipt = db.prepare('SELECT expires_at FROM uploads WHERE upload_id = ?').bind(uploadId)
  const originalExpiry = await receipt.first<number>('expires_at')
  if (originalExpiry === null) throw new Error('Missing capability expiry')
  const receiving = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const send = runtime({
    BLOBS: {
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      async head(key: string) {
        const existing = await bucket.head(key)
        receiving.resolve()
        await resume.promise
        return existing
      },
    } as R2Bucket,
  })
  const storing = putUpload(send, url)
  try {
    await Promise.race([
      receiving.promise,
      storing.then((response) => {
        throw new Error(`PUT did not begin streaming: ${response.status}`)
      }),
    ])
    await maintain(core, originalExpiry)
    expect(await receipt.first<number>('expires_at')).toBeGreaterThan(originalExpiry)
  } finally {
    resume.resolve()
  }
  expect((await storing).status).toBe(204)
  expect(await call('publish', { slug, mode: 'replace', files: [{ path, uploadId }] })).toMatchObject({
    revision: 1,
  })
})

it('claims an upload atomically, refuses replay, and serves no cross-origin allowances', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { url, uploadId, path } = await uploadUrl(call, 'capability')
  expect(new URL(url).pathname.endsWith(uploadId)).toBe(false)
  expect((await putUpload(send, url, 'hello', 5, read)).status).toBe(403)
  const preflight = await send(url, { method: 'OPTIONS', headers: { origin: 'https://example.test' } })
  expect(preflight.status).toBe(405)
  expect(preflight.headers.has('access-control-allow-origin')).toBe(false)
  const concurrent = await Promise.all([
    putUpload(send, url, 'hello', '0005', 'https://example.test'),
    putUpload(send, url, 'hello', '0005'),
  ])
  expect(concurrent.map(({ status }) => status).sort()).toEqual([204, 404])
  for (const response of concurrent) {
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(await response.text()).toBe('')
  }
  expect((await putUpload(send, url)).status).toBe(404)
  expect(
    await call('publish', { slug: 'capability', mode: 'replace', files: [{ path, uploadId }] }),
  ).toMatchObject({
    revision: 1,
  })
})

it('refuses a demoted, removed, or reinstated issuer even with the original capability', async () => {
  const send = runtime()
  const { id, owner, call } = await bot(send)
  const { url } = await uploadUrl(call, 'upload-revocation')
  const members = '/admin/members'
  expect((await owner.post(members, { id, action: 'role', role: 'viewer' })).status).toBe(303)
  expect((await putUpload(send, url)).status).toBe(404)
  expect((await owner.post(members, { id, action: 'role', role: 'publisher' })).status).toBe(303)
  expect((await owner.post(members, { id, action: 'remove' })).status).toBe(303)
  expect((await putUpload(send, url)).status).toBe(404)
  expect((await owner.post(members, { id, action: 'reinstate', role: 'publisher' })).status).toBe(303)
  expect((await putUpload(send, url)).status).toBe(404)
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
})

it('refuses to issue uploads if the credential generation changes while reading the MCP body', async () => {
  const send = runtime()
  const { id, owner, token } = await bot(send)
  const reading = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve()
        await resume.promise
        const params = {
          name: 'create_uploads',
          arguments: { slug: 'stale-credential', files: [textUpload] },
        }
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params })),
        )
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const pending = mcpPost(send, token, body)
  await Promise.race([
    reading.promise,
    pending.then(() => {
      throw new Error('MCP completed before reading its body')
    }),
  ])
  try {
    const members = '/admin/members'
    expect((await owner.post(members, { id, action: 'remove' })).status).toBe(303)
    expect((await owner.post(members, { id, action: 'reinstate', role: 'publisher' })).status).toBe(303)
  } finally {
    resume.resolve()
  }
  const result = await (await pending).json<{ result: { isError: boolean; content: { text: string }[] } }>()
  expect(result.result.isError).toBe(true)
  expect(JSON.parse(result.result.content[0].text)).toMatchObject({ error: 'forbidden' })
  const uploads = await db
    .prepare('SELECT count(*) AS n FROM uploads WHERE member_id = ?')
    .bind(id)
    .first('n')
  expect(uploads).toBe(0)
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'upload.issue' AND member_id = ?")
      .bind(id)
      .first('n'),
  ).toBe(0)
})

it('audits each issued upload and successful store without revealing capabilities', async () => {
  const send = runtime()
  const { call, id } = await bot(send)
  const slug = 'audited-uploads'
  const declarations = [textUpload, { ...textUpload, path: 'other.txt' }]
  const { files } = await call('create_uploads', { slug, files: declarations })
  expect((await putUpload(send, files[0].url)).status).toBe(204)
  expect((await putUpload(send, files[1].url, 'world')).status).toBe(422)
  const { results } = await db
    .prepare(`SELECT action, member_id AS memberId, detail_json AS detail FROM audit_log
      WHERE action IN ('upload.issue', 'upload.store') ORDER BY action, json_extract(detail_json, '$.path')`)
    .all<{ action: string; memberId: string; detail: string }>()
  expect(
    results.map(({ action, memberId, detail }) => ({ action, memberId, detail: JSON.parse(detail) })),
  ).toEqual([
    { action: 'upload.issue', memberId: id, detail: { slug, ...declarations[0] } },
    { action: 'upload.issue', memberId: id, detail: { slug, ...declarations[1] } },
    { action: 'upload.store', memberId: id, detail: { slug, ...declarations[0] } },
  ])
})

it('burns failed capabilities without storing an object on length or checksum mismatch', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'bad-upload'
  const short = await uploadUrl(call, slug)
  expect((await putUpload(send, short.url, 'no', 2)).status).toBe(400)
  expect((await putUpload(send, short.url)).status).toBe(404)
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()

  const corrupt = await uploadUrl(call, slug)
  expect((await putUpload(send, corrupt.url, 'world')).status).toBe(422)
  expect((await putUpload(send, corrupt.url)).status).toBe(404)
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  expect(
    await call('publish', {
      slug,
      mode: 'replace',
      files: [{ path: corrupt.path, uploadId: corrupt.uploadId }],
    }),
  ).toMatchObject({ error: 'not_found' })
})

it.each([4, 6])(
  'refuses a five-byte stream with a matching declared length and header of %s',
  async (size) => {
    const send = runtime()
    const { call } = await bot(send)
    const slug = 'wrong-stream-length'
    const { url } = await uploadUrl(call, slug, { ...textUpload, size })
    expect((await putUpload(send, url, 'hello', size)).status).toBe(400)
    expect((await putUpload(send, url, 'hello', size)).status).toBe(404)
    expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  },
)

it('does not store a matching hash prefix followed by a trailing chunk', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { url } = await uploadUrl(call, 'trailing-upload-chunk')
  const stream = new FixedLengthStream(6)
  const writing = (async () => {
    const writer = stream.writable.getWriter()
    try {
      await writer.write(new TextEncoder().encode('hello'))
      await writer.write(new Uint8Array([33]))
      await writer.close()
    } catch {
      // The worker may cancel the source when rejecting the upload.
    }
  })()
  const [response] = await Promise.all([putUpload(send, url, stream.readable, 5), writing])
  expect(response.status).toBe(400)
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
})

it('binds uploads to member, slug and path and consumes only on a committing publish', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const other = await bot(send, 'publisher', 'Other publisher')
  const slug = 'upload-publish'
  expect(
    await call('publish', { slug, mode: 'replace', files: [file('index.html', '<h1>head</h1>')] }),
  ).toMatchObject({
    revision: 1,
  })
  const { path, url, uploadId } = await uploadUrl(call, slug)
  const reference = { path, uploadId }
  const input = { slug, mode: 'merge', files: [reference] }
  expect(await call('publish', input)).toMatchObject({ error: 'not_found' })
  expect((await putUpload(send, url)).status).toBe(204)
  expect(await other.call('publish', input)).toMatchObject({ error: 'not_found' })
  expect(await call('publish', { ...input, slug: 'not-the-same-slug' })).toMatchObject({ error: 'not_found' })
  const wrongPath = { ...reference, path: 'elsewhere.txt' }
  expect(await call('publish', { ...input, files: [wrongPath] })).toMatchObject({ error: 'not_found' })
  expect(await call('publish', { ...input, expectedRevision: 0 })).toMatchObject({
    error: 'conflict',
    currentRevision: 1,
  })
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1, files: [{ path: 'index.html' }] })
  expect(await call('publish', { ...input, expectedRevision: 1 })).toMatchObject({ revision: 2 })
  expect(await call('publish', input)).toMatchObject({ error: 'not_found' })
  const { files } = await call('create_uploads', {
    slug,
    files: [
      { ...textUpload, path: 'race-a.txt' },
      { ...textUpload, path: 'race-b.txt' },
    ],
  })
  const raced = await Promise.all(
    files.map(({ path, uploadId }: { path: string; uploadId: string }) =>
      call('publish', { slug, mode: 'merge', files: [{ path, uploadId }], expectedRevision: 2 }),
    ),
  )
  expect(raced).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ revision: 3 }),
      expect.objectContaining({ error: 'conflict', currentRevision: 3 }),
    ]),
  )
  const { path: loserPath, uploadId: loserId } = files[raced[0].error ? 0 : 1]
  expect(
    await call('publish', {
      slug,
      mode: 'merge',
      files: [{ path: loserPath, uploadId: loserId }],
      expectedRevision: 3,
    }),
  ).toMatchObject({ revision: 4 })
  expect(await call('read_file', { slug, path })).toMatchObject({ revision: 4, text: 'hello' })
})

it('rolls back the revision and head if consuming its upload fails in D1', async () => {
  const send = runtime()
  const { call, token } = await bot(send)
  const slug = 'upload-rollback'
  expect(
    await call('publish', { slug, mode: 'replace', files: [file('index.html', 'original')] }),
  ).toMatchObject({ revision: 1 })
  const { path, url, uploadId } = await uploadUrl(call, slug)
  expect((await putUpload(send, url)).status).toBe(204)
  await db
    .prepare(`CREATE TRIGGER reject_consumption BEFORE UPDATE OF state ON uploads
    WHEN NEW.state = 'consumed' BEGIN SELECT RAISE(ABORT, 'test: consumption blocked'); END`)
    .run()
  const input = { slug, mode: 'merge', expectedRevision: 1, files: [{ path, uploadId }] }
  const result = await mcpPost(
    send,
    token,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'publish', arguments: input },
    }),
  )
  expect(await result.json()).toMatchObject({ error: { code: -32603 } })
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1, files: [{ path: 'index.html' }] })
  const { results } = await db
    .prepare('SELECT number FROM revisions JOIN artefacts ON id = artefact_id WHERE slug = ?')
    .bind(slug)
    .all()
  expect(results).toEqual([{ number: 1 }])
  expect(
    await db.prepare('SELECT state FROM uploads WHERE upload_id = ?').bind(uploadId).first('state'),
  ).toBe('stored')
  await db.prepare('DROP TRIGGER reject_consumption').run()
  expect(await call('publish', input)).toMatchObject({ revision: 2 })
})

it('allows only one concurrent publish to consume the same upload ID', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'upload-consumption-race'
  expect(
    await call('publish', { slug, mode: 'replace', files: [file('index.html', 'original')] }),
  ).toMatchObject({ revision: 1 })
  const { path, url, uploadId } = await uploadUrl(call, slug)
  expect((await putUpload(send, url)).status).toBe(204)
  const input = { slug, mode: 'merge', files: [{ path, uploadId }] }
  const results = await Promise.all([call('publish', input), call('publish', input)])
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ revision: 2 }),
      expect.objectContaining({ error: 'not_found' }),
    ]),
  )
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 2 })
  expect(
    await db.prepare('SELECT state FROM uploads WHERE upload_id = ?').bind(uploadId).first('state'),
  ).toBe('consumed')
})

it('refuses expired capabilities and stored IDs after their respective deadlines', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'upload-expiry'
  const expired = await uploadUrl(call, slug)
  const expire = db.prepare('UPDATE uploads SET expires_at = 0 WHERE upload_id = ?')
  await expire.bind(expired.uploadId).run()
  expect((await putUpload(send, expired.url)).status).toBe(404)
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  const { path, url, uploadId } = await uploadUrl(call, slug)
  expect((await putUpload(send, url)).status).toBe(204)
  await expire.bind(uploadId).run()
  expect(await call('publish', { slug, mode: 'replace', files: [{ path, uploadId }] })).toMatchObject({
    error: 'not_found',
  })
})

it('rejects oversized upload requests and forbids viewers from minting capabilities', async () => {
  const send = runtime({ MAX_UPLOAD_BYTES: '4', MAX_BLOB_WRITES_PER_CALL: '1' })
  const { call } = await bot(send)
  const viewer = await bot(send, 'viewer')
  const slug = 'upload-limits'
  expect(await call('create_uploads', { slug, files: [textUpload] })).toMatchObject({ error: 'too_large' })
  const small = { ...textUpload, size: 4 }
  expect(await call('create_uploads', { slug, files: [small, { ...small, path: 'second' }] })).toMatchObject({
    error: 'too_large',
  })
  expect(await viewer.call('create_uploads', { slug, files: [small] })).toMatchObject({ error: 'forbidden' })
})

it('publishes an already-referenced hash without a PUT and verifies the declared size', async () => {
  const send = runtime()
  const { call } = await bot(send)
  expect(
    await call('publish', { slug: 'source', mode: 'replace', files: [file('first.txt')] }),
  ).toMatchObject({
    revision: 1,
  })
  const slug = 'dedup-upload'
  expect(await call('create_uploads', { slug, files: [{ ...textUpload, size: 4 }] })).toMatchObject({
    error: 'invalid_input',
  })
  const { files } = await call('create_uploads', { slug, files: [textUpload] })
  expect(files).toEqual([{ path: 'body.txt', uploadId: expect.any(String), alreadyStored: true }])
  const { path, uploadId } = files[0]
  expect(await call('publish', { slug, mode: 'replace', files: [{ path, uploadId }] })).toMatchObject({
    revision: 1,
  })
  expect(await call('read_file', { slug, path })).toMatchObject({ text: 'hello' })
})

it('verifies each PUT body before reusing an orphaned R2 object without overwriting it', async () => {
  const orphan = await bucket.put(`blobs/${uploadHash}`, 'hello', { sha256: uploadHash })
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'orphan-upload'
  const corrupt = await uploadUrl(call, slug)
  expect((await putUpload(send, corrupt.url, 'world')).status).toBe(422)
  expect((await putUpload(send, corrupt.url)).status).toBe(404)
  const { path, url, uploadId } = await uploadUrl(call, slug)
  expect((await putUpload(send, url)).status).toBe(204)
  expect(await call('publish', { slug, mode: 'replace', files: [{ path, uploadId }] })).toMatchObject({
    revision: 1,
  })
  expect(await call('read_file', { slug, path })).toMatchObject({ text: 'hello' })
  expect((await bucket.head(`blobs/${uploadHash}`))?.version).toBe(orphan.version)
  expect((await bucket.list({ prefix: 'upload-verification/' })).objects).toEqual([])
})

it.each([
  ['text/plain', '; charset=iso-8859-1', 'hello'],
  ['text/plain', '', 'hello'],
  ['application/xml', '; charset=iso-8859-1', '<example>hello</example>'],
])('serves edited %s with a corrected or added charset (%s)', async (baseType, charset, body) => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'uploaded-media-type'
  const mediaType = `${baseType}; note="keep; charset=quoted"`
  const bytes = new TextEncoder().encode(body)
  const { path, url, uploadId } = await uploadUrl(call, slug, {
    size: bytes.length,
    sha256: Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'),
    path: 'page.bin',
    contentType: mediaType + charset,
  })
  expect((await putUpload(send, url, body, bytes.length)).status).toBe(204)
  const input = { slug, mode: 'replace', files: [{ path, uploadId }] }
  expect(await call('publish', input)).toMatchObject({ revision: 1 })
  expect(
    await call('edit_file', { slug, path, oldText: 'hello', newText: 'café', expectedRevision: 1 }),
  ).toMatchObject({ revision: 2 })
  const type = `${mediaType}; charset=utf-8`
  const edited = body.replace('hello', 'café')
  expect(await call('read_file', { slug, path })).toMatchObject({ text: edited, type })
  expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
  const response = await send(`${read}/a/${slug}/${path}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe(type)
  expect(await response.text()).toBe(edited)
})

it.each(['text/html', 'Text/HTML ; charset="utf-8"; title="test; value"'])(
  'persists uploaded %s as the revision entry and serves it in MCP and the public index',
  async (contentType) => {
    const send = runtime({ PUBLIC_INDEX: 'true' })
    const { call } = await bot(send)
    const slug = 'html-entry'
    const { path, uploadId, url } = await uploadUrl(call, slug, { ...textUpload, path: 'z.bin', contentType })
    expect((await putUpload(send, url)).status).toBe(204)
    const files = [file('a.txt', 'fallback'), { path, uploadId }]
    expect(await call('publish', { slug, mode: 'replace', files })).toMatchObject({
      url: `${read}/a/${slug}/${path}`,
    })
    const persisted = await db
      .prepare(
        `SELECT r.entry_path FROM artefacts a JOIN revisions r
        ON r.artefact_id = a.id AND r.number = a.current_revision WHERE a.slug = ?`,
      )
      .bind(slug)
      .first<string>('entry_path')
    expect(persisted).toBe(path)
    expect(await call('get_artefact', { slug })).toMatchObject({ url: `${read}/a/${slug}/${path}` })
    expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
    expect(await (await send(`${read}/`)).text()).toContain(`href="${read}/a/${slug}/${path}"`)
  },
)

it('refuses malformed or oversized upload media types', async () => {
  const { call } = await bot(runtime())
  for (const contentType of [
    'html',
    'text/html; bare',
    'text/html; bad=a,b',
    'text/html;\r\nx=y',
    `text/${'x'.repeat(251)}`,
  ]) {
    expect(
      await call('create_uploads', { slug: 'invalid-media', files: [{ ...textUpload, contentType }] }),
    ).toMatchObject({ error: 'invalid_input' })
  }
})

it('streams a multi-MB binary upload and reads its tail through the read host', async () => {
  const send = runtime({ MAX_INLINE_BYTES: '16', MAX_BLOB_WRITES_PER_CALL: '1' })
  const { call } = await bot(send)
  const slug = 'binary-upload'
  const chunk = new Uint8Array(64 * 1024)
  chunk.set([7, 0, 42, 199], chunk.length - 4)
  const chunks = 72
  const size = chunks * chunk.length
  const hash = new crypto.DigestStream('SHA-256')
  const hashing = hash.getWriter()
  for (let i = 0; i < chunks; i++) await hashing.write(chunk)
  await hashing.close()
  const sha256 = Buffer.from(await hash.digest).toString('hex')
  const input = { path: 'payload.bin', size, sha256, contentType: 'application/x-forge-test' }
  const { path, url, uploadId } = await uploadUrl(call, slug, input)
  const stream = new FixedLengthStream(size)
  const writing = (async () => {
    const writer = stream.writable.getWriter()
    for (let i = 0; i < chunks; i++) await writer.write(chunk)
    await writer.close()
  })()
  const [response] = await Promise.all([putUpload(send, url, stream.readable, size), writing])
  expect(response.status).toBe(204)
  expect(
    await call('publish', { slug, mode: 'replace', files: [{ path, uploadId }, file('index.html')] }),
  ).toMatchObject({ revision: 1 })
  expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
  const range = await send(`${read}/a/${slug}/${path}`, { headers: { range: 'bytes=-4' } })
  expect(range.status).toBe(206)
  expect(range.headers.get('content-range')).toBe(`bytes ${size - 4}-${size - 1}/${size}`)
  expect(range.headers.get('content-type')).toBe('application/x-forge-test')
  expect(Array.from(new Uint8Array(await range.arrayBuffer()))).toEqual([7, 0, 42, 199])
})

it('serves private share links anonymously with relative subresources and throttles last-used updates', async () => {
  const send = runtime({ ALLOW_INDEXING: 'true' })
  const { call } = await bot(send)
  const slug = 'share-preview'
  const html =
    '<link rel="stylesheet" href="site.css"><script src="site.js"></script><img src="assets/photo.svg">'
  const resources = {
    'site.css': 'body { color: red }',
    'site.js': 'document.title = "Loaded"',
    'assets/photo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  }
  const types = {
    'site.css': 'text/css; charset=utf-8',
    'site.js': 'text/javascript; charset=utf-8',
    'assets/photo.svg': 'image/svg+xml; charset=utf-8',
  }
  await call('publish', {
    slug,
    mode: 'replace',
    files: [file('index.html', html), ...Object.entries(resources).map(([path, body]) => file(path, body))],
  })
  const { id, url } = await call('create_share_link', { slug, label: 'Preview' })
  expect(url).toMatch(new RegExp(`^${read}/s/${slug}/[A-Za-z0-9_-]{22}/$`))
  const list = async () => (await call('list_share_links', { slug })).shareLinks
  expect(await list()).toEqual([{ id, label: 'Preview', createdAt: expect.any(Number), lastUsedAt: null }])
  const slash = await send(`${url.slice(0, -1)}?x=1`)
  expect(slash.status).toBe(301)
  expect(slash.headers.get('location')).toBe(`${new URL(url).pathname}?x=1`)
  expect(slash.headers.get('cache-control')).toBe('private, no-store')

  const clock = vi.spyOn(Date, 'now')
  const now = Date.now()
  clock.mockReturnValue(now)
  try {
    const root = await send(url, { headers: { 'if-none-match': '*' } })
    expect(root.status).toBe(200)
    expect(root.headers.get('cache-control')).toBe('private, no-store')
    expect(root.headers.get('x-robots-tag')).toBe('noindex')
    expect(root.headers.get('referrer-policy')).toBe('same-origin')
    expect(root.headers.has('etag')).toBe(false)
    expect(root.headers.has('set-cookie')).toBe(false)
    const page = await root.text()
    expect(page).toBe(html)
    expect((await list())[0].lastUsedAt).toBe(now)
    clock.mockReturnValue(now + 59_999)
    for (const [, path] of page.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const relative = new URL(path, url)
      expect(relative.href.startsWith(url)).toBe(true)
      const asset = await send(relative)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toBe(types[path as keyof typeof types])
      expect(await asset.text()).toBe(resources[path as keyof typeof resources])
    }
    expect((await list())[0].lastUsedAt).toBe(now)

    clock.mockReturnValue(now + 60_000)
    const range = await send(new URL('site.css', url), { headers: { range: 'bytes=0-3' } })
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('body')
    expect((await list())[0].lastUsedAt).toBe(now + 60_000)
  } finally {
    clock.mockRestore()
  }
})

it('keeps the original share URL valid when a replacement moves the entry file', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'share-entry'
  await call('publish', { slug, mode: 'replace', files: [file('index.html', 'Original')] })
  const { id, url } = await call('create_share_link', { slug })
  expect(await (await send(url)).text()).toBe('Original')
  await call('publish', { slug, mode: 'replace', files: [file('docs/index.html', 'Replacement')] })
  expect(await call('get_share_link', { id })).toEqual({ url })
  const { url: newUrl } = await call('create_share_link', { slug })
  for (const root of [url, newUrl]) {
    expect(new URL(root).pathname.split('/')).toHaveLength(5)
    const opened = await send(`${root}?preview=1`)
    expect(opened.status).toBe(302)
    expect(opened.headers.get('cache-control')).toBe('private, no-store')
    const entry = new URL(opened.headers.get('location') ?? '', root)
    expect(entry.href).toBe(`${root}docs/index.html?preview=1`)
    expect(await (await send(entry)).text()).toBe('Replacement')
  }
})

it('reads a bounded number of D1 rows from a stable share root as the revision grows', async () => {
  const { call } = await bot(runtime())
  const slug = 'share-bounded-entry'
  let rowsRead = 0
  const measuredDb = new Proxy(db, {
    get(target, property) {
      if (property !== 'prepare') return Reflect.get(target, property)
      return (sql: string) => ({
        bind: (...args: unknown[]) => ({
          async first(column?: string) {
            const { results, meta } = await target
              .prepare(sql)
              .bind(...args)
              .all<Record<string, unknown>>()
            rowsRead += meta.rows_read
            const row = results[0]
            return row ? (column === undefined ? row : row[column]) : null
          },
        }),
      })
    },
  })
  const send = runtime({ DB: measuredDb })
  const entry = file('docs/index.html', 'Entry')
  await call('publish', { slug, mode: 'replace', files: [entry] })
  const { url } = await call('create_share_link', { slug })
  const check = async () => {
    rowsRead = 0
    const response = await send(url)
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location') ?? '', url).href).toBe(`${url}docs/index.html`)
    return rowsRead
  }
  const initial = await check()
  expect(initial).toBeGreaterThan(0)
  const assets = Array.from({ length: 512 }, (_, i) => file(`asset-${i}.txt`))
  expect(await call('publish', { slug, mode: 'merge', files: assets })).toMatchObject({ revision: 2 })
  expect(await check()).toBeLessThanOrEqual(initial + 2)
})

it('backfills a legacy entry once and preserves base media type precedence on publish', async () => {
  const send = runtime({ PUBLIC_INDEX: 'true' })
  const { call } = await bot(send)
  const slug = 'legacy-entry'
  await call('publish', { slug, mode: 'replace', files: [file('a.txt'), file('y.data'), file('z.data')] })
  const id = await db.prepare('SELECT id FROM artefacts WHERE slug = ?').bind(slug).first<string>('id')
  if (!id) throw new Error('Expected a published artefact')
  // Simulate the prior Worker (which did not persist entries) with HTML media types from uploaded files.
  await db.batch([
    db.prepare('UPDATE revisions SET entry_path = NULL WHERE artefact_id = ?').bind(id),
    db
      .prepare("UPDATE files SET content_type = 'text/html' WHERE artefact_id = ? AND path = 'z.data'")
      .bind(id),
  ])
  await call('set_visibility', { slug, visibility: 'public' })
  expect(await (await send(read)).text()).toContain(`href="${read}/a/${slug}/z.data"`)
  expect(
    await db.prepare('SELECT entry_path FROM revisions WHERE artefact_id = ?').bind(id).first('entry_path'),
  ).toBe('z.data')

  await db
    .prepare(
      "UPDATE files SET content_type = 'TEXT/HTML ; charset=utf-8' WHERE artefact_id = ? AND path = 'y.data'",
    )
    .bind(id)
    .run()
  expect(await call('get_artefact', { slug })).toMatchObject({ url: `${read}/a/${slug}/z.data` })
  expect(await call('publish', { slug, mode: 'merge', files: [file('b.txt')] })).toEqual({
    revision: 2,
    url: `${read}/a/${slug}/y.data`,
  })
  const { url } = await call('create_share_link', { slug })
  const root = await send(url)
  expect(root.status).toBe(302)
  expect(new URL(root.headers.get('location') ?? '', url).href).toBe(`${url}y.data`)
  expect(await (await send(read)).text()).toContain(`href="${read}/a/${slug}/y.data"`)
})

it('keeps legacy redirects, public listings and publishing available when entry caching fails', async () => {
  const send = runtime({ PUBLIC_INDEX: 'true' })
  const { call } = await bot(send)
  const slug = 'legacy-cache-failure'
  await call('publish', { slug, mode: 'replace', files: [file('legacy/page.html')] })
  await call('set_visibility', { slug, visibility: 'public' })
  const { url } = await call('create_share_link', { slug })
  const id = await db.prepare('SELECT id FROM artefacts WHERE slug = ?').bind(slug).first<string>('id')
  if (!id) throw new Error('Expected a published artefact')
  await db.batch([
    db.prepare('UPDATE revisions SET entry_path = NULL WHERE artefact_id = ?').bind(id),
    db.prepare(`CREATE TRIGGER test_fail_entry_cache BEFORE UPDATE OF entry_path ON revisions
      BEGIN SELECT RAISE(ABORT, 'test entry cache failure'); END`),
  ])

  const canonical = `${read}/a/${slug}/legacy/page.html`
  const opened = await send(url)
  expect(opened.status).toBe(302)
  expect(new URL(opened.headers.get('location') ?? '', url).href).toBe(`${url}legacy/page.html`)
  const index = await send(read)
  expect(index.status).toBe(200)
  expect(await index.text()).toContain(`href="${canonical}"`)
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1, url: canonical })

  const next = 'current/page.html'
  expect(await call('publish', { slug, mode: 'replace', files: [file(next, 'Current')] })).toEqual({
    revision: 2,
    url: `${read}/a/${slug}/${next}`,
  })
  const reopened = await send(url)
  expect(reopened.status).toBe(302)
  expect(new URL(reopened.headers.get('location') ?? '', url).href).toBe(`${url}${next}`)
  const { results } = await db
    .prepare('SELECT entry_path AS path FROM revisions WHERE artefact_id = ? ORDER BY number')
    .bind(id)
    .all()
  expect(results).toEqual([{ path: null }, { path: null }])
})

it('redirects authorized directory indexes without a slash so relative assets load on both routes', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'share-directory'
  const html = '<link rel="stylesheet" href="site.css">'
  await call('publish', {
    slug,
    mode: 'replace',
    files: [
      file('index.html'),
      file('guide/index.html', html),
      file('guide/site.css', 'body { color: red }'),
    ],
  })
  const { url } = await call('create_share_link', { slug })
  const canonical = `${read}/a/${slug}/`
  expect((await send(`${canonical}guide`)).status).toBe(401)
  const wrongKey = `${read}/s/${slug}/wrong-but-well-formed-key/guide`
  expect((await send(wrongKey)).status).toBe(404)
  expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
  for (const root of [canonical, url]) {
    const bare = await send(`${root}guide?theme=red`)
    expect(bare.status).toBe(301)
    if (root === url) expect(bare.headers.get('cache-control')).toBe('private, no-store')
    const directory = new URL(bare.headers.get('location') ?? '', root)
    expect(directory.href).toBe(`${root}guide/?theme=red`)
    expect(await (await send(directory)).text()).toBe(html)
    const css = new URL('site.css', directory)
    const asset = await send(css)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await asset.text()).toBe('body { color: red }')
  }
})

it('records at most one concurrent use and serves files even if tracking fails', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'share-usage'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const { url } = await call('create_share_link', { slug })
  const { url: failingUrl } = await call('create_share_link', { slug })
  await db.batch([
    db.prepare('CREATE TABLE test_share_writes (link TEXT NOT NULL)'),
    db.prepare(`CREATE TRIGGER test_count_share_writes AFTER UPDATE OF last_used_at ON share_links
      BEGIN INSERT INTO test_share_writes (link) VALUES (NEW.id); END`),
  ])
  const clock = vi.spyOn(Date, 'now')
  clock.mockReturnValue(Date.now())
  try {
    const responses = await Promise.all([send(url), send(url)])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(['hello', 'hello'])
    expect(await db.prepare('SELECT COUNT(*) AS count FROM test_share_writes').first('count')).toBe(1)
    await db
      .prepare(`CREATE TRIGGER test_fail_share_write BEFORE UPDATE OF last_used_at ON share_links
        BEGIN SELECT RAISE(ABORT, 'test usage tracking failure'); END`)
      .run()
    const response = await send(failingUrl)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
  } finally {
    clock.mockRestore()
  }
})

it('caps active share links atomically and frees capacity on revocation', async () => {
  const { call } = await bot(runtime())
  const slug = 'share-capacity'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  for (let i = 0; i < 99; i++) {
    expect(await call('create_share_link', { slug })).toHaveProperty('id')
  }
  const final = await Promise.all([call('create_share_link', { slug }), call('create_share_link', { slug })])
  expect(final.filter((value) => value.error === 'too_large')).toHaveLength(1)
  const { shareLinks } = await call('list_share_links', { slug })
  expect(shareLinks).toHaveLength(100)
  expect((await call('get_artefact', { slug })).shareLinks).toHaveLength(100)
  expect(await call('revoke_share_link', { id: shareLinks[0].id })).toEqual({})
  expect(await call('create_share_link', { slug })).toHaveProperty('id')
})

it('returns the same 404 for invalid, cross-artefact, deleted and revoked share URLs on a public artefact', async () => {
  const send = runtime({ ALLOW_INDEXING: 'true' })
  const { call } = await bot(send)
  const slug = 'share-public'
  for (const target of [slug, 'share-other']) {
    await call('publish', { slug: target, mode: 'replace', files: [file('index.html')] })
  }
  expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
  const { id, url } = await call('create_share_link', { slug })
  const active = await send(url, { headers: { 'if-none-match': '*' } })
  expect(active.status).toBe(200)
  expect(active.headers.get('cache-control')).toBe('private, no-store')
  expect(active.headers.get('x-robots-tag')).toBe('noindex')
  expect(active.headers.has('etag')).toBe(false)
  expect(await active.text()).toBe('hello')
  const other = await call('create_share_link', { slug: 'share-other' })
  const crossArtefact = await send(other.url.replace('/share-other/', `/${slug}/`))
  expect(crossArtefact.status).toBe(404)
  await db.prepare('UPDATE artefacts SET deleted_at = ? WHERE slug = ?').bind(Date.now(), 'share-other').run()
  const canonical = await send(`${read}/a/${slug}/`)
  expect(canonical.status).toBe(200)
  const headers = { 'if-none-match': canonical.headers.get('etag') ?? '*' }
  expect(await call('revoke_share_link', { id })).toEqual({})
  expect(await call('get_share_link', { id })).toMatchObject({ error: 'not_found' })
  expect(await call('list_share_links', { slug })).toEqual({ shareLinks: [] })
  const unavailable = [
    url,
    url.slice(0, -1),
    other.url,
    other.url.replace('/share-other/', `/${slug}/`),
    url.replace(`/${slug}/`, '/unknown/'),
    `${read}/s/${slug}/not-a-valid-key/`,
    `${read}/s/${slug}/wrong-but-well-formed-key/`,
  ]
  const missing = await send(`${read}/missing`)
  const body = await missing.text()
  for (const path of unavailable) {
    const denied = await send(path, { headers })
    expect(denied.status).toBe(404)
    expect([...denied.headers]).toEqual([...missing.headers])
    expect(await denied.text()).toBe(body)
  }
  expect((await send(`${read}/a/${slug}/`, { headers })).status).toBe(304)
})

it('restricts share management to publishers, reveals keys only on create or get, and audits without keys', async () => {
  const send = runtime()
  const publisher = await bot(send)
  const viewer = await bot(send, 'viewer')
  const slug = 'share-manage'
  await publisher.call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  for (const key of ['publisher-imported-key', 17]) {
    expect(await publisher.call('create_share_link', { slug, key })).toMatchObject({ error: 'forbidden' })
  }
  expect(await viewer.call('create_share_link', { slug })).toMatchObject({ error: 'forbidden' })
  const { id, url } = await publisher.call('create_share_link', { slug, label: 'Demo' })
  expect(await publisher.call('get_share_link', { id })).toEqual({ url })
  expect(await viewer.call('get_share_link', { id })).toMatchObject({ error: 'forbidden' })
  expect(await viewer.call('list_share_links', { slug })).toMatchObject({ error: 'forbidden' })
  expect(await viewer.call('revoke_share_link', { id })).toMatchObject({ error: 'forbidden' })

  const metadata = [{ id, label: 'Demo', createdAt: expect.any(Number), lastUsedAt: null }]
  expect(await publisher.call('list_share_links', { slug })).toEqual({ shareLinks: metadata })
  expect((await publisher.call('get_artefact', { slug })).shareLinks).toEqual(metadata)
  expect(await publisher.call('revoke_share_link', { id })).toEqual({})
  const { results } = await db
    .prepare(
      "SELECT action, detail_json AS detail FROM audit_log WHERE action IN ('share.create', 'share.revoke')",
    )
    .all()
  expect(results).toEqual(
    expect.arrayContaining([
      { action: 'share.create', detail: JSON.stringify({ id }) },
      { action: 'share.revoke', detail: JSON.stringify({ id }) },
    ]),
  )
  expect(results).toHaveLength(2)
})

it('unseals only an intact share key bound to its original link and artefact', async () => {
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
  const key = 'Some-share_key-123'
  const sealed = await sealShareKey(secret, 'link', 'artefact', key)
  expect(sealed).not.toBe(await sealShareKey(secret, 'link', 'artefact', key))
  expect(await unsealShareKey(secret, 'link', 'artefact', sealed)).toBe(key)
  const tampered = base64url.decode(sealed)
  tampered[tampered.length - 1] ^= 1
  await expect(unsealShareKey(secret, 'link', 'artefact', base64url.encode(tampered))).rejects.toThrow()
  await expect(unsealShareKey(secret, 'other', 'artefact', sealed)).rejects.toThrow()
  await expect(unsealShareKey(secret, 'link', 'other', sealed)).rejects.toThrow()
})

async function coreAdmin() {
  const env = configuredEnv()
  const config = configuration(env)
  const member = await db
    .prepare('SELECT id, kind, name, email, role, status FROM members WHERE email = ?')
    .bind(`${admin}@example.test`)
    .first<Member>()
  if (!config || !member) throw new Error('Expected an authenticated admin and valid test configuration')
  return { member, core: { env, config } }
}

async function artefactId(slug: string) {
  const id = await db.prepare('SELECT id FROM artefacts WHERE slug = ?').bind(slug).first<string>('id')
  if (!id) throw new Error('Expected an artefact')
  return id
}

it('restores retained files and their entry path as a new revision without changing the slug', async () => {
  const { call, id } = await bot(runtime())
  const slug = 'restore-entry'
  await call('publish', {
    slug,
    mode: 'replace',
    files: [file('docs/old page.html', 'original'), file('asset.txt', 'asset')],
    message: 'First edition',
  })
  const { url } = await call('publish', { slug, mode: 'replace', files: [file('index.html', 'second')] })
  expect(url).toBe(`${read}/a/${slug}/`)
  expect((await call('list_revisions', { slug })).revisions).toEqual([
    { number: 2, author: id, createdAt: expect.any(Number), message: null },
    { number: 1, author: id, createdAt: expect.any(Number), message: 'First edition' },
  ])
  expect(await call('restore_revision', { slug, revision: 1 })).toEqual({ revision: 3 })
  expect(await call('get_artefact', { slug })).toMatchObject({
    revision: 3,
    visibility: 'private',
    url: `${read}/a/${slug}/docs/old%20page.html`,
    files: [{ path: 'asset.txt' }, { path: 'docs/old page.html' }],
  })
  expect(await call('read_file', { slug, path: 'docs/old page.html' })).toMatchObject({ text: 'original' })
  expect(await call('read_file', { slug, path: 'index.html', revision: 2 })).toMatchObject({ text: 'second' })
  expect(
    await db
      .prepare('SELECT entry_path FROM revisions WHERE artefact_id = ? AND number = 3')
      .bind(await artefactId(slug))
      .first('entry_path'),
  ).toBe('docs/old page.html')
})

it('lists revision history by cursor and rejects reads and restores outside retention', async () => {
  const { call } = await bot(runtime({ REVISION_RETENTION: '22' }))
  const slug = 'retention'
  const input = { slug, mode: 'replace', files: [file('index.html')] }
  for (let number = 1; number <= 25; number++) {
    expect(await call('publish', input)).toMatchObject({ revision: number })
  }
  const first = await call('list_revisions', { slug })
  expect(first.revisions.map(({ number }: { number: number }) => number)).toEqual(
    Array.from({ length: 20 }, (_, offset) => 25 - offset),
  )
  expect(first.nextCursor).toEqual(expect.any(String))
  const second = await call('list_revisions', { slug, cursor: first.nextCursor })
  expect(second.revisions.map(({ number }: { number: number }) => number)).toEqual([5, 4])
  expect(second.nextCursor).toBeUndefined()
  expect(await call('restore_revision', { slug, revision: 3 })).toMatchObject({ error: 'not_found' })
  expect(await call('read_file', { slug, path: 'index.html', revision: 3 })).toMatchObject({
    error: 'not_found',
  })
  expect(
    await db
      .prepare('SELECT min(number) AS oldest FROM revisions WHERE artefact_id = ?')
      .bind(await artefactId(slug))
      .first('oldest'),
  ).toBe(4)
})

it('renames paths directly across two renames and only redirects an active share key of the target', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'rename-a'
  await call('publish', {
    slug,
    mode: 'replace',
    files: [file('index.html', 'entry'), file('docs/a b.txt', 'asset')],
  })
  const { id: shareId, url: share } = await call('create_share_link', { slug })
  expect(await call('rename_artefact', { slug, newSlug: 'rename-b' })).toEqual({
    url: `${read}/a/rename-b/`,
  })
  const privateAlias = await send(`${read}/a/${slug}/`)
  expect(privateAlias.status).toBe(401)
  expect(privateAlias.headers.get('location')).toBeNull()
  await call('set_visibility', { slug: 'rename-b', visibility: 'public' })
  expect(await call('rename_artefact', { slug: 'rename-b', newSlug: 'rename-c' })).toEqual({
    url: `${read}/a/rename-c/`,
  })
  for (const oldSlug of [slug, 'rename-b']) {
    const canonical = await send(`${read}/a/${oldSlug}/docs/a%20b.txt?x=1&y=2`)
    expect(canonical.status).toBe(302)
    expect(canonical.headers.get('location')).toBe('/a/rename-c/docs/a%20b.txt?x=1&y=2')
    expect(await (await send(`${read}${canonical.headers.get('location')}`)).text()).toBe('asset')
    const alias = await send(`${share.replace(`/${slug}/`, `/${oldSlug}/`)}?preview=1`)
    expect(alias.status).toBe(302)
    expect(alias.headers.get('cache-control')).toBe('private, no-store')
    expect(new URL(alias.headers.get('location') ?? '', share).href).toBe(
      `${share.replace(`/${slug}/`, '/rename-c/')}?preview=1`,
    )
    const target = await send(new URL(alias.headers.get('location') ?? '', share))
    expect(target.status).toBe(200)
    expect(await target.text()).toBe('entry')
  }
  await call('revoke_share_link', { id: shareId })
  const missing = await send(`${read}/missing`)
  const body = await missing.text()
  for (const url of [share, `${read}/s/${slug}/not-a-valid-share-key/`]) {
    const denied = await send(url)
    expect(denied.status).toBe(404)
    expect([...denied.headers]).toEqual([...missing.headers])
    expect(await denied.text()).toBe(body)
  }
  expect(await call('publish', { slug, mode: 'replace', files: [file('index.html')] })).toMatchObject({
    error: 'conflict',
  })
})

it('matches the longest configured prefix, but a live slug wins even with no file or valid share key', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  for (const slug of ['redirect-target', 'redirect-live']) {
    await call('publish', { slug, mode: 'replace', files: [file('index.html', slug)] })
    await call('set_visibility', { slug, visibility: 'public' })
  }
  const add = [
    { fromPrefix: '/a/alias/', toPrefix: '/a/redirect-live/' },
    { fromPrefix: '/a/alias/nested/', toPrefix: '/a/redirect-target/docs/' },
    { fromPrefix: '/a/redirect-live/', toPrefix: '/a/redirect-target/' },
    { fromPrefix: '/s/redirect-live/', toPrefix: '/s/redirect-target/' },
    { fromPrefix: '/a/reserved-only/nested/', toPrefix: '/a/redirect-target/' },
  ]
  expect(await call('set_redirects', { add, remove: [] })).toMatchObject({ error: 'forbidden' })
  await setRedirects(core, member, { add, remove: [] })
  expect((await send(`${read}/a/alias/nested/x%20y.txt?q=1`)).headers.get('location')).toBe(
    '/a/redirect-target/docs/x%20y.txt?q=1',
  )
  expect((await send(`${read}/a/alias/nested-like/file`)).headers.get('location')).toBe(
    '/a/redirect-live/nested-like/file',
  )
  expect(await (await send(`${read}/a/redirect-live/`)).text()).toBe('redirect-live')
  expect((await send(`${read}/a/redirect-live/missing`)).status).toBe(404)
  expect((await send(`${read}/s/redirect-live/not-a-valid-share-key/`)).status).toBe(404)
  expect(await call('rename_artefact', { slug: 'redirect-live', newSlug: 'reserved-only' })).toMatchObject({
    error: 'conflict',
  })
  await expect(
    setRedirects(core, member, {
      add: [{ fromPrefix: '/a/elsewhere/', toPrefix: '/a/not-live/' }],
      remove: ['/a/alias/nested/'],
    }),
  ).rejects.toMatchObject({ code: 'not_found' })
  expect((await send(`${read}/a/alias/nested/x`)).headers.get('location')).toBe('/a/redirect-target/docs/x')
  await setRedirects(core, member, { add: [], remove: ['/a/alias/nested/'] })
  expect((await send(`${read}/a/alias/nested/x`)).headers.get('location')).toBe('/a/redirect-live/nested/x')
})

it('soft-deletes canonical and share URLs, reserves the slug, and restores access only for admins', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const viewer = await bot(send, 'viewer')
  const { member, core } = await coreAdmin()
  const slug = 'delete-me'
  const input = { slug, mode: 'replace', files: [file('index.html')] }
  await call('publish', input)
  await call('set_visibility', { slug, visibility: 'public' })
  const { url } = await call('create_share_link', { slug })
  expect(await viewer.call('rename_artefact', { slug, newSlug: 'viewer-rename' })).toMatchObject({
    error: 'forbidden',
  })
  expect(await viewer.call('delete_artefact', { slug })).toMatchObject({ error: 'forbidden' })
  expect(await viewer.call('restore_revision', { slug, revision: 1 })).toMatchObject({ error: 'forbidden' })
  expect(await call('delete_artefact', { slug })).toEqual({})
  const missing = await send(`${read}/missing`)
  const unavailable = await missing.text()
  for (const location of [`${read}/a/${slug}/`, url]) {
    const response = await send(location)
    expect(response.status).toBe(404)
    expect([...response.headers]).toEqual([...missing.headers])
    expect(await response.text()).toBe(unavailable)
  }
  expect(await call('publish', input)).toMatchObject({ error: 'conflict', currentRevision: 1 })
  await expect(restoreDeletedArtefact(core, { ...member, role: 'publisher' }, slug)).rejects.toMatchObject({
    code: 'forbidden',
  })
  await restoreDeletedArtefact(core, member, slug)
  expect(await (await send(`${read}/a/${slug}/`)).text()).toBe('hello')
  expect(await (await send(url)).text()).toBe('hello')
  await call('delete_artefact', { slug })
  await db.prepare('UPDATE artefacts SET deleted_at = 1 WHERE slug = ?').bind(slug).run()
  await expect(restoreDeletedArtefact(core, member, slug)).rejects.toMatchObject({ code: 'conflict' })
})

it('resumes purge in bounded chunks, keeping blobs shared by files or an unexpired stored upload', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-chunks'
  await call('publish', {
    slug,
    mode: 'replace',
    files: [
      ...Array.from({ length: 256 }, (_, offset) => file(`only-${offset}.txt`, 'unreferenced')),
      file('shared.txt', 'shared'),
      file('upload.txt', 'hello'),
    ],
  })
  await call('publish', { slug: 'survivor', mode: 'replace', files: [file('shared.txt', 'shared')] })
  const receipt = (await call('create_uploads', { slug: 'replacement', files: [textUpload] })).files[0]
  expect(receipt.alreadyStored).toBe(true)
  const id = await artefactId(slug)
  const only = await db
    .prepare("SELECT sha256 FROM files WHERE artefact_id = ? AND path = 'only-0.txt'")
    .bind(id)
    .first<string>('sha256')
  await expect(purgeArtefact(core, member, id)).rejects.toMatchObject({ code: 'conflict' })
  await call('delete_artefact', { slug })
  expect(await purgeArtefact(core, member, id)).toEqual({ done: false })
  expect(await bucket.head(`blobs/${only}`)).not.toBeNull()
  await expect(restoreDeletedArtefact(core, member, slug)).rejects.toMatchObject({ code: 'conflict' })
  expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
  expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
  expect(await bucket.head(`blobs/${only}`)).toBeNull()
  expect(await call('read_file', { slug: 'survivor', path: 'shared.txt' })).toMatchObject({ text: 'shared' })
  expect(
    await call('publish', {
      slug: 'replacement',
      mode: 'replace',
      files: [{ path: receipt.path, uploadId: receipt.uploadId }],
    }),
  ).toMatchObject({ revision: 1 })
  expect(await call('read_file', { slug: 'replacement', path: receipt.path })).toMatchObject({
    text: 'hello',
  })
})

it('authorizes and audits bounded purge steps for historical share links and redirects', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-dependents'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const id = await artefactId(slug)
  // A long-lived page can accumulate revoked links and redirects far beyond the active share cap.
  const numbers = 'WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 513)'
  await db.batch([
    db
      .prepare(`${numbers}
        INSERT INTO share_links (id, artefact_id, key_hash, key_sealed, created_by, created_at, revoked_at)
        SELECT 'link-' || n, ?, printf('%064x', n), 'sealed', ?, 1, CASE WHEN n > 1 THEN 2 END
        FROM numbers`)
      .bind(id, member.id),
    db
      .prepare(`${numbers}
        INSERT INTO redirects (from_prefix, source_slug, target_artefact_id, target_path, created_at, created_by)
        SELECT '/a/alias-' || n || '/', 'alias-' || n, ?, '', 1, ? FROM numbers`)
      .bind(id, member.id),
  ])
  await call('delete_artefact', { slug })

  const state = () =>
    db
      .prepare(`SELECT
        (SELECT count(*) FROM artefacts WHERE id = ?1 AND deleted_at IS NOT NULL) AS deleted,
        (SELECT count(*) FROM files WHERE artefact_id = ?1) AS files,
        (SELECT count(*) FROM share_links WHERE artefact_id = ?1) AS links,
        (SELECT count(*) FROM redirects WHERE target_artefact_id = ?1) AS redirects,
        (SELECT count(*) FROM artefact_purges WHERE artefact_id = ?1) AS jobs`)
      .bind(id)
      .first()
  const audit = async () =>
    (
      await db
        .prepare(`SELECT action, member_id AS actor, artefact_id AS id, json_extract(detail_json, '$.slug') AS slug
          FROM audit_log WHERE artefact_id = ? AND action IN ('artefact.purge_start', 'artefact.purge')
          ORDER BY rowid`)
        .bind(id)
        .all()
    ).results

  await expect(purgeArtefact(core, { ...member, role: 'publisher' }, id, slug)).rejects.toMatchObject({
    code: 'forbidden',
  })
  await expect(purgeArtefact(core, member, id, 'different-slug')).rejects.toMatchObject({ code: 'conflict' })
  expect(await state()).toEqual({ deleted: 1, files: 1, links: 513, redirects: 513, jobs: 0 })
  expect(await audit()).toEqual([])
  expect(await bucket.head(`blobs/${uploadHash}`)).not.toBeNull()

  const start = { action: 'artefact.purge_start', actor: member.id, id, slug }
  for (const remaining of [257, 1]) {
    expect(await purgeArtefact(core, member, id, slug)).toEqual({ done: false })
    expect(await state()).toEqual({ deleted: 1, files: 0, links: remaining, redirects: remaining, jobs: 1 })
    expect(await audit()).toEqual([start])
  }
  expect(await purgeArtefact(core, member, id, slug)).toEqual({ done: true })
  expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
  expect(await state()).toEqual({ deleted: 0, files: 0, links: 0, redirects: 0, jobs: 0 })
  expect(await audit()).toEqual([start, { action: 'artefact.purge', actor: member.id, id, slug }])
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
})

it('rejects a publish that deduplicated a blob before a concurrent purge deleted it', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  const slug = 'purge-inline-race'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const paused = withBucket({
    async put(key, bytes, options) {
      // This sibling put occurs after the batch of D1 dedup reads.
      entered.resolve()
      await resume.promise
      return bucket.put(key, bytes, options)
    },
  })
  const input = {
    slug: 'after-purge',
    mode: 'replace',
    files: [file('index.html'), file('sibling.txt', 'unique sibling')],
  }
  const publishing = call('publish', input, paused)
  await Promise.race([
    entered.promise,
    publishing.then(() => {
      throw new Error('Publish did not pause')
    }),
  ])
  try {
    expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
    expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  } finally {
    resume.resolve()
  }
  expect(await publishing).toMatchObject({ error: 'conflict', currentRevision: 0 })
  expect(await call('publish', input)).toMatchObject({ revision: 1 })
  expect(await call('read_file', { slug: input.slug, path: 'index.html' })).toMatchObject({ text: 'hello' })
})

it('blocks new references to a claimed hash until its R2 delete finishes', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-claim'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const paused = {
    ...core,
    env: {
      ...core.env,
      BLOBS: {
        async delete(keys: string[]) {
          entered.resolve()
          await resume.promise
          await bucket.delete(keys)
        },
      } as R2Bucket,
    },
  }
  const deleting = purgeArtefact(paused, member, id)
  await Promise.race([
    entered.promise,
    deleting.then(() => {
      throw new Error('Purge did not pause')
    }),
  ])
  const input = { slug: 'reuse-claim', mode: 'replace', files: [file('index.html')] }
  try {
    expect(await purgeArtefact(core, member, id)).toEqual({ done: false })
    expect(await call('publish', input)).toMatchObject({ error: 'conflict', currentRevision: 0 })
  } finally {
    resume.resolve()
  }
  expect(await deleting).toEqual({ done: true })
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  expect(await call('publish', input)).toMatchObject({ revision: 1 })
})

it('refuses to mark a verifying upload stored when its incumbent blob is concurrently purged', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  const { path, url, uploadId } = await uploadUrl(call, 'verifying')
  const slug = 'purge-upload-race'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const paused = runtime({
    BLOBS: {
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      async head(key: string) {
        const old = await bucket.head(key)
        entered.resolve()
        await resume.promise
        return old
      },
    } as R2Bucket,
  })
  const storing = putUpload(paused, url)
  await Promise.race([
    entered.promise,
    storing.then(() => {
      throw new Error('Upload did not pause')
    }),
  ])
  try {
    expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
    expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  } finally {
    resume.resolve()
  }
  expect((await storing).status).toBe(409)
  expect(
    await call('publish', { slug: 'verifying', mode: 'replace', files: [{ path, uploadId }] }),
  ).toMatchObject({ error: 'not_found' })
})

function watchBatches(
  before?: (sql: string[]) => Promise<void>,
  after?: (results: D1Result[]) => void,
): D1Database {
  const statementsByProxy = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; sql: string }
  >()
  function trace(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => trace(target.bind(...values), sql)
        if (key === 'run' || key === 'all') {
          return async () => {
            const result = await target[key]()
            after?.([result])
            return result
          }
        }
        if (key === 'first') return target.first.bind(target)
        return Reflect.get(target, key)
      },
    })
    statementsByProxy.set(proxy, { statement, sql })
    return proxy
  }
  return {
    prepare: (sql: string) => trace(db.prepare(sql), sql),
    async batch(statements: D1PreparedStatement[]) {
      const originals = statements.map((statement) => statementsByProxy.get(statement))
      await before?.(originals.map((item) => item?.sql ?? ''))
      const results = await db.batch(statements.map((statement, i) => originals[i]?.statement ?? statement))
      after?.(results)
      return results
    },
  } as D1Database
}

it('does not issue an alreadyStored receipt after purge removes the file reference during upload creation', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  const slug = 'source-of-dedup'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  const racing = runtime({
    DB: watchBatches(async (sql) => {
      if (!sql.some((text) => text.includes('INSERT INTO uploads'))) return
      expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
      expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
    }),
  })
  const request = { slug: 'upload-after-purge', files: [textUpload] }
  expect(await call('create_uploads', request, racing)).toMatchObject({ error: 'conflict' })
  expect(await db.prepare('SELECT state FROM uploads WHERE slug = ?').bind(request.slug).first()).toBeNull()
})

it('bounds purge reference probes by page size even with a large backlog of candidate hashes', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-backlog'
  const id = crypto.randomUUID()
  await db.prepare('INSERT INTO artefact_purges (slug, artefact_id) VALUES (?, ?)').bind(slug, id).run()
  const candidates = 10_000
  await call('publish', { slug: 'retaining-hashes', mode: 'replace', files: [file('index.html')] })
  const liveId = await artefactId('retaining-hashes')
  await db
    .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO purge_candidates (slug, sha256) SELECT ?, printf('%064x', n) FROM numbers`)
    .bind(candidates, slug)
    .run()
  await db
    .prepare(`INSERT INTO files (artefact_id, revision, path, sha256, size, content_type)
      SELECT ?, 1, sha256, sha256, 0, 'text/plain' FROM purge_candidates WHERE slug = ?`)
    .bind(liveId, slug)
    .run()
  let reads = 0
  const measured = watchBatches(undefined, (results) => {
    for (const result of results) reads += result.meta.rows_read
  })
  expect(await purgeArtefact({ ...core, env: { ...core.env, DB: measured } }, member, id)).toEqual({
    done: false,
  })
  expect(reads).toBeGreaterThan(0)
  expect(reads).toBeLessThan(2_000)
  expect(
    await db
      .prepare('SELECT count(*) AS count FROM purge_candidates WHERE slug = ?')
      .bind(slug)
      .first('count'),
  ).toBe(candidates - 64)
})

it('retries an owned purge claim after a failed R2 delete and releases the hash for publishing', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-retry'
  const input = { slug, mode: 'replace', files: [file('index.html')] }
  await call('publish', input)
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  const fault = {
    ...core,
    env: {
      ...core.env,
      BLOBS: {
        async delete(_keys: Parameters<R2Bucket['delete']>[0]): Promise<void> {
          throw new Error('R2 delete failed')
        },
      } as R2Bucket,
    },
  }
  await expect(purgeArtefact(fault, member, id)).rejects.toThrow('R2 delete failed')
  expect(
    (
      await db
        .prepare("SELECT action FROM audit_log WHERE artefact_id = ? AND action LIKE 'artefact.purge%'")
        .bind(id)
        .all()
    ).results,
  ).toEqual([{ action: 'artefact.purge_start' }])
  expect(await bucket.head(`blobs/${uploadHash}`)).not.toBeNull()
  expect(await call('publish', { ...input, slug: 'reuse-retry' })).toMatchObject({ error: 'conflict' })
  expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  expect(await call('publish', { ...input, slug: 'reuse-retry' })).toMatchObject({ revision: 1 })
})

it('respects a fresh purge lease and resumes its outstanding claim after expiry', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-lease'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  // Durable state left by a worker stopped after claiming the blob and before deleting it.
  await db.batch([
    db.prepare('INSERT INTO artefact_purges (slug, artefact_id) VALUES (?, ?)').bind(slug, id),
    db.prepare('INSERT INTO purge_candidates (slug, sha256) VALUES (?, ?)').bind(slug, uploadHash),
    db.prepare('DELETE FROM artefacts WHERE id = ?').bind(id),
    db.prepare('INSERT INTO blob_purge_claims (sha256, owner) VALUES (?, ?)').bind(uploadHash, id),
    db
      .prepare('INSERT INTO purge_attempts (artefact_id, token, expires_at) VALUES (?, ?, ?)')
      .bind(id, 'stopped-attempt', Date.now() + 60_000),
  ])
  const key = `blobs/${uploadHash}`
  expect(await purgeArtefact(core, member, id)).toEqual({ done: false })
  expect(await bucket.head(key)).not.toBeNull()
  expect(
    await db.prepare('SELECT token FROM purge_attempts WHERE artefact_id = ?').bind(id).first('token'),
  ).toBe('stopped-attempt')
  await db.prepare('UPDATE purge_attempts SET expires_at = 0 WHERE artefact_id = ?').bind(id).run()
  expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
  expect(await bucket.head(key)).toBeNull()
})

it('cannot claim a hash from a reused slug after its purge lease is replaced and completed', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-reused-slug'
  const input = { slug, mode: 'replace', files: [file('index.html')] }
  await call('publish', input)
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  let nextId = ''
  const delayed = watchBatches(async (sql) => {
    if (!sql.some((text) => text.includes('INSERT INTO blob_purge_claims'))) return
    await db.prepare('UPDATE purge_attempts SET expires_at = 0 WHERE artefact_id = ?').bind(id).run()
    expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
    expect(await call('publish', input)).toMatchObject({ revision: 1 })
    nextId = await artefactId(slug)
    await call('delete_artefact', { slug })
    await db.batch([
      db.prepare('INSERT INTO artefact_purges (slug, artefact_id) VALUES (?, ?)').bind(slug, nextId),
      db.prepare('INSERT INTO purge_candidates (slug, sha256) VALUES (?, ?)').bind(slug, uploadHash),
      db.prepare('DELETE FROM artefacts WHERE id = ?').bind(nextId),
    ])
  })
  expect(await purgeArtefact({ ...core, env: { ...core.env, DB: delayed } }, member, id)).toEqual({
    done: true,
  })
  expect(await purgeArtefact(core, member, nextId)).toEqual({ done: true })
  expect(await bucket.head(`blobs/${uploadHash}`)).toBeNull()
  expect(await call('publish', input)).toMatchObject({ revision: 1 })
})

it('does not release the successor lease or its hash claim when the old purge delete finishes late', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'purge-late-completion'
  const input = { slug, mode: 'replace', files: [file('index.html')] }
  await call('publish', input)
  const id = await artefactId(slug)
  await call('delete_artefact', { slug })
  async function pauseDelete() {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const result = purgeArtefact(
      {
        ...core,
        env: {
          ...core.env,
          BLOBS: {
            async delete(keys: string[]) {
              entered.resolve()
              await resume.promise
              await bucket.delete(keys)
            },
          } as R2Bucket,
        },
      },
      member,
      id,
    )
    await Promise.race([
      entered.promise,
      result.then(() => {
        throw new Error('Purge did not pause')
      }),
    ])
    return { result, resume: resume.resolve }
  }
  const old = await pauseDelete()
  try {
    await db.prepare('UPDATE purge_attempts SET expires_at = 0 WHERE artefact_id = ?').bind(id).run()
    const successor = await pauseDelete()
    try {
      const lease = db.prepare('SELECT token FROM purge_attempts WHERE artefact_id = ?').bind(id)
      const token = await lease.first('token')
      expect(token).toEqual(expect.any(String))
      old.resume()
      expect(await old.result).toEqual({ done: false })
      expect(await lease.first('token')).toBe(token)
      expect(await call('publish', { ...input, slug: 'reuse-late-hash' })).toMatchObject({
        error: 'conflict',
      })
      expect(
        await db
          .prepare('SELECT owner FROM blob_purge_claims WHERE sha256 = ?')
          .bind(uploadHash)
          .first('owner'),
      ).toBe(id)
      expect(
        await db
          .prepare('SELECT sha256 FROM purge_candidates WHERE slug = ? AND sha256 = ?')
          .bind(slug, uploadHash)
          .first('sha256'),
      ).toBe(uploadHash)
    } finally {
      successor.resume()
    }
    expect(await successor.result).toEqual({ done: true })
  } finally {
    old.resume()
  }
})

it('returns uniform 404 from canonical and share aliases pointing at a soft-deleted target', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'deleted-alias'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  await call('set_visibility', { slug, visibility: 'public' })
  const { url } = await call('create_share_link', { slug })
  await call('rename_artefact', { slug, newSlug: 'deleted-target' })
  await call('delete_artefact', { slug: 'deleted-target' })
  const missing = await send(`${read}/missing`)
  const body = await missing.text()
  for (const location of [`${read}/a/${slug}/`, url]) {
    const response = await send(location)
    expect(response.status).toBe(404)
    expect([...response.headers]).toEqual([...missing.headers])
    expect(await response.text()).toBe(body)
  }
})

it('commits exactly one rename when both calls read the same source slug', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const slug = 'rename-race'
  await call('publish', { slug, mode: 'replace', files: [file('index.html')] })
  await call('set_visibility', { slug, visibility: 'public' })
  const both = Promise.withResolvers<void>()
  let arrivals = 0
  const racing = runtime({
    DB: watchBatches(async (sql) => {
      if (!sql.some((text) => text.includes('UPDATE artefacts SET slug'))) return
      if (++arrivals === 2) both.resolve()
      await both.promise
    }),
  })
  const outcomes = await Promise.all(
    ['first-target', 'second-target'].map((newSlug) => call('rename_artefact', { slug, newSlug }, racing)),
  )
  const successes = outcomes.filter((outcome) => outcome.url)
  expect(successes).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.error)).toEqual([
    expect.objectContaining({ error: 'conflict' }),
  ])
  const alias = await send(`${read}/a/${slug}/`)
  expect(alias.status).toBe(302)
  expect(new URL(alias.headers.get('location') ?? '', read).href).toBe(successes[0].url)
})

it('rejects creating a slug reserved by set_redirects after the publish preflight', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  const slug = 'reservation-race'
  await call('publish', { slug: 'reserved-target', mode: 'replace', files: [file('index.html')] })
  const racing = withBucket({
    async put(key, bytes, options) {
      await setRedirects(core, member, {
        add: [{ fromPrefix: `/a/${slug}/`, toPrefix: '/a/reserved-target/' }],
        remove: [],
      })
      return bucket.put(key, bytes, options)
    },
  })
  expect(
    await call('publish', { slug, mode: 'replace', files: [file('index.html', 'unique')] }, racing),
  ).toMatchObject({ error: 'conflict', currentRevision: 0 })
  expect(await call('get_artefact', { slug })).toMatchObject({ error: 'not_found' })
})

it('rejects escaped unreserved characters and lowercase escape hex without reserving the source slug', async () => {
  const { call } = await bot(runtime())
  const { member, core } = await coreAdmin()
  const slug = 'escape-alias'
  await call('publish', { slug: 'escape-target', mode: 'replace', files: [file('index.html')] })
  for (const path of ['%65ntry/', 'space%c2%a0/']) {
    await expect(
      setRedirects(core, member, {
        add: [{ fromPrefix: `/a/${slug}/${path}`, toPrefix: '/a/escape-target/' }],
        remove: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      setRedirects(core, member, {
        add: [{ fromPrefix: `/a/${slug}/`, toPrefix: `/a/escape-target/${path}` }],
        remove: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  }
  expect(await call('publish', { slug, mode: 'replace', files: [file('index.html')] })).toMatchObject({
    revision: 1,
  })
})

it('removes root aliases on rename-back but preserves a nested admin alias through the next rename', async () => {
  const send = runtime()
  const { call } = await bot(send)
  const { member, core } = await coreAdmin()
  const slug = 'rename-return'
  await call('publish', {
    slug,
    mode: 'replace',
    files: [file('index.html'), file('new-docs/page.txt', 'docs')],
  })
  await call('set_visibility', { slug, visibility: 'public' })
  const { url } = await call('create_share_link', { slug })
  await call('rename_artefact', { slug, newSlug: 'rename-away' })
  await setRedirects(core, member, {
    add: [{ fromPrefix: `/a/${slug}/old-docs/`, toPrefix: '/a/rename-away/new-docs/' }],
    remove: [],
  })
  expect(await call('rename_artefact', { slug: 'rename-away', newSlug: slug })).toEqual({
    url: `${read}/a/${slug}/`,
  })
  expect(await (await send(`${read}/a/${slug}/`)).text()).toBe('hello')
  expect(await (await send(url)).text()).toBe('hello')
  const alias = await send(url.replace(`/${slug}/`, '/rename-away/'))
  expect(alias.status).toBe(302)
  expect(new URL(alias.headers.get('location') ?? '', read).href).toBe(url)
  const { results } = await db
    .prepare('SELECT from_prefix FROM redirects WHERE source_slug = ?')
    .bind(slug)
    .all()
  expect(results).toEqual([{ from_prefix: `/a/${slug}/old-docs/` }])
  await call('rename_artefact', { slug, newSlug: 'rename-final' })
  const docs = await send(`${read}/a/${slug}/old-docs/page.txt`)
  expect(docs.status).toBe(302)
  const location = new URL(docs.headers.get('location') ?? '', read).href
  expect(location).toBe(`${read}/a/rename-final/new-docs/page.txt`)
  expect(await (await send(location)).text()).toBe('docs')
})
