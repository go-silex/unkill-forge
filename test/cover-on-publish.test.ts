import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
import { coverCron } from '../src/core/generated-covers'
import { renderCover } from '../src/cover-renderer'
import worker from '../src/index'
import {
  admin,
  configuredEnv,
  flashNavigation,
  type Handle,
  listedId,
  location,
  manage,
  read,
  runtime,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

vi.mock('../src/cover-renderer', () => ({ renderCover: vi.fn() }))

setupStorage()
setupOidc()

const overrides = { PUBLIC_INDEX: 'true' }
const browser = {} as BrowserRun // Only presence is relevant; the renderer adapter is mocked.
const render = vi.mocked(renderCover)
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])
const replacementJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd9])
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X+uoAAAAASUVORK5CYII='
const preview = (slug: string) => `${read}/_forge/preview/${slug}`
const htmlFile = (path: string) => ({ path, content: `<h1>${path}</h1>` })

beforeEach(() => {
  render.mockReset().mockResolvedValue(jpeg)
})

async function fixture() {
  const env = configuredEnv({ ...overrides, COVER_BROWSER: browser })
  const send: Handle = async (path, init) => {
    const ctx = createExecutionContext()
    const response = await worker.fetch(new Request(new URL(path, manage), init), env, ctx)
    await waitOnExecutionContext(ctx)
    return response
  }
  const withoutBrowser = runtime(overrides)
  const owner = await mockProvider().signedIn(send, admin)
  const name = 'Cover publisher'
  expect((await owner.post('/admin/bots', { action: 'create', name, role: 'publisher' })).status).toBe(303)
  const id = await listedId(owner, '/admin/members', name)
  const tokenResponse = await owner.post('/admin/bots', { action: 'token', id, name: 'Cover tests' })
  expect(tokenResponse.status).toBe(303)
  const tokenPage = await owner.request(location(tokenResponse), { headers: flashNavigation })
  const token = /<code>(fgt_[A-Za-z0-9_-]+)<\/code>/.exec(await tokenPage.text())?.[1]
  if (!token) throw new Error('Expected a bot token')

  async function call(name: string, args: object, transport = send): Promise<unknown> {
    const response = await transport('/mcp', {
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
    const { result } = await response.json<{
      result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
    }>()
    return result.isError ? JSON.parse(result.content[0].text) : result.structuredContent
  }

  async function publish(
    slug: string,
    files: { path: string; content: string; encoding?: 'base64' }[],
    expectedRevision: number,
    transport = send,
  ) {
    return call('publish', { slug, mode: 'replace', files, expectedRevision }, transport)
  }

  async function makePublic(slug: string) {
    expect(await call('set_visibility', { slug, visibility: 'public' })).toEqual({ visibility: 'public' })
  }

  return { env, send, withoutBrowser, publish, makePublic }
}

function trackRequest(env: Env, ctx = createExecutionContext()) {
  const waitUntil = vi.spyOn(ctx, 'waitUntil')
  const send: Handle = (path, init) => worker.fetch(new Request(new URL(path, manage), init), env, ctx)
  return { send, waitUntil, drain: () => waitOnExecutionContext(ctx) }
}

async function expectCover(response: Response, bytes: Uint8Array, type = 'image/jpeg') {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe(type)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
}

it('generates a cover in the publish background for only the exact committed head, without cron', async () => {
  const { env, send, withoutBrowser, publish, makePublic } = await fixture()
  expect(await publish('backfill', [htmlFile('backfill.html')], 0, withoutBrowser)).toMatchObject({
    revision: 1,
  })
  await makePublic('backfill')
  expect(await publish('report', [htmlFile('first.html')], 0)).toMatchObject({ revision: 1 })
  await makePublic('report')
  await expectCover(await send(preview('report')), jpeg)

  // Put an older job first in the recovery queue so a global sweep cannot accidentally pass.
  await env.DB.prepare(
    `INSERT INTO generated_covers (artefact_id, revision, retry_at)
      SELECT id, current_revision, 0 FROM artefacts WHERE slug = 'backfill'`,
  ).run()
  const capture = Promise.withResolvers<typeof replacementJpeg>()
  render.mockClear().mockReturnValue(capture.promise)
  const background = trackRequest(env)
  try {
    expect(await publish('report', [htmlFile('latest.html')], 1, background.send)).toEqual({
      revision: 2,
      url: `${read}/a/report/latest.html`,
    })
    expect((await send(preview('report'))).status).toBe(404)
  } finally {
    capture.resolve(replacementJpeg)
    await background.drain()
  }
  expect(background.waitUntil).toHaveBeenCalled()
  expect(render).toHaveBeenCalledExactlyOnceWith(browser, env.BLOBS, 'latest.html', [
    expect.objectContaining({ path: 'latest.html' }),
  ])
  await expectCover(await send(preview('report')), replacementJpeg)
  expect((await send(preview('backfill'))).status).toBe(404)
})

it('returns the publish receipt and serves the new head when cover registration throws', async () => {
  const { env, send, withoutBrowser, publish, makePublic } = await fixture()
  expect(await publish('report', [htmlFile('first.html')], 0, withoutBrowser)).toMatchObject({
    revision: 1,
  })
  await makePublic('report')

  const ctx = createExecutionContext()
  const register = ctx.waitUntil.bind(ctx)
  const background = trackRequest(env, ctx)
  let unregistered: Promise<unknown> | undefined
  background.waitUntil
    .mockImplementationOnce(register) // Let the entry-cache write register normally.
    .mockImplementationOnce((work) => {
      unregistered = work
      throw new Error('Test cover registration failed')
    })
  const entry = htmlFile('latest.html')
  const url = `${read}/a/report/latest.html`
  try {
    expect(await publish('report', [entry], 1, background.send)).toEqual({ revision: 2, url })
  } finally {
    await Promise.all([background.drain(), unregistered])
  }
  expect(background.waitUntil).toHaveBeenCalledTimes(2)
  const response = await send(url)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(entry.content)
})

it('renders a matching, never-attempted head even when cron discovered it at a later time', async () => {
  const { env, send, publish, makePublic } = await fixture()
  // Interleave just the discovery write with the commit, before publish can claim the head.
  await env.DB.prepare(`CREATE TRIGGER discover_report_cover AFTER UPDATE OF current_revision ON artefacts
    WHEN NEW.slug = 'report'
    BEGIN
      INSERT INTO generated_covers (artefact_id, revision, retry_at, attempts)
        VALUES (NEW.id, NEW.current_revision, NEW.updated_at + 60000, 0);
    END`).run()

  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    expect(await publish('report', [htmlFile('index.html')], 0)).toMatchObject({ revision: 1 })
  } finally {
    clock.mockRestore()
  }
  await makePublic('report')
  await expectCover(await send(preview('report')), jpeg)
})

it('does not schedule cover generation when expectedRevision rejects a publish', async () => {
  const { env, send, withoutBrowser, publish, makePublic } = await fixture()
  const current = htmlFile('current.html')
  expect(await publish('report', [current], 0, withoutBrowser)).toMatchObject({ revision: 1 })
  await makePublic('report')
  const background = trackRequest(env)
  expect(await publish('report', [htmlFile('rejected.html')], 0, background.send)).toMatchObject({
    error: 'conflict',
    currentRevision: 1,
  })
  await background.drain()
  expect(background.waitUntil).not.toHaveBeenCalled()
  expect(render).not.toHaveBeenCalled()
  expect(await (await send(`${read}/a/report/current.html`)).text()).toBe(current.content)
  expect((await send(preview('report'))).status).toBe(404)
})

it('serves a valid supplied cover without rendering on publish', async () => {
  const { send, publish, makePublic } = await fixture()
  expect(
    await publish(
      'report',
      [htmlFile('index.html'), { path: 'og.png', content: png, encoding: 'base64' }],
      0,
    ),
  ).toMatchObject({ revision: 1 })
  await makePublic('report')
  expect(render).not.toHaveBeenCalled()
  const supplied = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
  await expectCover(await send(preview('report')), supplied, 'image/png')
})

it('leaves the publish successful after a render failure and recovers the cover on cron', async () => {
  const { env, send, publish, makePublic } = await fixture()
  const entry = htmlFile('index.html')
  const url = `${read}/a/report/`
  const attemptTime = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(attemptTime)
  render.mockRejectedValueOnce(new Error('Test renderer failed'))
  try {
    expect(await publish('report', [entry], 0)).toEqual({ revision: 1, url })
    expect(render).toHaveBeenCalledTimes(1)
    await makePublic('report')
    expect(await (await send(url)).text()).toBe(entry.content)
    expect((await send(preview('report'))).status).toBe(404)

    for (const elapsed of [120_001, 299_999]) {
      const tooSoon = attemptTime + elapsed
      clock.mockReturnValue(tooSoon)
      await worker.scheduled(createScheduledController({ cron: coverCron, scheduledTime: tooSoon }), env)
      expect(render).toHaveBeenCalledTimes(1)
      expect((await send(preview('report'))).status).toBe(404)
    }

    const retryTime = attemptTime + 300_000
    clock.mockReturnValue(retryTime)
    await worker.scheduled(createScheduledController({ cron: coverCron, scheduledTime: retryTime }), env)
  } finally {
    clock.mockRestore()
  }
  expect(render).toHaveBeenCalledTimes(2)
  await expectCover(await send(preview('report')), jpeg)
})
