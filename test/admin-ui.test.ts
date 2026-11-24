import { env } from 'cloudflare:test'
import { createHash } from 'node:crypto'
import { base64url } from 'jose'
import { expect, it, vi } from 'vitest'
import type { Env } from '../src/config'
import { hashSecret } from '../src/core'
import { createOwnToken, revokeOwnToken } from '../src/core/admin'
import { catalogueCountLimit } from '../src/core/catalogue'
import { Action, Avatar, time } from '../src/manage/ui/page'
import {
  admin,
  Browser,
  flashNavigation,
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
  const page = await browser.request(destination, { headers: flashNavigation })
  expect(page.status).toBe(200)
  return page.text()
}

async function html(browser: Browser, path: string | URL, status = 200) {
  const response = await browser.request(path)
  expect(response.status).toBe(status)
  return response.text()
}

async function artefactId(browser: Browser, path = detail) {
  return formValue(await html(browser, path), 'artefactId')
}

function sheets(document: string) {
  const panels = Array.from(
    document.matchAll(
      /<div id="(forge-sheet-[a-z0-9_-]+)" class="forge-sheet"([^>]*)>(.*?<\/form>)<\/div>/gs,
    ),
    ([, id, attributes, contents]) => {
      expect(attributes).toMatch(/\bpopover(?:="(?:auto)?")?(?=\s|$)/)
      const kind = /role="(alertdialog|dialog)"/.exec(attributes)?.[1]
      expect(kind).toBeDefined()
      expect(attributes).toContain(`aria-labelledby="${id}-title"`)
      if (kind === 'alertdialog' || attributes.includes('aria-describedby')) {
        expect(attributes).toContain(`aria-describedby="${id}-body"`)
        expect(contents).toContain(`<p id="${id}-body" class="forge-sheet__body">`)
      }
      expect(document).toMatch(new RegExp(`<button[^>]*type="button"[^>]*popovertarget="${id}">`))
      expect(contents).toContain(`<h2 id="${id}-title" class="forge-sheet__title">`)
      const form = /<form class="forge-sheet__actions" method="post"[^>]*>(.*?)<\/form>/s.exec(contents)?.[1]
      if (!form) throw new Error('Expected a sheet POST form')
      expect(form).toMatch(
        new RegExp(
          `<button[^>]*type="button"[^>]*popovertarget="${id}"[^>]*popovertargetaction="hide"[^>]* autofocus`,
        ),
      )
      const action = /<button[^>]*type="submit"[^>]*name="action" value="([^"]+)"/.exec(form)?.[1]
      if (!action) throw new Error('Expected a sheet submit button')
      expect(form).toContain(
        `class="forge-button forge-button--${kind === 'alertdialog' ? 'danger-solid' : 'primary'}"`,
      )
      return { id, contents, form, action, kind }
    },
  )
  expect(new Set(panels.map(({ id }) => id)).size).toBe(panels.length)
  return panels
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
  const selectedId = await artefactId(owner)
  const id = crypto.randomUUID()
  const mutations = [
    [detail, { action: 'restore-revision', revision: '1', artefactId: selectedId }],
    [detail, { action: 'visibility', visibility: 'public', artefactId: selectedId }],
    [detail, { action: 'access', access: 'shared', artefactId: selectedId }],
    [detail, { action: 'create-share', label: 'Test share', artefactId: selectedId }],
    [detail, { action: 'reveal-share', id }],
    [detail, { action: 'revoke-share', id }],
    [detail, { action: 'rename', slug: 'modified', artefactId: selectedId }],
    [detail, { action: 'delete', artefactId: selectedId }],
    [tokens, { action: 'create', name: 'Forbidden' }],
    [tokens, { action: 'revoke', id }],
  ] as const
  const adminOnly = [
    [deleted, { action: 'restore', slug, artefactId: selectedId }],
    [deleted, { action: 'purge', slug, id: selectedId }],
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
  }
  for (const [browser, name, role, expected] of [
    [
      viewer,
      'viewer',
      'viewer',
      [
        ['Content', ['/artefacts']],
        ['My account', ['/connect']],
      ],
    ],
    [
      publisher,
      'publisher',
      'publisher',
      [
        ['Content', ['/artefacts']],
        ['My account', ['/connect', tokens]],
      ],
    ],
    [
      owner,
      admin,
      'admin',
      [
        ['Content', ['/artefacts', deleted, redirects]],
        ['Access', [members, bots]],
        ['My account', ['/connect', tokens]],
      ],
    ],
  ] as const) {
    const catalogue = await html(browser, '/artefacts')
    const menus = [...catalogue.matchAll(/<nav class="forge-nav"[^>]*>(.*?)<\/nav>/gs)]
    expect(menus).toHaveLength(2)
    for (const [, menu] of menus) {
      const groups = Array.from(
        menu.matchAll(/<section class="forge-nav__group" aria-label="([^"]+)">(.*?)<\/section>/gs),
        ([, label, section]) => [label, [...section.matchAll(/href="([^"]+)"/g)].map(([, href]) => href)],
      )
      expect(groups).toEqual(expected)
    }
    const accounts = [...catalogue.matchAll(/<div class="forge-account">(.*?)<\/div>/gs)]
    expect(accounts).toHaveLength(2)
    for (const [, account] of accounts) {
      expect(account).toContain(`<span class="forge-account__name">${name}</span>`)
      expect(account).toContain(`<span class="forge-account__role">${role}</span>`)
      expect(account).toContain('action="/logout" method="post"')
    }
  }
  expect((await viewer.request(tokens)).status).toBe(403)
  expect((await viewer.request(detail)).status).toBe(200)
  const publisherDetail = await html(publisher, detail)
  expect(publisherDetail).toContain('forge-detail__aside')
  expect(publisherDetail).not.toContain('name="key"')
  expect(await html(owner, detail)).toContain('name="key"')
  expect(
    (
      await publisher.post(detail, {
        action: 'create-share',
        key: 'supplied-key-1234',
        artefactId: selectedId,
      })
    ).status,
  ).toBe(403)
  expect(await html(owner, detail)).toContain('Quarterly report')
  await post(owner, members, { action: 'role', id: publisherId, role: 'viewer' })
  expect(
    (await publisher.post(detail, { action: 'visibility', visibility: 'public', artefactId: selectedId }))
      .status,
  ).toBe(403)
})

it('shows a personal token exactly once, stores its hash, records use and enforces ownership', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const publisher = await idp.signedIn(send, 'publisher')
  await idp.signedIn(send, 'viewer')
  const viewer = await listedId(owner, members, 'viewer@example.test')
  expect(await createOwnToken(db, viewer, 'Denied direct issuance', Date.now())).toBeNull()
  expect(await db.prepare('SELECT id FROM api_tokens WHERE member_id = ?').bind(viewer).first()).toBeNull()
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
  const ownerId = await db
    .prepare('SELECT id FROM members WHERE email = ?')
    .bind(`${admin}@example.test`)
    .first<string>('id')
  if (!ownerId) throw new Error('Expected an authenticated administrator')
  expect(await revokeOwnToken(db, ownerId, row.id, Date.now())).toBe(false)
  expect(await db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').bind(row.id).first()).toEqual({
    revoked_at: null,
  })
  expect((await whoami(send, token)).id).toBe(member)
  const used = await db
    .prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
    .bind(row.id)
    .first<number>('last_used_at')
  if (used === null) throw new Error('Expected a timestamp after using the token')
  const list = await html(publisher, tokens)
  expect(list).toContain(`<time datetime="${new Date(used).toISOString()}"`)
  expect(list).not.toContain(token)
  await post(owner, tokens, { action: 'revoke', id: row.id })
  await post(owner, bots, { action: 'revoke', id: row.id })
  expect((await mcpCall(send, token)).status).toBe(200)
  expect(await post(publisher, tokens, { action: 'revoke', id: row.id })).toContain('Token revoked.')
  expect((await mcpCall(send, token)).status).toBe(401)
  const overloaded = await publisher.post(tokens, { action: 'create', name: 'a'.repeat(40_000) })
  expect(overloaded.status).toBe(400)
})

it('refuses direct token revocation by its owner after a publisher is downgraded to viewer', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const publisher = await idp.signedIn(send, 'publisher')
  const member = await listedId(owner, members, 'publisher@example.test')
  await post(owner, members, { action: 'role', id: member, role: 'publisher' })
  await issueToken(publisher, 'Downgrade fixture')
  const id = await db
    .prepare('SELECT id FROM api_tokens WHERE member_id = ?')
    .bind(member)
    .first<string>('id')
  if (!id) throw new Error('Expected publisher token')
  await post(owner, members, { action: 'role', id: member, role: 'viewer' })
  expect(await revokeOwnToken(db, member, id, Date.now())).toBe(false)
  expect(await db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').bind(id).first()).toEqual({
    revoked_at: null,
  })
})

