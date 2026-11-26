import { readCookie, readForm, writeCookie } from './http'
import type { Locale } from './i18n'

export const languagePath = '/_forge/language'
const preference = '__Host-forge-language'
const preferenceMaxAge = 365 * 24 * 60 * 60
const languageRange =
  /^\s*(en|fr)(?:-[a-z0-9]{1,8})*\s*(?:;\s*q\s*=\s*(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?\s*$/i

function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'fr'
}

export function visitorLocale(request: Request, fallback: Locale): Locale {
  const cookie = readCookie(request, preference)
  if (isLocale(cookie)) return cookie

  let best = fallback
  let quality = 0
  for (const range of request.headers.get('Accept-Language')?.split(',') ?? []) {
    const match = languageRange.exec(range)
    if (!match) continue
    const weight = match[2] === undefined ? 1 : Number(match[2])
    if (weight <= quality) continue
    best = match[1].toLowerCase() === 'fr' ? 'fr' : 'en'
    quality = weight
    if (weight === 1) break
  }
  return best
}

function localReturn(value: string | null, origin: string): string | null {
  if (!value || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || /\s/.test(value))
    return null
  if (/\\|%5c/i.test(value.split(/[?#]/, 1)[0])) return null
  const target = new URL(value, origin)
  if (target.origin !== origin || target.pathname.startsWith('//')) return null
  return target.pathname + target.search + target.hash
}

// This cookie is only a presentation preference, even when set by read-origin artefacts.
export async function setLanguage(request: Request, origin: string, headers: Headers): Promise<Response> {
  if (request.method !== 'POST') {
    headers.set('Allow', 'POST')
    return new Response(null, { status: 405, headers })
  }
  if (request.headers.get('Origin') !== origin) return new Response(null, { status: 403, headers })
  const fields = await readForm(request)
  const language = fields?.get('language') ?? null
  // Consent and Manage pages omit the return field to avoid reflecting request query values in HTML.
  const referer = request.headers.get('Referer')
  const fromPage = referer?.startsWith(`${origin}/`) ? referer.slice(origin.length) : null
  const location = localReturn(fields?.get('return') ?? fromPage, origin)
  if (!isLocale(language) || !location) return new Response(null, { status: 400, headers })
  headers.set('Set-Cookie', writeCookie(preference, language, preferenceMaxAge))
  headers.set('Location', location)
  return new Response(null, { status: 303, headers })
}
