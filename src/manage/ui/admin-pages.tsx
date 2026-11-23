import { Hono } from 'hono'
import type { Child } from 'hono/jsx'
import { z } from 'zod'
import type { Runtime } from '../../config'
import { createOwnToken, listOwnTokens, revokeOwnToken, uiActor } from '../../core/admin'
import {
  ArtefactError,
  createShareLink,
  deleteArtefact,
  encodeFilePath,
  getArtefactDetails,
  getShareLink,
  listDeletedArtefacts,
  listRedirects,
  listRevisions,
  renameArtefact,
  restoreDeletedArtefact,
  restoreRevision,
  revokeShareLink,
  setRedirects,
  setVisibility,
} from '../../core/artefacts'
import { searchArtefacts } from '../../core/catalogue'
import type { BrowserSession, Member, Role } from '../../core/index'
import { purgeArtefact } from '../../core/purge'
import { artefactPath, maxRedirectPrefix } from '../../core/read-path'
import { shareKeyMax } from '../../core/share-keys'
import { readForm } from '../../http'
import { type AdminMessage, type AdminTranslate, adminMessages } from '../../i18n'
import { requireBrowserSession } from '../login'
import { flash, page, time, type UiContext } from './page'

export const adminPages = new Hono<{ Bindings: Runtime }>({
  getPath: (request) => new URL(request.url).pathname,
})

const cataloguePath = '/artefacts'
const deletedPath = '/admin/deleted'
const tokensPath = '/tokens'
const redirectsPath = '/admin/redirects'
const detailPath = (slug: string) => `${cataloguePath}/${slug}`

const id = z.uuid()
const slug = z
  .string()
  .max(64)
  .refine((value) => artefactPath(`/a/${value}`)?.slug === value)
const visibility = z.enum(['private', 'public'])
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.int().positive())
const prefix = z.string().max(maxRedirectPrefix)
const maxNameLength = 120
const maxShareLabelLength = 200
const artefactAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('visibility'), visibility, artefactId: id }),
  z.strictObject({ action: z.literal('restore-revision'), revision, artefactId: id }),
  z.strictObject({
    action: z.literal('create-share'),
    artefactId: id,
    label: z.string().trim().max(maxShareLabelLength).optional(),
    key: z.string().optional(),
  }),
  z.strictObject({ action: z.enum(['reveal-share', 'revoke-share']), id }),
  z.strictObject({ action: z.literal('rename'), slug, artefactId: id }),
  z.strictObject({ action: z.literal('delete'), artefactId: id }),
])
const deletedAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('restore'), slug, artefactId: id }),
  z.strictObject({ action: z.literal('purge'), slug, id }),
])
const tokenAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), name: z.string().trim().min(1).max(maxNameLength) }),
  z.strictObject({ action: z.literal('revoke'), id }),
])
const redirectAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), fromPrefix: prefix, toPrefix: prefix }),
  z.strictObject({ action: z.literal('remove'), fromPrefix: prefix }),
])

type BrowserHandler = (
  c: UiContext,
  session: BrowserSession,
  actor: Member,
  t: AdminTranslate,
) => Promise<Response>
type ActionResult = { message: AdminMessage; path?: string; secret?: string }

function browser(minimum: Role, handler: BrowserHandler) {
  return async (c: UiContext) => {
    const t = adminMessages(c.env.config.locale)
    const session = await requireBrowserSession(c.req.raw, c.env)
    if (session instanceof Response) return session
    try {
      const actor = await uiActor(c.env.env.DB, session.member.id, minimum)
      return await handler(c, { ...session, member: actor }, actor, t)
    } catch (error) {
      if (!(error instanceof ArtefactError)) throw error
      if (error.code === 'forbidden') return c.text(t(error.code), 403)
      if (error.code === 'not_found') return c.text(t(error.code), 404)
      return c.text(t(error.code), error.code === 'conflict' ? 409 : 400)
    }
  }
}

async function runAction<S extends z.ZodType>(
  c: UiContext,
  session: BrowserSession,
  t: AdminTranslate,
  path: string,
  schema: S,
  run: (input: z.output<S>) => Promise<ActionResult>,
  missingPath = path,
) {
  const form = await readForm(c.req.raw)
  if (!form) return c.text(t('malformed'), 400)
  const fields = Object.fromEntries(form)
  if (form.size !== Object.keys(fields).length) return c.text(t('malformed'), 400)
  const parsed = schema.safeParse(fields)
  if (!parsed.success) return c.text(t('malformed'), 400)
  let result: ActionResult
  try {
    result = await run(parsed.data)
  } catch (error) {
    if (!(error instanceof ArtefactError) || error.code === 'forbidden') throw error
    result = { message: error.code, path: error.code === 'not_found' ? missingPath : path }
  }
  return flash(c, session, result.path ?? path, t(result.message), result.secret)
}

