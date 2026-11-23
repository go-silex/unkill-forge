import { env } from 'cloudflare:test'
import { base64url } from 'jose'
import { expect, it } from 'vitest'
import type { Env } from '../src/config'
import { hashSecret } from '../src/core'
import {
  admin,
  Browser,
  formValue,
  type Handle,
  listedId,
  location,
  manage,
  mcpCall,
  navigation,
  provider,
  read,
  runtime,
  setupStorage,
  whoami,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()
const { DB: db, BLOBS: blobs } = env as typeof env & Pick<Env, 'DB' | 'BLOBS'>
const slug = 'quarterly'
const detail = `/artefacts/${slug}`
const deleted = '/admin/deleted'
const redirects = '/admin/redirects'
const tokens = '/tokens'
const members = '/admin/members'
const bots = '/admin/bots'
const tokenPattern = /<code>(fgt_[A-Za-z0-9_-]{43})<\/code>/

async function post(browser: Browser, path: string, values: Record<string, string>) {
  const response = await browser.post(path, values)
  expect(response.status).toBe(303)
  const destination = location(response)
  expect(destination.origin).toBe(manage)
  expect(destination.href).not.toMatch(/fgt_|\/invite\/|\/s\//)
  return html(browser, destination)
}

async function html(browser: Browser, path: string | URL, status = 200) {
  const response = await browser.request(path)
  expect(response.status).toBe(status)
  return response.text()
}

async function issueToken(browser: Browser, name: string) {
  const text = await post(browser, tokens, { action: 'create', name })
  const token = tokenPattern.exec(text)?.[1]
  expect(token).toBeDefined()
  if (!token) throw new Error('A new token should appear on the redirect')
  return token
}

async function publish(
  send: Handle,
  token: string,
  name: string,
  title: string,
  count = 1,
  entry = '<h1>Report</h1>',
) {
  const response = await send('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'publish',
        arguments: {
          slug: name,
          title,
          mode: 'replace',
          files: [
            { path: 'index.html', content: entry },
            ...Array.from({ length: count - 1 }, (_, i) => ({
              path: `asset-${i}.txt`,
              content: `Different bytes ${i}`,
            })),
          ],
        },
      },
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    result: { structuredContent: { revision: expect.any(Number) } },
  })
}

it('refuses every browser mutation without the manage origin and refuses insufficient live roles', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const viewer = await idp.signedIn(send, 'viewer')
  const publisher = await idp.signedIn(send, 'publisher')
  const publisherId = await listedId(owner, members, 'publisher@example.test')
  await post(owner, members, { action: 'role', id: publisherId, role: 'publisher' })
  const token = await issueToken(owner, 'Fixture token')
  await publish(send, token, slug, 'Quarterly report')
  const id = crypto.randomUUID()
  const mutations = [
    [detail, { action: 'restore-revision', revision: '1' }],
    [detail, { action: 'visibility', visibility: 'public' }],
    [detail, { action: 'create-share', label: 'Test share' }],
    [detail, { action: 'reveal-share', id }],
    [detail, { action: 'revoke-share', id }],
    [detail, { action: 'rename', slug: 'modified' }],
    [detail, { action: 'delete' }],
    [tokens, { action: 'create', name: 'Forbidden' }],
    [tokens, { action: 'revoke', id }],
  ] as const
  const adminOnly = [
    [deleted, { action: 'restore', slug }],
    [deleted, { action: 'purge', id }],
    [redirects, { action: 'add', fromPrefix: '/a/alias/', toPrefix: `/a/${slug}/` }],
    [redirects, { action: 'remove', fromPrefix: '/a/alias/' }],
    [members, { action: 'admit', id, role: 'viewer' }],
    [members, { action: 'role', id, role: 'publisher' }],
    [members, { action: 'remove', id }],
    [members, { action: 'reinstate', id }],
    [members, { action: 'create-invite', role: 'viewer' }],
    [members, { action: 'revoke-invite', id: 'D'.repeat(43) }],
    [bots, { action: 'create', name: 'Forbidden', role: 'viewer' }],
    [bots, { action: 'token', id, name: 'Forbidden' }],
    [bots, { action: 'revoke', id }],
  ] as const
  for (const [path, values] of [...mutations, ...adminOnly]) {
    expect((await viewer.post(path, values)).status, `viewer ${path} ${values.action}`).toBe(403)
    for (const origin of [undefined, read, 'https://unrelated.example']) {
      const response = await owner.request(path, {
        method: 'POST',
        headers: origin ? { origin } : undefined,
        body: new URLSearchParams(values),
      })
      expect(response.status, `${origin} ${path} ${values.action}`).toBe(403)
    }
  }
  for (const [path, values] of adminOnly)
    expect((await publisher.post(path, values)).status, `publisher ${path} ${values.action}`).toBe(403)
  for (const path of [deleted, redirects, members, bots]) {
    expect((await viewer.request(path)).status).toBe(403)
    expect((await publisher.request(path)).status).toBe(403)
    expect(await html(publisher, '/artefacts')).not.toContain(`href="${path}"`)
  }
  expect(await html(viewer, '/artefacts')).not.toContain(`href="${tokens}"`)
  expect(await html(publisher, '/artefacts')).toContain(`href="${tokens}"`)
  expect((await viewer.request(tokens)).status).toBe(403)
  expect((await viewer.request(detail)).status).toBe(200)
  expect((await publisher.post(detail, { action: 'create-share', key: 'supplied-key-1234' })).status).toBe(
    403,
  )
  expect(await html(owner, detail)).toContain('Quarterly report')
  await post(owner, members, { action: 'role', id: publisherId, role: 'viewer' })
  expect((await publisher.post(detail, { action: 'visibility', visibility: 'public' })).status).toBe(403)
})

