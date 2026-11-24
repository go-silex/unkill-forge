import type { Context } from 'hono'
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import { BrandBlock } from '../../brand-block'
import type { Config, Runtime } from '../../config'
import type { BrowserSession, Member } from '../../core'
import type { CatalogueAccess } from '../../core/catalogue'
import { putUiFlash, takeUiFlash } from '../../core/ui-flash'
import { DocumentHead } from '../../head'
import { type CopyLabels, messages } from '../../i18n'

export type UiContext = Context<{ Bindings: Runtime }>

type Sheet = { title: string; body?: string; label: string; cancel: string }
type PageHead = { lead?: string; actions?: Child }

export function Action({
  action,
  label,
  fields,
  variant,
  confirm,
  sheet,
  path,
  children,
}: {
  action: string
  label: string
  fields?: Record<string, string | number>
  variant?: 'primary' | 'danger'
  confirm?: Sheet & { body: string }
  sheet?: Sheet
  path?: string
  children?: Child
}) {
  const inputs = fields
    ? Object.entries(fields).map(([name, value]) => <input type="hidden" name={name} value={value} />)
    : null
  const buttonClass = variant ? `forge-button forge-button--${variant}` : 'forge-button'
  const panel = confirm ?? sheet
  if (panel) {
    const id = `forge-sheet-${crypto.randomUUID()}`
    const titleId = `${id}-title`
    const bodyId = `${id}-body`
    return (
      <div class="forge-action">
        <button type="button" class={buttonClass} popovertarget={id}>
          {label}
        </button>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both dialog and alertdialog support the label and description. */}
        <div
          id={id}
          class="forge-sheet"
          popover="auto"
          role={confirm ? 'alertdialog' : 'dialog'}
          aria-labelledby={titleId}
          aria-describedby={panel.body ? bodyId : undefined}
        >
          <h2 id={titleId} class="forge-sheet__title">
            {panel.title}
          </h2>
          {panel.body && (
            <p id={bodyId} class="forge-sheet__body">
              {panel.body}
            </p>
          )}
          <form class="forge-sheet__actions" method="post" action={path}>
            {inputs}
            {confirm ? children : <div class="forge-sheet__fields">{children}</div>}
            <button
              type="button"
              class="forge-button"
              popovertarget={id}
              popovertargetaction="hide"
              autofocus
            >
              {panel.cancel}
            </button>
            <button
              type="submit"
              class={`forge-button forge-button--${confirm ? 'danger-solid' : 'primary'}`}
              name="action"
              value={action}
            >
              {panel.label}
            </button>
          </form>
        </div>
      </div>
    )
  }
  return (
    <form class="forge-action" action={path} method="post">
      {inputs}
      {children}
      <button class={buttonClass} type="submit" name="action" value={action}>
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

function CopyButton({ labels }: { labels: CopyLabels }) {
  return (
    <button
      class="forge-button"
      type="button"
      data-copy=""
      data-copied={labels.copied}
      data-failed={labels.copyFailed}
      hidden
    >
      {labels.copy}
    </button>
  )
}

export function CopyField({
  value,
  labels,
  block,
  flash,
}: {
  value: string
  labels: CopyLabels
  block?: boolean
  flash?: boolean
}) {
  const code = <code>{value}</code>
  if (flash)
    return (
      <p class="forge-secret">
        {code}
        <CopyButton labels={labels} />
      </p>
    )
  return (
    <div class={block ? 'forge-copy forge-copy--block' : 'forge-copy'}>
      {block ? <pre>{code}</pre> : code}
      <CopyButton labels={labels} />
    </div>
  )
}

const copyScript =
  'document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.previousElementSibling.textContent);b.textContent=b.dataset.copied}catch{b.textContent=b.dataset.failed}});addEventListener("pageshow",(e)=>{if(e.persisted)document.querySelector("[data-secret-flash]")?.remove()});document.querySelectorAll("button[data-copy]").forEach((b)=>{b.hidden=false});'
export const copyScriptSource = "'sha256-gKtKyAGgpJlKo+7uRRmAq5ws0oWd85H3QGIE/Wvp3Gc='"

const navGroups = [
  [
    'content',
    [
      ['/artefacts', 'artefacts', 'viewer'],
      ['/admin/deleted', 'deleted', 'admin'],
      ['/admin/redirects', 'redirects', 'admin'],
    ],
  ],
  [
    'access',
    [
      ['/admin/members', 'members', 'admin'],
      ['/admin/bots', 'bots', 'admin'],
    ],
  ],
  [
    'account',
    [
      ['/connect', 'connect', 'viewer'],
      ['/tokens', 'tokens', 'publisher'],
    ],
  ],
] as const

const roleRank = { viewer: 0, publisher: 1, admin: 2 }

export function Badge({
  variant,
  children,
}: {
  variant: CatalogueAccess | 'current' | 'entry' | 'ok' | 'warn' | 'muted'
  children: Child
}) {
  return <span class={`forge-badge forge-badge--${variant}`}>{children}</span>
}

export function AccessBadge({ access, label }: { access: CatalogueAccess; label: string }) {
  return <Badge variant={access}>{label}</Badge>
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function Avatar({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/, 2)
    .map((word) => graphemes.segment(word).containing(0)?.segment)
    .join('')
    .toUpperCase()
  return (
    <span class="forge-avatar" aria-hidden="true" dir="auto">
      {initials || '—'}
    </span>
  )
}

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
  beforeTitle,
  lead,
  actions,
  children,
}: {
  config: Config
  title: string
  member?: Member
  path?: string
  panel?: 'sign-in' | 'invite' | 'consent'
  beforeTitle?: Child
  children: Child
} & PageHead) {
  const t = messages(config)
  const navigation = member && (
    <>
      {member.status === 'active' && (
        <nav class="forge-nav" aria-label={t.navigation}>
          {navGroups.map(([group, links]) => {
            const visible = links.filter(([, , role]) => roleRank[member.role] >= roleRank[role])
            return (
              visible.length > 0 && (
                <section class="forge-nav__group" aria-label={t.navGroups[group]}>
                  <span class="forge-nav__group-label">{t.navGroups[group]}</span>
                  {visible.map(([href, label]) => (
                    <a
                      class="forge-nav__link"
                      href={href}
                      aria-current={path === href || path?.startsWith(`${href}/`) ? 'page' : undefined}
                    >
                      {t[label]}
                    </a>
                  ))}
                </section>
              )
            )
          })}
        </nav>
      )}
      <div class="forge-account">
        <span class="forge-account__name">{member.name}</span>
        <span class="forge-account__role">{t.roles[member.role]}</span>
        <form class="forge-action" action="/logout" method="post">
          <button class="forge-button" type="submit">
            {t.signOut}
          </button>
        </form>
      </div>
    </>
  )
  const titleElement = <h1 class="forge-title">{title}</h1>
  const heading =
    lead || actions ? (
      <header class="forge-page-head">
        <div>
          {titleElement}
          {lead && <p class="forge-lead">{lead}</p>}
        </div>
        {actions && <div class="forge-page-actions">{actions}</div>}
      </header>
    ) : (
      titleElement
    )
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
              {beforeTitle}
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

type DateConfig = Pick<Config, 'locale' | 'timeZone'>
type DateFormats = {
  absolute: Intl.DateTimeFormat
  short: Intl.DateTimeFormat
  relative: Intl.RelativeTimeFormat
  now: string
}

const dateFormats = new WeakMap<DateConfig, DateFormats>()

function dateFormat(config: DateConfig) {
  const cached = dateFormats.get(config)
  if (cached) return cached
  const { locale, timeZone } = config
  const language = locale === 'fr' ? 'fr-FR' : 'en-GB'
  const format = {
    absolute: new Intl.DateTimeFormat(language, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }),
    short: new Intl.DateTimeFormat(language, { timeZone, dateStyle: 'short' }),
    relative: new Intl.RelativeTimeFormat(language, { style: 'short' }),
    now: new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' }).format(0, 'second'),
  }
  dateFormats.set(config, format)
  return format
}

