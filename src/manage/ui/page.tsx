import type { Context } from 'hono'
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import { BrandBlock } from '../../brand-block'
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
  variant,
  path,
  children,
}: {
  action: string
  label: string
  fields?: Record<string, string | number>
  variant?: 'primary' | 'danger'
  path?: string
  children?: Child
}) {
  return (
    <form class="forge-action" action={path} method="post">
      {fields &&
        Object.entries(fields).map(([name, value]) => <input type="hidden" name={name} value={value} />)}
      {children}
      <button
        class={variant ? `forge-button forge-button--${variant}` : 'forge-button'}
        type="submit"
        name="action"
        value={action}
      >
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

export type TableColumn = string | { secondary: string } | { folded: string }

export function Fold({ label, children }: { label?: string; children: Child }) {
  return (
    <span class="forge-fold" hidden>
      {label && <strong>{label}: </strong>}
      {children}
    </span>
  )
}

export function Table({ columns, children }: { columns: TableColumn[]; children: Child }) {
  return (
    <div class="forge-table-scroll" tabindex={0}>
      <table class="forge-table">
        <thead>
          <tr>
            {columns.map((column) =>
              typeof column === 'string' ? (
                <th scope="col">{column}</th>
              ) : 'folded' in column ? (
                <th scope="col" class="forge-col--folded">
                  {column.folded}
                </th>
              ) : (
                <th scope="col" class="forge-col--secondary">
                  {column.secondary}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Page({
  config,
  title,
  member,
  path,
  panel,
  children,
}: {
  config: Config
  title: string
  member?: Member
  path?: string
  panel?: 'sign-in' | 'invite' | 'consent'
  children: Child
}) {
  const t = messages(config)
  const navigation = member && (
    <>
      {member.status === 'active' && (
        <nav class="forge-nav" aria-label={t.navigation}>
          {nav
            .slice(0, member.role === 'admin' ? nav.length : member.role === 'publisher' ? 3 : 2)
            .map(([href, label]) => (
              <a
                class="forge-nav__link"
                href={href}
                aria-current={path === href || path?.startsWith(`${href}/`) ? 'page' : undefined}
              >
                {t[label]}
              </a>
            ))}
        </nav>
      )}
      <form class="forge-action" action="/logout" method="post">
        <button class="forge-button" type="submit">
          {t.signOut}
        </button>
      </form>
    </>
  )
  const heading = <h1 class="forge-title">{title}</h1>
  return (
    <html lang={config.locale}>
      <DocumentHead config={config} title={`${title} · ${config.name}`} />
      <body>
        {member ? (
          <div class="forge-shell">
            <header class="forge-tray">
              <div class="forge-bar">
                <BrandBlock config={config} variant="home-link" />
                <details class="forge-drawer">
                  <summary class="forge-menu forge-button">{t.menu}</summary>
                  <div class="forge-drawer__panel">{navigation}</div>
                </details>
              </div>
              <div class="forge-tray__sections">{navigation}</div>
            </header>
            <main class="forge-content">
              {heading}
              {children}
            </main>
          </div>
        ) : (
          <div class={`forge-panel${panel ? ` forge-panel--${panel}` : ''}`}>
            <header class="forge-panel__header">
              <BrandBlock config={config} variant="home-link" />
            </header>
            <main class="forge-panel__body">
              {heading}
              {children}
            </main>
          </div>
        )}
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
    <Page config={config} title={title} member={session.member} path={c.req.path}>
      {notice && (
        <aside
          class="forge-notice"
          role="status"
          aria-label={t.notice}
          data-secret-flash={secret === undefined ? undefined : ''}
        >
          <p>{notice.message}</p>
          {secret !== undefined && (
            <p class="forge-secret">
              <code>{secret}</code>
              <button
                class="forge-button"
                type="button"
                data-copy=""
                data-copied={t.copied}
                data-failed={t.copyFailed}
              >
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