it('searches by slug or title prefix with visibility and keeps a stable pagination cursor', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Search publisher')
  await publish(send, token, slug, 'Reports quarterly')
  await publish(send, token, 'recent', 'Quarterly briefs')
  await publish(send, token, 'other', 'Midyear quarterly summaries')
  const recentPath = '/artefacts/recent'
  await post(owner, recentPath, {
    action: 'visibility',
    visibility: 'public',
    artefactId: await artefactId(owner, recentPath),
  })
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
  const listFirst = await html(owner, '/artefacts?q=quarterly&visibility=private&view=list')
  const listNext = /href="([^"]+)"[^>]*>Next page<\/a>/.exec(listFirst)?.[1]?.replaceAll('&amp;', '&')
  expect(listNext && new URL(listNext, manage).searchParams.get('view')).toBe('list')
})

it('shows private artefacts with an active share link as shared and filters on that derived state', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Shared state publisher')
  await publish(send, token, 'notes', 'Private notes')
  await publish(send, token, 'deck', 'Shared deck')
  await publish(send, token, 'open', 'Open deck')
  await publish(send, token, 'archived', 'Archived deck')
  await post(owner, '/artefacts/archived', {
    action: 'delete',
    artefactId: await artefactId(owner, '/artefacts/archived'),
  })
  const deck = { artefactId: await artefactId(owner, '/artefacts/deck') }
  const open = { artefactId: await artefactId(owner, '/artefacts/open') }
  await post(owner, '/artefacts/deck', { action: 'create-share', label: 'Readers', ...deck })
  await post(owner, '/artefacts/open', { action: 'create-share', label: 'Readers', ...open })
  await post(owner, '/artefacts/open', { action: 'visibility', visibility: 'public', ...open })
  const idp = mockProvider()
  const viewer = await idp.signedIn(send, 'catalogue-reader')
  const list = await html(viewer, '/artefacts?view=list')
  const grid = await html(viewer, '/artefacts')
  for (const state of ['Private', 'Shared', 'Public']) {
    const badge = `<span class="forge-badge forge-badge--${state.toLowerCase()}">${state}</span>`
    expect(grid).toContain(badge)
    expect(list).toContain(`<td class="forge-col--folded">${badge}</td>`)
  }
  const filtered = await html(viewer, '/artefacts?q=shared&visibility=shared&view=list')
  const filters = Array.from(
    filtered.matchAll(
      /<a class="forge-filters__link" href="([^"]+)"( aria-current="page")?>([^<]+) <span class="forge-filters__count">(\d+)<\/span><\/a>/g,
    ),
    ([, href, current, label, count]) => ({
      params: Object.fromEntries(new URL(href.replaceAll('&amp;', '&'), manage).searchParams),
      current: Boolean(current),
      label,
      count: Number(count),
    }),
  )
  expect(filters).toEqual([
    { params: { q: 'shared', view: 'list' }, current: false, label: 'All', count: 3 },
    {
      params: { q: 'shared', view: 'list', visibility: 'private' },
      current: false,
      label: 'Private',
      count: 1,
    },
    { params: { q: 'shared', view: 'list', visibility: 'shared' }, current: true, label: 'Shared', count: 1 },
    {
      params: { q: 'shared', view: 'list', visibility: 'public' },
      current: false,
      label: 'Public',
      count: 1,
    },
  ])
  expect(filtered).toContain('<input type="hidden" name="visibility" value="shared"/>')
  expect(grid).not.toContain('Archived deck')
  expect((await viewer.request('/artefacts?visibility=unknown')).status).toBe(400)
  const guest = new Browser(send)
  const login = await guest.request('/artefacts')
  expect(location(login).pathname).toBe('/login')
  expect(await login.text()).not.toContain('forge-filters__count')
  const pending = await idp.signedIn(
    runtime({ AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]) }),
    'pending-reader',
  )
  const approval = await pending.request('/artefacts')
  expect(approval.status).toBe(303)
  expect(approval.headers.get('Location')).toBe('/')
  const approvalPage = await html(pending, '/')
  expect(approvalPage).toContain('Pending access')
  expect(approvalPage).not.toContain('forge-filters__count')
  expect(approvalPage).not.toContain('forge-nav__group')
  const titles = async (filter: string) => {
    const page = await html(owner, `/artefacts?${filter}`)
    return ['Private notes', 'Shared deck', 'Open deck'].filter((title) => page.includes(title))
  }
  expect(await titles('visibility=shared')).toEqual(['Shared deck'])
  expect(await titles('visibility=private')).toEqual(['Private notes'])
  expect(await titles('visibility=public')).toEqual(['Open deck'])
  expect(await titles('q=shared&visibility=shared')).toEqual(['Shared deck'])
  expect(await titles('q=shared&visibility=private')).toEqual([])

  const shareId = await db
    .prepare('SELECT s.id FROM share_links s JOIN artefacts a ON a.id = s.artefact_id WHERE a.slug = ?')
    .bind('deck')
    .first<string>('id')
  if (!shareId) throw new Error('Expected a share link')
  await post(owner, '/artefacts/deck', { action: 'revoke-share', id: shareId })
  expect(await titles('visibility=shared')).toEqual([])
  expect(await titles('visibility=private')).toEqual(['Private notes', 'Shared deck'])
  expect(await html(viewer, '/artefacts')).toMatch(
    />Private <span class="forge-filters__count">2<\/span>.*>Shared <span class="forge-filters__count">0<\/span>/s,
  )

  // Filtering scans the usual bounded page of the private index, then continues on the next page.
  await post(owner, '/artefacts/deck', { action: 'create-share', label: 'Readers again', ...deck })
  await db
    .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 60)
    INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
    SELECT printf('20000000-0000-4000-8000-%012d', n), printf('filler-%02d', n), 'Filler', 'private',
    current_revision, created_by, created_at, updated_at + n FROM artefacts, numbers WHERE slug = 'deck'`)
    .run()
  const first = await html(owner, '/artefacts?visibility=shared')
  expect(first).toContain('No new matches on this page.')
  const next = /href="([^"]+)"[^>]*>Next page<\/a>/.exec(first)?.[1]?.replaceAll('&amp;', '&')
  if (!next) throw new Error('Expected a next page link')
  expect(new URL(next, manage).searchParams.get('visibility')).toBe('shared')
  const second = await html(owner, next)
  expect(second).toContain('Shared deck')
  expect(second).not.toContain('Private notes')
})

it('keeps modified seek cursors inside the prefix and explains duplicate-only pages with more matches', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Catalogue duplicate fixture')
  await publish(send, token, 'aardvark', 'Aardvark')
  await publish(send, token, 'late-title', 'Report ZZ Late title')
  await db
    .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 120)
    INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
    SELECT printf('10000000-0000-4000-8000-%012d', n), printf('report-%03d', n), 'Report duplicate', 'private',
    current_revision, created_by, created_at, updated_at FROM artefacts, numbers WHERE slug = 'aardvark'`)
    .run()
  const catalogue = '/artefacts?q=report'
  let page = await html(owner, catalogue)
  const first = page
  let duplicatePages = 0
  for (let i = 0; i < 5; i++) {
    const next = /href="([^"]+)"[^>]*>Next page<\/a>/.exec(page)?.[1]?.replaceAll('&amp;', '&')
    if (!next) break
    page = await html(owner, next)
    expect(page).not.toContain('No results.')
    if (page.includes('No new matches on this page.')) duplicatePages++
  }
  expect(duplicatePages).toBeGreaterThan(0)
  expect(page).toContain('Report ZZ Late title')
  expect(page).not.toContain('Next page')
  const tampered = new URL(catalogue, manage)
  tampered.searchParams.set('cursor', base64url.encode(JSON.stringify(['report', null, 'slug', '', ''])))
  expect(await html(owner, tampered)).toBe(first)
})

