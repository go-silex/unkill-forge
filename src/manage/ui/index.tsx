import { Hono } from 'hono'
import type { Child } from 'hono/jsx'
import { z } from 'zod'
import type { Config, Runtime } from '../../config'
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
import { openInvite, requireBrowserSession, returnPath } from '../login'

export function Page({ config, title, children }: { config: Config; title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>
          {title} · {config.name}
        </title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <header>
          <a href="/">{config.name}</a>
        </header>
        <main>
          <h1>{title}</h1>
          {children}
        </main>
      </body>
    </html>
  )
}

// Keep routing and the outer Origin guard on the same, un-decoded path.
const app = new Hono<{ Bindings: Runtime }>({ getPath: (request) => new URL(request.url).pathname })
app.onError((error, c) => {
  console.error('Forge UI request failed', error.name)
  return c.text('Forge is unavailable', 503)
})
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

function RoleSelect({ human = false, value = 'viewer' }: { human?: boolean; value?: string }) {
  return (
    <select aria-label="Role" name="role">
      <option value="viewer" selected={value === 'viewer'}>
        viewer
      </option>
      <option value="publisher" selected={value === 'publisher'}>
        publisher
      </option>
      {human && (
        <option value="admin" selected={value === 'admin'}>
          admin
        </option>
      )}
    </select>
  )
}

app.get(
  '/style.css',
  () =>
    new Response(
      `
  :root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}
  body{max-width:64rem;margin:2rem auto;padding:0 1rem}
  h1,h2{line-height:1.2} form{display:inline-flex;gap:.4rem;margin:.2rem;flex-wrap:wrap}
  button,input,select{font:inherit} a{color:LinkText} code{overflow-wrap:anywhere}
  table{width:100%;border-collapse:collapse} th,td{text-align:left;vertical-align:top;padding:.4rem;border-bottom:1px solid GrayText}
`,
      { headers: { 'Content-Type': 'text/css; charset=utf-8' } },
    ),
)

function SignIn({ config, query }: { config: Config; query: URLSearchParams }) {
  return (
    <Page config={config} title="Sign in">
      <ul>
        {config.providers.map((provider) => (
          <li>
            <a href={`/login/${provider.id}?${query}`}>{provider.label}</a>
          </li>
        ))}
      </ul>
    </Page>
  )
}

app.get('/login', (c) => {
  const { config } = c.env
  const query = new URLSearchParams({
    return: returnPath(c.req.query('return') ?? null, config.manageOrigin),
  })
  return c.html(<SignIn config={config} query={query} />)
})

app.get('/invite/:token', async (c) => {
  const redirect = await openInvite(c.env, c.req.param('token'))
  if (redirect) return redirect
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(
    <Page config={c.env.config} title="Invite invalid or expired">
      <a href="/login">Sign in</a>
    </Page>,
    404,
  )
})

app.get('/', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  const { config } = c.env
  const { member } = session
  const logout = (
    <form action="/logout" method="post">
      <button type="submit">Sign out</button>
    </form>
  )
  if (member.status === 'pending')
    return c.html(
      <Page config={config} title="Pending access">
        <p>Signed in as {member.name}. An administrator needs to approve your access.</p>
        {logout}
      </Page>,
    )
  return c.html(
    <Page config={config} title="Manage">
      <p>
        Signed in as {member.name} ({member.role}).
      </p>
      <h2>Connect an agent</h2>
      <p>
        MCP URL: <code>{config.manageOrigin}/mcp</code>
      </p>
      {isAdmin(member) && (
        <nav>
          <a href="/admin/members">Members</a> · <a href="/admin/bots">Bots and API tokens</a>
        </nav>
      )}
      {logout}
    </Page>,
  )
})

app.get('/admin/members', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  if (!isAdmin(session.member)) return c.text('Forbidden', 403)
  const db = c.env.env.DB
  const [members, invites] = await Promise.all([
    listMembers(db),
    listInvites(db, session.member.id, Date.now()),
  ])
  return c.html(
    <Page config={c.env.config} title="Members">
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Provider</th>
            <th>Email</th>
            <th>Status</th>
            <th>Role</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr>
              <td>{member.name}</td>
              <td>{member.provider ?? 'Bot'}</td>
              <td>{member.email ?? '—'}</td>
              <td>{member.status}</td>
              <td>{member.role}</td>
              <td>
                {member.status !== 'removed' && (
                  <form action="/admin/members" method="post">
                    <input type="hidden" name="id" value={member.id} />
                    <RoleSelect human={member.kind === 'human'} value={member.role} />
                    {member.status === 'pending' ? (
                      <button type="submit" name="action" value="admit">
                        Admit
                      </button>
                    ) : (
                      <button type="submit" name="action" value="role">
                        Change role
                      </button>
                    )}
                  </form>
                )}
                <form action="/admin/members" method="post">
                  <input type="hidden" name="id" value={member.id} />
                  {member.status === 'removed' ? (
                    <button type="submit" name="action" value="reinstate">
                      Reinstate
                    </button>
                  ) : (
                    <button type="submit" name="action" value="remove">
                      Remove
                    </button>
                  )}
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Invite links</h2>
      <form action="/admin/members" method="post">
        <RoleSelect human />
        <button type="submit" name="action" value="create-invite">
          Create invite link
        </button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Expires (UTC)</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => (
            <tr>
              <td>{invite.role}</td>
              <td>{new Date(invite.expiresAt).toISOString()}</td>
              <td>
                <form action="/admin/members" method="post">
                  <input type="hidden" name="id" value={invite.id} />
                  <button type="submit" name="action" value="revoke-invite">
                    Revoke
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>,
  )
})

