import { Hono } from 'hono'
import type { Child } from 'hono/jsx'
import { z } from 'zod'
import type { Config, Runtime } from '../../config'
import type { Member, Role } from '../../core'
import {
  changeMember,
  countHumanMembers,
  createApiToken,
  createBot,
  isAdmin,
  listMembers,
  listTokens,
  revokeApiToken,
} from '../../core/admin'
import { countInvites, createInvite, inviteKey, listInvites, revokeInvite } from '../../core/invites'
import { adminCountLimit, adminPageSize } from '../../core/pagination'
import { readForm } from '../../http'
import { messages } from '../../i18n'
import { openInvite, requireBrowserSession, returnPath } from '../login'
import { adminPages } from './admin-pages'
import { Action, Avatar, Badge, Fold, flash, Page, page, pageLink, Table, time, type UiContext } from './page'

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
  return c.text(messages(c.env.config).unavailable, 503)
})
app.notFound((c) => c.text(messages(c.env.config).notFound, 404))
const roleSchema = z.enum(['viewer', 'publisher', 'admin'])
const idSchema = z.uuid()
const labelSchema = z.string().trim().min(1).max(120)
const memberAction = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['admit', 'role']), id: idSchema, role: roleSchema }),
  z.object({ action: z.enum(['remove', 'reinstate']), id: idSchema }),
  z.object({ action: z.literal('create-invite'), role: roleSchema }),
  z.object({ action: z.literal('revoke-invite'), id: z.string().regex(inviteKey) }),
])
const botAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name: labelSchema, role: z.enum(['viewer', 'publisher']) }),
  z.object({ action: z.literal('token'), id: idSchema, name: labelSchema }),
  z.object({ action: z.literal('revoke'), id: idSchema }),
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
  return (
    <Page config={config} title={messages(config).signIn} panel={query.has('invite') ? 'invite' : 'sign-in'}>
      <ul class="forge-link-list">
        {config.providers.map((provider) => (
          <li>
            <a class="forge-button" href={`/login/${provider.id}?${query}`}>
              {provider.label}
            </a>
          </li>
        ))}
      </ul>
    </Page>
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
  return c.html(<SignIn config={config} query={query} />)
})

app.get('/invite/:token', async (c) => {
  const redirect = await openInvite(c.env, c.req.param('token'))
  if (redirect) return redirect
  const { config } = c.env
  const text = messages(config).legacy
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(
    <Page config={config} title={text.invalidInvite} panel="invite">
      <a class="forge-button" href="/login">
        {messages(config).signIn}
      </a>
    </Page>,
    404,
  )
})

app.get('/', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  if (session.member.status === 'active') return c.redirect('/artefacts', 303)
  const common = messages(c.env.config)
  const text = common.legacy
  return page(
    c,
    session,
    common.pending,
    <p>
      {text.signedIn} {session.member.name}. {text.approvalRequired}
    </p>,
  )
})

async function memberAdmin(c: UiContext) {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  const { config, env } = c.env
  const common = messages(config)
  if (!isAdmin(session.member)) return c.text(common.forbidden, 403)
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
    const dateLabel = awaiting ? copy.requested : current ? copy.since : copy.removedOn
    const columns = [
      text.member,
      ...(current || awaiting ? [{ folded: text.email }] : []),
      ...(current ? [{ folded: text.provider }, { folded: text.role }, { folded: text.status }] : []),
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
                {(current || awaiting) && member.email && (
                  <span class="forge-fold forge-member-email" title={member.email} hidden>
                    {member.email}
                  </span>
                )}
                {current && (
                  <>
                    {member.provider && <Fold label={text.provider}>{member.provider}</Fold>}
                    <Fold label={text.role}>{roles[member.role]}</Fold>
                    <Fold>{badge}</Fold>
                  </>
                )}
                <Fold label={dateLabel}>{date}</Fold>
              </td>
              {(current || awaiting) && <td class="forge-col--folded">{member.email ?? '—'}</td>}
              {current && (
                <>
                  <td class="forge-col--folded">{member.provider ?? '—'}</td>
                  <td class="forge-col--folded">{roles[member.role]}</td>
                  <td class="forge-col--folded">{badge}</td>
                </>
              )}
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
                          fields={{ id: member.id }}
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
  if (!form.success) return c.text(text.invalidMemberAction, 400)
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
      : await changeMember(db, actor, data.id, data.action, 'role' in data ? data.role : undefined, now)
  const notices = {
    admit: text.admitDone,
    role: text.roleDone,
    remove: text.removeDone,
    reinstate: text.reinstateDone,
    'revoke-invite': text.inviteRevoked,
  }
  return flash(c, session, membersPath, changed ? notices[data.action] : text.memberNotAllowed)
})