it('shows a personal token exactly once, stores its hash, records use and enforces ownership', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const publisher = await idp.signedIn(send, 'publisher')
  const member = await listedId(owner, members, 'publisher@example.test')
  await post(owner, members, { action: 'role', id: member, role: 'publisher' })
  const token = await issueToken(publisher, 'Terminal token')
  expect(await html(publisher, tokens)).not.toContain(token)
  expect(await html(owner, tokens)).not.toContain('Terminal token')
  const row = await db
    .prepare('SELECT id, token_hash AS hash, last_used_at AS used FROM api_tokens WHERE member_id = ?')
    .bind(member)
    .first<{ id: string; hash: string; used: number | null }>()
  expect(row).toEqual({ id: expect.any(String), hash: await hashSecret(token), used: null })
  if (!row) throw new Error('Expected a persisted token hash')
  expect((await whoami(send, token)).id).toBe(member)
  const used = await db
    .prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
    .bind(row.id)
    .first<number>('last_used_at')
  if (used === null) throw new Error('Expected a timestamp after using the token')
  const list = await html(publisher, tokens)
  expect(list).toContain(new Date(used).toISOString())
  expect(list).not.toContain(token)
  await post(owner, tokens, { action: 'revoke', id: row.id })
  await post(owner, bots, { action: 'revoke', id: row.id })
  expect((await mcpCall(send, token)).status).toBe(200)
  expect(await post(publisher, tokens, { action: 'revoke', id: row.id })).toContain('Token revoked.')
  expect((await mcpCall(send, token)).status).toBe(401)
  const overloaded = await publisher.post(tokens, { action: 'create', name: 'a'.repeat(40_000) })
  expect(overloaded.status).toBe(400)
})

it('searches by slug or title prefix with visibility and keeps a stable pagination cursor', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Search publisher')
  await publish(send, token, slug, 'Reports quarterly')
  await publish(send, token, 'recent', 'Quarterly briefs')
  await publish(send, token, 'other', 'Midyear quarterly summaries')
  await post(owner, '/artefacts/recent', { action: 'visibility', visibility: 'public' })
  const list = await html(owner, '/artefacts?q=quarterly')
  expect(list).toContain('Reports quarterly')
  expect(list).toContain('Quarterly briefs')
  expect(list).not.toContain('Midyear quarterly summaries')
  const publicOnly = await html(owner, '/artefacts?q=quarterly&visibility=public')
  expect(publicOnly).toContain('Quarterly briefs')
  expect(publicOnly).not.toContain('Reports quarterly')
  await db
    .prepare(`INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
    SELECT printf('12345678-1234-4123-8123-%012d', value), printf('quarterly-fixture-%02d', value), 'Bulk row', 'private',
    current_revision, created_by, created_at, updated_at - 1 FROM artefacts, json_each(?) WHERE slug = ?`)
    .bind(JSON.stringify(Array.from({ length: 50 }, (_, i) => i)), slug)
    .run()
  const first = await html(owner, '/artefacts?q=quarterly&visibility=private')
  const next = /href="([^"]+)"[^>]*>Next page<\/a>/.exec(first)?.[1]?.replaceAll('&amp;', '&')
  if (!next) throw new Error('Expected a next page link')
  const second = await html(owner, new URL(next, manage))
  expect(first).toContain('quarterly-fixture-48')
  expect(first).not.toContain('quarterly-fixture-49')
  expect(second).toContain('quarterly-fixture-49')
  expect(second).not.toContain('quarterly-fixture-48')
})

