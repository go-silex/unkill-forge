import type { Child } from 'hono/jsx'
import { BrandBlock } from '../../brand-block'
import type { Config } from '../../config'
import type { Member } from '../../core'
import { DocumentHead } from '../../head'
import { messages } from '../../i18n'
import { LanguageSwitch } from '../../language-switch'

export type PageHead = { lead?: string; actions?: Child }

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

export function ManageShell({
  config,
  title,
  member,
  path,
  beforeTitle,
  lead,
  actions,
  children,
}: {
  config: Config
  title: string
  member: Member
  path: string
  beforeTitle?: Child
  children: Child
} & PageHead) {
  const t = messages(config)
  const navigation = (
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
                      aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}
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
        <LanguageSwitch locale={config.locale} />
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
      </body>
    </html>
  )
}
