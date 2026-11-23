import type { Context } from 'hono'
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { Config, Runtime } from '../../config'
import type { BrowserSession, Member } from '../../core'
import { putUiFlash, takeUiFlash } from '../../core/ui-flash'
import { DocumentHead } from '../../head'
import { type Locale, messages } from '../../i18n'

export type UiContext = Context<{ Bindings: Runtime }>

export function Action({
  action,
  label,
  fields,
  path,
  children,
}: {
  action: string
  label: string
  fields?: Record<string, string | number>
  path?: string
  children?: Child
}) {
  return (
    <form action={path} method="post">
      {fields &&
        Object.entries(fields).map(([name, value]) => <input type="hidden" name={name} value={value} />)}
      {children}
      <button type="submit" name="action" value={action}>
        {label}
      </button>
    </form>
  )
}

export function pageLink(href: string, label: string) {
  return (
    <p>
      <a href={href}>{label}</a>
    </p>
  )
}

const copyScript =
  'document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.previousElementSibling.textContent);b.textContent=b.dataset.copied}catch{b.textContent=b.dataset.failed}});addEventListener("pageshow",(e)=>{if(e.persisted)document.querySelector("[data-secret-flash]")?.remove()});'
export const copyScriptSource = "'sha256-YpBfT0WFfrJI9blwi4A0xOODReRSb4tKB5oO3wQz02k='"

const nav = [
  ['/artefacts', 'artefacts'],
  ['/connect', 'connect'],
  ['/tokens', 'tokens'],
  ['/admin/members', 'members'],
  ['/admin/bots', 'bots'],
  ['/admin/deleted', 'deleted'],
  ['/admin/redirects', 'redirects'],
] as const

export function Page({
  config,
  title,
  member,
  children,
}: {
  config: Config
  title: string
  member?: Member
  children: Child
}) {
  const t = messages(config)
  const links =
    member?.status !== 'active'
      ? []
      : nav.slice(0, member.role === 'admin' ? nav.length : member.role === 'publisher' ? 3 : 2)
  return (
    <html lang={config.locale}>
      <DocumentHead title={`${title} · ${config.name}`} />
      <body>
        <header>
          <a class="brand" href="/">
            <img src="/logo.svg" alt="" width="32" height="32" />
            {config.name}
          </a>
          {links.length > 0 && (
            <nav aria-label={t.navigation}>
              {links.map(([href, label]) => (
                <a href={href}>{t[label]}</a>
              ))}
            </nav>
          )}
          {member && (
            <form action="/logout" method="post">
              <button type="submit">{t.signOut}</button>
            </form>
          )}
        </header>
        <main>
          <h1>{title}</h1>
          {children}
        </main>
      </body>
    </html>
  )
}

const utcOptions = { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC', hour12: false } as const
const utc = {
  en: new Intl.DateTimeFormat('en-GB', utcOptions),
  fr: new Intl.DateTimeFormat('fr-FR', utcOptions),
}

export function time(locale: Locale, timestamp: number | null) {
  return timestamp === null ? '—' : `${utc[locale].format(timestamp)} UTC`
}

export async function flash(
  c: UiContext,
  session: BrowserSession,
  location: string,
  message: string,
  secret?: string,
) {
  const { pathname, search, hash } = new URL(location, c.env.config.manageOrigin)
  const path = pathname + search
  const id = await putUiFlash(c.env, session, path, message, secret)
  return c.redirect(`${path}${search ? '&' : '?'}flash-id=${id}${hash}`, 303)
}

async function navigationFlash(c: UiContext, session: BrowserSession) {
  const request = c.req.raw
  if (
    request.method !== 'GET' ||
    request.headers.get('Sec-Fetch-Mode') !== 'navigate' ||
    request.headers.get('Sec-Fetch-Dest') !== 'document'
  )
    return null

  const { pathname, search } = new URL(request.url)
  // Keep the exact spelling and order of the remaining query, rather than re-encoding it.
  const query = search.slice(1).split('&')
  const index = query.findIndex((part) => part.startsWith('flash-id='))
  if (index === -1) return null
  const id = query[index].slice('flash-id='.length)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return null
  query.splice(index, 1)
  return takeUiFlash(c.env, session, id, query.length ? `${pathname}?${query.join('&')}` : pathname)
}

export async function page(c: UiContext, session: BrowserSession, title: string, children: Child) {
  const { config } = c.env
  const t = messages(config)
  const notice = await navigationFlash(c, session)
  const secret = notice?.secret
  return c.html(
    <Page config={config} title={title} member={session.member}>
      {notice && (
        <aside role="status" aria-label={t.notice} data-secret-flash={secret === undefined ? undefined : ''}>
          <p>{notice.message}</p>
          {secret !== undefined && (
            <p>
              <code>{secret}</code>
              <button type="button" data-copy="" data-copied={t.copied} data-failed={t.copyFailed}>
                {t.copy}
              </button>
            </p>
          )}
        </aside>
      )}
      {children}
      {secret !== undefined && <script>{raw(copyScript)}</script>}
    </Page>,
  )
}