it('shows a localized end-of-results message when a catalogue continuation exhausts duplicate matches', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  await publish(send, await issueToken(owner, 'Catalogue duplicate fixture'), 'report', 'Report duplicate')
  await db
    .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 64)
    INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
    SELECT printf('10000000-0000-4000-8000-%012d', n), printf('report-%03d', n), title, 'private',
    current_revision, created_by, created_at, updated_at FROM artefacts, numbers WHERE slug = 'report'`)
    .run()
  const next = (page: string) => {
    const href = /href="([^"]+)"[^>]*>Next page<\/a>/.exec(page)?.[1]?.replaceAll('&amp;', '&')
    if (!href) throw new Error('Expected catalogue continuation')
    return href
  }
  const first = await html(owner, '/artefacts?q=report')
  const second = await html(owner, next(first))
  expect(first.match(/href="\/artefacts\/report[^"]*"/g)).toHaveLength(50)
  expect(second.match(/href="\/artefacts\/report[^"]*"/g)).toHaveLength(15)
  const lastPath = next(second)
  const exhausted = await html(owner, lastPath)
  expect(exhausted).toContain('No more results.')
  expect(exhausted).not.toContain('No results.')
  expect(exhausted).not.toContain('Next page')
  const french = await runtime({ LOCALE: 'fr' })(lastPath, { headers: { Cookie: owner.cookieHeader() } })
  expect(french.status).toBe(200)
  expect(await french.text()).toContain('Il n’y a plus de résultats.')
})

it('identifies same-title and blank-title artefacts without covers in both catalogue views', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Identity fixtures')
  const samples = [
    ['first-report', 'Report', 'Report'],
    ['second-report', 'Report', 'Report'],
    ['blank-report', '  ', 'blank-report'],
  ] as const
  for (const [slug, title] of samples) await publish(send, token, slug, title)
  const grid = await html(owner, '/artefacts')
  const list = await html(owner, '/artefacts?view=list')
  for (const [slug, , label] of samples) {
    expect(grid).toContain(
      `href="/artefacts/${slug}"><span class="forge-gallery__caption"><span class="forge-gallery__title">${label}</span></span></a><div class="forge-gallery__detail"><code class="forge-catalogue-slug">${slug}</code>`,
    )
    expect(list).toContain(`href="/artefacts/${slug}"><span>${label}</span></a>`)
    expect(list).toContain(`<td class="forge-col--folded" title="${slug}"><code>${slug}</code></td>`)
  }
})

it('uses bounded index seeks for missing and sparse matches in a large catalogue', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  await publish(send, await issueToken(owner, 'Catalogue seed'), slug, 'Exact Élément %_')
  const seed =
    db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT ?1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?2)
    INSERT INTO artefacts (id, slug, title, visibility, current_revision, created_by, created_at, updated_at)
    SELECT printf('10000000-0000-4000-8000-%012d', n), printf('common-%04d', n), 'Exact other title', 'public',
    current_revision, created_by, created_at, updated_at FROM artefacts, numbers WHERE slug = ?3`)
  await seed.bind(1, catalogueCountLimit - 1, slug).run()
  expect(await html(owner, '/artefacts?q=missing')).toContain(
    `All <span class="forge-filters__count">${catalogueCountLimit}</span>`,
  )
  await seed.bind(catalogueCountLimit, catalogueCountLimit, slug).run()
  // A long revocation history must not be walked by the active-link probe, even after ANALYZE.
  await db
    .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 2000)
    INSERT INTO share_links (id, artefact_id, key_hash, key_sealed, created_by, created_at, revoked_at)
    SELECT printf('revoked-%04d', n), id, printf('revoked-hash-%04d', n), 'sealed', created_by, created_at, created_at
    FROM artefacts, numbers WHERE slug = ?`)
    .bind(slug)
    .run()
  await db.prepare('ANALYZE').run()
  let totalReads = 0
  let searchReads = 0
  const planStatements: D1PreparedStatement[] = []
  const originals = new WeakMap<D1PreparedStatement, { statement: D1PreparedStatement; search: boolean }>()
  const measure = <T>(result: D1Result<T>) => {
    totalReads += result.meta.rows_read
    return result
  }
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const search = sql.includes('visibility = ?')
    const wrapped = new Proxy(statement, {
      get(prepared, key) {
        if (key === 'bind')
          return (...args: unknown[]) => {
            if (search) planStatements.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args))
            return wrap(prepared.bind(...args), sql)
          }
        if (key === 'all') return async () => measure(await prepared.all())
        if (key === 'run') return async () => measure(await prepared.run())
        if (key === 'first')
          return async (column?: string) => {
            const { results } = measure(await prepared.all<Record<string, unknown>>())
            const row = results[0]
            return row ? (column === undefined ? row : row[column]) : null
          }
        if (key === 'raw') throw new Error('Catalogue D1 meter does not support raw results')
        return Reflect.get(prepared, key, prepared)
      },
    })
    originals.set(wrapped, { statement, search })
    return wrapped
  }
  const measured = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const entries = statements.map((statement) => originals.get(statement))
          const results = await target.batch(
            statements.map((statement, i) => entries[i]?.statement ?? statement),
          )
          for (const [i, result] of results.entries()) {
            measure(result)
            if (entries[i]?.search) searchReads += result.meta.rows_read
          }
          return results
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const browsing = runtime({ DB: measured })
  const fetch = (query: string, visibility?: string) =>
    browsing(
      `/artefacts?${new URLSearchParams({
        q: query,
        ...(visibility ? { visibility } : {}),
      })}`,
      { headers: { Cookie: owner.cookieHeader() } },
    )
  const empty = await fetch('missing')
  expect(empty.status).toBe(200)
  const oversized = await empty.text()
  expect(oversized).toContain('No results.')
  expect(oversized).not.toContain('forge-filters__count')
  expect(
    [...oversized.matchAll(/<a class="forge-filters__link"[^>]*>([^<]+)<\/a>/g)].map(([, label]) => label),
  ).toEqual(['All', 'Private', 'Shared', 'Public'])
  const emptyReads = totalReads
  expect(emptyReads).toBeGreaterThanOrEqual(catalogueCountLimit + 1)
  // D1 can meter both an index step and a table lookup for each sampled live artefact.
  expect(emptyReads).toBeLessThan(2 * (catalogueCountLimit + 1) + 30)
  await seed.bind(catalogueCountLimit + 1, catalogueCountLimit + 500, slug).run()
  totalReads = 0
  expect((await fetch('missing')).status).toBe(200)
  expect(totalReads).toBe(emptyReads)
  const sparse = await fetch('eXaCt Élément %_')
  expect(sparse.status).toBe(200)
  expect(await sparse.text()).toContain('Exact Élément %_')
  const filtered = await fetch('', 'private')
  expect(filtered.status).toBe(200)
  expect(await filtered.text()).toContain('Exact Élément %_')
  const shared = await fetch('exact', 'shared')
  expect(shared.status).toBe(200)
  expect(await shared.text()).toContain('No results.')
  expect(searchReads).toBeGreaterThan(0)
  expect(searchReads).toBeLessThan(20)
  const plans = (await db.batch<{ detail: string }>(planStatements)).flatMap((result) =>
    result.results.map((row) => row.detail),
  )
  for (const suffix of ['slug', 'title', 'recent']) {
    expect(
      plans.some((plan) => plan.includes(`SEARCH artefacts USING INDEX artefacts_catalogue_${suffix}`)),
    ).toBe(true)
  }
  const probes = plans.filter((plan) => plan.includes('share_links'))
  expect(probes.length).toBeGreaterThan(0)
  for (const probe of probes) expect(probe).toContain('share_links_active_artefact')
})

it('restores a revision, reveals and revokes share links, then renames and restores the deleted artefact', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Revision publisher')
  await publish(send, token, slug, 'Quarterly report', 1, '<p>Original version</p>')
  await publish(send, token, slug, 'Quarterly report', 1, '<p>Revised version</p>')
  const identity = { artefactId: await artefactId(owner) }
  const history = await html(owner, detail)
  const author = await db
    .prepare('SELECT name FROM members WHERE id = (SELECT created_by FROM artefacts WHERE id = ?)')
    .bind(identity.artefactId)
    .first<string>('name')
  expect(history).toContain(` · ${author}</p>`)
  expect(history).toMatch(/<time datetime="[^"]+Z" title="[^"]+ UTC">/)
  const first = await post(owner, detail, { action: 'create-share', label: 'Early readers', ...identity })
  const url = /<code>(https:\/\/read\.forge\.example\/s\/quarterly\/[A-Za-z0-9_-]+\/)<\/code>/.exec(
    first,
  )?.[1]
  if (!url) throw new Error('Expected a share URL in the flash')
  expect(first).toContain(`<p class="forge-secret"><code>${url}</code><button`)
  expect(await html(owner, detail)).not.toContain(url)
  const shareId = await db.prepare('SELECT id FROM share_links').first<string>('id')
  if (!shareId) throw new Error('Expected a share link ID')
  expect(await post(owner, detail, { action: 'reveal-share', id: shareId })).toContain(url)
  expect(await (await send(url)).text()).toBe('<p>Revised version</p>')
  await post(owner, detail, { action: 'restore-revision', revision: '1', ...identity })
  expect(await (await send(url)).text()).toBe('<p>Original version</p>')
  await post(owner, detail, { action: 'revoke-share', id: shareId })
  expect((await send(url)).status).toBe(404)
  await post(owner, detail, { action: 'visibility', visibility: 'public', ...identity })
  await post(owner, detail, { action: 'rename', slug: 'renamed-report', ...identity })
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
  await post(owner, '/artefacts/renamed-report', { action: 'delete', ...identity })
  expect((await send(`${read}/a/renamed-report/`)).status).toBe(404)
  expect(await html(owner, deleted)).toContain('Quarterly report')
  await post(owner, deleted, { action: 'restore', slug: 'renamed-report', ...identity })
  expect(await (await send(`${read}/a/renamed-report/`)).text()).toBe('<p>Original version</p>')
})

it('supports all nine access transitions without replacing existing share links', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const viewer = await idp.signedIn(send, 'detail-reader')
  const token = await issueToken(owner, 'Access publisher')
  const states = ['private', 'shared', 'public'] as const
  for (const from of states) {
    for (const to of states) {
      const name = `${from}-to-${to}`
      const path = `/artefacts/${name}`
      await publish(send, token, name, name)
      const identity = { artefactId: await artefactId(owner, path) }
      const links = async () =>
        (
          await db
            .prepare('SELECT id, label FROM share_links WHERE artefact_id = ? AND revoked_at IS NULL')
            .bind(identity.artefactId)
            .all<{ id: string; label: string | null }>()
        ).results
      if (from !== 'private')
        await post(owner, path, { action: 'create-share', label: 'Existing', ...identity })
      if (from === 'public')
        await post(owner, path, { action: 'visibility', visibility: 'public', ...identity })
      const initialUpdated = Date.UTC(2025, 0, 1)
      await db
        .prepare('UPDATE artefacts SET updated_at = ? WHERE id = ?')
        .bind(initialUpdated, identity.artefactId)
        .run()
      const initial = await html(owner, path)
      expect(initial).toContain(`forge-badge--${from}`)
      expect(initial).toMatch(new RegExp(`type="radio" name="access" value="${from}" checked`))
      const before = await links()
      const result = await post(owner, path, {
        action: 'access',
        access: to,
        ...identity,
        ...(to === 'private' && before.length ? { revoke: String(before.length) } : {}),
      })
      expect(result).toContain(`forge-badge--${to}`)
      const after = await links()
      const updated = await db
        .prepare('SELECT updated_at FROM artefacts WHERE id = ?')
        .bind(identity.artefactId)
        .first<number>('updated_at')
      if (to === from) expect(updated).toBe(initialUpdated)
      else expect(updated).toBeGreaterThan(initialUpdated)
      if (to === 'private') expect(after).toEqual([])
      else if (to === 'shared' && !before.length) {
        expect(after).toEqual([{ id: expect.any(String), label: null }])
        expect(result).toContain('data-secret-flash=""')
      } else {
        expect(after).toEqual(before)
        expect(result).not.toContain('data-secret-flash=""')
      }
      if (from === 'shared' && to === 'shared') {
        const readonly = await html(viewer, path)
        expect(readonly).toContain('forge-badge--shared')
        expect(readonly).not.toMatch(
          /forge-detail__aside|value="(?:access|rename|delete|create-share|reveal-share|revoke-share)"/,
        )
        expect((await viewer.post(path, { action: 'access', access: 'public', ...identity })).status).toBe(
          403,
        )
      }
    }
  }
}, 20_000)

it('confirms the current revocation count before changing access or auditing the change', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Sharing publisher')
  await publish(send, token, slug, 'Quarterly report')
  const identity = { artefactId: await artefactId(owner) }
  await post(owner, detail, { action: 'access', access: 'public', ...identity })
  const first = await owner.post(detail, { action: 'access', access: 'shared', ...identity })
  expect(first.status).toBe(303)
  const destination = location(first)
  const flash = await (await owner.request(destination, { headers: flashNavigation })).text()
  const url = /<code>(https:\/\/read\.forge\.example\/s\/quarterly\/([A-Za-z0-9_-]+)\/)<\/code>/.exec(flash)
  if (!url) throw new Error('Expected the first generated share link to be flashed')
  expect(flash.split(url[1])).toHaveLength(2)
  expect(await (await owner.request(destination, { headers: flashNavigation })).text()).not.toContain(url[2])
  expect(await html(owner, detail)).not.toContain(url[2])

  const initial = await html(owner, detail)
  const stale = sheets(initial).find(({ action }) => action === 'access')
  if (!stale) throw new Error('Expected a Private confirmation')
  expect(formValue(stale.form, 'revoke')).toBe('1')
  await post(owner, detail, { action: 'visibility', visibility: 'public', ...identity })
  const key = 'synthetic-sample-key'
  await post(owner, detail, { action: 'create-share', label: 'Review', key, ...identity })
  const initialUpdated = Date.UTC(2025, 0, 1)
  await db
    .prepare('UPDATE artefacts SET updated_at = ? WHERE id = ?')
    .bind(initialUpdated, identity.artefactId)
    .run()
  const twoLinks = await html(owner, detail)
  expect(twoLinks).not.toContain(key)
  expect(twoLinks).toContain(
    'Anyone with an active share link can read the current artefact. Share links only with intended recipients.',
  )
  const confirmations = sheets(twoLinks)
  expect(
    confirmations.filter(({ action }) => action === 'revoke-share').map(({ contents }) => contents),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining('Revoke “Review”?'),
      expect.stringContaining('Revoke “Unlabeled”?'),
    ]),
  )
  expect(confirmations.find(({ action }) => action === 'access')?.contents).toContain('2 active share links')
  const audit = () =>
    db
      .prepare(
        `SELECT detail_json FROM audit_log WHERE artefact_id = ? AND action = 'artefact.access' ORDER BY at`,
      )
      .bind(identity.artefactId)
      .all<{ detail_json: string }>()
  const before = (await audit()).results
  for (const revoke of [undefined, '0', formValue(stale.form, 'revoke'), '3']) {
    const rejected = await post(owner, detail, {
      action: 'access',
      access: 'private',
      ...identity,
      ...(revoke === undefined ? {} : { revoke }),
    })
    expect(rejected).toContain('Access was not changed. Active share links: 2.')
    expect(rejected).toContain('forge-badge--public')
    expect(rejected).toContain('<span>Updated <time datetime="2025-01-01T00:00:00.000Z"')
    expect((await send(url[1])).status).toBe(200)
    expect((await send(`${read}/s/${slug}/${key}/`)).status).toBe(200)
  }
  expect((await audit()).results).toEqual(before)
  const success = await post(owner, detail, { action: 'access', access: 'private', revoke: '2', ...identity })
  expect(success).toContain('forge-badge--private')
  expect(sheets(success).map(({ action }) => action)).toEqual(['delete'])
  expect((await send(url[1])).status).toBe(404)
  expect((await send(`${read}/s/${slug}/${key}/`)).status).toBe(404)
  expect((await audit()).results.map(({ detail_json }) => JSON.parse(detail_json))).toContainEqual({
    access: 'private',
    revoked: 2,
  })
  const staleAfterRevoke = await post(owner, detail, {
    action: 'access',
    access: 'private',
    revoke: '2',
    ...identity,
  })
  expect(staleAfterRevoke).toContain('Access was not changed. Active share links: 0.')
})

it('marks the entry and head, restores older versions only, and keeps long messages readable', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const viewer = await idp.signedIn(send, 'version-reader')
  const token = await issueToken(owner, 'Version publisher')
  await publish(send, token, slug, 'Quarterly report', 2)
  await publish(send, token, slug, 'Quarterly report', 2)
  const identity = { artefactId: await artefactId(owner) }
  const message = `${'x'.repeat(200)} tail`
  await db
    .prepare('UPDATE revisions SET message = ? WHERE artefact_id = ? AND number = 2')
    .bind(message, identity.artefactId)
    .run()
  const document = await html(owner, detail)
  expect(document).not.toContain('forge-detail__preview')
  expect(document.match(/forge-badge--entry/g)).toHaveLength(1)
  expect(document).toMatch(
    /<code>index\.html<\/code><\/a> <span class="forge-badge forge-badge--entry">Entry page/,
  )
  expect(document).toMatch(
    /<code>https:\/\/read\.forge\.example\/a\/quarterly\/<\/code><button[^>]*data-copy=""[^>]*hidden="">Copy address/,
  )
  const timeline = Array.from(
    document.matchAll(/<li class="forge-version">(.*?)<\/li>/gs),
    (match) => match[1],
  )
  expect(timeline).toHaveLength(2)
  expect(timeline[0]).toContain('Version 2')
  expect(timeline[0]).toContain('forge-badge--current')
  expect(timeline[0]).not.toContain('value="restore-revision"')
  expect(timeline[0]).toContain(`<summary>Full message</summary><p>${message}</p>`)
  expect(timeline[1]).toContain('Version 1')
  expect(timeline[1]).not.toContain('forge-badge--current')
  expect(timeline[1]).toContain('value="restore-revision"')
  expect(await html(viewer, detail)).not.toContain('value="restore-revision"')
})

it('keeps revision authorship separate from later changes and counts all revision files despite a cursor', async () => {
  const send = runtime()
  const idp = mockProvider()
  const alice = await idp.signedIn(send, admin, { userinfo: { name: 'Alice Example' } })
  const bob = await idp.signedIn(send, 'bob', { userinfo: { name: 'Bob Example' } })
  const bobId = await listedId(alice, members, 'bob@example.test')
  await post(alice, members, { action: 'role', id: bobId, role: 'publisher' })
  const token = await issueToken(alice, 'Alice publisher')
  await publish(send, token, slug, 'Quarterly report')
  const id = await artefactId(alice)
  const publishedAt = Date.UTC(2025, 0, 1)
  await db.batch([
    db.prepare('UPDATE revisions SET created_at = ? WHERE artefact_id = ?').bind(publishedAt, id),
    db.prepare('UPDATE artefacts SET updated_at = ? WHERE id = ?').bind(publishedAt, id),
  ])
  await post(bob, detail, { action: 'access', access: 'shared', artefactId: id })
  const cursor = base64url.encode(JSON.stringify([id, 1, 'index.html']))
  const document = await html(bob, `${detail}?files=${cursor}`)
  const metadata = /<div class="forge-detail__meta">(.*?)<\/div>/s.exec(document)?.[1]
  expect(metadata).toMatch(
    /<span>v1 by Alice Example · <time datetime="2025-01-01T00:00:00\.000Z"[^>]*>[^<]+<\/time><\/span><span>Updated <time datetime="([^"]+)"[^>]*>[^<]+<\/time><\/span><span>1 file<\/span>/,
  )
  const changedAt = /Updated <time datetime="([^"]+)"/.exec(metadata ?? '')?.[1]
  expect(Date.parse(changedAt ?? '')).toBeGreaterThan(publishedAt)
  expect(metadata).not.toContain('Bob Example')
  expect(document).not.toContain('200+ files')
})

it('confirms deletion and purge with separate forms for each deleted artefact', async () => {
  const send = runtime({ LOCALE: 'fr' })
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Confirmation fixture')
  for (const [name, title] of [
    ['confirm-first', 'confirm-first'],
    ['confirm-second', 'confirm-second'],
    ['confirm-blank', '  '],
  ]) {
    const path = `/artefacts/${name}`
    await publish(send, token, name, title)
    const panels = sheets(await html(owner, path))
    expect(panels).toHaveLength(1)
    const [sheet] = panels
    expect(sheet.action).toBe('delete')
    expect(sheet.contents).toContain(`Supprimer « ${name} » ?`)
    expect(sheet.contents).toContain('ses liens de partage cessent de fonctionner')
    expect(sheet.contents).toContain('pendant 30 jours')
    expect(sheet.form).toContain('>Annuler</button>')
    await post(owner, path, { action: sheet.action, artefactId: formValue(sheet.form, 'artefactId') })
    expect((await owner.request(path)).status).toBe(404)
  }
  const document = await html(owner, deleted)
  expect(sheets(document)).toHaveLength(3)
  for (const name of ['confirm-blank', 'confirm-first', 'confirm-second']) {
    const row = bodyRows(document).find((entry) => entry.includes(`<code>${name}</code>`))
    if (!row) throw new Error(`Missing row for ${name}`)
    const [panel] = sheets(row)
    expect(panel.action).toBe('purge')
    expect(panel.contents).toContain(`Purger « ${name} » ?`)
    expect(panel.contents).toContain('La purge est irréversible')
    expect(panel.form).toContain('>Purger définitivement</button>')
    expect(formValue(panel.form, 'slug')).toBe(name)
    await post(owner, deleted, { action: panel.action, slug: name, id: formValue(panel.form, 'id') })
    expect(await html(owner, deleted)).not.toContain(name)
  }
})

it('continues an interrupted purge after its artefact row has already been removed', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Purge fixture')
  await publish(send, token, slug, 'Purge this artefact', 65)
  const before = await blobs.list({ prefix: 'blobs/' })
  expect(before.objects).toHaveLength(65)
  await post(owner, detail, { action: 'delete', artefactId: await artefactId(owner) })
  const id = formValue(await html(owner, deleted), 'id')
  const intermediate = await post(owner, deleted, { action: 'purge', id, slug })
  expect(intermediate).toContain('Continue purge')
  expect(intermediate).not.toContain('popovertarget')
  expect(intermediate).toMatch(
    /<form class="forge-action"[^>]*>.*?<button[^>]*type="submit" name="action" value="purge">Continue purge<\/button><\/form>/s,
  )
  expect(intermediate).toContain('<th scope="col" class="forge-col--folded">Slug</th>')
  expect(intermediate).toContain(`<td class="forge-col--folded" title="${slug}"><code>${slug}</code></td>`)
  expect(intermediate).toContain(`<span class="forge-fold" hidden=""><code>${slug}</code></span>`)
  expect(intermediate).not.toContain('Restore artefact')
  expect((await blobs.list({ prefix: 'blobs/' })).objects).toHaveLength(1)
  const finished = await post(owner, deleted, { action: 'purge', id, slug })
  expect(finished).toContain('Artefact permanently purged.')
  expect(finished).not.toContain('Continue purge')
  expect((await blobs.list({ prefix: 'blobs/' })).objects).toHaveLength(0)
})

function section(document: string, id: string) {
  const match = new RegExp(`<section id="${id}"[^>]*>(.*?)</section>`, 's').exec(document)?.[1]
  if (!match) throw new Error(`No ${id} section`)
  return match
}

function bodyRows(markup: string) {
  return Array.from(markup.matchAll(/<tr><td(?:\s|>).*?<\/tr>/gs), ([row]) => row)
}

function namedRow(markup: string, value: string) {
  const row = bodyRows(markup).find((entry) => entry.includes(value))
  if (!row) throw new Error(`No row for ${value}`)
  return row
}

it('keeps same-role invite rows distinct and binds each revoke trigger to its own record', async () => {
  const owner = await mockProvider().signedIn(runtime(), admin, { userinfo: { name: 'Alice Example' } })
  const expires = Date.UTC(2099, 0, 2, 3, 4)
  const first = /<code>[^<]+\/invite\/([^<]+)<\/code>/.exec(
    await post(owner, members, { action: 'create-invite', role: 'viewer' }),
  )?.[1]
  if (!first) throw new Error('Expected the first invite secret in its flash')
  const id = await hashSecret(first)
  await db.prepare('UPDATE invites SET expires_at = ? WHERE token_hash = ?').bind(expires, id).run()
  await post(owner, members, { action: 'create-invite', role: 'viewer' })
  const invites = section(await html(owner, members), 'invites')
  const rows = bodyRows(invites)
  expect(rows).toHaveLength(2)
  const row = namedRow(invites, new Date(expires).toISOString())
  expect(row).toContain('By Alice Example')
  const [sheet] = sheets(row)
  expect(sheet.action).toBe('revoke-invite')
  expect(sheet.contents).toContain('Alice Example')
  expect(formValue(sheet.form, 'id')).toBe(id)
  const updated = section(await post(owner, members, { action: sheet.action, id }), 'invites')
  expect(bodyRows(updated)).toHaveLength(1)
  expect(updated).not.toContain(new Date(expires).toISOString())
  expect(updated).not.toContain(first)
})

it('groups only humans and submits each row’s own role and confirmation sheets', async () => {
  const owner = await mockProvider().signedIn(runtime(), admin, { userinfo: { name: 'Alice Example' } })
  const initial = await html(owner, members)
  for (const id of ['pending', 'invites', 'removed']) {
    const empty = section(initial, id)
    expect(empty).toContain('class="forge-empty"')
    expect(empty).not.toContain('<table')
  }
  const now = Date.now()
  const seed = db.prepare(`INSERT INTO members (id, kind, name, email, role, status, created_at, removed_at)
    VALUES (?, ?, ?, ?, 'publisher', ?, ?, ?)`)
  const fixtures = [
    ['human', 'Bob', 'pending'],
    ['human', 'Carol', 'pending'],
    ['human', 'Dave', 'active'],
    ['human', 'Eve', 'active'],
    ['human', 'Fran', 'removed'],
    ['bot', 'Synthetic bot', 'active'],
  ].map(([kind, name, status]) => ({ id: crypto.randomUUID(), kind, name, status }))
  await db.batch(
    fixtures.map(({ id, kind, name, status }) =>
      seed.bind(
        id,
        kind,
        name,
        `${name.toLowerCase().replace(' ', '-')}@example.test`,
        status,
        now,
        status === 'removed' ? now : null,
      ),
    ),
  )
  const document = await html(owner, members)
  const scopes = ['pending', 'active', 'removed'].map((id) => section(document, id))
  expect(scopes.map((scope) => bodyRows(scope).length)).toEqual([2, 3, 1])
  expect(document).not.toContain('Synthetic bot')
  const self = namedRow(scopes[1], 'Alice Example')
  expect(self).toContain('>You</span>')
  expect(self).not.toMatch(/<form|<button/)
  const [inviteSheet] = sheets(/<header class="forge-page-head">(.*?)<\/header>/s.exec(document)?.[1] ?? '')
  expect(inviteSheet.action).toBe('create-invite')
  expect(inviteSheet.form).toMatch(/<select[^>]*name="role".*?<option value="admin">/s)
  expect(sheets(document)).toHaveLength(9)
  for (const { id, kind, name, status } of fixtures) {
    if (kind === 'bot') continue
    const scope = status === 'pending' ? scopes[0] : status === 'active' ? scopes[1] : scopes[2]
    const row = namedRow(scope, `<strong dir="auto">${name}</strong>`)
    expect(row).toContain(`datetime="${new Date(now).toISOString()}"`)
    const stored = db.prepare('SELECT role, status FROM members WHERE id = ?').bind(id)
    if (status === 'removed') {
      expect(sheets(row)).toHaveLength(0)
      expect(row).toContain('name="action" value="reinstate"')
      expect(formValue(row, 'id')).toBe(id)
      await post(owner, members, { action: 'admit', role: 'viewer', id })
      expect(await stored.first()).toEqual({ role: 'publisher', status: 'removed' })
      await post(owner, members, { action: 'reinstate', id })
      expect(await stored.first()).toEqual({ role: 'publisher', status: 'active' })
      continue
    }
    const [edit, remove] = sheets(row)
    expect(edit.kind).toBe('dialog')
    expect(edit.action).toBe(status === 'pending' ? 'admit' : 'role')
    expect(edit.form).toMatch(
      new RegExp(`<option value="${status === 'pending' ? 'viewer' : 'publisher'}" selected[^>]*>`),
    )
    expect(remove.kind).toBe('alertdialog')
    expect(remove.action).toBe('remove')
    expect(remove.contents).toContain(name)
    expect(formValue(edit.form, 'id')).toBe(id)
    expect(formValue(remove.form, 'id')).toBe(id)
    if (name === 'Bob') {
      await post(owner, members, { action: 'reinstate', id })
      expect(await stored.first()).toEqual({ role: 'publisher', status: 'pending' })
    }
    if (name === 'Carol' || name === 'Eve') {
      await post(owner, members, { action: remove.action, id: formValue(remove.form, 'id') })
      expect(await stored.first()).toEqual({ role: 'publisher', status: 'removed' })
    } else {
      await post(owner, members, { action: edit.action, id: formValue(edit.form, 'id'), role: 'viewer' })
      expect(await stored.first()).toEqual({ role: 'viewer', status: 'active' })
    }
  }
})

it('links form and confirmation sheets for non-UUID values without collisions', () => {
  const render = (value: string, confirmation: boolean) =>
    Action({
      action: 'remove',
      label: 'Remove',
      fields: { fromPrefix: value },
      ...(confirmation
        ? {
            confirm: {
              title: 'Remove prefix',
              body: 'This removes the prefix.',
              label: 'Remove',
              cancel: 'Cancel',
            },
          }
        : { sheet: { title: 'Remove prefix', label: 'Remove', cancel: 'Cancel' } }),
    }).toString()
  const first = render('/a/old/', true)
  const second = render('/a/OLD/', false)
  expect(sheets(first + second)).toHaveLength(2)
  expect(formValue(sheets(first)[0].form, 'fromPrefix')).toBe('/a/old/')
  expect(formValue(sheets(second)[0].form, 'fromPrefix')).toBe('/a/OLD/')
  for (const [name, initials] of [
    ['👩🏿‍💻 Example Name', '👩🏿‍💻E'],
    ['ليلى أحمد', 'لأ'],
    ['  ', '—'],
  ]) {
    expect(Avatar({ name }).toString()).toContain(`aria-hidden="true" dir="auto">${initials}</span>`)
  }
})

it('paginates the four sections independently with capped counts and no per-row queries', async () => {
  const owner = await mockProvider().signedIn(runtime(), admin)
  const ownerId = await db
    .prepare('SELECT id FROM members WHERE email = ?')
    .bind(`${admin}@example.test`)
    .first<string>('id')
  if (!ownerId) throw new Error('Expected an authenticated administrator')
  const now = Date.now()
  const memberKey = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const inviteKey = (index: number) => String(index).padStart(43, '0')
  await db.batch([
    db
      .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 600),
      buckets(k, status) AS (VALUES (0, 'pending'), (1, 'active'), (2, 'removed'), (3, 'active'))
      INSERT INTO members (id, kind, name, role, status, created_at, removed_at)
      SELECT printf('00000000-0000-4000-8000-%012d', n * 10 + k),
      CASE k WHEN 3 THEN 'bot' ELSE 'human' END, printf('Person %d-%d', k, n), 'viewer',
      status, ?1, CASE status WHEN 'removed' THEN ?1 END FROM numbers, buckets`)
      .bind(now),
    db
      .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 600)
      INSERT INTO invites (token_hash, role, created_by, created_at, expires_at)
      SELECT printf('%043d', n), 'viewer', ?, ?, ? FROM numbers`)
      .bind(ownerId, now, now + 86_400_000),
  ])
  const reads: { sql: string; limit: unknown; rows: number; rowsRead: number }[] = []
  const measured = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (
            !/\) m LEFT JOIN identities|LEFT JOIN members creator|WITH sections\(status\)|SELECT COUNT\(\*\) AS total FROM/.test(
              sql,
            )
          ) {
            return statement
          }
          return new Proxy(statement, {
            get(prepared, method) {
              if (method !== 'bind') throw new Error(`Unexpected list statement method: ${String(method)}`)
              return (...args: unknown[]) => {
                const bound = prepared.bind(...args)
                return new Proxy(bound, {
                  get(boundStatement, operation) {
                    if (operation !== 'first' && operation !== 'all')
                      throw new Error(`Unexpected list read: ${String(operation)}`)
                    return async (column?: string) => {
                      const result = await boundStatement.all<Record<string, unknown>>()
                      reads.push({
                        sql,
                        limit: args.at(-1),
                        rows: result.results.length,
                        rowsRead: result.meta.rows_read,
                      })
                      if (operation === 'all') return result
                      return (column ? result.results[0]?.[column] : result.results[0]) ?? null
                    }
                  },
                })
              }
            },
          })
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const cursors = {
    pendingAfter: memberKey(10),
    after: memberKey(21),
    inviteAfter: inviteKey(3),
    removedAfter: memberKey(42),
  }
  const current = `${members}?${new URLSearchParams(cursors)}`
  const result = await runtime({ DB: measured })(current, { headers: { Cookie: owner.cookieHeader() } })
  expect(result.status).toBe(200)
  const document = await result.text()
  expect(reads).toHaveLength(6)
  expect(reads.every(({ rowsRead }) => rowsRead > 0)).toBe(true)
  const pages = reads.filter(({ sql }) => sql.includes('LEFT JOIN'))
  expect(pages.map(({ limit, rows }) => [limit, rows])).toEqual(Array.from({ length: 4 }, () => [51, 51]))
  const counts = reads.filter(({ sql }) => !sql.includes('LEFT JOIN')).sort((a, b) => a.rows - b.rows)
  expect(counts.map(({ limit, rows }) => [limit, rows])).toEqual([
    [101, 1],
    [101, 3],
  ])
  const sections = [
    ['pending', 'pendingAfter', memberKey(20), memberKey(510)],
    ['active', 'after', memberKey(31), memberKey(521)],
    ['invites', 'inviteAfter', inviteKey(4), inviteKey(53)],
    ['removed', 'removedAfter', memberKey(52), memberKey(542)],
  ] as const
  for (const [name, param, first, last] of sections) {
    const scope = section(document, name)
    expect(scope).toMatch(/<h2[^>]*>[^<]+ \(100\+\)<\/h2>/)
    const rows = bodyRows(scope)
    expect(rows).toHaveLength(50)
    expect(formValue(rows[0], 'id')).toBe(first)
    expect(formValue(rows[49], 'id')).toBe(last)
    const href = /<a href="([^"]+)"/.exec(scope)?.[1]
    if (!href) throw new Error(`No next link for ${name}`)
    const next = new URL(href.replaceAll('&amp;', '&'), manage)
    expect(next.hash).toBe(`#${name}`)
    expect(Object.fromEntries(next.searchParams)).toEqual({ ...cursors, [param]: last })
    const following = await html(owner, next)
    for (const [other, , otherFirst] of sections) {
      const nextFirst = formValue(bodyRows(section(following, other))[0], 'id')
      if (name === other) expect(nextFirst > last).toBe(true)
      else expect(nextFirst).toBe(otherFirst)
    }
  }
})

