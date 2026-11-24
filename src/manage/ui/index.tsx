import { Hono } from 'hono'
import { html } from 'hono/html'
import type { Child } from 'hono/jsx'
import { z } from 'zod'
import { AccessCard, CardLink } from '../../access-card'
import type { Config, Runtime } from '../../config'
import type { Member, Role } from '../../core'
import {
  type BotDetails as BotDetailsData,
  botCredentialSummaryLimit,
  changeBot,
  changeMember,
  countHumanMembers,
  createApiToken,
  createBot,
  getBotDetails,
  isAdmin,
  listMembers,
  revokeApiToken,
  summarizeBotCredentials,
} from '../../core/admin'
import { countInvites, createInvite, inviteKey, listInvites, revokeInvite } from '../../core/invites'
import { adminCountLimit } from '../../core/pagination'
import { time } from '../../dates'
import { readForm } from '../../http'
import { messages } from '../../i18n'
import { isReservedManagePath, manageError, PendingAccess } from '../access'
import { openInvite, requireBrowserSession, returnPath } from '../login'
import { adminPages } from './admin-pages'
import { Action, Avatar, Badge, Fold, flash, page, pageLink, Table, type UiContext } from './page'

function withQuery(path: string, params: Record<string, string | undefined>) {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, value)
  }
  return query.size === 0 ? path : `${path}?${query}`
}

// Keep routing and the outer Origin guard on the same, un-decoded path.
const app = new Hono<{ Bindings: Runtime }>({ getPath: (request) => new URL(request.url).pathname })
app.onError((error, c) => {
  console.error('Forge UI request failed', error.name)
  const { config } = c.env
  return manageError(config, 503, messages(config).unavailable)
})
app.notFound((c) => {
  const { config } = c.env
  const { method } = c.req.raw
  const t = messages(config)
  return (method === 'GET' || method === 'HEAD') && !isReservedManagePath(c.req.path)
    ? manageError(config, 404, t.access.notFoundLead)
    : c.text(t.notFound, 404)
})
const roleSchema = z.enum(['viewer', 'publisher', 'admin'])
const idSchema = z.uuid()
const labelSchema = z.string().trim().min(1).max(120)
const memberAction = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['admit', 'role']), id: idSchema, role: roleSchema }),
  z.object({ action: z.literal('remove'), id: idSchema, expect: z.enum(['pending', 'active']).optional() }),
  z.object({ action: z.literal('reinstate'), id: idSchema }),
  z.object({ action: z.literal('create-invite'), role: roleSchema }),
  z.object({ action: z.literal('revoke-invite'), id: z.string().regex(inviteKey) }),
])
const botAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), name: labelSchema, role: z.enum(['viewer', 'publisher']) }),
  z.strictObject({ action: z.literal('token'), id: idSchema, name: labelSchema }),
  z.strictObject({ action: z.literal('revoke'), id: idSchema }),
  z.strictObject({
    action: z.literal('role'),
    id: idSchema,
    role: z.enum(['viewer', 'publisher']),
    expect: z.literal('active').optional(),
  }),
  z.strictObject({ action: z.literal('remove'), id: idSchema, expect: z.literal('active').optional() }),
  z.strictObject({ action: z.literal('reinstate'), id: idSchema }),
])

function RoleSelect({
  config,
  human = false,
  value = 'viewer',
}: {
  config: Config
  human?: boolean
  value?: Role
}) {
  const { legacy: text, roles } = messages(config)
  return (
    <label>
      {text.role}
      <select name="role">
        <option value="viewer" selected={value === 'viewer'}>
          {roles.viewer}
        </option>
        <option value="publisher" selected={value === 'publisher'}>
          {roles.publisher}
        </option>
        {human && (
          <option value="admin" selected={value === 'admin'}>
            {roles.admin}
          </option>
        )}
      </select>
    </label>
  )
}