it('restores a revision, reveals and revokes share links, then renames and restores the deleted artefact', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Revision publisher')
  await publish(send, token, slug, 'Quarterly report', 1, '<p>Original version</p>')
  await publish(send, token, slug, 'Quarterly report', 1, '<p>Revised version</p>')
  const first = await post(owner, detail, { action: 'create-share', label: 'Early readers' })
  const url = /<code>(https:\/\/read\.forge\.example\/s\/quarterly\/[A-Za-z0-9_-]+\/)<\/code>/.exec(
    first,
  )?.[1]
  if (!url) throw new Error('Expected a share URL in the flash')
  expect(first).toContain('data-copy')
  expect(await html(owner, detail)).not.toContain(url)
  const shareId = await db.prepare('SELECT id FROM share_links').first<string>('id')
  if (!shareId) throw new Error('Expected a share link ID')
  expect(await post(owner, detail, { action: 'reveal-share', id: shareId })).toContain(url)
  expect(await (await send(url)).text()).toBe('<p>Revised version</p>')
  await post(owner, detail, { action: 'restore-revision', revision: '1' })
  expect(await (await send(url)).text()).toBe('<p>Original version</p>')
  await post(owner, detail, { action: 'revoke-share', id: shareId })
  expect((await send(url)).status).toBe(404)
  await post(owner, detail, { action: 'visibility', visibility: 'public' })
  await post(owner, detail, { action: 'rename', slug: 'renamed-report' })
  expect(location(await send(`${read}/a/${slug}/`)).pathname).toBe('/a/renamed-report/')
  await post(owner, redirects, {
    action: 'add',
    fromPrefix: '/a/report-alias/',
    toPrefix: '/a/renamed-report/',
  })
  expect(location(await send(`${read}/a/report-alias/`)).pathname).toBe('/a/renamed-report/')
  expect(await html(owner, redirects)).toContain('/a/report-alias/')
  await post(owner, redirects, { action: 'remove', fromPrefix: '/a/report-alias/' })
  expect((await send(`${read}/a/report-alias/`)).status).toBe(404)
  await post(owner, '/artefacts/renamed-report', { action: 'delete' })
  expect((await send(`${read}/a/renamed-report/`)).status).toBe(404)
  expect(await html(owner, deleted)).toContain('Quarterly report')
  await post(owner, deleted, { action: 'restore', slug: 'renamed-report' })
  expect(await (await send(`${read}/a/renamed-report/`)).text()).toBe('<p>Original version</p>')
})

it('continues an interrupted purge after its artefact row has already been removed', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Purge fixture')
  await publish(send, token, slug, 'Purge this artefact', 65)
  const before = await blobs.list({ prefix: 'blobs/' })
  expect(before.objects).toHaveLength(65)
  await post(owner, detail, { action: 'delete' })
  const id = formValue(await html(owner, deleted), 'id')
  const intermediate = await post(owner, deleted, { action: 'purge', id })
  expect(intermediate).toContain('Continue purge')
  expect(intermediate).not.toContain('Restore artefact')
  expect((await blobs.list({ prefix: 'blobs/' })).objects).toHaveLength(1)
  const finished = await post(owner, deleted, { action: 'purge', id })
  expect(finished).toContain('Artefact permanently purged.')
  expect(finished).not.toContain('Continue purge')
  expect((await blobs.list({ prefix: 'blobs/' })).objects).toHaveLength(0)
})

