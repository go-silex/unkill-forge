import { Hono } from 'hono'
import { z } from 'zod'
import type { Config, Runtime } from '../../config'
import type { Role } from '../../core'
import {
  changeMember,
  createApiToken,
  createBot,
  isAdmin,
  listMembers,
  listTokens,
  revokeApiToken,
} from '../../core/admin'
import { createInvite, inviteKey, listInvites, revokeInvite } from '../../core/invites'
import { readForm } from '../../http'
import { messages } from '../../i18n'
import { openInvite, requireBrowserSession, returnPath } from '../login'
import { adminPages } from './admin-pages'
import { Action, Fold, flash, Page, page, pageLink, Table, time, type UiContext } from './page'

const pageSize = 50

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
    <select aria-label={text.role} name="role">
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
  const { config } = c.env
  const { member } = session
  const common = messages(config)
  const text = common.legacy
  if (member.status === 'pending') {
    return page(
      c,
      session,
      common.pending,
      <p>
        {text.signedIn} {member.name}. {text.approvalRequired}
      </p>,
    )
  }
  return page(
    c,
    session,
    common.manage,
    <>
      <p>
        {text.signedIn} {member.name} ({common.roles[member.role]}).
      </p>
      <p>
        <a class="forge-button forge-button--primary" href="/artefacts">
          {common.artefacts}
        </a>
      </p>
      <h2>{common.connect}</h2>
      <p>
        {text.mcpUrl} <code>{config.manageOrigin}/mcp</code>
      </p>
    </>,
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

app.get('/admin/members', async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, config, db, common, text, actor } = admin
  const after = idSchema.safeParse(c.req.query('after')).data
  const inviteCursor = c.req.query('inviteAfter')
  const inviteAfter = inviteCursor && inviteKey.test(inviteCursor) ? inviteCursor : undefined
  const [members, invites] = await Promise.all([
    listMembers(db, actor, after),
    listInvites(db, actor, inviteAfter),
  ])
  return page(
    c,
    session,
    common.members,
    <>
      <Table
        columns={[
          text.member,
          { folded: text.provider },
          { folded: text.email },
          text.status,
          { folded: text.role },
          common.admin.actions,
        ]}
      >
        {members.map((member) => (
          <tr key={member.id}>
            <td title={member.name}>
              <span>{member.name}</span>
              {member.email && (
                <span class="forge-fold forge-member-email" title={member.email} hidden>
                  {member.email}
                </span>
              )}
              <Fold label={text.provider}>{member.provider ?? text.bot}</Fold>
              <Fold label={text.role}>{common.roles[member.role]}</Fold>
            </td>
            <td class="forge-col--folded" title={member.provider ?? text.bot}>
              {member.provider ?? text.bot}
            </td>
            <td class="forge-col--folded" title={member.email ?? undefined}>
              {member.email ?? '—'}
            </td>
            <td>{text[member.status]}</td>
            <td class="forge-col--folded">{common.roles[member.role]}</td>
            <td>
              {member.status !== 'removed' && (
                <Action
                  path="/admin/members"
                  action={member.status === 'pending' ? 'admit' : 'role'}
                  label={member.status === 'pending' ? text.admit : text.changeRole}
                  fields={{ id: member.id }}
                >
                  <RoleSelect config={config} human={member.kind === 'human'} value={member.role} />
                </Action>
              )}
              <Action
                path="/admin/members"
                action={member.status === 'removed' ? 'reinstate' : 'remove'}
                label={member.status === 'removed' ? text.reinstate : text.remove}
                fields={{ id: member.id }}
              />
            </td>
          </tr>
        ))}
      </Table>
      {members.length === pageSize &&
        pageLink(withQuery('/admin/members', { after: members.at(-1)?.id, inviteAfter }), text.nextMembers)}
      <h2>{text.inviteLinks}</h2>
      <Action path="/admin/members" action="create-invite" variant="primary" label={text.createInvite}>
        <RoleSelect config={config} human />
      </Action>
      <Table columns={[text.role, text.expires, common.admin.actions]}>
        {invites.map((invite) => (
          <tr key={invite.id}>
            <td>{common.roles[invite.role]}</td>
            <td>{time(config.locale, invite.expiresAt)}</td>
            <td>
              <Action
                path="/admin/members"
                action="revoke-invite"
                label={text.revoke}
                fields={{ id: invite.id }}
              />
            </td>
          </tr>
        ))}
      </Table>
      {invites.length === pageSize &&
        pageLink(withQuery('/admin/members', { after, inviteAfter: invites.at(-1)?.id }), text.nextInvites)}
    </>,
  )
})

app.post('/admin/members', async (c) => {
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
    if (!token) return flash(c, session, '/admin/members', text.inviteNotAllowed)
    return flash(c, session, '/admin/members', text.inviteCreated, `${config.manageOrigin}/invite/${token}`)
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
  return flash(c, session, '/admin/members', changed ? notices[data.action] : text.memberNotAllowed)
})

app.get('/admin/bots', async (c) => {
  const admin = await memberAdmin(c)
  if (admin instanceof Response) return admin
  const { session, config, db, common, text, actor } = admin
  const { createCredential, ownCredentialName } = common.admin
  const after = idSchema.safeParse(c.req.query('after')).data
  const botId = idSchema.safeParse(c.req.query('bot')).data
  const tokenAfter = idSchema.safeParse(c.req.query('tokenAfter')).data
  const [bots, tokens] = await Promise.all([
    listMembers(db, actor, after, true),
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
      {bots.length === pageSize &&
        pageLink(withQuery('/admin/bots', { after: bots.at(-1)?.id }), text.nextBots)}
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
          {tokens.length === pageSize &&
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