app.get('/admin/bots', async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, config, db, common, text, actor } = admin
  const { createCredential, ownCredentialName } = common.admin
  const after = idSchema.safeParse(c.req.query('after')).data
  const botId = idSchema.safeParse(c.req.query('bot')).data
  const tokenAfter = idSchema.safeParse(c.req.query('tokenAfter')).data
  const [{ members: bots, nextCursor: nextBot }, tokens] = await Promise.all([
    listMembers(db, actor, { kind: 'bot', after }),
    botId ? listTokens(db, actor, botId, tokenAfter) : null,
  ])
  const selectedBot = bots.find((bot) => bot.id === botId)
  const focusedPath = withQuery('/admin/bots', { after, bot: botId, tokenAfter })
  return page(
    c,
    session,
    common.bots,
    <>
      <Action path="/admin/bots" action="create" variant="primary" label={text.createBot}>
        <label>
          {text.botName} <input name="name" required maxlength={120} />
        </label>
        <RoleSelect config={config} />
      </Action>
      {bots.map((bot) => {
        const path = withQuery('/admin/bots', { after, bot: bot.id })
        return (
          <section key={bot.id}>
            <h2>{bot.name}</h2>
            <p>
              {common.roles[bot.role]} · {text[bot.status]}
            </p>
            {bot.status === 'active' && (
              <Action path={path} action="token" label={createCredential} fields={{ id: bot.id }}>
                <label>
                  {ownCredentialName} <input name="name" required maxlength={120} />
                </label>
              </Action>
            )}
            <a href={`${path}#bot-tokens`}>{text.viewCredentials}</a>
          </section>
        )
      })}
      {nextBot && pageLink(withQuery('/admin/bots', { after: nextBot }), text.nextBots)}
      {tokens && (
        <section id="bot-tokens">
          <h2>
            {common.tokens}
            {selectedBot && ` · ${selectedBot.name}`}
          </h2>
          {tokens.length === 0 && <p class="forge-empty">{text.emptyCredentials}</p>}
          <ul>
            {tokens.map((token) => (
              <li key={token.id}>
                {token.name} <code>{token.prefix}…</code>{' '}
                {token.revokedAt !== null ? (
                  text.revoked
                ) : (
                  <Action path={focusedPath} action="revoke" label={text.revoke} fields={{ id: token.id }} />
                )}
              </li>
            ))}
          </ul>
          {tokens.length === adminPageSize &&
            pageLink(
              `${withQuery('/admin/bots', { after, bot: botId, tokenAfter: tokens.at(-1)?.id })}#bot-tokens`,
              text.nextCredentials,
            )}
        </section>
      )}
    </>,
  )
})

app.post('/admin/bots', async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, db, text, actor } = admin
  const fields = await readForm(c.req.raw)
  const form = botAction.safeParse(fields ? Object.fromEntries(fields) : null)
  if (!form.success) return c.text(text.invalidBotAction, 400)
  const { data } = form
  const after = idSchema.safeParse(c.req.query('after')).data
  const now = Date.now()
  if (data.action === 'token') {
    const issued = await createApiToken(db, actor, data.id, data.name, now)
    const path = withQuery('/admin/bots', { after, bot: data.id })
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
    return flash(c, session, '/admin/bots', created ? text.botCreated : text.botNotAllowed)
  }
  const revoked = await revokeApiToken(db, actor, data.id, now)
  const bot = idSchema.safeParse(c.req.query('bot')).data
  const tokenAfter = idSchema.safeParse(c.req.query('tokenAfter')).data
  const path = withQuery('/admin/bots', { after, bot, tokenAfter })
  return flash(c, session, path, revoked ? text.credentialRevoked : text.botNotAllowed)
})

app.route('/', adminPages)

export { app as manageUi }
