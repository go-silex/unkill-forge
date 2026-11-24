import { expect, it, vi } from 'vitest'
import { configuration } from '../src/config'
import { generateCovers } from '../src/core/generated-covers'
import {
  admin,
  configuredEnv,
  flashNavigation,
  formValue,
  listedId,
  location,
  read,
  runtime,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const slug = 'report'
const preview = `/_forge/preview/${slug}`
const publicPreview = `${read}${preview}`
const publicUrl = `${read}/a/${slug}/`
const image = { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' } }
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])
const newerJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd9])
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X+uoAAAAASUVORK5CYII='
type Renderer = Parameters<typeof generateCovers>[1]

async function fixture() {
  const overrides = { PUBLIC_INDEX: 'true' }
  const env = configuredEnv(overrides)
  const config = configuration(env)
  if (!config) throw new Error('Expected valid test configuration')
  const core = { config, env }
  const send = runtime(overrides)
  const owner = await mockProvider().signedIn(send, admin)
  const name = 'Cover publisher'
  expect((await owner.post('/admin/bots', { action: 'create', name, role: 'publisher' })).status).toBe(303)
  const id = await listedId(owner, '/admin/members', name)
  const tokenResponse = await owner.post('/admin/bots', { action: 'token', id, name: 'Cover tests' })
  expect(tokenResponse.status).toBe(303)
  const tokenPage = await owner.request(location(tokenResponse), { headers: flashNavigation })
  const token = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await tokenPage.text())?.[1]
  if (!token) throw new Error('Expected a bot token')
  async function call(name: string, args: object) {
    const response = await send('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    expect(response.status).toBe(200)
    const { result } = await response.json<{ result: { isError?: boolean; structuredContent?: unknown } }>()
    expect(result.isError ?? false, name).toBe(false)
    return result.structuredContent
  }
  return {
    send,
    owner,
    call,
    core,
    generate: (render: Renderer, now = Date.now()) => generateCovers(core, render, now),
  }
}

async function expectImage(response: Response, bytes: Uint8Array, type = 'image/jpeg') {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe(type)
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
}

it('fills a missing gallery cover from the exact committed head without changing publication', async () => {
  const { call, generate, owner, send } = await fixture()
  await call('publish', {
    slug,
    mode: 'replace',
    files: [{ path: 'index.html', content: '<h1>Old head</h1>' }],
  })
  const entry = 'docs/start here.html'
  const html = '<link rel="stylesheet" href="../theme.css"><h1>Current head</h1>'
  const css = 'h1 { color: blue }'
  const entryUrl = `${publicUrl}docs/start%20here.html`
  expect(
    await call('publish', {
      slug,
      title: 'Coverless report',
      mode: 'replace',
      expectedRevision: 1,
      files: [
        { path: entry, content: html },
        { path: 'theme.css', content: css },
      ],
    }),
  ).toEqual({ revision: 2, url: entryUrl })
  await call('set_visibility', { slug, visibility: 'public' })
  expect(await call('create_share_link', { slug })).toMatchObject({ id: expect.any(String) })
  const before = await call('get_artefact', { slug })
  const revisions = await call('list_revisions', { slug })
  expect(before).toMatchObject({ revision: 2, visibility: 'public', url: entryUrl })
  const gallery = await (await send(read)).text()
  expect(gallery).toContain('Coverless report')
  expect(gallery).not.toContain(`src="${preview}"`)
  expect((await send(publicPreview)).status).toBe(404)
  expect(await (await send(entryUrl)).text()).toBe(html)

  const render = vi.fn<Renderer>(async () => jpeg)
  await generate(render)
  expect(render.mock.calls).toEqual([
    [
      entry,
      [
        {
          path: entry,
          size: html.length,
          type: 'text/html; charset=utf-8',
          sha256: 'a65d98754688d2758763da69833bf3eeee37498b0542c928d16559a124994ce0',
        },
        {
          path: 'theme.css',
          size: css.length,
          type: 'text/css; charset=utf-8',
          sha256: 'b76fab049c6c5eb84c3802571605bf763ab5b9b8dda4d86be95b25d86632894b',
        },
      ],
    ],
  ])
  expect(await (await send(read)).text()).toContain(`src="${preview}"`)
  expect(await (await owner.request('/artefacts')).text()).toContain(`src="${preview}"`)
  await expectImage(await send(publicPreview), jpeg)
  const manageCover = await owner.request(preview, image)
  expect(manageCover.headers.get('Content-Disposition')).toBe('attachment')
  await expectImage(manageCover, jpeg)
  expect(await call('get_artefact', { slug })).toEqual(before)
  expect(await call('list_revisions', { slug })).toEqual(revisions)
  expect(await (await send(entryUrl)).text()).toBe(html)
  expect((await send(`${publicUrl}og.jpg`)).status).toBe(404)
})