export function absoluteTime(config: DateConfig, timestamp: number | null) {
  return timestamp === null ? '—' : dateFormat(config).absolute.format(timestamp)
}

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const week = 7 * day

export function time(config: DateConfig, timestamp: number | null) {
  if (timestamp === null) return '—'
  const format = dateFormat(config)
  const delta = timestamp - Date.now()
  const distance = Math.abs(delta)
  let relative: string
  if (distance < minute) relative = format.now
  else if (distance < hour) relative = format.relative.format(Math.trunc(delta / minute), 'minute')
  else if (distance < day) relative = format.relative.format(Math.trunc(delta / hour), 'hour')
  else if (distance < week) relative = format.relative.format(Math.trunc(delta / day), 'day')
  else if (distance <= 8 * week) relative = format.relative.format(Math.trunc(delta / week), 'week')
  else relative = format.short.format(timestamp)
  return (
    <time datetime={new Date(timestamp).toISOString()} title={absoluteTime(config, timestamp)}>
      {relative}
    </time>
  )
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

export async function page(
  c: UiContext,
  session: BrowserSession,
  title: string,
  children: Child,
  options?: PageHead & { beforeTitle?: Child },
) {
  const { config } = c.env
  const t = messages(config)
  const notice = await navigationFlash(c, session)
  const secret = notice?.secret
  return c.html(
    <Page config={config} title={title} member={session.member} path={c.req.path} {...options}>
      {notice && (
        <aside
          class="forge-notice"
          role="status"
          aria-label={t.notice}
          data-secret-flash={secret === undefined ? undefined : ''}
        >
          <p>{notice.message}</p>
          {secret !== undefined && <CopyField value={secret} labels={t} flash />}
        </aside>
      )}
      {children}
      <script>{raw(copyScript)}</script>
    </Page>,
  )
}
