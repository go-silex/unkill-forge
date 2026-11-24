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
import { galleryPreviewSlugs, previewPrefix } from '../../core/gallery-previews'
import type { BrowserSession, Member, Role } from '../../core/index'
import { purgeArtefact } from '../../core/purge'
import { artefactPath, maxRedirectPrefix } from '../../core/read-path'
import { shareKeyMax } from '../../core/share-keys'
import { Gallery, GalleryViews, galleryView } from '../../gallery'
import { readForm } from '../../http'
import { type AdminMessage, type AdminTranslate, adminMessages, messages } from '../../i18n'
import { requireBrowserSession } from '../login'
import { localClientPath } from '../oauth'
import { Action, Fold, flash, page, pageLink, Table, type TableColumn, time, type UiContext } from './page'

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

function table(columns: TableColumn[], rows: Child[], t: AdminTranslate) {
  if (rows.length === 0) return <p class="forge-empty">{t('noResults')}</p>
  return <Table columns={columns}>{rows}</Table>
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
  return pageLink(`${path}?${query}`, label)
}

adminPages.get(
  cataloguePath,
  browser('viewer', async (c, session, actor, t) => {
    const q = c.req.query('q') ?? ''
    const rawVisibility = c.req.query('visibility')
    const filter = visibility.safeParse(rawVisibility)
    if (rawVisibility && !filter.success) return c.text(t('malformed'), 400)
    const selected = filter.data
    const cursor = c.req.query('cursor')
    const { artefacts, nextCursor } = await searchArtefacts(c.env, actor, q, selected, cursor)
    const previews = await galleryPreviewSlugs(
      c.env,
      artefacts.map((entry) => entry.slug),
      'member',
    )
    const view = galleryView(c.req.query('view'))
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (selected) params.set('visibility', selected)
    if (view === 'list') params.set('view', view)
    const { locale } = c.env.config
    return page(
      c,
      session,
      t('artefacts'),
      <>
        <div class="forge-toolbar">
          <form class="forge-action" method="get">
            <label>
              {t('searchQuery')} <input type="search" name="q" value={q} />
            </label>
            <label>
              {t('visibility')}{' '}
              <select name="visibility">
                <VisibilityOptions t={t} value={selected} includeAll />
              </select>
            </label>
            {view === 'list' && <input type="hidden" name="view" value={view} />}
            <button class="forge-button forge-button--primary" type="submit">
              {t('search')}
            </button>
          </form>
          <GalleryViews
            path={cataloguePath}
            params={params}
            view={view}
            labels={messages(c.env.config).views}
          />
        </div>
        {artefacts.length === 0 ? (
          <p class="forge-empty">{t(nextCursor ? 'noNewMatches' : cursor ? 'noMoreResults' : 'noResults')}</p>
        ) : view === 'list' ? (
          <Table
            columns={[
              t('title'),
              { folded: t('slug') },
              { folded: t('visibility') },
              { secondary: t('revision') },
              { folded: t('updated') },
            ]}
          >
            {artefacts.map((entry) => {
              const updated = time(locale, entry.updatedAt)
              return (
                <tr>
                  <td title={entry.title}>
                    <a href={detailPath(entry.slug)}>
                      {previews.has(entry.slug) && (
                        <img
                          class="forge-thumb"
                          src={`${previewPrefix}${entry.slug}`}
                          alt=""
                          loading="lazy"
                        />
                      )}
                      <span>{entry.title}</span>
                    </a>
                    <Fold>
                      <code>{entry.slug}</code>
                    </Fold>
                    <Fold label={t('visibility')}>{t(entry.visibility)}</Fold>
                    <Fold label={t('updated')}>{updated}</Fold>
                  </td>
                  <td class="forge-col--folded" title={entry.slug}>
                    <code>{entry.slug}</code>
                  </td>
                  <td class="forge-col--folded">{t(entry.visibility)}</td>
                  <td class="forge-col--secondary">{entry.revision}</td>
                  <td class="forge-col--folded">{updated}</td>
                </tr>
              )
            })}
          </Table>
        ) : (
          <Gallery
            label={t('artefacts')}
            items={artefacts.map((entry) => ({
              href: detailPath(entry.slug),
              title: entry.title,
              preview: previews.has(entry.slug) ? entry.slug : undefined,
              detail: (
                <dl>
                  <dt>{t('slug')}</dt>
                  <dd>
                    <code>{entry.slug}</code>
                  </dd>
                  <dt>{t('visibility')}</dt>
                  <dd>{t(entry.visibility)}</dd>
                  <dt>{t('revision')}</dt>
                  <dd>{entry.revision}</dd>
                  <dt>{t('updated')}</dt>
                  <dd>{time(locale, entry.updatedAt)}</dd>
                </dl>
              ),
            }))}
          />
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
    const history = await listRevisions(c.env, actor, currentSlug, revisionCursor, artefact.id)
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
          <Action action="visibility" label={t('saveVisibility')} fields={{ artefactId: artefact.id }}>
            <label>
              {t('visibility')}{' '}
              <select name="visibility">
                <VisibilityOptions t={t} value={artefact.visibility} />
              </select>
            </label>
          </Action>
        )}
        <h2>{t('files')}</h2>
        {table(
          [t('file'), { secondary: t('size') }, { secondary: t('type') }],
          artefact.files.map((file) => (
            <tr>
              <td title={file.path}>
                <a href={readBase + encodeFilePath(file.path)}>
                  <code>{file.path}</code>
                </a>
              </td>
              <td class="forge-col--secondary">{file.size}</td>
              <td class="forge-col--secondary" title={file.type}>
                {file.type}
              </td>
            </tr>
          )),
          t,
        )}
        {nextPage(path, artefact.nextCursor, t('nextFiles'), params, 'files')}
        <h2>{t('revisions')}</h2>
        {table(
          [
            t('revision'),
            { secondary: t('author') },
            { secondary: t('created') },
            t('message'),
            ...(canWrite ? [t('actions')] : []),
          ],
          history.revisions.map((entry) => (
            <tr>
              <td>{entry.number}</td>
              <td class="forge-col--secondary" title={entry.author}>
                {entry.author}
              </td>
              <td class="forge-col--secondary">{time(c.env.config.locale, entry.createdAt)}</td>
              <td title={entry.message ?? undefined}>{entry.message}</td>
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
            <Action action="create-share" label={t('createShare')} fields={{ artefactId: artefact.id }}>
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
            </Action>
            {table(
              [t('shareLabel'), { folded: t('created') }, { folded: t('lastUsed') }, t('actions')],
              artefact.shareLinks.map((share) => {
                const label = share.label || t('unlabeled')
                const created = time(c.env.config.locale, share.createdAt)
                const lastUsed = time(c.env.config.locale, share.lastUsedAt)
                return (
                  <tr>
                    <td title={label}>
                      <span>{label}</span>
                      <Fold label={t('created')}>{created}</Fold>
                      <Fold label={t('lastUsed')}>{lastUsed}</Fold>
                    </td>
                    <td class="forge-col--folded">{created}</td>
                    <td class="forge-col--folded">{lastUsed}</td>
                    <td>
                      <Action action="reveal-share" label={t('showShare')} fields={{ id: share.id }} />
                      <Action action="revoke-share" label={t('revokeShare')} fields={{ id: share.id }} />
                    </td>
                  </tr>
                )
              }),
              t,
            )}
            <h2>{t('rename')}</h2>
            <Action action="rename" label={t('rename')} fields={{ artefactId: artefact.id }}>
              <label>
                {t('newSlug')} <input name="slug" required maxlength={64} />
              </label>
            </Action>
            <h2>{t('delete')}</h2>
            <p>{t('deleteHelp')}</p>
            <Action
              action="delete"
              variant="danger"
              label={t('delete')}
              fields={{ artefactId: artefact.id }}
            />
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
          [
            t('title'),
            { folded: t('slug') },
            { folded: t('deletedAt') },
            { folded: t('status') },
            t('actions'),
          ],
          artefacts.map((entry) => {
            const deletedAt = time(c.env.config.locale, entry.deletedAt)
            const status = t(entry.purging ? 'purging' : entry.restorable ? 'restorable' : 'expired')
            return (
              <tr>
                <td title={entry.title ?? undefined}>
                  <span>{entry.title}</span>
                  <Fold>
                    <code>{entry.slug}</code>
                  </Fold>
                  <Fold label={t('deletedAt')}>{deletedAt}</Fold>
                  <Fold>{status}</Fold>
                </td>
                <td class="forge-col--folded" title={entry.slug}>
                  <code>{entry.slug}</code>
                </td>
                <td class="forge-col--folded">{deletedAt}</td>
                <td class="forge-col--folded">{status}</td>
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
                    variant="danger"
                    label={t(entry.purging ? 'resumePurge' : 'purge')}
                    fields={{ id: entry.id, slug: entry.slug }}
                  />
                </td>
              </tr>
            )
          }),
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
        <Action action="create" variant="primary" label={t('createCredential')}>
          <label>
            {t('ownCredentialName')} <input name="name" required maxlength={maxNameLength} />
          </label>
        </Action>
        {table(
          [
            t('ownCredentialName'),
            t('ownCredentialPrefix'),
            { folded: t('lastUsed') },
            { folded: t('revokedAt') },
            t('actions'),
          ],
          tokens.map((token) => {
            const lastUsed = time(c.env.config.locale, token.lastUsedAt)
            const revoked = time(c.env.config.locale, token.revokedAt)
            return (
              <tr>
                <td title={token.name}>
                  <span>{token.name}</span>
                  <Fold label={t('lastUsed')}>{lastUsed}</Fold>
                  <Fold label={t('revokedAt')}>{revoked}</Fold>
                </td>
                <td title={token.prefix}>
                  <code>{token.prefix}</code>
                </td>
                <td class="forge-col--folded">{lastUsed}</td>
                <td class="forge-col--folded">{revoked}</td>
                <td>
                  {token.revokedAt === null && (
                    <Action action="revoke" label={t('revokeCredential')} fields={{ id: token.id }} />
                  )}
                </td>
              </tr>
            )
          }),
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
        <Action action="add" label={t('addRedirect')}>
          <label>
            {t('fromPrefix')}{' '}
            <input name="fromPrefix" required maxlength={maxRedirectPrefix} placeholder="/a/old/" />
          </label>
          <label>
            {t('toPrefix')}{' '}
            <input name="toPrefix" required maxlength={maxRedirectPrefix} placeholder="/a/new/" />
          </label>
        </Action>
        {table(
          [t('fromPrefix'), t('toPrefix'), t('actions')],
          redirects.map((entry) => (
            <tr>
              <td title={entry.fromPrefix}>
                <code>{entry.fromPrefix}</code>
              </td>
              <td title={entry.toPrefix}>
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

function connectSection(name: string, instructions: string, ...snippets: string[]) {
  return (
    <>
      <h2>{name}</h2>
      <p>{instructions}</p>
      {snippets.map((snippet) => (
        <pre>
          <code>{snippet}</code>
        </pre>
      ))}
    </>
  )
}

adminPages.get(
  '/connect',
  browser('viewer', async (c, session, _actor, t) => {
    const origin = c.env.config.manageOrigin
    const url = `${origin}/mcp`
    const omp = {
      type: 'http',
      url,
      oauth: {
        clientId: origin + localClientPath,
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
          {t('endpoint')} <code>{url}</code>
        </p>
        {connectSection('claude.ai', t('claudeAi'))}
        {connectSection('Claude Desktop', t('claudeDesktop'))}
        {connectSection('Claude Code', t('claudeCode'), `claude mcp add --transport http forge ${url}`)}
        {connectSection('Codex', t('codex'), `codex mcp add forge --url ${url}\ncodex mcp login forge`)}
        {connectSection('OMP', t('omp'), JSON.stringify({ mcpServers: { forge: omp } }, null, 2))}
        {connectSection(
          'Hermes',
          t('hermes'),
          `${variable}=…`,
          `mcp_servers:\n  forge:\n    url: ${JSON.stringify(url)}\n    headers:\n      Authorization: "Bearer \${${variable}}"`,
        )}
        <p>{t('verifyAgent')}</p>
      </>,
    )
  }),
)