it('keeps a valid supplied raster even if a higher-priority filename has an invalid signature', async () => {
  const { call, generate, send } = await fixture()
  await call('publish', {
    slug,
    mode: 'replace',
    files: [
      { path: 'index.html', content: '<h1>Report</h1>' },
      { path: 'og.jpg', content: '<h1>Not a JPEG</h1>' },
      { path: 'og.png', content: png, encoding: 'base64' },
    ],
  })
  await call('set_visibility', { slug, visibility: 'public' })
  const render = vi.fn<Renderer>(async () => jpeg)
  await generate(render)
  expect(render).not.toHaveBeenCalled()
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
  await expectImage(await send(publicPreview), bytes, 'image/png')
})

it('serves a generated JPEG on GET and HEAD when every supplied raster signature is invalid', async () => {
  const { call, generate, send } = await fixture()
  await call('publish', {
    slug,
    mode: 'replace',
    files: [
      { path: 'index.html', content: '<h1>Report</h1>' },
      ...['og.jpg', 'og.jpeg', 'og.png', 'og.webp', 'index.og.png'].map((path) => ({
        path,
        content: 'Not raster bytes',
      })),
    ],
  })
  await call('set_visibility', { slug, visibility: 'public' })
  expect((await send(publicPreview)).status).toBe(404)
  const render = vi.fn<Renderer>(async () => jpeg)
  await generate(render)
  expect(render).toHaveBeenCalledTimes(1)
  await expectImage(await send(publicPreview), jpeg)
  const head = await send(publicPreview, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('Content-Type')).toBe('image/jpeg')
  expect(head.headers.get('Content-Length')).toBe(String(jpeg.byteLength))
  expect((await head.arrayBuffer()).byteLength).toBe(0)
})

it('rechecks live visibility, session policy and deletion when serving a generated cover', async () => {
  const { call, generate, owner, send } = await fixture()
  await call('publish', {
    slug,
    mode: 'replace',
    files: [{ path: 'index.html', content: '<h1>Report</h1>' }],
  })
  await call('set_visibility', { slug, visibility: 'public' })
  await generate(async () => jpeg)
  await expectImage(await send(publicPreview), jpeg)
  expect((await runtime()(publicPreview)).status).toBe(404)
  expect((await send(preview, image)).status).toBe(404)
  expect((await owner.request(preview)).status).toBe(404)

  await call('set_visibility', { slug, visibility: 'private' })
  expect((await send(publicPreview, { headers: { 'If-None-Match': '*' } })).status).toBe(404)
  expect(await (await send(read)).text()).not.toContain(`src="${preview}"`)
  await expectImage(await owner.request(preview, image), jpeg)

  await call('delete_artefact', { slug })
  expect((await send(publicPreview)).status).toBe(404)
  expect((await owner.request(preview, image)).status).toBe(404)
  expect(await (await owner.request('/artefacts')).text()).not.toContain(`src="${preview}"`)
})

