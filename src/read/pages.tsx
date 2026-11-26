import type { Child } from 'hono/jsx'
import { CardLink, ErrorCard } from '../access-card'
import { forgePageSources } from '../brand'
import { BrandBlock } from '../brand-block'
import type { Config } from '../config'
import { DocumentHead } from '../head'
import { messages } from '../i18n'
import { readHeaders } from './headers'

export function notFound(config: Config, head = false) {
  return statusPage(config, messages(config).access.notFoundLead, 404, head)
}

export function statusPage(config: Config, lead: string, status: 404 | 503, head: boolean) {
  const t = messages(config)
  return documentResponse(
    config,
    <ErrorCard
      config={config}
      status={status}
      lead={lead}
      languageReturn="/"
      actions={
        <>
          <CardLink href="/" primary>
            {t.access.home}
          </CardLink>
          <CardLink href={new URL('/artefacts', config.manageOrigin).href}>{t.signIn}</CardLink>
        </>
      }
    />,
    head,
    status,
  )
}

export function handoffStatus(
  config: Config,
  title: string,
  status: 400 | 404 | 503,
  head = false,
  children?: Child,
) {
  return documentResponse(
    config,
    <html lang={config.locale}>
      <DocumentHead config={config} title={title} />
      <body>
        <main class="forge-panel forge-panel--error">
          <header class="forge-panel__header">
            <BrandBlock config={config} />
          </header>
          <div class="forge-panel__body">
            <h1 class="forge-title">{title}</h1>
            {children}
          </div>
        </main>
      </body>
    </html>,
    head,
    status,
  )
}

export function documentResponse(config: Config, html: Child, head: boolean, status = 200) {
  const headers = readHeaders()
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Content-Language', config.locale)
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; ${forgePageSources}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  )
  return new Response(head ? null : `<!doctype html>${html}`, { status, headers })
}