function SignIn({ config, query }: { config: Config; query: URLSearchParams }) {
  const t = messages(config)
  const invite = query.has('invite')
  return (
    <AccessCard
      config={config}
      variant={invite ? 'invite' : 'sign-in'}
      title={t.signIn}
      lead={invite ? t.access.inviteLead : t.access.signInLead}
      note={t.access.signInNote}
      homeLink
      actions={
        <ul class="forge-link-list">
          {config.providers.map((provider, index) => (
            <li>
              <CardLink href={`/login/${provider.id}?${query}`} primary={index === 0}>
                {provider.label}
              </CardLink>
            </li>
          ))}
        </ul>
      }
    />
  )
}

app.get('/login', (c) => {
  const { config } = c.env
  const context = c.req.query('invite')
  const query = new URLSearchParams(
    context && inviteKey.test(context)
      ? { invite: context }
      : { return: returnPath(c.req.query('return') ?? null, config.manageOrigin) },
  )
  return c.html(html`<!doctype html>${<SignIn config={config} query={query} />}`)
})

app.get('/invite/:token', async (c) => {
  const redirect = await openInvite(c.env, c.req.param('token'))
  if (redirect) return redirect
  const { config } = c.env
  const t = messages(config)
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(
    html`<!doctype html>${(
      <AccessCard
        config={config}
        variant="invite"
        title={t.access.invalidInvite}
        lead={t.access.invalidInviteLead}
        status={404}
        homeLink
        actions={
          <CardLink href="/login" primary>
            {t.signIn}
          </CardLink>
        }
      />
    )}`,
    404,
  )
})

app.get('/', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  if (session.member.status === 'active') return c.redirect('/artefacts', 303)
  return c.html(html`<!doctype html>${<PendingAccess config={c.env.config} member={session.member} />}`)
})

async function memberAdmin(c: UiContext) {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  const { config, env } = c.env
  const common = messages(config)
  if (!isAdmin(session.member)) return manageError(config, 403, common.forbidden, { home: '/artefacts' })
  return { session, config, db: env.DB, common, text: common.legacy, actor: session.member.id }
}

const membersPath = '/admin/members'

function MemberSection({
  id,
  title,
  count,
  empty,
  next,
  children,
}: {
  id: string
  title: string
  count: number
  empty: string
  next: Child
  children: Child
}) {
  return (
    <section id={id} class="forge-member-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        {title} ({count > adminCountLimit ? `${adminCountLimit}+` : count})
      </h2>
      {children || <p class="forge-empty">{empty}</p>}
      {next}
    </section>
  )
}