it('never serves the previous cover or an in-flight render after the head changes', async () => {
  const { call, generate, send } = await fixture()
  async function publish(path: string, content: string, expectedRevision?: number) {
    return call('publish', { slug, mode: 'replace', files: [{ path, content }], expectedRevision })
  }
  await publish('index.html', '<h1>First head</h1>')
  await call('set_visibility', { slug, visibility: 'public' })
  await generate(async () => jpeg)
  await expectImage(await send(publicPreview), jpeg)

  expect(await publish('racing.html', '<h1>Second head</h1>', 1)).toMatchObject({ revision: 2 })
  expect((await send(publicPreview)).status).toBe(404)
  const render = vi.fn<Renderer>(async () => newerJpeg)
  const racing = vi.fn<Renderer>(async () => {
    expect(await publish('latest.html', '<h1>Third head</h1>', 2)).toMatchObject({ revision: 3 })
    expect((await send(publicPreview)).status).toBe(404)
    expect(await (await send(read)).text()).not.toContain(`src="${preview}"`)
    await generate(render)
    return jpeg
  })
  await generate(racing)
  expect(racing).toHaveBeenCalledExactlyOnceWith('racing.html', [
    expect.objectContaining({ path: 'racing.html' }),
  ])
  expect(render).toHaveBeenCalledExactlyOnceWith('latest.html', [
    expect.objectContaining({ path: 'latest.html' }),
  ])
  await expectImage(await send(publicPreview), newerJpeg)
  expect(await (await send(`${publicUrl}latest.html`)).text()).toBe('<h1>Third head</h1>')
})

it('keeps the newer attempt’s cover when an expired attempt finishes on the same revision', async () => {
  const { call, generate, send } = await fixture()
  await call('publish', {
    slug,
    mode: 'replace',
    files: [{ path: 'index.html', content: '<h1>Unchanged head</h1>' }],
  })
  await call('set_visibility', { slug, visibility: 'public' })

  const now = Date.now()
  const tooSoon = vi.fn<Renderer>(async () => jpeg)
  const fresh = vi.fn<Renderer>(async () => newerJpeg)
  const expired = vi.fn<Renderer>(async () => {
    await generate(tooSoon, now + 119_999)
    await generate(fresh, now + 120_001)
    return jpeg
  })
  await generate(expired, now)

  expect(expired).toHaveBeenCalledTimes(1)
  expect(tooSoon).not.toHaveBeenCalled()
  expect(fresh.mock.calls).toEqual(expired.mock.calls)
  await expectImage(await send(publicPreview), newerJpeg)
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1 })
})

it('retries when a delete and restore temporarily hide the claimed revision’s manifest', async () => {
  const { call, core, generate, owner, send } = await fixture()
  const html = '<h1>Restored report</h1>'
  await call('publish', { slug, mode: 'replace', files: [{ path: 'index.html', content: html }] })
  await call('set_visibility', { slug, visibility: 'public' })
  const detail = await owner.request(`/artefacts/${slug}`)
  expect(detail.status).toBe(200)
  const artefactId = formValue(await detail.text(), 'artefactId')
  const { DB: db } = core.env
  let manifestRows: number | undefined
  let restoreStatus: number | undefined
  const interleavedDb = {
    batch: db.batch.bind(db),
    prepare(sql: string) {
      const statement = db.prepare(sql)
      if (!sql.includes('SELECT f.path, f.sha256, f.size')) return statement
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values)
          return {
            async all<T>() {
              await call('delete_artefact', { slug })
              const result = await bound.all<T>()
              manifestRows = result.results.length
              const restore = await owner.post('/admin/deleted', { action: 'restore', slug, artefactId })
              restoreStatus = restore.status
              return result
            },
          }
        },
      } as D1PreparedStatement
    },
  } as D1Database

  const now = Date.now()
  const render = vi.fn<Renderer>(async () => jpeg)
  await generateCovers({ ...core, env: { ...core.env, DB: interleavedDb } }, render, now)
  expect(manifestRows).toBe(0)
  expect(restoreStatus).toBe(303)
  expect(render).not.toHaveBeenCalled()
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1 })
  expect(await (await send(publicUrl)).text()).toBe(html)
  expect((await send(publicPreview)).status).toBe(404)

  await generate(render, now + 5 * 60 * 1000)
  expect(render).toHaveBeenCalledTimes(1)
  await expectImage(await send(publicPreview), jpeg)
})