it('localizes share creation metadata and keeps one visible copy of folded table metadata', async () => {
  const send = runtime({ LOCALE: 'fr' })
  const owner = await mockProvider().signedIn(send, admin)
  const token = await issueToken(owner, 'Jeton de publication')
  const title = 'Rapport trimestriel'
  const label = 'Partage pour les lecteurs'
  await publish(send, token, slug, title)
  const artefactIdValue = await artefactId(owner)
  await post(owner, detail, { action: 'create-share', label, artefactId: artefactIdValue })
  const createdAt = Date.UTC(2025, 1, 3, 4, 5)
  await db.prepare('UPDATE share_links SET created_at = ?').bind(createdAt).run()
  const lastUsedAt = Date.UTC(2025, 2, 4, 5, 6)
  await db.prepare('UPDATE api_tokens SET last_used_at = ?, revoked_at = ?').bind(lastUsedAt, createdAt).run()

  const created = `<time datetime="2025-02-03T04:05:00.000Z" title="3 févr. 2025, 04:05 UTC">03/02/2025</time>`
  const lastUsed = `<time datetime="2025-03-04T05:06:00.000Z" title="4 mars 2025, 05:06 UTC">04/03/2025</time>`
  const fold = (value: string, label?: string) => `${label ? `<strong>${label}: </strong>` : ''}${value}`
  function expectRow(document: string, name: string, headings: string[], copies: string[], cells: string[]) {
    for (const heading of headings) {
      expect(document).toContain(`<th scope="col" class="forge-col--folded">${heading}</th>`)
    }
    const row = [...document.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)]
      .map((match) => match[1] ?? '')
      .find((entry) => entry.startsWith(`<td title="${name}"><span>${name}</span>`))
    if (!row) throw new Error(`No row for ${name}`)
    const hidden =
      /<span class="forge-fold(?: forge-member-email)?"(?: title="[^"]*")? hidden="">(.*?)<\/span>/g
    expect([...row.matchAll(hidden)].map((match) => match[1])).toEqual(copies)
    // Without CSS these hidden spans do not render, but the heading and column cells do.
    expect(row.replace(hidden, '')).toBe(
      `<td title="${name}"><span>${name}</span></td>${cells.join('')}${row.slice(row.lastIndexOf('<td>'))}`,
    )
  }
  const column = (value: string, title?: string) =>
    `<td class="forge-col--folded"${title ? ` title="${title}"` : ''}>${value}</td>`

  const sharePage = await html(owner, detail)
  expect(sharePage).toContain(`<strong>${label}</strong>`)
  expect(sharePage).toContain(`Créé le ${created} par `)
  expect(sharePage).toContain(
    'Toute personne disposant d’un lien de partage actif peut lire l’artefact actuel. Réservez ces liens aux personnes concernées.',
  )
  const prefix = token.slice(0, 12)
  expectRow(
    await html(owner, tokens),
    'Jeton de publication',
    ['Dernière utilisation', 'Révoqué le'],
    [fold(lastUsed, 'Dernière utilisation'), fold(created, 'Révoqué le')],
    [`<td title="${prefix}"><code>${prefix}</code></td>`, column(lastUsed), column(created)],
  )
  const email = `${admin}@example.test`
  const member = namedRow(section(await html(owner, members), 'active'), email)
  for (const [label, value] of [
    ['E-mail', email],
    ['Fournisseur', 'team'],
    ['Rôle', 'administrateur'],
  ]) {
    expect(member).toContain(column(value))
    expect(member).toContain(
      label === 'E-mail' ? `hidden="">${value}</span>` : `${fold(value, label)}</span>`,
    )
  }

  await post(owner, detail, { action: 'delete', artefactId: artefactIdValue })
  await db.prepare('UPDATE artefacts SET deleted_at = ? WHERE id = ?').bind(createdAt, artefactIdValue).run()
  const code = `<code>${slug}</code>`
  const status = 'Délai de restauration expiré'
  expectRow(
    await html(owner, deleted),
    title,
    ['Identifiant', 'Supprimé le', 'État'],
    [code, fold(created, 'Supprimé le'), status],
    [column(code, slug), column(created), column(status)],
  )
})

