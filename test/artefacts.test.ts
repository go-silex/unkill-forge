import { env } from 'cloudflare:test'
import { base64url } from 'jose'
import { expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
import { sealShareKey, unsealShareKey } from '../src/core/share-keys'
import { admin, type Handle, listedId, read, runtime, setupStorage } from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()
const { DB: db, BLOBS: bucket } = env as typeof env & Pick<Env, 'DB' | 'BLOBS'>

function mcpPost(send: Handle, token: string, body: string, protocolVersion = '2025-11-25') {
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

async function bot(send: Handle, role: 'viewer' | 'publisher' = 'publisher') {
  const owner = await mockProvider().signedIn(send, admin)
  const name = `Artefact ${role}`
  expect((await owner.post('/admin/bots', { action: 'create', name, role })).status).toBe(303)
  const id = await listedId(owner, '/admin/members', name)
  const response = await owner.post('/admin/bots', { action: 'token', id, name: 'Artefact token' })
  expect(response.status).toBe(200)
  const token = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await response.text())?.[1]
  if (!token) throw new Error('Expected a bot token')
  return {
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
