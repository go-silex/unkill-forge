import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  admin,
  type Browser,
  flashNavigation,
  listedId,
  location,
  provider,
  runtime,
  setupStorage,
  whoami,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const bots = '/admin/bots'
const tokenPattern = /<code>(fgt_[A-Za-z0-9_-]{43})<\/code>/

async function createBot(owner: Browser, name: string, display = name) {
  expect((await owner.post(bots, { action: 'create', name, role: 'publisher' })).status).toBe(303)
  return listedId(owner, '/admin/members', display)
}

async function mint(owner: Browser, id: string) {
  const response = await owner.post(bots, { action: 'token', id, name: 'Flash test token' })
  expect(response.status).toBe(303)
  const destination = location(response)
  expect(destination.pathname).toBe(bots)
  expect(destination.searchParams.get('bot')).toBe(id)
  expect(destination.searchParams.get('flash-id')).toMatch(/^[0-9a-f-]{36}$/)
  expect(destination.href).not.toContain('fgt_')
  expect(await response.text()).not.toContain('fgt_')
  return destination
}

it('keeps the continuation unconsumed without a document navigation or the issuing session', async () => {
  const send = runtime()
  const idp = mockProvider()
  const owner = await idp.signedIn(send, admin)
  const otherSession = await idp.signedIn(send, admin)
  const name = 'Flash owner $&'
  const id = await createBot(owner, name, 'Flash owner')
  const url = await mint(owner, id)

  for (const headers of [
    undefined,
    { ...flashNavigation, 'Sec-Fetch-Mode': 'cors' },
    { ...flashNavigation, 'Sec-Fetch-Dest': 'empty' },
  ]) {
    const response = await owner.request(url, { headers })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toMatch(tokenPattern)
  }
  expect(await (await otherSession.request(url, { headers: flashNavigation })).text()).not.toMatch(
    tokenPattern,
  )

  const response = await owner.request(url, { headers: flashNavigation })
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('same-origin')
  const html = await response.text()
  const token = tokenPattern.exec(html)?.[1]
  if (!token) throw new Error('Expected a one-time bot token')
  expect(html).toContain('API token created for Flash owner $&amp;.')
  expect(html).toMatch(/<aside[^>]*data-secret-flash[^>]*>[\s\S]*<code>fgt_/)
  const script = /<script>([^<]+)<\/script>/.exec(html)?.[1]
  if (!script) throw new Error('Expected the one-time secret cleanup script')
  expect(script).toContain('pageshow')
  expect(script).toContain('e.persisted')
  const hash = createHash('sha256').update(script).digest('base64')
  expect(response.headers.get('Content-Security-Policy')).toContain(`'sha256-${hash}'`)
  expect(await whoami(send, token)).toMatchObject({ id, name })
  expect(await (await owner.request(url, { headers: flashNavigation })).text()).not.toMatch(tokenPattern)
})

it('displays the flash once after a cross-site silent OIDC revalidation redirect', async () => {
  const send = runtime()
  const idp = mockProvider()
  vi.useFakeTimers({ toFake: ['Date'] })
  const signedInAt = Date.now()
  const owner = await idp.signedIn(send, admin)
  const id = await createBot(owner, 'Revalidated bot')
  const deadline = signedInAt + provider.revalidateAfterMinutes * 60_000
  vi.setSystemTime(deadline - 1_000)
  const destination = await mint(owner, id)
  vi.setSystemTime(deadline + 1_000)

  const challenge = await owner.request(destination, { headers: flashNavigation })
  expect(challenge.status).toBe(302)
  const authorization = location(challenge)
  expect(authorization.searchParams.get('prompt')).toBe('none')
  expect(authorization.href).not.toContain('flash-id')
  const headers = { ...flashNavigation, 'Sec-Fetch-Site': 'cross-site' }
  const callback = await owner.request(await idp.issue(authorization, admin), { headers })
  expect(callback.status).toBe(302)
  expect(location(callback).href).toBe(destination.href)
  const page = await owner.request(location(callback), { headers })
  expect(page.status).toBe(200)
  expect(page.headers.get('Referrer-Policy')).toBe('same-origin')
  const token = tokenPattern.exec(await page.text())?.[1]
  if (!token) throw new Error('Expected the same flash after revalidation')
  expect(await whoami(send, token)).toMatchObject({ id })
  expect(await (await owner.request(destination, { headers })).text()).not.toMatch(tokenPattern)
})

it('isolates simultaneous bot flashes and rejects another bot or extra query parameters', async () => {
  const send = runtime()
  const owner = await mockProvider().signedIn(send, admin)
  const a = await createBot(owner, 'Bot A')
  const b = await createBot(owner, 'Bot B')
  const aUrl = await mint(owner, a)
  const bUrl = await mint(owner, b)
  const aFlash = aUrl.searchParams.get('flash-id')
  if (!aFlash) throw new Error('Expected a flash ID')
  expect(aFlash).not.toBe(bUrl.searchParams.get('flash-id'))

  const wrongBot = new URL(bUrl)
  wrongBot.searchParams.set('flash-id', aFlash)
  const extraQuery = new URL(aUrl)
  extraQuery.searchParams.set('irrelevant', 'true')
  for (const url of [wrongBot, extraQuery]) {
    const response = await owner.request(url, { headers: flashNavigation })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toMatch(tokenPattern)
  }

  for (const [url, id] of [
    [aUrl, a],
    [bUrl, b],
  ] as const) {
    const response = await owner.request(url, { headers: flashNavigation })
    const token = tokenPattern.exec(await response.text())?.[1]
    if (!token) throw new Error('Expected an independent bot token')
    expect(await whoami(send, token)).toMatchObject({ id })
    expect(await (await owner.request(url, { headers: flashNavigation })).text()).not.toMatch(tokenPattern)
  }
})