function Action({
  action,
  label,
  fields,
}: {
  action: string
  label: string
  fields?: Record<string, string | number>
}) {
  return (
    <form method="post">
      {fields &&
        Object.entries(fields).map(([name, value]) => <input type="hidden" name={name} value={value} />)}
      <button type="submit" name="action" value={action}>
        {label}
      </button>
    </form>
  )
}

function VisibilityOptions({
  t,
  value,
  includeAll = false,
}: {
  t: AdminTranslate
  value?: z.output<typeof visibility>
  includeAll?: boolean
}) {
  return (
    <>
      {includeAll && (
        <option value="" selected={value === undefined}>
          {t('all')}
        </option>
      )}
      <option value="private" selected={value === 'private'}>
        {t('private')}
      </option>
      <option value="public" selected={value === 'public'}>
        {t('public')}
      </option>
    </>
  )
}

function table(headers: string[], rows: Child[], t: AdminTranslate) {
  if (rows.length === 0) return <p>{t('noResults')}</p>
  return (
    <table>
      <thead>
        <tr>
          {headers.map((label) => (
            <th scope="col">{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  )
}

function nextPage(
  path: string,
  cursor: string | undefined,
  label: string,
  params?: URLSearchParams,
  key = 'cursor',
) {
  if (!cursor) return null
  const query = new URLSearchParams(params)
  query.set(key, cursor)
  return (
    <p>
      <a href={`${path}?${query}`}>{label}</a>
    </p>
  )
}

adminPages.get(
  cataloguePath,
  browser('viewer', async (c, session, actor, t) => {
    const q = c.req.query('q') ?? ''
    const rawVisibility = c.req.query('visibility')
    const filter = visibility.safeParse(rawVisibility)
    if (rawVisibility && !filter.success) return c.text(t('malformed'), 400)
    const selected = filter.data
    const { artefacts, nextCursor } = await searchArtefacts(c.env, actor, q, selected, c.req.query('cursor'))
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (selected) params.set('visibility', selected)
    return page(
      c,
      session,
      t('artefacts'),
      <>
        <form method="get">
          <label>
            {t('searchQuery')} <input type="search" name="q" value={q} />
          </label>
          <label>
            {t('visibility')}{' '}
            <select name="visibility">
              <VisibilityOptions t={t} value={selected} includeAll />
            </select>
          </label>
          <button type="submit">{t('search')}</button>
        </form>
        {table(
          [t('title'), t('slug'), t('visibility'), t('revision'), t('updated')],
          artefacts.map((entry) => (
            <tr>
              <td>
                <a href={detailPath(entry.slug)}>{entry.title}</a>
              </td>
              <td>
                <code>{entry.slug}</code>
              </td>
              <td>{t(entry.visibility)}</td>
              <td>{entry.revision}</td>
              <td>{time(c.env.config.locale, entry.updatedAt)}</td>
            </tr>
          )),
          t,
        )}
        {nextPage(cataloguePath, nextCursor, t('next'), params)}
      </>,
    )
  }),
)

adminPages.get(
  '/artefacts/:slug',
  browser('viewer', async (c, session, actor, t) => {
    const slugValue = slug.safeParse(c.req.param('slug'))
    if (!slugValue.success) return c.text(t('not_found'), 404)
    const currentSlug = slugValue.data
    const path = detailPath(currentSlug)
    const fileCursor = c.req.query('files')
    const revisionCursor = c.req.query('revisions')
    const artefact = await getArtefactDetails(c.env, actor, currentSlug, fileCursor)
    const history = await listRevisions(c.env, actor, currentSlug, revisionCursor, {
      expectedId: artefact.id,
    })
    const canWrite = actor.role !== 'viewer'
    const params = new URLSearchParams()
    if (fileCursor) params.set('files', fileCursor)
    if (revisionCursor) params.set('revisions', revisionCursor)
    const readBase = `${c.env.config.readOrigin}/a/${currentSlug}/`
    return page(
      c,
      session,
      artefact.title,
      <>
        <p>
          <a href={cataloguePath}>{t('artefacts')}</a>
        </p>
        <p>
          <a href={artefact.url}>{t('open')}</a>
        </p>
        <dl>
          <dt>{t('slug')}</dt>
          <dd>
            <code>{currentSlug}</code>
          </dd>
          <dt>{t('currentRevision')}</dt>
          <dd>{artefact.revision}</dd>
          <dt>{t('visibility')}</dt>
          <dd>{t(artefact.visibility)}</dd>
        </dl>
        {canWrite && (
          <form method="post">
            <input type="hidden" name="artefactId" value={artefact.id} />
            <label>
              {t('visibility')}{' '}
              <select name="visibility">
                <VisibilityOptions t={t} value={artefact.visibility} />
              </select>
            </label>
            <button type="submit" name="action" value="visibility">
              {t('saveVisibility')}
            </button>
          </form>
        )}
        <h2>{t('files')}</h2>
        {table(
          [t('file'), t('size'), t('type')],
          artefact.files.map((file) => (
            <tr>
              <td>
                <a href={readBase + encodeFilePath(file.path)}>
                  <code>{file.path}</code>
                </a>
              </td>
              <td>{file.size}</td>
              <td>{file.type}</td>
            </tr>
          )),
          t,
        )}
        {nextPage(path, artefact.nextCursor, t('nextFiles'), params, 'files')}
        <h2>{t('revisions')}</h2>
        {table(
          [t('revision'), t('author'), t('created'), t('message'), ...(canWrite ? [t('actions')] : [])],
          history.revisions.map((entry) => (
            <tr>
              <td>{entry.number}</td>
              <td>{entry.author}</td>
              <td>{time(c.env.config.locale, entry.createdAt)}</td>
              <td>{entry.message}</td>
              {canWrite && (
                <td>
                  {entry.number !== artefact.revision && (
                    <Action
                      action="restore-revision"
                      label={t('restoreRevision')}
                      fields={{ revision: entry.number, artefactId: artefact.id }}
                    />
                  )}
                </td>
              )}
            </tr>
          )),
          t,
        )}
        {nextPage(path, history.nextCursor, t('nextRevisions'), params, 'revisions')}
        {canWrite && (
          <>
            <h2>{t('shareLinks')}</h2>
            <p>{t('shareWarning')}</p>
            <form method="post">
              <input type="hidden" name="artefactId" value={artefact.id} />
              <label>
                {t('shareLabel')} <input name="label" maxlength={maxShareLabelLength} />
              </label>
              {actor.role === 'admin' && (
                <label>
                  {t('customShare')}{' '}
                  <input
                    type="password"
                    name="key"
                    autocomplete="off"
                    maxlength={shareKeyMax}
                    pattern="[A-Za-z0-9_\-]{16,128}"
                  />
                </label>
              )}
              <button type="submit" name="action" value="create-share">
                {t('createShare')}
              </button>
            </form>
            {table(
              [t('shareLabel'), t('created'), t('lastUsed'), t('actions')],
              artefact.shareLinks.map((share) => (
                <tr>
                  <td>{share.label || t('unlabeled')}</td>
                  <td>{time(c.env.config.locale, share.createdAt)}</td>
                  <td>{time(c.env.config.locale, share.lastUsedAt)}</td>
                  <td>
                    <Action action="reveal-share" label={t('showShare')} fields={{ id: share.id }} />
                    <Action action="revoke-share" label={t('revokeShare')} fields={{ id: share.id }} />
                  </td>
                </tr>
              )),
              t,
            )}
            <h2>{t('rename')}</h2>
            <form method="post">
              <input type="hidden" name="artefactId" value={artefact.id} />
              <label>
                {t('newSlug')} <input name="slug" required maxlength={64} />
              </label>
              <button type="submit" name="action" value="rename">
                {t('rename')}
              </button>
            </form>
            <h2>{t('delete')}</h2>
            <p>{t('deleteHelp')}</p>
            <Action action="delete" label={t('delete')} fields={{ artefactId: artefact.id }} />
          </>
        )}
      </>,
    )
  }),
)

adminPages.post(
  '/artefacts/:slug',
  browser('publisher', async (c, session, actor, t) => {
    const slugValue = slug.safeParse(c.req.param('slug'))
    if (!slugValue.success) return c.text(t('malformed'), 400)
    const currentSlug = slugValue.data
    return runAction(
      c,
      session,
      t,
      detailPath(currentSlug),
      artefactAction,
      async (input) => {
        switch (input.action) {
          case 'visibility':
            await setVisibility(c.env, actor, currentSlug, input.visibility, input.artefactId)
            return { message: 'visibilitySaved' }
          case 'restore-revision':
            await restoreRevision(c.env, actor, currentSlug, input.revision, undefined, input.artefactId)
            return { message: 'revisionRestored' }
          case 'create-share': {
            const share = await createShareLink(
              c.env,
              actor,
              { slug: currentSlug, label: input.label || undefined, key: input.key || undefined },
              input.artefactId,
            )
            return { message: 'shareCreated', secret: share.url }
          }
          case 'reveal-share': {
            const share = await getShareLink(c.env, actor, input.id, currentSlug)
            return { message: 'shareRevealed', secret: share.url }
          }
          case 'revoke-share':
            await revokeShareLink(c.env, actor, input.id, currentSlug)
            return { message: 'shareRevoked' }
          case 'rename':
            await renameArtefact(c.env, actor, currentSlug, input.slug, input.artefactId)
            return { message: 'artefactRenamed', path: detailPath(input.slug) }
          case 'delete':
            await deleteArtefact(c.env, actor, currentSlug, input.artefactId)
            return { message: 'artefactDeleted', path: cataloguePath }
        }
      },
      cataloguePath,
    )
  }),
)

adminPages.get(
  deletedPath,
  browser('admin', async (c, session, actor, t) => {
    const { artefacts, nextCursor } = await listDeletedArtefacts(c.env, actor, c.req.query('cursor'))
    return page(
      c,
      session,
      t('deleted'),
      <>
        <p>{t('purgeHelp')}</p>
        {table(
          [t('title'), t('slug'), t('deletedAt'), t('status'), t('actions')],
          artefacts.map((entry) => (
            <tr>
              <td>{entry.title}</td>
              <td>
                <code>{entry.slug}</code>
              </td>
              <td>{time(c.env.config.locale, entry.deletedAt)}</td>
              <td>{t(entry.purging ? 'purging' : entry.restorable ? 'restorable' : 'expired')}</td>
              <td>
                {entry.restorable && (
                  <Action
                    action="restore"
                    label={t('restoreDeleted')}
                    fields={{ slug: entry.slug, artefactId: entry.id }}
                  />
                )}
                <Action
                  action="purge"
                  label={t(entry.purging ? 'resumePurge' : 'purge')}
                  fields={{ id: entry.id, slug: entry.slug }}
                />
              </td>
            </tr>
          )),
          t,
        )}
        {nextPage(deletedPath, nextCursor, t('next'))}
      </>,
    )
  }),
)

adminPages.post(
  deletedPath,
  browser('admin', (c, session, actor, t) => {
    const cursor = c.req.query('cursor')
    const path = cursor ? `${deletedPath}?${new URLSearchParams({ cursor })}` : deletedPath
    return runAction(c, session, t, path, deletedAction, async (input) => {
      if (input.action === 'restore') {
        await restoreDeletedArtefact(c.env, actor, input.slug, input.artefactId)
        return { message: 'artefactRestored', path: detailPath(input.slug) }
      }
      const { done } = await purgeArtefact(c.env, actor, input.id, input.slug)
      return { message: done ? 'purgeDone' : 'purgePending' }
    })
  }),
)

adminPages.get(
  tokensPath,
  browser('publisher', async (c, session, actor, t) => {
    const { tokens, nextCursor } = await listOwnTokens(c.env.env.DB, actor.id, c.req.query('cursor'))
    return page(
      c,
      session,
      t('tokens'),
      <>
        <p>{t('ownCredentialHelp')}</p>
        <form method="post">
          <label>
            {t('ownCredentialName')} <input name="name" required maxlength={maxNameLength} />
          </label>
          <button type="submit" name="action" value="create">
            {t('createCredential')}
          </button>
        </form>
        {table(
          [t('ownCredentialName'), t('ownCredentialPrefix'), t('lastUsed'), t('revokedAt'), t('actions')],
          tokens.map((token) => (
            <tr>
              <td>{token.name}</td>
              <td>
                <code>{token.prefix}</code>
              </td>
              <td>{time(c.env.config.locale, token.lastUsedAt)}</td>
              <td>{time(c.env.config.locale, token.revokedAt)}</td>
              <td>
                {token.revokedAt === null && (
                  <Action action="revoke" label={t('revokeCredential')} fields={{ id: token.id }} />
                )}
              </td>
            </tr>
          )),
          t,
        )}
        {nextPage(tokensPath, nextCursor, t('next'))}
      </>,
    )
  }),
)

adminPages.post(
  tokensPath,
  browser('publisher', (c, session, actor, t) =>
    runAction(c, session, t, tokensPath, tokenAction, async (input) => {
      const { DB: db } = c.env.env
      if (input.action === 'create') {
        const secret = await createOwnToken(db, actor.id, input.name, Date.now())
        return secret ? { message: 'ownCredentialCreated', secret } : { message: 'conflict' }
      }
      const revoked = await revokeOwnToken(db, actor.id, input.id, Date.now())
      return { message: revoked ? 'ownCredentialRevoked' : 'not_found' }
    }),
  ),
)

adminPages.get(
  redirectsPath,
  browser('admin', async (c, session, actor, t) => {
    const { redirects, nextCursor } = await listRedirects(c.env, actor, c.req.query('cursor'))
    return page(
      c,
      session,
      t('redirects'),
      <>
        <p>{t('redirectHelp')}</p>
        <form method="post">
          <label>
            {t('fromPrefix')}{' '}
            <input name="fromPrefix" required maxlength={maxRedirectPrefix} placeholder="/a/old/" />
          </label>
          <label>
            {t('toPrefix')}{' '}
            <input name="toPrefix" required maxlength={maxRedirectPrefix} placeholder="/a/new/" />
          </label>
          <button type="submit" name="action" value="add">
            {t('addRedirect')}
          </button>
        </form>
        {table(
          [t('fromPrefix'), t('toPrefix'), t('actions')],
          redirects.map((entry) => (
            <tr>
              <td>
                <code>{entry.fromPrefix}</code>
              </td>
              <td>
                <code>{entry.toPrefix}</code>
              </td>
              <td>
                <Action
                  action="remove"
                  label={t('removeRedirect')}
                  fields={{ fromPrefix: entry.fromPrefix }}
                />
              </td>
            </tr>
          )),
          t,
        )}
        {nextPage(redirectsPath, nextCursor, t('next'))}
      </>,
    )
  }),
)

adminPages.post(
  redirectsPath,
  browser('admin', (c, session, actor, t) =>
    runAction(c, session, t, redirectsPath, redirectAction, async (input) => {
      if (input.action === 'add') {
        await setRedirects(c.env, actor, {
          add: [{ fromPrefix: input.fromPrefix, toPrefix: input.toPrefix }],
          remove: [],
        })
        return { message: 'redirectSaved' }
      }
      await setRedirects(c.env, actor, { add: [], remove: [input.fromPrefix] })
      return { message: 'redirectRemoved' }
    }),
  ),
)

adminPages.get(
  '/connect',
  browser('viewer', async (c, session, _actor, t) => {
    const origin = c.env.config.manageOrigin
    const url = `${origin}/mcp`
    const omp = {
      type: 'http',
      url,
      oauth: {
        clientId: `${origin}/oauth/clients/local.json`,
        redirectUri: 'http://127.0.0.1:3000/callback',
      },
    }
    const variable = 'FORGE_API_TOKEN'
    return page(
      c,
      session,
      t('connect'),
      <>
        <p>
          {t('endpoint')}: <code>{url}</code>
        </p>
        <h2>claude.ai</h2>
        <p>{t('claudeAi')}</p>
        <h2>Claude Desktop</h2>
        <p>{t('claudeDesktop')}</p>
        <h2>Claude Code</h2>
        <p>{t('claudeCode')}</p>
        <pre>
          <code>{`claude mcp add --transport http forge ${url}`}</code>
        </pre>
        <h2>Codex</h2>
        <p>{t('codex')}</p>
        <pre>
          <code>{`codex mcp add forge --url ${url}\ncodex mcp login forge`}</code>
        </pre>
        <h2>OMP</h2>
        <p>{t('omp')}</p>
        <pre>
          <code>{JSON.stringify({ mcpServers: { forge: omp } }, null, 2)}</code>
        </pre>
        <h2>Hermes</h2>
        <p>{t('hermes')}</p>
        <pre>
          <code>{`${variable}=…`}</code>
        </pre>
        <pre>
          <code>{`mcp_servers:\n  forge:\n    url: ${JSON.stringify(url)}\n    headers:\n      Authorization: "Bearer \${${variable}}"`}</code>
        </pre>
        <p>{t('verifyAgent')}</p>
      </>,
    )
  }),
)
