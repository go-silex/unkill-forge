import type { Context } from 'hono'
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { Config, Runtime } from '../../config'
import type { BrowserSession } from '../../core'
import type { CatalogueAccess } from '../../core/catalogue'
import { putUiFlash, takeUiFlash } from '../../core/ui-flash'
import { type CopyLabels, messages } from '../../i18n'
import { ManageShell, type PageHead } from './shell'

export type UiContext = Context<{ Bindings: Runtime }>

type Sheet = { title: string; body?: string; label: string; cancel: string }

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
      <a class="forge-page-link" href={href}>
        {label}
      </a>
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
            {columns.map((column) => {
              if (typeof column === 'string') return <th scope="col">{column}</th>
              const folded = 'folded' in column
              return (
                <th scope="col" class={folded ? 'forge-col--folded' : 'forge-col--secondary'}>
                  {folded ? column.folded : column.secondary}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Notice({
  config,
  tone,
  title,
  children,
}: {
  config: Config
  tone: 'info' | 'success' | 'warn' | 'error'
  title?: string
  children: Child
}) {
  return (
    <div
      class={`forge-notice forge-notice--${tone}`}
      role={tone === 'warn' || tone === 'error' ? 'alert' : 'status'}
    >
      <span class="forge-sr-only">{messages(config).noticeTone[tone]}: </span>
      {title && <strong>{title}</strong>}
      {children}
    </div>
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
    <ManageShell config={config} title={title} member={session.member} path={c.req.path} {...options}>
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
    </ManageShell>,
  )
}