app.get(membersPath, async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, config, db, common, text, actor } = admin
  const {
    membership: copy,
    roles,
    confirmation: { cancel },
  } = common
  const inviteCursor = c.req.query('inviteAfter')
  const cursors = {
    pendingAfter: idSchema.safeParse(c.req.query('pendingAfter')).data,
    after: idSchema.safeParse(c.req.query('after')).data,
    inviteAfter: inviteCursor && inviteKey.test(inviteCursor) ? inviteCursor : undefined,
    removedAfter: idSchema.safeParse(c.req.query('removedAfter')).data,
  }
  const [pending, active, removed, { invites, nextCursor: nextInvite }, memberCounts, inviteCount] =
    await Promise.all([
      listMembers(db, actor, { kind: 'human', status: 'pending', after: cursors.pendingAfter }),
      listMembers(db, actor, { kind: 'human', status: 'active', after: cursors.after }),
      listMembers(db, actor, { kind: 'human', status: 'removed', after: cursors.removedAfter }),
      listInvites(db, actor, cursors.inviteAfter),
      countHumanMembers(db, actor),
      countInvites(db, actor),
    ])
  const next = (key: keyof typeof cursors, cursor: string | undefined, section: string, label: string) =>
    cursor && pageLink(`${withQuery(membersPath, { ...cursors, [key]: cursor })}#${section}`, label)
  const actionColumn = common.admin.actions

  function humanRows(list: typeof active.members, status: Member['status']) {
    if (list.length === 0) return null
    const awaiting = status === 'pending'
    const current = status === 'active'
    const dateLabel = awaiting ? copy.requested : current ? copy.accountCreated : copy.removedOn
    const columns = [
      text.member,
      { folded: text.email },
      { folded: text.provider },
      ...(!awaiting ? [{ folded: text.role }] : []),
      ...(current ? [{ folded: text.status }] : []),
      { folded: dateLabel },
      actionColumn,
    ]
    return (
      <Table columns={columns}>
        {list.map((member) => {
          const self = actor === member.id
          const date = time(config, status === 'removed' ? member.removedAt : member.createdAt)
          const badge = current ? <Badge variant="ok">{text.active}</Badge> : null
          const label = awaiting ? copy.approve : text.changeRole
          const removeLabel = awaiting ? copy.refuse : text.remove
          return (
            <tr key={member.id}>
              <td>
                <div class="forge-member-identity">
                  <Avatar name={member.name} />
                  <strong dir="auto">{member.name}</strong>
                  {awaiting && <Badge variant="warn">{text.pending}</Badge>}
                  {self && <Badge variant="muted">{copy.you}</Badge>}
                </div>
                {member.email && (
                  <span class="forge-fold forge-member-email" title={member.email} hidden>
                    {member.email}
                  </span>
                )}
                {member.provider && <Fold label={text.provider}>{member.provider}</Fold>}
                {!awaiting && <Fold label={text.role}>{roles[member.role]}</Fold>}
                {current && <Fold>{badge}</Fold>}
                <Fold label={dateLabel}>{date}</Fold>
              </td>
              <td class="forge-col--folded">{member.email ?? '—'}</td>
              <td class="forge-col--folded">{member.provider ?? '—'}</td>
              {!awaiting && <td class="forge-col--folded">{roles[member.role]}</td>}
              {current && <td class="forge-col--folded">{badge}</td>}
              <td class="forge-col--folded">{date}</td>
              <td>
                {!self && (
                  <div class="forge-row-actions">
                    {status === 'removed' ? (
                      <Action
                        path={membersPath}
                        action="reinstate"
                        label={text.reinstate}
                        fields={{ id: member.id }}
                      />
                    ) : (
                      <>
                        <Action
                          path={membersPath}
                          action={awaiting ? 'admit' : 'role'}
                          label={label}
                          fields={{ id: member.id }}
                          sheet={{
                            title: awaiting
                              ? copy.approveTitle(member.name)
                              : copy.changeRoleTitle(member.name),
                            label,
                            cancel,
                          }}
                        >
                          <RoleSelect config={config} human value={awaiting ? 'viewer' : member.role} />
                        </Action>
                        <Action
                          path={membersPath}
                          action="remove"
                          label={removeLabel}
                          fields={{ id: member.id, expect: awaiting ? 'pending' : 'active' }}
                          variant="danger"
                          confirm={{
                            title: awaiting ? copy.refuseTitle(member.name) : copy.removeTitle(member.name),
                            body: awaiting ? copy.refuseBody : copy.removeBody,
                            label: removeLabel,
                            cancel,
                          }}
                        />
                      </>
                    )}
                  </div>
                )}
              </td>
            </tr>
          )
        })}
      </Table>
    )
  }

  return page(
    c,
    session,
    common.members,
    <>
      <MemberSection
        id="pending"
        title={copy.awaiting}
        count={memberCounts.pending}
        empty={copy.emptyPending}
        next={next('pendingAfter', pending.nextCursor, 'pending', copy.nextPending)}
      >
        {humanRows(pending.members, 'pending')}
      </MemberSection>
      <MemberSection
        id="active"
        title={common.members}
        count={memberCounts.active}
        empty={copy.emptyActive}
        next={next('after', active.nextCursor, 'active', text.nextMembers)}
      >
        {humanRows(active.members, 'active')}
      </MemberSection>
      <MemberSection
        id="invites"
        title={text.inviteLinks}
        count={inviteCount}
        empty={copy.emptyInvites}
        next={next('inviteAfter', nextInvite, 'invites', text.nextInvites)}
      >
        {invites.length > 0 ? (
          <Table columns={[text.role, { folded: copy.created }, { folded: text.expires }, actionColumn]}>
            {invites.map((invite) => {
              const { creatorName } = invite
              const created = (
                <>
                  {creatorName && <>{copy.createdBy(creatorName)} · </>}
                  {time(config, invite.createdAt)}
                </>
              )
              const expires = time(config, invite.expiresAt)
              return (
                <tr key={invite.id}>
                  <td>
                    <span>{roles[invite.role]}</span> <Badge variant="ok">{copy.valid}</Badge>
                    <Fold label={copy.created}>{created}</Fold>
                    <Fold label={text.expires}>{expires}</Fold>
                  </td>
                  <td class="forge-col--folded">{created}</td>
                  <td class="forge-col--folded">{expires}</td>
                  <td>
                    <div class="forge-row-actions">
                      <Action
                        path={membersPath}
                        action="revoke-invite"
                        label={text.revoke}
                        fields={{ id: invite.id }}
                        variant="danger"
                        confirm={{
                          title: creatorName ? copy.revokeByTitle(creatorName) : copy.revokeTitle,
                          body: copy.revokeBody,
                          label: text.revoke,
                          cancel,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </Table>
        ) : null}
      </MemberSection>
      <MemberSection
        id="removed"
        title={text.removed}
        count={memberCounts.removed}
        empty={copy.emptyRemoved}
        next={next('removedAfter', removed.nextCursor, 'removed', copy.nextRemoved)}
      >
        {humanRows(removed.members, 'removed')}
      </MemberSection>
      <p class="forge-member-legend">{copy.legend(roles.viewer, roles.publisher, roles.admin)}</p>
    </>,
    {
      lead: copy.lead,
      actions: (
        <Action
          path={membersPath}
          action="create-invite"
          variant="primary"
          label={copy.invite}
          sheet={{ title: copy.invite, label: text.createInvite, cancel }}
        >
          <RoleSelect config={config} human />
        </Action>
      ),
    },
  )
})

app.post(membersPath, async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, config, db, text, actor } = admin
  const fields = await readForm(c.req.raw)
  const form = memberAction.safeParse(fields ? Object.fromEntries(fields) : null)
  if (!form.success) return manageError(config, 400, text.invalidMemberAction, { home: '/artefacts' })
  const { data } = form
  const now = Date.now()
  if (data.action === 'create-invite') {
    const token = await createInvite(db, actor, data.role, now)
    if (!token) return flash(c, session, membersPath, text.inviteNotAllowed)
    return flash(c, session, membersPath, text.inviteCreated, `${config.manageOrigin}/invite/${token}`)
  }
  const changed =
    data.action === 'revoke-invite'
      ? await revokeInvite(db, actor, data.id, now)
      : await changeMember(
          db,
          actor,
          data.id,
          data.action,
          'role' in data ? data.role : undefined,
          now,
          data.action === 'remove' ? data.expect : undefined,
        )
  const notices = {
    admit: text.admitDone,
    role: text.roleDone,
    remove: data.action === 'remove' && data.expect === 'pending' ? text.refuseDone : text.removeDone,
    reinstate: text.reinstateDone,
    'revoke-invite': text.inviteRevoked,
  }
  return flash(c, session, membersPath, changed ? notices[data.action] : text.memberNotAllowed)
})

const botsPath = '/admin/bots'

function BotStatus({ config, status }: { config: Config; status: Member['status'] }) {
  const { legacy } = messages(config)
  return <Badge variant={status === 'active' ? 'ok' : 'muted'}>{legacy[status]}</Badge>
}

function BotDetails({
  config,
  details: { bot, tokens, nextCursor },
  after,
  tokenAfter,
}: {
  config: Config
  details: BotDetailsData
  after?: string
  tokenAfter?: string
}) {
  const { admin, confirmation, legacy, robots, roles } = messages(config)
  const path = withQuery(botsPath, { after, bot: bot.id, tokenAfter })
  return (
    <aside class="forge-admin-panel" id="bot-tokens" aria-labelledby="robot-name">
      <div class="forge-member-identity">
        <Avatar name={bot.name} />
        <h2 id="robot-name">{bot.name}</h2>
      </div>
      <p>
        {roles[bot.role]} · <BotStatus config={config} status={bot.status} /> · {admin.created}{' '}
        {time(config, bot.createdAt)}
      </p>
      <h3>{robots.credentials}</h3>
      {tokens.length ? (
        <ul class="forge-credentials">
          {tokens.map((token) => (
            <li key={token.id}>
              <div>
                <strong>{token.revokedAt === null ? token.name : <s>{token.name}</s>}</strong>{' '}
                <code>{token.prefix}…</code>
                <div class="forge-admin-meta">
                  {token.lastUsedAt === null ? admin.neverUsed : time(config, token.lastUsedAt)}
                </div>
              </div>
              <div class="forge-row-actions">
                <Badge variant={token.revokedAt === null ? 'ok' : 'muted'}>
                  {token.revokedAt === null ? legacy.active : legacy.revoked}
                </Badge>
                {token.revokedAt === null && (
                  <Action
                    path={path}
                    action="revoke"
                    variant="danger"
                    label={legacy.revoke}
                    fields={{ id: token.id }}
                    confirm={{
                      title: robots.revokeTitle(token.name),
                      body: robots.revokeBody,
                      label: legacy.revoke,
                      cancel: confirmation.cancel,
                    }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p class="forge-empty">{legacy.emptyCredentials}</p>
      )}
      {nextCursor &&
        pageLink(
          `${withQuery(botsPath, { after, bot: bot.id, tokenAfter: nextCursor })}#bot-tokens`,
          legacy.nextCredentials,
        )}
      {bot.status === 'active' && (
        <>
          <h3>{robots.newCredential}</h3>
          <Action path={path} action="token" label={robots.createCredential} fields={{ id: bot.id }}>
            <label>
              {robots.credentialName} <input name="name" required maxlength={120} />
            </label>
          </Action>
        </>
      )}
      {bot.status !== 'pending' && (
        <section class="forge-bot-controls">
          <h3>{robots.settings}</h3>
          <div class="forge-row-actions">
            {bot.status === 'active' ? (
              <>
                <Action
                  path={path}
                  action="role"
                  label={legacy.changeRole}
                  fields={{ id: bot.id, expect: 'active' }}
                  sheet={{
                    title: robots.changeRoleTitle(bot.name),
                    label: legacy.changeRole,
                    cancel: confirmation.cancel,
                  }}
                >
                  <RoleSelect config={config} value={bot.role} />
                </Action>
                <Action
                  path={path}
                  action="remove"
                  label={robots.deactivate}
                  variant="danger"
                  fields={{ id: bot.id, expect: 'active' }}
                  confirm={{
                    title: robots.deactivateTitle(bot.name),
                    body: robots.deactivateBody,
                    label: robots.deactivate,
                    cancel: confirmation.cancel,
                  }}
                />
              </>
            ) : (
              <Action path={path} action="reinstate" label={robots.reactivate} fields={{ id: bot.id }} />
            )}
          </div>
        </section>
      )}
    </aside>
  )
}

app.get(botsPath, async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, config, db, common, text, actor } = admin
  const { robots, confirmation } = common
  const after = idSchema.safeParse(c.req.query('after')).data
  const botId = idSchema.safeParse(c.req.query('bot')).data
  const tokenAfter = idSchema.safeParse(c.req.query('tokenAfter')).data
  const [{ members: bots, nextCursor }, details] = await Promise.all([
    listMembers(db, actor, { kind: 'bot', after }),
    botId ? getBotDetails(db, actor, botId, tokenAfter) : null,
  ])
  const summaries = await summarizeBotCredentials(
    db,
    bots.map(({ id }) => id),
  )
  const botList = (
    <section aria-label={common.bots}>
      {bots.length ? (
        <Table
          columns={[
            text.botName,
            { folded: text.role },
            { folded: common.admin.status },
            robots.activeCredentials,
            { folded: common.admin.lastUsed },
          ]}
        >
          {bots.map((bot) => {
            const [active, lastUsedAt, sampled] = summaries.get(bot.id) ?? [0, null, 0]
            const capped = sampled === botCredentialSummaryLimit
            const lastUse =
              lastUsedAt === null ? (
                capped ? (
                  robots.unavailable
                ) : (
                  common.admin.neverUsed
                )
              ) : (
                <>
                  {time(config, lastUsedAt)}
                  {capped && <small class="forge-admin-meta">{robots.sampled}</small>}
                </>
              )
            const status = <BotStatus config={config} status={bot.status} />
            const selected = bot.id === details?.bot.id
            return (
              <tr key={bot.id}>
                <td>
                  <a
                    href={`${withQuery(botsPath, { after, bot: bot.id })}#bot-tokens`}
                    aria-current={selected ? 'true' : undefined}
                  >
                    {bot.name}
                  </a>
                  <Fold label={text.role}>{common.roles[bot.role]}</Fold>
                  <Fold>{status}</Fold>
                  <Fold label={common.admin.lastUsed}>{lastUse}</Fold>
                </td>
                <td class="forge-col--folded">{common.roles[bot.role]}</td>
                <td class="forge-col--folded">{status}</td>
                <td>{capped ? `${Math.min(active, adminCountLimit)}+` : active}</td>
                <td class="forge-col--folded">{lastUse}</td>
              </tr>
            )
          })}
        </Table>
      ) : (
        <p class="forge-empty">{robots.empty}</p>
      )}
      {nextCursor &&
        pageLink(withQuery(botsPath, { after: nextCursor, bot: details?.bot.id, tokenAfter }), text.nextBots)}
    </section>
  )
  return page(
    c,
    session,
    common.bots,
    details ? (
      <div class="forge-admin-split">
        {botList}
        <BotDetails config={config} details={details} after={after} tokenAfter={tokenAfter} />
      </div>
    ) : (
      botList
    ),
    {
      lead: robots.lead,
      actions: (
        <Action
          path={botsPath}
          action="create"
          variant="primary"
          label={text.createBot}
          sheet={{ title: text.createBot, label: text.createBot, cancel: confirmation.cancel }}
        >
          <label>
            {text.botName} <input name="name" required maxlength={120} />
          </label>
          <RoleSelect config={config} />
        </Action>
      ),
    },
  )
})

app.post(botsPath, async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const {
    session,
    db,
    text,
    actor,
    common: { robots },
  } = admin
  const fields = await readForm(c.req.raw)
  const form = botAction.safeParse(fields ? Object.fromEntries(fields) : null)
  if (!form.success) return manageError(c.env.config, 400, text.invalidBotAction, { home: '/artefacts' })
  const { data } = form
  const after = idSchema.safeParse(c.req.query('after')).data
  const now = Date.now()
  if (data.action === 'token') {
    const issued = await createApiToken(db, actor, data.id, data.name, now)
    const path = withQuery(botsPath, { after, bot: data.id })
    return issued
      ? flash(
          c,
          session,
          path,
          text.credentialCreated.replace('{bot}', () => issued.ownerName),
          issued.token,
        )
      : flash(c, session, path, text.credentialNotAllowed)
  }
  if (data.action === 'create') {
    const created = await createBot(db, actor, data.name, data.role, now)
    return flash(c, session, botsPath, created ? text.botCreated : text.botNotAllowed)
  }
  if (data.action !== 'revoke') {
    const changed = await changeBot(
      db,
      actor,
      data.id,
      data.action,
      'role' in data ? data.role : undefined,
      now,
      'expect' in data ? data.expect : undefined,
    )
    const path = withQuery(botsPath, { after, bot: data.id })
    return flash(
      c,
      session,
      path,
      changed ? (data.action === 'role' ? text.roleDone : robots[data.action]) : text.botNotAllowed,
    )
  }
  const revoked = await revokeApiToken(db, actor, data.id, now)
  const bot = idSchema.safeParse(c.req.query('bot')).data
  const tokenAfter = idSchema.safeParse(c.req.query('tokenAfter')).data
  const path = withQuery(botsPath, { after, bot, tokenAfter })
  return flash(c, session, path, revoked ? text.credentialRevoked : text.botNotAllowed)
})

app.route('/', adminPages)

export { app as manageUi }
