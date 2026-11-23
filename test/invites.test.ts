import { env } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import {
  admin,
  Browser,
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
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const link = /<code>(https:\/\/[^<]+\/invite\/[A-Za-z0-9_-]{43})<\/code>/.exec(await response.text())?.[1]
  if (!link) throw new Error('No invite URL was shown')
  expect(new URL(link).origin).toBe(manage)
  return link
}

async function beginInvite(browser: Browser, link: string) {
  const redirect = await browser.request(link)
  expect(redirect.status).toBe(303)
  expect(redirect.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(redirect.headers.getSetCookie()).toEqual([
    expect.stringMatching(
      /^__Host-forge-invite=[\w-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/,
    ),
  ])
  const landing = location(redirect)
  expect(landing.href).toBe(`${manage}/login`)
  const page = await browser.request(landing)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).not.toContain(link.split('/').at(-1))
  const href = /href="(\/login\/team\?return=%2F)"/.exec(html)?.[1]
  if (!href) throw new Error('No token-free provider link was shown')
  const response = await browser.request(href)
  expect(response.status).toBe(302)
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('Location')).not.toContain(link.split('/').at(-1))
  expect(browser.cookie('__Host-forge-invite')).toBeUndefined()
  return location(response)
}

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
  const pages = await Promise.all([first, second].map(async (b) => (await b.request('/')).text()))
  expect(pages.filter((page) => page.includes('(publisher)'))).toHaveLength(1)
  expect(pages.filter((page) => page.includes('Pending access'))).toHaveLength(1)
  expect((await send(link)).status).toBe(404)
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

it('rechecks expiry using D1 time even when the callback Worker clock is behind', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const link = await createInvite(owner, 'publisher')
  const browser = new Browser(send)
  const callback = await idp.issue(await beginInvite(browser, link), 'expired-invitee')
  await DB.prepare("UPDATE invites SET expires_at = unixepoch('subsec') * 1000 - 1").run()

  const expired = await send(link)
  const unknown = await send(`/invite/${'a'.repeat(43)}`)
  expect(expired.status).toBe(404)
  expect(await expired.text()).toBe(await unknown.text())
  expect(await (await owner.request(members)).text()).not.toContain('revoke-invite')
  const workerTime = Date.now() - 5_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(workerTime)
  try {
    expect((await browser.request(callback)).status).toBe(302)
  } finally {
    clock.mockRestore()
  }
  expect(await (await browser.request('/')).text()).toContain('expired-invitee (viewer)')
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
  expect(
    (
      await owner.post(members, {
        id: await listedId(owner, members, `${admin}@example.test`),
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

  const link = await createInvite(owner, 'publisher')
  const id = await listedId(owner, members, 'revoke-invite')
  const revoke = { action: 'revoke-invite', id }
  expect((await viewer.post(members, revoke)).status).toBe(403)
  expect((await owner.post(members, revoke, read)).status).toBe(403)
  const browser = new Browser(send)
  const callback = await idp.issue(await beginInvite(browser, link), 'revoked-invitee')
  expect((await owner.post(members, revoke)).status).toBe(303)
  expect((await owner.post(members, revoke)).status).toBe(409)
  expect((await send(link)).status).toBe(404)
  expect((await browser.request(callback)).status).toBe(302)
  expect(await (await browser.request('/')).text()).toContain('revoked-invitee (viewer)')
  const audit = (
    await DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'invite.%' ORDER BY action").all()
  ).results
  expect(audit.map((row) => row.action)).toEqual(['invite.create', 'invite.revoke'])
})
