import type { Child } from 'hono/jsx'
import { BrandBlock } from './brand-block'
import type { Config } from './config'
import { DocumentHead } from './head'
import { messages } from './i18n'
import { LanguageSwitch } from './language-switch'

export function AccessCard({
  config,
  variant,
  title,
  lead,
  facts,
  children,
  actions,
  note,
  status,
  homeLink,
  languageReturn,
}: {
  config: Config
  variant: 'sign-in' | 'invite' | 'pending' | 'consent' | 'error' | 'landing'
  title: string
  lead?: string
  facts?: readonly (readonly [label: string, value: Child])[]
  children?: Child
  actions?: Child
  note?: string
  status?: number
  homeLink?: boolean
  // `true` follows the initiating page via the same-origin Referer rather than echoing its URL.
  languageReturn?: string | true
}) {
  return (
    <html lang={config.locale}>
      <DocumentHead config={config} title={variant === 'landing' ? title : `${title} · ${config.name}`} />
      <body>
        <main class={`forge-panel forge-panel--${variant}`}>
          <header class="forge-panel__header">
            <BrandBlock config={config} variant={homeLink ? 'home-link' : undefined} />
            {languageReturn && (
              <LanguageSwitch
                locale={config.locale}
                returnPath={typeof languageReturn === 'string' ? languageReturn : undefined}
              />
            )}
          </header>
          <div class="forge-panel__body">
            {status && <p class="forge-card-status">{messages(config).access.errorCode(status)}</p>}
            <h1 class="forge-title">{title}</h1>
            {lead && <p class="forge-lead">{lead}</p>}
            {facts && (
              <dl class="forge-facts">
                {facts.map(([label, value]) => (
                  <div>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {children}
            {actions && <div class="forge-card-actions">{actions}</div>}
          </div>
          {note && <p class="forge-panel__note">{note}</p>}
        </main>
      </body>
    </html>
  )
}

export function CardLink({ href, primary, children }: { href: string; primary?: boolean; children: Child }) {
  return (
    <a class={primary ? 'forge-button forge-button--primary' : 'forge-button'} href={href}>
      {children}
    </a>
  )
}

export type CardErrorStatus = 400 | 401 | 403 | 404 | 409 | 503

export function ErrorCard({
  config,
  status,
  lead,
  actions,
  homeLink,
  languageReturn,
}: {
  config: Config
  status: CardErrorStatus
  lead: string
  actions: Child
  homeLink?: boolean
  languageReturn?: string
}) {
  return (
    <AccessCard
      config={config}
      variant="error"
      title={messages(config).access.errorTitle[status]}
      status={status}
      lead={lead}
      actions={actions}
      homeLink={homeLink}
      languageReturn={languageReturn}
    />
  )
}