it.each(['en', 'fr'] as const)(
  'renders every admin and read page in %s and serves configured branding',
  async (locale) => {
    const french = locale === 'fr'
    const send = runtime({
      LOCALE: locale,
      FORGE_NAME: 'Ember Studio',
      BRAND: '{"accent":"#123a6f","landingText":"Ember landing"}',
      ALLOW_DCR: 'true',
      AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]),
    })
    const idp = mockProvider()
    const owner = await idp.signedIn(send, admin)
    const pending = await idp.signedIn(send, 'awaiting-approval')
    const anonymous = new Browser(send)
    const token = await issueToken(owner, 'Locale test')
    await publish(send, token, slug, 'Quarterly report')
    const pages = [
      [anonymous, '/login', 'Sign in', 'Se connecter'],
      [pending, '/', 'Pending access', 'Accès en attente'],
      [owner, '/', 'Manage', 'Gestion'],
      [owner, '/artefacts', 'Start of title or slug', 'Début du titre ou de l’identifiant'],
      [owner, detail, 'Open artefact', 'Ouvrir l’artefact'],
      [owner, deleted, 'Deleted artefacts', 'Artefacts supprimés'],
      [owner, tokens, 'Last used', 'Dernière utilisation'],
      [owner, redirects, 'Source prefix', 'Préfixe source'],
      [owner, members, 'Invite links', 'Liens d’invitation'],
      [owner, bots, 'Create bot', 'Créer un robot'],
      [owner, '/connect', 'MCP endpoint', 'Point d’accès MCP'],
    ] as const
    for (const [browser, path, en, fr] of pages) {
      const document = await html(browser, path)
      expect(document, path).toContain(french ? fr : en)
      expect(document, path).toContain(`lang="${locale}"`)
      expect(document, path).toContain('Ember Studio')
    }
    const sample = await html(owner, detail)
    expect(sample).toContain('src="/logo.svg"')
    expect(sample).toContain('href="/favicon.svg"')
    if (french)
      for (const english of [
        'Open artefact',
        'Files',
        'Current revision',
        'Create share link',
        'Sign out',
        'Delete artefact',
        'New slug',
      ])
        expect(sample).not.toContain(english)
    const css = await send('/style.css')
    expect(await css.text()).toContain('--brand-accent:#123a6f')
    for (const origin of [read, manage]) {
      const icon = await send(`${origin}/favicon.svg`)
      expect(icon.headers.get('Content-Type')).toContain('image/svg+xml')
      expect(await icon.text()).toContain('<svg')
    }
    const landing = await html(anonymous, `${read}/`)
    expect(landing).toContain('Ember landing')
    expect(landing).toContain('href="/favicon.svg"')
    expect(await html(anonymous, `${read}/missing`, 404)).toContain(french ? 'Page introuvable' : 'Not found')

    const privateUrl = `${read}/a/${slug}/`
    const reader = new Browser(send)
    const start = await reader.request(privateUrl, { headers: navigation })
    expect(start.status).toBe(302)
    const handoff = await pending.request(location(start), { headers: navigation })
    expect(handoff.status).toBe(200)
    const handoffHtml = await handoff.text()
    expect(handoffHtml).toContain(french ? 'Continuer vers Forge' : 'Continue to Forge')
    const handoffFields = (document: string) =>
      new URLSearchParams(
        Object.fromEntries(
          ['code', 'state', 'nonce', 'return'].map((key) => [key, formValue(document, key)]),
        ),
      )
    const fields = handoffFields(handoffHtml)
    const complete = await reader.request(`${read}/_forge/session`, {
      method: 'POST',
      headers: { origin: manage },
      body: fields,
    })
    expect(complete.status).toBe(303)
    expect(await html(reader, privateUrl)).toContain(french ? 'Accès en attente' : 'Pending access')
    const next = await new Browser(send).request(privateUrl, { headers: navigation })
    const nextHandoff = await pending.request(location(next), { headers: navigation })
    const retry = await anonymous.request(`${read}/_forge/session`, {
      method: 'POST',
      headers: { origin: manage },
      body: handoffFields(await nextHandoff.text()),
    })
    expect(retry.status).toBe(400)
    expect(await retry.text()).toContain(french ? 'Réessayer de se connecter' : 'Try signing in again')

    const register = await send('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Locale test client',
        token_endpoint_auth_method: 'none',
        redirect_uris: ['https://client.example/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    expect(register.status).toBe(201)
    const { client_id } = await register.json<{ client_id: string }>()
    const authorize = `/authorize?${new URLSearchParams({
      client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
      code_challenge_method: 'S256',
      resource: `${manage}/mcp`,
      scope: 'mcp',
    })}`
    expect(await html(owner, authorize)).toContain(french ? 'Autoriser' : 'Allow')
  },
)

it('fails closed on invalid locale or unsafe brand data', async () => {
  expect((await runtime({ LOCALE: 'de' })('/login')).status).toBe(503)
  expect(
    (await runtime({ BRAND: '{"accent":"red; background: url(https://example.test)"}' })('/login')).status,
  ).toBe(503)
})