it.each(['en', 'fr'] as const)(
  'renders every admin and read page in %s and serves configured branding',
  async (locale) => {
    const french = locale === 'fr'
    const send = runtime({
      LOCALE: locale,
      FORGE_NAME: 'Ember Studio',
      BRAND: '{"accent":"#123a6f","landingText":"Ember landing","label":"  Ember & Co  "}',
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
      [owner, '/artefacts', 'Start of title or slug', 'Début du titre ou de l’identifiant'],
      [owner, detail, 'Open artefact', 'Ouvrir l’artefact'],
      [owner, deleted, 'Deleted artefacts', 'Artefacts supprimés'],
      [owner, tokens, 'Last used', 'Dernière utilisation'],
      [owner, redirects, 'Source prefix', 'Préfixe source'],
      [owner, members, 'Invitation links', 'Liens d’invitation'],
      [owner, bots, 'Create bot', 'Créer un robot'],
      [owner, '/connect', 'MCP endpoint', 'Point d’accès MCP'],
    ] as const
    for (const [browser, path, en, fr] of pages) {
      const document = await html(browser, path)
      expect(document, path).toContain(french ? fr : en)
      expect(document, path).toContain(`lang="${locale}"`)
      expect(document, path).toContain('Ember Studio')
      expect(document, path).toContain('Ember &amp; Co</a>')
    }
    const home = await owner.request('/')
    expect(home.status).toBe(303)
    expect(home.headers.get('Location')).toBe('/artefacts')
    const held = await pending.request('/artefacts?view=list')
    expect(held.status).toBe(303)
    expect(held.headers.get('Location')).toBe('/')
    const catalogue = await html(owner, '/artefacts')
    expect(catalogue).toContain('class="forge-shell"')
    expect(catalogue).toContain('class="forge-nav__link" href="/artefacts" aria-current="page"')
    expect(catalogue.match(/class="forge-nav__link"[^>]*aria-current="page"/g)).toHaveLength(2)
    expect(catalogue).toMatch(
      /<details class="forge-drawer"><summary class="forge-menu forge-button">Menu<\/summary>.*?href="\/artefacts" aria-current="page".*?action="\/logout".*?<\/details><\/div><div class="forge-tray__sections">.*?href="\/artefacts" aria-current="page".*?action="\/logout"/s,
    )
    expect(catalogue).toContain('<ul class="forge-gallery" role="list" aria-label="Artefacts">')
    expect(catalogue).not.toContain('<table')
    expect(catalogue).toContain(`href="${detail}"`)
    expect(catalogue).toContain('Quarterly report')
    expect(catalogue).not.toContain(`/_forge/preview/${slug}`)
    expect(catalogue).not.toContain('<dl>')
    expect(catalogue).toMatch(/<time datetime="[^"]+Z" title="[^"]+ UTC">[^<]+<\/time> · v1/)
    expect(catalogue).toContain(
      `<span class="forge-badge forge-badge--private">${french ? 'Privé' : 'Private'}</span>`,
    )
    expect(catalogue).toContain(`class="forge-nav__group" aria-label="${french ? 'Contenu' : 'Content'}"`)
    const [grid, list] = french ? ['Grille', 'Liste'] : ['Grid', 'List']
    expect(catalogue).toContain(
      `<nav class="forge-views" aria-label="${french ? 'Affichage' : 'View'}"><a href="/artefacts" aria-current="page">${grid}</a><a href="/artefacts?view=list">${list}</a></nav>`,
    )
    const listed = await html(owner, '/artefacts?visibility=private&view=list')
    expect(listed).not.toContain('class="forge-gallery')
    expect(listed).toContain(
      `<a class="forge-catalogue-link" href="${detail}"><span>Quarterly report</span></a>`,
    )
    expect(listed).toContain(`<td class="forge-col--folded" title="${slug}"><code>${slug}</code></td>`)
    expect(listed).toContain('<input type="hidden" name="view" value="list"/>')
    expect(listed).toContain(
      `<a href="/artefacts?visibility=private">${grid}</a><a href="/artefacts?visibility=private&amp;view=list" aria-current="page">${list}</a>`,
    )
    const invalidInvite = await html(anonymous, '/invite/invalid', 404)
    expect(invalidInvite).toContain(french ? 'Invitation invalide ou expirée' : 'Invite invalid or expired')
    expect(invalidInvite).toContain('forge-panel--invite')
    expect(invalidInvite).toContain('Ember &amp; Co</a>')
    const connection = await owner.request('/connect')
    expect(connection.status).toBe(200)
    const connect = await connection.text()
    expect(connect).toContain(
      french ? 'Point d’accès MCP (Streamable HTTP) :' : 'MCP endpoint (Streamable HTTP):',
    )
    const copyControl =
      /<button[^>]*type="button" data-copy="" data-copied="[^"]+" data-failed="[^"]+" hidden="">(?:Copy|Copier)<\/button>/
    expect(connect).toMatch(
      new RegExp(`<div class="forge-copy"><code>${manage}/mcp</code>${copyControl.source}</div>`),
    )
    const block = new RegExp(
      `<div class="forge-copy forge-copy--block"><pre><code>[\\s\\S]+?</code></pre>${copyControl.source}</div>`,
      'g',
    )
    expect(connect.match(block)).toHaveLength(5)
    expect(connect.match(/<pre>/g)).toHaveLength(5)
    const script = /<script>([^<]+)<\/script>/.exec(connect)?.[1]
    if (!script) throw new Error('Expected the copy script on the connection page')
    const hash = createHash('sha256').update(script).digest('base64')
    const policy = connection.headers.get('Content-Security-Policy')?.split('; ')
    expect(policy?.find((rule) => rule.startsWith('script-src '))).toBe(`script-src 'sha256-${hash}'`)
    for (const [client, command] of [
      ['claude.ai', 'CIMD'],
      ['Claude Desktop', 'JSON'],
      ['Claude Code', 'claude mcp add'],
      ['Codex', 'codex mcp login'],
      ['OMP', '/mcp reauth forge'],
      ['Hermes', 'FORGE_API_TOKEN'],
    ])
      expect(connect).toMatch(new RegExp(`<h2>${client}</h2>(?:(?!<h2>)[^])*?${command}`))
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
    const publicSend = runtime({ LOCALE: locale, PUBLIC_INDEX: 'true' })
    const emptyIndex = await html(new Browser(publicSend), `${read}/`)
    expect(emptyIndex).toContain(
      `<p class="forge-empty">${french ? 'Aucun artefact publié pour le moment.' : 'Nothing has been published yet.'}</p>`,
    )
    expect(emptyIndex).toContain(`<a href="/?view=list">${list}</a>`)
    const identity = { artefactId: await artefactId(owner) }
    await post(owner, detail, { action: 'visibility', visibility: 'public', ...identity })
    const publicIndex = await html(new Browser(publicSend), `${read}/`)
    expect(publicIndex).not.toContain(french ? 'Artefacts publics' : 'Public artefacts')
    expect(publicIndex).toContain(
      `<a class="forge-button forge-button--primary" href="${manage}/artefacts">${french ? 'Se connecter' : 'Sign in'}</a></header>`,
    )
    expect(publicIndex).toContain('<ul class="forge-gallery" role="list" aria-label="Artefacts">')
    expect(publicIndex).toContain('Quarterly report')
    const publicList = await html(new Browser(publicSend), `${read}/?view=list`)
    expect(publicList).toContain(
      '<ul class="forge-gallery forge-gallery--list" role="list" aria-label="Artefacts">',
    )
    expect(publicList).toContain(
      `<a href="/">${grid}</a><a href="/?view=list" aria-current="page">${list}</a>`,
    )
    const css = await send('/style.css')
    expect(await css.text()).toContain('--forge-accent:#123a6f')
    for (const origin of [read, manage]) {
      const icon = await send(`${origin}/favicon.svg`)
      expect(icon.headers.get('Content-Type')).toContain('image/svg+xml')
      expect(await icon.text()).toContain('<svg')
    }
    const landing = await html(anonymous, `${read}/`)
    expect(landing).toContain('Ember landing')
    expect(landing).toContain('href="/favicon.svg"')
    expect(landing).toContain('<title>Ember Studio</title>')
    expect(landing).toContain('Ember &amp; Co</h1>')
    const missingUrl = `${read}/a/${slug}/missing.html`
    const notFound = await html(anonymous, missingUrl, 404)
    expect(notFound).toContain(`lang="${locale}"`)
    expect(notFound).toContain(french ? '<title>Page introuvable</title>' : '<title>Not found</title>')
    expect(notFound).toContain('Ember &amp; Co</div>')
    await post(owner, detail, { action: 'visibility', visibility: 'private', ...identity })
    const unavailable = runtime({
      LOCALE: locale,
      PUBLIC_INDEX: 'true',
      DB: new Proxy(db, {
        get(target, key) {
          if (key === 'prepare')
            return () => {
              throw new Error('D1 unavailable')
            }
          return Reflect.get(target, key, target)
        },
      }),
    })
    const failed = await unavailable(`${read}/`)
    expect(failed.status).toBe(503)
    const errorPage = await failed.text()
    expect(errorPage).toContain(`lang="${locale}"`)
    expect(errorPage).toContain(
      french ? '<title>Forge est indisponible</title>' : '<title>Forge is unavailable</title>',
    )

    const privateUrl = `${read}/a/${slug}/`
    const reader = new Browser(send)
    const start = await reader.request(privateUrl, { headers: navigation })
    expect(start.status).toBe(302)
    const handoff = await pending.request(location(start), { headers: navigation })
    expect(handoff.status).toBe(200)
    const handoffHtml = await handoff.text()
    expect(handoffHtml).toContain(french ? 'Continuer vers Forge' : 'Continue to Forge')
    expect(handoffHtml).toContain('Ember &amp; Co</div>')
    expect(handoff.headers.get('Content-Security-Policy')).toContain("font-src 'self'")
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
    const waiting = await html(reader, privateUrl)
    expect(waiting).toContain(french ? 'Accès en attente' : 'Pending access')
    expect(waiting).toContain('Ember &amp; Co</div>')
    expect((await reader.request(privateUrl)).headers.get('Content-Security-Policy')).toContain(
      "font-src 'self'",
    )
    const next = await new Browser(send).request(privateUrl, { headers: navigation })
    const nextHandoff = await pending.request(location(next), { headers: navigation })
    const retry = await anonymous.request(`${read}/_forge/session`, {
      method: 'POST',
      headers: { origin: manage },
      body: handoffFields(await nextHandoff.text()),
    })
    expect(retry.status).toBe(400)
    const retryHtml = await retry.text()
    expect(retryHtml).toContain(french ? 'Réessayer de se connecter' : 'Try signing in again')
    expect(retryHtml).toContain('Ember &amp; Co</div>')

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
    const consent = await html(owner, authorize)
    expect(consent).toContain(french ? 'Autoriser' : 'Allow')
    expect(consent).toContain('Locale test client')
    expect(consent).toContain('forge-panel--consent')
    expect(consent).toContain('Ember &amp; Co</a>')
    const metadata = await send('/.well-known/oauth-protected-resource/mcp')
    expect(await metadata.json()).toMatchObject({ resource_name: 'Ember Studio' })
    const local = new URL(authorize, manage)
    const localClientId = `${manage}/oauth/clients/local.json`
    const fetchIdp = fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      input === localClientId ? send(localClientId) : fetchIdp(input, init),
    )
    local.searchParams.set('client_id', localClientId)
    local.searchParams.set('redirect_uri', 'http://127.0.0.1:3000/callback')
    expect(await html(owner, local)).toContain(french ? 'Client MCP local' : 'Local MCP client')
  },
)

