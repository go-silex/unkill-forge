import type { Child } from 'hono/jsx'
import { AccessCard, type CardErrorStatus, CardLink, ErrorCard } from '../access-card'
import type { Config } from '../config'
import type { Member } from '../core'
import { messages } from '../i18n'
import { manageCsp } from './origin'
import { Avatar } from './ui/page'

// Classify 404 presentation only. Routing and Origin checks must use the original pathname.
export function isUnambiguousBrowserPath(path: string): boolean {
  if (path.length > 512 || !path.startsWith('/') || /[^A-Za-z0-9._~/-]|\/\/|\/\.{1,2}(?:\/|$)/.test(path))
    return false
  const lower = path.toLowerCase()
  return (
    !/^\/(?:oauth|\.well-known|_forge|_theme|mcp|token|register|authorize|logout|upload)(?:\/|$)/.test(
      lower,
    ) &&
    !/^\/(?:auth\/handoff|login\/[^/]+\/backchannel-logout|(?:logo|favicon)\.svg|style\.css)(?:\/|$)/.test(
      lower,
    )
  )
}

export function PendingAccess({ config, member }: { config: Config; member: Member }) {
  const t = messages(config)
  return (
    <AccessCard
      config={config}
      variant="pending"
      title={t.pending}
      lead={t.legacy.approvalRequired}
      note={t.access.pendingNote}
      homeLink
      actions={
        <form class="forge-action" action="/logout" method="post">
          <button class="forge-button forge-button--primary" type="submit">
            {t.signOut}
          </button>
        </form>
      }
    >
      <p class="forge-card-account">
        <Avatar name={member.name} />
        <span>
          <small>{t.legacy.signedIn}</small>
          <strong class="forge-account__name" dir="auto">
            {member.name}
          </strong>
          {member.email && <small dir="auto">{member.email}</small>}
        </span>
      </p>
    </AccessCard>
  )
}

// Keep the security policy of the former text responses; the outer adapter adds the other manage headers.
export function manageAccessResponse(
  card: Child,
  status: number,
  options?: { noReferrer?: boolean; cookie?: string },
) {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': manageCsp(false),
  })
  if (options?.noReferrer) headers.set('Referrer-Policy', 'no-referrer')
  if (options?.cookie) headers.append('Set-Cookie', options.cookie)
  return new Response(`<!doctype html>${card}`, { status, headers })
}

export function manageError(
  config: Config,
  status: CardErrorStatus,
  lead: string,
  options?: { home?: '/artefacts' | '/login'; retry?: boolean; noReferrer?: boolean; cookie?: string },
) {
  const t = messages(config)
  return manageAccessResponse(
    <ErrorCard
      config={config}
      status={status}
      lead={lead}
      homeLink
      actions={
        <>
          {options?.retry && (
            <CardLink href="/login" primary>
              {t.access.retry}
            </CardLink>
          )}
          <CardLink href={options?.home ?? '/'} primary={!options?.retry}>
            {options?.home === '/login' ? t.signIn : t.access.home}
          </CardLink>
        </>
      }
    />,
    status,
    options,
  )
}