app.post('/admin/members', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  if (!isAdmin(session.member)) return c.text('Forbidden', 403)
  const form = memberAction.safeParse(await c.req.parseBody())
  if (!form.success) return c.text('Invalid member action', 400)
  const { data } = form
  const {
    config,
    env: { DB },
  } = c.env
  const actor = session.member.id
  const now = Date.now()
  if (data.action === 'create-invite') {
    const token = await createInvite(DB, actor, data.role, now)
    if (!token) return c.text('Invite action not allowed', 409)
    return c.html(
      <Page config={config} title="Invite link created">
        <p>Copy this link now. It will not be shown again. It expires in seven days and can be used once.</p>
        <p>
          <code>
            {config.manageOrigin}/invite/{token}
          </code>
        </p>
        <a href="/admin/members">Back to members</a>
      </Page>,
    )
  }
  const changed =
    data.action === 'revoke-invite'
      ? await revokeInvite(DB, actor, data.id, now)
      : await changeMember(DB, actor, data.id, data.action, 'role' in data ? data.role : undefined, now)
  return changed ? c.redirect('/admin/members', 303) : c.text('Member action not allowed', 409)
})

app.get('/admin/bots', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  if (!isAdmin(session.member)) return c.text('Forbidden', 403)
  const db = c.env.env.DB
  const [members, tokens] = await Promise.all([listMembers(db), listTokens(db)])
  return c.html(
    <Page config={c.env.config} title="Bots and API tokens">
      <form action="/admin/bots" method="post">
        <label>
          Bot name <input name="name" required maxlength={120} />
        </label>
        <RoleSelect />
        <button type="submit" name="action" value="create">
          Create bot
        </button>
      </form>
      {members
        .filter((member) => member.kind === 'bot')
        .map((bot) => (
          <section>
            <h2>{bot.name}</h2>
            <p>
              {bot.role} · {bot.status}
            </p>
            {bot.status === 'active' && (
              <form action="/admin/bots" method="post">
                <input type="hidden" name="id" value={bot.id} />
                <label>
                  Token name <input name="name" required maxlength={120} />
                </label>
                <button type="submit" name="action" value="token">
                  Create token
                </button>
              </form>
            )}
            <ul>
              {tokens
                .filter((token) => token.memberId === bot.id)
                .map((token) => (
                  <li>
                    {token.name} <code>{token.prefix}…</code>{' '}
                    {token.revokedAt !== null ? (
                      'Revoked'
                    ) : (
                      <form action="/admin/bots" method="post">
                        <input type="hidden" name="id" value={token.id} />
                        <button type="submit" name="action" value="revoke">
                          Revoke
                        </button>
                      </form>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
    </Page>,
  )
})

app.post('/admin/bots', async (c) => {
  const session = await requireBrowserSession(c.req.raw, c.env)
  if (session instanceof Response) return session
  if (!isAdmin(session.member)) return c.text('Forbidden', 403)
  const form = botAction.safeParse(await c.req.parseBody())
  if (!form.success) return c.text('Invalid bot action', 400)
  const { data } = form
  const db = c.env.env.DB
  const actor = session.member.id
  const now = Date.now()
  if (data.action === 'token') {
    const token = await createApiToken(db, actor, data.id, data.name, now)
    if (!token) return c.text('Token action not allowed', 409)
    return c.html(
      <Page config={c.env.config} title="API token created">
        <p>Copy this token now. It will not be shown again.</p>
        <p>
          <code>{token}</code>
        </p>
        <a href="/admin/bots">Back to bots</a>
      </Page>,
    )
  }
  const changed =
    data.action === 'create'
      ? await createBot(db, actor, data.name, data.role, now)
      : await revokeApiToken(db, actor, data.id, now)
  return changed ? c.redirect('/admin/bots', 303) : c.text('Bot action not allowed', 409)
})

export { app as manageUi }
