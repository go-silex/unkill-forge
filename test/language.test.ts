import { expect, it } from 'vitest'
import { instanceConfiguration } from '../src/config'
import { Browser, configuredEnv, formValue, manage, read, runtime, setupStorage } from './http'

const preference = '__Host-forge-language'
const endpoint = '/_forge/language'
const frenchHeader = { 'Accept-Language': 'fr-CA, en;q=0.8' }

setupStorage()

it('reuses both localized configurations without changing the instance default or time zone', () => {
  for (const locale of ['en', 'fr'] as const) {
    const env = configuredEnv({ LOCALE: locale, TIMEZONE: 'Europe/Paris' })
    const instance = instanceConfiguration(env)
    expect(instance).not.toBeNull()
    expect(instanceConfiguration(env)).toBe(instance)
    expect(instance?.default).toBe(instance?.locales[locale])
    expect(instance?.default.locale).toBe(locale)
    expect(instance?.locales.en).toMatchObject({ locale: 'en', timeZone: 'Europe/Paris' })
    expect(instance?.locales.fr).toMatchObject({ locale: 'fr', timeZone: 'Europe/Paris' })
  }
})

it.each([
  ['en', 'fr', undefined, 'fr'],
  ['fr', 'en', undefined, 'en'],
  ['en', 'de;q=1,en-GB;q=0.3, FR-ca ; Q=0.75', undefined, 'fr'],
  ['fr', 'fr-FR;q=0.4,en-US;q=0.75', undefined, 'en'],
  ['fr', 'fr;q = 1,en;q=0.8', undefined, 'en'],
  ['fr', 'fr;q= 1,en;q=0.8', undefined, 'en'],
  ['en', 'fr-CA;q=0.7,en;q=0.7', undefined, 'fr'],
  ['en', 'fr;q=0,de,*;q=0.8', undefined, 'en'],
  ['fr', 'en;q=1.1,en;q=oops,es-ES', undefined, 'fr'],
  ['fr', undefined, undefined, 'fr'],
  ['en', 'en', `${preference}=fr`, 'fr'],
  ['fr', 'fr', `${preference}=en`, 'en'],
  ['en', 'fr', `${preference}=de`, 'fr'],
  ['en', 'en', `${preference}=fr; ${preference}=en`, 'en'],
] as const)('negotiates (%s, %s, %s)', async (fallback, accept, cookie, locale) => {
  const send = runtime({ LOCALE: fallback })
  const headers = new Headers()
  if (accept) headers.set('Accept-Language', accept)
  if (cookie) headers.set('Cookie', cookie)
  for (const path of [`${read}/`, '/login']) {
    const page = await send(path, { headers })
    expect(page.status).toBe(200)
    expect(page.headers.get('Content-Language')).toBe(locale)
    expect(page.headers.get('Cache-Control')).toContain('no-store')
    const body = await page.text()
    expect(body).toContain(`<html lang="${locale}">`)
    expect(body).toContain(locale === 'fr' ? 'Se connecter' : 'Sign in')
  }
})

it('switches and persists independently on both hosts, keeping local page state', async () => {
  const send = runtime({ PUBLIC_INDEX: 'true' })
  const reader = new Browser(send)
  const manager = new Browser(send)
  const landing = '/?q=plan&view=list'
  const login = '/login?return=%2Fconnect'
  const cases = [
    [reader, read, landing, 'Rechercher'],
    [manager, manage, login, 'Se connecter'],
  ] as const
  for (const [browser, origin, path, french] of cases) {
    const start = await browser.request(origin + path, { headers: frenchHeader })
    expect(start.headers.get('Content-Security-Policy')).toContain("form-action 'self'")
    expect(start.headers.get('Referrer-Policy')).toBe('same-origin')
    const document = await start.text()
    expect(document).toContain(french)
    expect(document).toContain(`class="forge-language-switch" action="${endpoint}" method="post"`)
    expect(document).toMatch(/name="language" value="en" lang="en" aria-label="English">EN<\/button>/)
    const returnPath = formValue(document, 'return').replace('&amp;', '&')
    expect(returnPath).toBe(path)
    const changed = await browser.post(origin + endpoint, { language: 'en', return: returnPath }, origin)
    expect(changed.status).toBe(303)
    expect(changed.headers.get('Location')).toBe(path)
    expect(changed.headers.get('Cache-Control')).toContain('no-store')
    expect(changed.headers.getSetCookie()).toEqual([
      `${preference}=en; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`,
    ])
    const page = await browser.request(origin + path, { headers: frenchHeader })
    expect(page.headers.get('Content-Language')).toBe('en')
    expect(await page.text()).toMatch(
      /name="language" value="fr" lang="fr" aria-label="Français">FR<\/button>/,
    )
  }
  const untouched = await send(`${read}/`, { headers: frenchHeader })
  expect(untouched.headers.get('Content-Language')).toBe('fr')
  const privateArea = await reader.request(`${read}/a/not-published/`, { headers: frenchHeader })
  expect(privateArea.status).toBe(404)
  expect(privateArea.headers.get('Content-Language')).toBe('en')
  expect(await privateArea.text()).toContain('Page not found')
})

it.each([read, manage])('requires same-origin POST and a local return on %s', async (origin) => {
  const send = runtime()
  const post = (body: URLSearchParams, from = origin) =>
    send(origin + endpoint, { method: 'POST', headers: from ? { Origin: from } : {}, body })
  const body = new URLSearchParams({ language: 'fr', return: '/?view=list' })
  const get = await send(origin + endpoint)
  expect(get.status).toBe(405)
  expect(get.headers.get('Allow')).toBe('POST')
  for (const from of ['', 'null', origin === read ? manage : read]) {
    const forbidden = await post(body, from)
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.has('Set-Cookie')).toBe(false)
  }
  for (const destination of [
    '',
    'relative',
    `${origin}/`,
    '//other.example/',
    '/\\other.example/',
    '/%5cother.example/',
    '/%2fother.example/',
    '/%252Fother.example/',
    '/%255Cother.example/',
    '/prefix/../%2Fother.example/',
    '/.//other.example/',
    '/a\t/b',
    `/${'x'.repeat(16_384)}`,
  ]) {
    const invalid = await post(new URLSearchParams({ language: 'fr', return: destination }))
    expect(invalid.status, destination).toBe(400)
    expect(invalid.headers.has('Set-Cookie')).toBe(false)
    expect(invalid.headers.has('Location')).toBe(false)
  }
  const safeQuery = '/?q=%2F%5C'
  const accepted = await post(new URLSearchParams({ language: 'fr', return: safeQuery }))
  expect(accepted.status).toBe(303)
  expect(accepted.headers.get('Location')).toBe(safeQuery)
  const invalidLanguage = await post(new URLSearchParams({ language: 'fr-CA', return: '/' }))
  expect(invalidLanguage.status).toBe(400)
  const duplicate = await post(new URLSearchParams('language=en&language=fr&return=%2F'))
  expect(duplicate.status).toBe(400)
  const json = await send(origin + endpoint, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(json.status).toBe(400)
  const missing = await post(new URLSearchParams({ language: 'fr' }))
  expect(missing.status).toBe(400)
  const foreign = await send(origin + endpoint, {
    method: 'POST',
    headers: { Origin: origin, Referer: 'https://other.example/page' },
    body: new URLSearchParams({ language: 'fr' }),
  })
  expect(foreign.status).toBe(400)
  expect(foreign.headers.has('Set-Cookie')).toBe(false)
})
