import { readCookie, readForm, writeCookie } from './http'
import type { Locale } from './i18n'

export const languagePath = '/_forge/language'
const preference = '__Host-forge-language'
const preferenceMaxAge = 365 * 24 * 60 * 60
// Allow the base64url read-handoff continuation and its enclosing sign-in URL.
const maxBrowserReturnLength = 16_384
const languageRange =
  /^[ \t]*(en|fr)(?:-[a-z0-9]{1,8})*[ \t]*(?:;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?[ \t]*$/i

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
  if (
    !value ||
    value.length > maxBrowserReturnLength ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\s\p{Cc}]/u.test(value)
  )
    return null
  if (/\\|%5c/i.test(value.split(/[?#]/, 1)[0])) return null
  const target = URL.parse(value, origin)
  // Validate the normalized pathname, including encoded leading separators, not the query.
  if (!target || target.origin !== origin || /^\/(?:\/|%(?:25)*(?:2f|5c))/i.test(target.pathname)) return null
  return target.pathname + target.search + target.hash
}

// This cookie is only a presentation preference, even when set by read-origin artefacts.
export async function setLanguage(
  request: Request,
  origin: string,
  headers: Headers,
  resolveConsent?: (token: string) => Promise<string | null>,
): Promise<Response> {
  if (request.method !== 'POST') {
    headers.set('Allow', 'POST')
    return new Response(null, { status: 405, headers })
  }
  if (request.headers.get('Origin') !== origin) return new Response(null, { status: 403, headers })
  const fields = await readForm(request)
  const language = fields?.get('language') ?? null
  if (!fields || !isLocale(language)) return new Response(null, { status: 400, headers })
  const consent = fields.get('consent')
  let location: string | null
  if (consent !== null) {
    location = resolveConsent && !fields.has('return') ? await resolveConsent(consent) : null
  } else {
    // The Manage shell uses its same-origin referrer rather than echoing query values in HTML.
    const referer = request.headers.get('Referer')
    const fromPage = referer?.startsWith(`${origin}/`) ? referer.slice(origin.length) : null
    location = localReturn(fields.get('return') ?? fromPage, origin)
  }
  if (!location) return new Response(null, { status: 400, headers })
  headers.set('Set-Cookie', writeCookie(preference, language, preferenceMaxAge))
  headers.set('Location', location)
  return new Response(null, { status: 303, headers })
}
