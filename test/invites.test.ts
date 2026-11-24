import { env } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import {
  admin,
  Browser,
  flashNavigation,
  listedId,
  location,
  manage,
  provider,
  read,
  runtime,
  sessionCookie,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const { DB } = env as typeof env & { DB: D1Database }
const members = '/admin/members'
const noAutoJoin = { AUTH_PROVIDERS: JSON.stringify([{ ...provider, autoJoinRole: undefined }]) }

it('keeps Gate 0 login flow inserts and deletes compatible after migration', async () => {
  const now = Date.now()
  const inserted = await DB.prepare('INSERT INTO login_flows VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('gate-0-state', 'gate-0-browser', 'team', '/', null, now, now + 300_000)
    .run()
  expect(inserted.success).toBe(true)
  const consumed = await DB.prepare(`DELETE FROM login_flows WHERE state_hash = ? AND browser_hash = ?
    AND provider = ? AND expires_at > ? RETURNING return_path AS returnPath`)
    .bind('gate-0-state', 'gate-0-browser', 'team', now)
    .first()
  expect(consumed).toEqual({ returnPath: '/' })
  expect((await DB.prepare('SELECT COUNT(*) AS count FROM login_flow_metadata').first())?.count).toBe(0)
})

async function createInvite(owner: Browser, role: string) {
  const response = await owner.post(members, { action: 'create-invite', role })
  expect(response.status).toBe(303)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const destination = location(response)
  expect(destination.origin + destination.pathname).toBe(manage + members)
  expect(await response.text()).not.toContain('/invite/')
  const landing = await owner.request(destination, { headers: flashNavigation })
  expect(landing.status).toBe(200)
  expect(landing.headers.get('Cache-Control')).toBe('no-store')
  const link = /<code>(https:\/\/[^<]+\/invite\/[A-Za-z0-9_-]{43})<\/code>/.exec(await landing.text())?.[1]
  if (!link) throw new Error('No invite URL was shown')
  expect(new URL(link).origin).toBe(manage)
  expect(await (await owner.request(destination, { headers: flashNavigation })).text()).not.toContain(link)
  return link
}

async function openInvite(browser: Browser, link: string) {
  const redirect = await browser.request(link)
  expect(redirect.status).toBe(303)
  expect(redirect.headers.get('Referrer-Policy')).toBe('no-referrer')
  const landing = location(redirect)
  const context = landing.searchParams.get('invite')
  const token = link.split('/').at(-1)
  expect(landing.origin + landing.pathname).toBe(`${manage}/login`)
  expect(landing.href).not.toContain(token)
  expect(context).toMatch(/^[\w-]{43}$/)
  const cookie = `__Host-forge-invite-${context}`
  expect(redirect.headers.getSetCookie()).toEqual([
    expect.stringMatching(
      /^__Host-forge-invite-[\w-]{43}=[\w-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/,
    ),
  ])
  expect(redirect.headers.get('Set-Cookie')).not.toContain(token)
  const page = await browser.request(landing)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('accept your invitation')
  expect(html).not.toContain(token)
  const href = /href="(\/login\/team\?invite=[\w-]{43})"/.exec(html)?.[1]
  if (!href) throw new Error('No token-free provider link was shown')
  expect(href).toBe(`/login/team?invite=${context}`)
  return { href, cookie, token }
}

async function beginInvite(browser: Browser, link: string) {
  const { href, cookie, token } = await openInvite(browser, link)
  const response = await browser.request(href)
  expect(response.status).toBe(302)
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('Location')).not.toContain(token)
  expect(browser.cookie(cookie)).toBeUndefined()
  return location(response)
}

it('keeps invite contexts separate across tabs and ignores them in ordinary or other-browser sign-ins', async () => {
  const send = runtime(noAutoJoin)
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const browser = new Browser(send)
  const viewerTab = await openInvite(browser, await createInvite(owner, 'viewer'))
  const adminTab = await openInvite(browser, await createInvite(owner, 'admin'))
  expect(viewerTab.href).not.toBe(adminTab.href)

  expect((await idp.login(browser, 'ordinary-tab')).status).toBe(302)
  expect(await (await browser.request('/')).text()).toContain('Pending access')
  const otherBrowser = new Browser(send)
  const copied = location(await otherBrowser.request(adminTab.href))
  expect((await otherBrowser.request(await idp.issue(copied, 'copied-context'))).status).toBe(302)
  expect(await (await otherBrowser.request('/')).text()).toContain('Pending access')

  const expectAccount = async (name: string, role: string) => {
    expect(await (await browser.request('/artefacts')).text()).toContain(
      `<div class="forge-account"><span class="forge-account__name">${name}</span><span class="forge-account__role">${role}</span>`,
    )
  }
  const viewerStart = location(await browser.request(viewerTab.href))
  const adminStart = location(await browser.request(adminTab.href))
  expect((await browser.request(await idp.issue(viewerStart, 'viewer-tab'))).status).toBe(302)
  await expectAccount('viewer-tab', 'viewer')
  expect((await browser.request(await idp.issue(adminStart, 'admin-tab'))).status).toBe(302)
  await expectAccount('admin-tab', 'admin')
})

it('admits only one of two concurrent invite callbacks and shows the URL only at creation', async () => {
  const send = runtime(noAutoJoin)
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const link = await createInvite(owner, 'publisher')
  const inviteToken = link.split('/').at(-1)
  const list = await (await owner.request(members)).text()
  expect(list).toContain('revoke-invite')
  expect(list).not.toContain(inviteToken)

  const first = new Browser(send)
  const second = new Browser(send)
  const firstCallback = await idp.issue(await beginInvite(first, link), 'first-invitee')
  const secondCallback = await idp.issue(await beginInvite(second, link), 'second-invitee')

  // Storage is the seam for the no-plaintext requirement, including the pending login flows.
  const invites = (await DB.prepare('SELECT * FROM invites').all()).results
  expect(invites).toEqual([expect.objectContaining({ role: 'publisher', token_hash: expect.any(String) })])
  expect(Number(invites[0]?.expires_at) - Number(invites[0]?.created_at)).toBe(604_800_000)
  expect(JSON.stringify(invites)).not.toContain(inviteToken)
  const flows = (await DB.prepare('SELECT * FROM login_flow_metadata').all()).results
  expect(flows.map((flow) => flow.invite_hash)).toEqual([invites[0]?.token_hash, invites[0]?.token_hash])
  expect(JSON.stringify(flows)).not.toContain(inviteToken)

  expect(
    (await Promise.all([first.request(firstCallback), second.request(secondCallback)])).map(
      (res) => res.status,
    ),
  ).toEqual([302, 302])
  expect((await DB.prepare('SELECT COUNT(*) AS count FROM login_flow_metadata').first())?.count).toBe(0)
  const homes = await Promise.all([first, second].map((b) => b.request('/')))
  expect(homes.map((home) => home.status).sort()).toEqual([200, 303])
  const winner = homes[0].status === 303 ? first : second
  expect(await (await winner.request('/artefacts')).text()).toContain(
    `<div class="forge-account"><span class="forge-account__name">${winner === first ? 'first' : 'second'}-invitee</span><span class="forge-account__role">publisher</span>`,
  )
  expect(await homes.find((home) => home.status === 200)?.text()).toContain('Pending access')
  const used = await send(link)
  const unknown = await send(`/invite/${'a'.repeat(43)}`)
  expect(used.status).toBe(404)
  expect(await used.text()).toBe(await unknown.text())
  expect(await (await owner.request(members)).text()).not.toContain('revoke-invite')
  const audit = (
    await DB.prepare(
      "SELECT action, detail_json FROM audit_log WHERE action LIKE 'invite.%' ORDER BY action",
    ).all()
  ).results
  expect(audit.map((row) => row.action)).toEqual(['invite.consume', 'invite.create'])
  expect(JSON.stringify(audit)).not.toContain(inviteToken)
})

it('admits a pending member, ignores active accounts, and ignores invite query parameters', async () => {
  const send = runtime(noAutoJoin)
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const pending = await idp.signedIn(send, 'pending-user')
  expect(await (await pending.request('/')).text()).toContain('Pending access')
  const id = await listedId(owner, members, 'pending-user@example.test')
  const link = await createInvite(owner, 'admin')

  expect((await owner.request(await idp.issue(await beginInvite(owner, link), admin))).status).toBe(302)
  expect((await send(link)).status).toBe(303)

  const injectedToken = link.split('/').at(-1) ?? ''
  const injectedStart = location(await pending.request(`/login/team?invite=${injectedToken}`))
  const injected = await idp.issue(injectedStart, 'pending-user')
  injected.searchParams.set('invite', injectedToken)
  expect((await pending.request(injected)).status).toBe(302)
  expect((await pending.request(members)).status).toBe(403)

  expect(
    (await pending.request(await idp.issue(await beginInvite(pending, link), 'pending-user'))).status,
  ).toBe(302)
  expect((await pending.request(members)).status).toBe(200)
  expect(await listedId(owner, members, 'pending-user@example.test')).toBe(id)
  expect((await pending.request(link)).status).toBe(404)
})

it('lists and claims invites using D1 time and can revoke an expired unused invite', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const link = await createInvite(owner, 'publisher')
  const id = await listedId(owner, members, 'revoke-invite')
  const browser = new Browser(send)
  const callback = await idp.issue(await beginInvite(browser, link), 'expired-invitee')
  await DB.prepare("UPDATE invites SET expires_at = unixepoch('subsec') * 1000 - 1").run()

  const expired = await send(link)
  const unknown = await send(`/invite/${'a'.repeat(43)}`)
  expect(expired.status).toBe(404)
  expect(unknown.status).toBe(404)
  expect(expired.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(expired.headers.get('Cache-Control')).toBe('no-store')
  const page = await expired.text()
  expect(page).toContain('forge-panel--invite')
  expect(page).not.toContain(link.split('/').at(-1))
  expect(page).toBe(await unknown.text())
  // List and callback must ignore a Worker clock that still considers this invite valid.
  const workerTime = Date.now() - 5_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(workerTime)
  try {
    expect(await (await owner.request(members)).text()).not.toContain('revoke-invite')
    expect((await browser.request(callback)).status).toBe(302)
  } finally {
    clock.mockRestore()
  }
  expect(await (await browser.request('/artefacts')).text()).toContain(
    '<div class="forge-account"><span class="forge-account__name">expired-invitee</span><span class="forge-account__role">viewer</span>',
  )
  expect((await owner.post(members, { action: 'revoke-invite', id })).status).toBe(303)
  const conflict = await owner.post(members, { action: 'revoke-invite', id })
  expect(conflict.status).toBe(303)
  expect(await (await owner.request(location(conflict), { headers: flashNavigation })).text()).toContain(
    'Member action not allowed',
  )
})

it('does not re-admit a removed identity by invite, auto-join or a listed bootstrap email', async () => {
  const subject = 'removed-invitee'
  const send = runtime({ ADMIN_EMAILS: `${admin}@example.test,${subject}@example.test` })
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const member = await idp.signedIn(send, subject)
  const link = await createInvite(owner, 'admin')
  const id = await listedId(owner, members, `${subject}@example.test`)
  expect((await owner.post(members, { id, action: 'remove' })).status).toBe(303)
  const ownerId = await DB.prepare('SELECT id FROM members WHERE email = ?')
    .bind(`${admin}@example.test`)
    .first<string>('id')
  if (!ownerId) throw new Error('Expected an authenticated administrator')
  expect(
    (
      await owner.post(members, {
        id: ownerId,
        action: 'remove',
      })
    ).status,
  ).toBe(303)

  const browser = new Browser(send)
  expect((await browser.request(await idp.issue(await beginInvite(browser, link), subject))).status).toBe(403)
  expect(browser.cookie(sessionCookie)).toBeUndefined()
  expect((await idp.login(browser, subject)).status).toBe(403)
  expect(
    (await browser.request(await idp.issue(await beginInvite(browser, link), 'new-invitee'))).status,
  ).toBe(302)
  expect((await browser.request(members)).status).toBe(200)
  expect(location(await member.request(members)).pathname).toBe('/login')
})

it('restricts invite creation and revocation to same-origin admins and audits a successful revoke', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const viewer = await idp.signedIn(send, 'viewer')
  const create = { action: 'create-invite', role: 'viewer' }
  expect((await viewer.request(members)).status).toBe(403)
  expect((await viewer.post(members, create)).status).toBe(403)
  expect((await owner.post(members, create, read)).status).toBe(403)
  expect((await owner.post(members, create, '')).status).toBe(403)
  const oversized = await owner.post(members, { ...create, padding: 'a'.repeat(40_000) })
  expect(oversized.status).toBe(400)

  const link = await createInvite(owner, 'publisher')
  const id = await listedId(owner, members, 'revoke-invite')
  const revoke = { action: 'revoke-invite', id }
  expect((await viewer.post(members, revoke)).status).toBe(403)
  expect((await owner.post(members, revoke, read)).status).toBe(403)
  const browser = new Browser(send)
  const callback = await idp.issue(await beginInvite(browser, link), 'revoked-invitee')
  expect((await owner.post(members, revoke)).status).toBe(303)
  const conflict = await owner.post(members, revoke)
  expect(conflict.status).toBe(303)
  expect(await (await owner.request(location(conflict), { headers: flashNavigation })).text()).toContain(
    'Member action not allowed',
  )
  expect((await send(link)).status).toBe(404)
  expect((await browser.request(callback)).status).toBe(302)
  expect(await (await browser.request('/artefacts')).text()).toContain(
    '<div class="forge-account"><span class="forge-account__name">revoked-invitee</span><span class="forge-account__role">viewer</span>',
  )
  const audit = (
    await DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'invite.%' ORDER BY action").all()
  ).results
  expect(audit.map((row) => row.action)).toEqual(['invite.create', 'invite.revoke'])
})
