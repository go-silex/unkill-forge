import { env } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
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

it('applies 10,000 literal replacements but refuses 10,001 before creating a revision', async () => {
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
  expect(await write(10_001)).toMatchObject({ revision: 3 })
  expect(await call('edit_file', { ...edit, expectedRevision: 3 })).toMatchObject({
    error: 'invalid_input',
    matches: 10_001,
    message: expect.stringContaining('Use publish instead'),
  })
  expect(await call('read_file', { slug, path: edit.path })).toMatchObject({
    revision: 3,
    text: 'a'.repeat(10_001),
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
  expect((await runtime({ MAX_BLOB_WRITES_PER_CALL: 901 })('/')).status).toBe(503)
})

it('rejects oversized publish arrays before validating their entries or touching R2', async () => {
  const put = vi.fn(bucket.put.bind(bucket))
  const { call } = await bot(withBucket({ put }, { MAX_FILES_PER_ARTEFACT: 2 }))
  const args = { slug: 'path-limit', mode: 'merge', files: [file('first.txt')] }
  const error = { error: 'too_large' }
  expect(await call('publish', { ...args, files: [false, null, 123] })).toMatchObject(error)
  expect(await call('publish', { ...args, delete: [false, null, 123] })).toMatchObject(error)
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

it('budgets only unreferenced blobs: 500 fresh files and a 501-file reused replacement succeed', async () => {
  const put = vi.fn(bucket.put.bind(bucket))
  const { call } = await bot(withBucket({ put }))
  const slug = 'full-call'
  const files = Array.from({ length: 500 }, (_, index) => file(`${index}.txt`, `content ${index}`))
  expect(await call('publish', { slug, mode: 'replace', files })).toMatchObject({ revision: 1 })
  expect(put).toHaveBeenCalledTimes(500)
  expect(await call('read_file', { slug, path: '499.txt' })).toMatchObject({ text: 'content 499' })
  put.mockClear()
  const tooMany = {
    slug,
    mode: 'replace',
    expectedRevision: 1,
    files: Array.from({ length: 501 }, (_, index) => file(`${index}.txt`, `fresh ${index}`)),
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
    text: 'content 498',
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
  const { call } = await bot(runtime({ MAX_INLINE_BYTES: '9000000' }))
  const slug = 'byte-types'
  expect(
    await call('publish', {
      slug,
      mode: 'replace',
      files: [
        { path: 'image.png', content: '/w==', encoding: 'base64' },
        { path: 'bad.txt', content: '/w==', encoding: 'base64' },
        file('large.txt', 'x'.repeat(8 * 1024 * 1024 + 1)),
        file('slice.txt', 'x'.repeat(100_001)),
      ],
    }),
  ).toMatchObject({ revision: 1 })
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