it('keeps publishing and reading available when the renderer fails, then retries after a delay', async () => {
  const { call, generate, send } = await fixture()
  const html = '<h1>Still readable</h1>'
  expect(
    await call('publish', { slug, mode: 'replace', files: [{ path: 'index.html', content: html }] }),
  ).toEqual({ revision: 1, url: publicUrl })
  await call('set_visibility', { slug, visibility: 'public' })
  const fail = vi.fn<Renderer>().mockRejectedValue(new Error('Test renderer failed'))
  const now = Date.now()
  await generate(fail, now)
  expect(fail).toHaveBeenCalledTimes(1)
  expect((await send(publicPreview)).status).toBe(404)
  expect(await (await send(publicUrl)).text()).toBe(html)
  expect(await call('get_artefact', { slug })).toMatchObject({ revision: 1, url: publicUrl })

  const recover = vi.fn<Renderer>().mockResolvedValue(jpeg)
  await generate(recover, now + 1)
  expect(recover).not.toHaveBeenCalled()
  expect((await send(publicPreview)).status).toBe(404)
  await generate(recover, now + 24 * 60 * 60 * 1000)
  expect(recover).toHaveBeenCalledTimes(1)
  await expectImage(await send(publicPreview), jpeg)
})

it('renders at most one missing HTML cover per pass and leaves non-HTML entries alone', async () => {
  const { call, generate, send } = await fixture()
  for (const [slug, path] of [
    ['first', 'first.html'],
    ['second', 'second.html'],
    ['text', 'readme.txt'],
  ]) {
    await call('publish', { slug, mode: 'replace', files: [{ path, content: 'Report' }] })
    await call('set_visibility', { slug, visibility: 'public' })
  }

  const render = vi.fn<Renderer>(async () => jpeg)
  await generate(render)
  expect(render).toHaveBeenCalledTimes(1)
  await generate(render)
  expect(render.mock.calls.map(([entry]) => entry).sort()).toEqual(['first.html', 'second.html'])
  await generate(render)
  expect(render).toHaveBeenCalledTimes(2)
  for (const slug of ['first', 'second']) {
    await expectImage(await send(`${read}/_forge/preview/${slug}`), jpeg)
  }
  expect((await send(`${read}/_forge/preview/text`)).status).toBe(404)
})

it('advances through more than one page of soft-deleted due jobs to render a live head', async () => {
  const { call, generate, send } = await fixture()
  await call('publish', {
    slug,
    mode: 'replace',
    files: [{ path: 'index.html', content: '<h1>Live report</h1>' }],
  })
  await call('set_visibility', { slug, visibility: 'public' })

  const { DB: db } = configuredEnv()
  const now = Date.now()
  await db.batch([
    db
      .prepare(`WITH RECURSIVE n(value) AS (VALUES (1) UNION ALL SELECT value + 1 FROM n WHERE value < 129)
        INSERT INTO artefacts
          (id, slug, title, visibility, current_revision, created_by, created_at, updated_at, deleted_at)
        SELECT 'stale-' || value, 'stale-' || value, 'Deleted report', 'public', 1, a.created_by, 0, 0, ?1
        FROM n CROSS JOIN artefacts AS a WHERE a.slug = ?2`)
      .bind(now - 1, slug),
    db.prepare(`INSERT INTO revisions (artefact_id, number, created_by, created_at)
      SELECT id, current_revision, created_by, created_at FROM artefacts WHERE slug LIKE 'stale-%'`),
    db
      .prepare(`INSERT INTO generated_covers (artefact_id, revision, retry_at)
        SELECT id, current_revision, ? FROM artefacts WHERE slug LIKE 'stale-%'`)
      .bind(now - 1),
  ])

  const render = vi.fn<Renderer>(async () => jpeg)
  await generate(render, now)
  expect(render).not.toHaveBeenCalled()
  expect((await send(publicPreview)).status).toBe(404)

  await generate(render, now + 5 * 60 * 1000)
  expect(render).toHaveBeenCalledExactlyOnceWith('index.html', [
    expect.objectContaining({ path: 'index.html' }),
  ])
  await expectImage(await send(publicPreview), jpeg)
})
