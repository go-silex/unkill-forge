import type { Context } from 'hono'
import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { Config, Runtime } from '../../config'
import type { BrowserSession, Member } from '../../core'
import { putUiFlash, takeUiFlash } from '../../core/ui-flash'
import { messages } from '../../i18n'

export type UiContext = Context<{ Bindings: Runtime }>

const copyScript =
  'document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.previousElementSibling.textContent);b.textContent=b.dataset.copied}catch{b.textContent=b.dataset.failed}});'
export const copyScriptSource = "'sha256-289tKwNP19oh7lJ9RAhbp6791v5VPAVjFdzyrcgFcDE='"

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
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>
          {title} · {config.name}
        </title>
        <link rel="icon" href="/favicon.svg" />
        <link rel="stylesheet" href="/style.css" />
      </head>
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

export function time(timestamp: number | null) {
  return timestamp === null ? '—' : new Date(timestamp).toISOString()
}

export async function flash(
  c: UiContext,
  session: BrowserSession,
  location: string,
  message: string,
  secret?: string,
) {
  const path = new URL(location, c.env.config.manageOrigin).pathname
  await putUiFlash(c.env, session, path, message, secret)
  return c.redirect(location, 303)
}

export async function page(c: UiContext, session: BrowserSession, title: string, children: Child) {
  const { config } = c.env
  const t = messages(config)
  const notice = c.req.raw.method === 'GET' ? await takeUiFlash(c.env, session, c.req.path) : null
  const secret = notice?.secret
  return c.html(
    <Page config={config} title={title} member={session.member}>
      {notice && (
        <aside role="status" aria-label={t.notice}>
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