it('fails closed on invalid locale or unsafe brand data', async () => {
  expect((await runtime({ LOCALE: 'de' })('/login')).status).toBe(503)
  expect(
    (await runtime({ BRAND: '{"accent":"red; background: url(https://example.test)"}' })('/login')).status,
  ).toBe(503)
})

it('uses UTC by default and a configured named zone for absolute timestamps without changing recent labels', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  await publish(send, await issueToken(owner, 'Date formatting'), slug, 'Date fixture')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  try {
    const match = /<time datetime="([^"]+)" title="([^"]+)">([^<]+)<\/time>/
    const utc = match.exec(await html(owner, '/artefacts'))
    const local = await runtime({ TIMEZONE: 'America/New_York' })('/artefacts', {
      headers: { Cookie: owner.cookieHeader() },
    })
    expect(local.status).toBe(200)
    const eastern = match.exec(await local.text())
    expect(utc?.[2]).toMatch(/ UTC$/)
    expect(eastern?.[2]).toMatch(/ (?:GMT-|\b[EC][SD]T)/)
    expect(eastern?.[2]).not.toBe(utc?.[2])
    expect(utc?.[3]).toBe('now')
    expect([eastern?.[1], eastern?.[3]]).toEqual([utc?.[1], utc?.[3]])
  } finally {
    clock.mockRestore()
  }
  expect((await runtime({ TIMEZONE: 'Europe/Missing' })('/login')).status).toBe(503)
  expect((await runtime({ TIMEZONE: '+02:00' })('/login')).status).toBe(503)
})

it('renders short elapsed and future times and falls back to a short absolute date beyond eight weeks', () => {
  const now = Date.UTC(2026, 1, 26)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const zone = { locale: 'en', timeZone: 'UTC' } as const
  const minute = 60_000
  const day = 24 * 60 * minute
  try {
    for (const [offset, label] of [
      [-minute + 1, /^now$/],
      [-minute, /^1 min\.? ago$/],
      [-60 * minute, /^1 hr\.? ago$/],
      [-day, /^1 day ago$/],
      [day, /^in 1 day$/],
      [-6 * day, /^6 days? ago$/],
      [-7 * day, /^1 wk\.? ago$/],
      [-56 * day, /^8 wk\.? ago$/],
      [-56 * day - 1, /^31\/12\/2025$/],
      [3 * day, /^in 3 days$/],
    ] as const) {
      const rendered = String(time(zone, now + offset))
      expect(rendered).toContain(`datetime="${new Date(now + offset).toISOString()}"`)
      expect(/>([^<]+)<\/time>/.exec(rendered)?.[1]).toMatch(label)
    }
    expect(time(zone, null)).toBe('—')
  } finally {
    clock.mockRestore()
  }
})

it.each([
  ['UTC', '2026-11-21T23:00:00Z', '2026-11-23T00:30:00Z'],
  // Both instants are on November 1 locally, 24.5 hours apart across the fallback.
  ['America/New_York', '2026-11-01T04:05:00Z', '2026-11-02T04:35:00Z'],
])('describes elapsed days without a calendar-day label in %s', (timeZone, timestamp, now) => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
  try {
    expect(String(time({ locale: 'en', timeZone }, Date.parse(timestamp)))).toMatch(/>1 day ago<\/time>$/)
  } finally {
    clock.mockRestore()
  }
})
