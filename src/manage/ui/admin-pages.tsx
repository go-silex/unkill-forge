import { Hono } from 'hono'
import type { Child } from 'hono/jsx'
import { z } from 'zod'
import type { Runtime } from '../../config'
import { createOwnToken, listOwnTokens, revokeOwnToken, uiActor } from '../../core/admin'
import {
  AccessConfirmationError,
  ArtefactError,
  createShareLink,
  deleteArtefact,
  deletedRetentionMs,
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
  setAccess,
  setRedirects,
  setVisibility,
} from '../../core/artefacts'
import { catalogueCounts, searchArtefacts } from '../../core/catalogue'
import { galleryPreviewSlugs, previewPrefix } from '../../core/gallery-previews'
import type { BrowserSession, Member, Role } from '../../core/index'
import { purgeArtefact } from '../../core/purge'
import { artefactPath, maxRedirectPrefix } from '../../core/read-path'
import { shareKeyMax } from '../../core/share-keys'
import { absoluteTime, time } from '../../dates'
import { Gallery, GalleryViews, galleryView } from '../../gallery'
import { readForm } from '../../http'
import { type AdminMessage, type AdminTranslate, adminMessages, type CopyLabels, messages } from '../../i18n'
import { manageError } from '../access'
import { requireBrowserSession } from '../login'
import { localClientPath } from '../oauth'
import {
  AccessBadge,
  Action,
  Badge,
  CopyField,
  Fold,
  flash,
  Notice,
  page,
  pageLink,
  Table,
  type TableColumn,
  type UiContext,
} from './page'

export const adminPages = new Hono<{ Bindings: Runtime }>({
  getPath: (request) => new URL(request.url).pathname,
})

const cataloguePath = '/artefacts'
const deletedPath = '/admin/deleted'
const tokensPath = '/tokens'
const redirectsPath = '/admin/redirects'
const detailPath = (slug: string) => `${cataloguePath}/${slug}`
const connectPath = '/connect'
const hourMs = 60 * 60 * 1_000
const dayMs = 24 * hourMs

const id = z.uuid()
const slug = z
  .string()
  .max(64)
  .refine((value) => artefactPath(`/a/${value}`)?.slug === value)
const visibility = z.enum(['private', 'public'])
const access = z.enum(['private', 'shared', 'public'])
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.int().positive())
const prefix = z.string().max(maxRedirectPrefix)
const maxNameLength = 120
const maxShareLabelLength = 200
const confirmedCount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number)
  .pipe(z.int().nonnegative())
const artefactAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('visibility'), visibility, artefactId: id }),
  z
    .strictObject({ action: z.literal('access'), access, artefactId: id, revoke: confirmedCount.optional() })
    .refine(({ access, revoke }) => access === 'private' || revoke === undefined),
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
    // Pending members land on the Manage home, which explains that approval is required.
    if (session.member.status === 'pending' && c.req.method === 'GET') return c.redirect('/', 303)
    try {
      const actor = await uiActor(c.env.env.DB, session.member.id, minimum)
      return await handler(c, { ...session, member: actor }, actor, t)
    } catch (error) {
      if (!(error instanceof ArtefactError)) throw error
      const status =
        error.code === 'forbidden'
          ? 403
          : error.code === 'not_found'
            ? 404
            : error.code === 'conflict'
              ? 409
              : 400
      return manageError(c.env.config, status, t(error.code), { home: '/artefacts' })
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
  if (!form) return manageError(c.env.config, 400, t('malformed'), { home: '/artefacts' })
  const parsed = schema.safeParse(Object.fromEntries(form))
  if (!parsed.success) return manageError(c.env.config, 400, t('malformed'), { home: '/artefacts' })
  let result: ActionResult
  try {
    result = await run(parsed.data)
  } catch (error) {
    if (error instanceof AccessConfirmationError)
      return flash(c, session, path, messages(c.env.config).detail.revokeCountChanged(error.activeLinks))
    if (!(error instanceof ArtefactError) || error.code === 'forbidden') throw error
    result = { message: error.code, path: error.code === 'not_found' ? missingPath : path }
  }
  return flash(c, session, result.path ?? path, t(result.message), result.secret)
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
    const filter = access.safeParse(rawVisibility)
    if (rawVisibility && !filter.success)
      return manageError(c.env.config, 400, t('malformed'), { home: '/artefacts' })
    const selected = filter.data
    const cursor = c.req.query('cursor')
    const [{ artefacts, nextCursor }, counts] = await Promise.all([
      searchArtefacts(c.env, actor, q, selected, cursor),
      catalogueCounts(c.env, actor),
    ])
    const previews = await galleryPreviewSlugs(
      c.env,
      artefacts.map((entry) => entry.slug),
      'member',
    )
    const rawView = c.req.query('view')
    const view = galleryView(rawView)
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (selected) params.set('visibility', selected)
    if (rawView === view) params.set('view', view)
    const { config } = c.env
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
            {selected && <input type="hidden" name="visibility" value={selected} />}
            {rawView === view && <input type="hidden" name="view" value={view} />}
            <button class="forge-button forge-button--primary" type="submit">
              {t('search')}
            </button>
          </form>
        </div>
        <div class="forge-toolbar">
          <nav class="forge-filters" aria-label={t('visibility')}>
            {(['all', ...access.options] as const).map((choice) => {
              const query = new URLSearchParams(params)
              if (choice === 'all') query.delete('visibility')
              else query.set('visibility', choice)
              return (
                <a
                  class="forge-filters__link"
                  href={query.size ? `${cataloguePath}?${query}` : cataloguePath}
                  aria-current={choice === (selected ?? 'all') ? 'page' : undefined}
                >
                  {t(choice)}
                  {counts && (
                    <>
                      {' '}
                      <span class="forge-filters__count">{counts[choice]}</span>
                    </>
                  )}
                </a>
              )
            })}
          </nav>
          <GalleryViews path={cataloguePath} params={params} view={view} labels={messages(config).views} />
        </div>
        {artefacts.length === 0 ? (
          <p class="forge-empty">{t(nextCursor ? 'noNewMatches' : cursor ? 'noMoreResults' : 'noResults')}</p>
        ) : view === 'list' ? (
          <Table
            columns={[
              t('title'),
              { folded: t('slug') },
              { folded: t('visibility') },
              { folded: t('revision') },
              { folded: t('updated') },
            ]}
          >
            {artefacts.map((entry) => {
              const label = entry.title.trim() || entry.slug
              const updated = time(config, entry.updatedAt)
              const badge = <AccessBadge access={entry.access} label={t(entry.access)} />
              return (
                <tr>
                  <td title={label}>
                    <a class="forge-catalogue-link" href={detailPath(entry.slug)}>
                      {previews.has(entry.slug) && (
                        <img
                          class="forge-thumb"
                          src={`${previewPrefix}${entry.slug}`}
                          alt=""
                          loading="lazy"
                        />
                      )}
                      <span>{label}</span>
                    </a>
                    <Fold>
                      <code>{entry.slug}</code>
                    </Fold>
                    <Fold>
                      <span class="forge-catalogue-meta">
                        <span>
                          {updated} · v{entry.revision}
                        </span>
                        {badge}
                      </span>
                    </Fold>
                  </td>
                  <td class="forge-col--folded" title={entry.slug}>
                    <code>{entry.slug}</code>
                  </td>
                  <td class="forge-col--folded">{badge}</td>
                  <td class="forge-col--folded">v{entry.revision}</td>
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
              title: entry.title.trim() || entry.slug,
              preview: previews.has(entry.slug) ? entry.slug : undefined,
              detail: (
                <>
                  <code class="forge-catalogue-slug">{entry.slug}</code>
                  <span class="forge-catalogue-meta">
                    <span>
                      {time(config, entry.updatedAt)} · v{entry.revision}
                    </span>
                    <AccessBadge access={entry.access} label={t(entry.access)} />
                  </span>
                </>
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
    if (!slugValue.success) return manageError(c.env.config, 404, t('not_found'), { home: '/artefacts' })
    const currentSlug = slugValue.data
    const path = detailPath(currentSlug)
    const fileCursor = c.req.query('files')
    const revisionCursor = c.req.query('revisions')
    const artefact = await getArtefactDetails(c.env, actor, currentSlug, fileCursor)
    const [history, previews] = await Promise.all([
      listRevisions(c.env, actor, currentSlug, revisionCursor, artefact.id),
      galleryPreviewSlugs(c.env, [currentSlug], 'member'),
    ])
    const canWrite = actor.role !== 'viewer'
    const { config } = c.env
    const copyLabels = messages(config)
    const { confirmation, detail: labels } = copyLabels
    const count = artefact.shareLinks.length
    const currentAccess = artefact.visibility === 'public' ? 'public' : count ? 'shared' : 'private'
    const params = new URLSearchParams()
    if (fileCursor) params.set('files', fileCursor)
    if (revisionCursor) params.set('revisions', revisionCursor)
    const readBase = `${config.readOrigin}/a/${currentSlug}/`
    return page(
      c,
      session,
      artefact.title,
      <>
        <div class="forge-detail__meta">
          <AccessBadge access={currentAccess} label={t(currentAccess)} />
          <span>
            v{artefact.revision}
            {artefact.revisionMeta && (
              <>
                {' '}
                {labels.by} {artefact.revisionMeta.author} · {time(config, artefact.revisionMeta.createdAt)}
              </>
            )}
          </span>
          <span>
            {t('updated')} {time(config, artefact.updatedAt)}
          </span>
          {artefact.revisionMeta && (
            <span>
              {labels.fileCount(
                artefact.revisionMeta.fileCount === 201 ? '200+' : artefact.revisionMeta.fileCount,
              )}
            </span>
          )}
        </div>
        <div class="forge-detail__actions">
          <a class="forge-button forge-button--primary" href={artefact.url}>
            {t('open')}
          </a>
          <CopyField value={artefact.url} labels={{ ...copyLabels, copy: labels.copyAddress }} />
        </div>
        <div class="forge-detail">
          <div class="forge-detail__main">
            {previews.has(currentSlug) && (
              <img
                class="forge-detail__preview"
                src={`${previewPrefix}${currentSlug}`}
                alt=""
                width="1600"
                height="900"
                decoding="async"
              />
            )}
            <h2>{t('files')}</h2>
            {table(
              [t('file'), { secondary: t('type') }, t('size')],
              artefact.files.map((file) => (
                <tr>
                  <td title={file.path}>
                    <a href={readBase + encodeFilePath(file.path)}>
                      <code>{file.path}</code>
                    </a>
                    {file.path === artefact.entryPath && (
                      <>
                        {' '}
                        <Badge variant="entry">{labels.entryPage}</Badge>
                      </>
                    )}
                  </td>
                  <td class="forge-col--secondary" title={file.type}>
                    {file.type}
                  </td>
                  <td>{file.size}</td>
                </tr>
              )),
              t,
            )}
            {nextPage(path, artefact.nextCursor, t('nextFiles'), params, 'files')}
            <h2>{t('revisions')}</h2>
            {history.revisions.length ? (
              // biome-ignore lint/a11y/noRedundantRoles: Safari removes unstyled lists from the accessibility tree.
              <ol class="forge-versions" role="list">
                {history.revisions.map((entry) => {
                  const isCurrent = entry.number === artefact.revision
                  const message = entry.message
                  return (
                    <li class="forge-version">
                      <div>
                        <strong>{labels.version(entry.number)}</strong>
                        {isCurrent && (
                          <>
                            {' '}
                            <Badge variant="current">{t('currentRevision')}</Badge>
                          </>
                        )}
                        {message &&
                          (message.length > 160 ? (
                            <>
                              <p>{message.slice(0, 160).toWellFormed()}…</p>
                              <details>
                                <summary>{labels.fullMessage}</summary>
                                <p>{message}</p>
                              </details>
                            </>
                          ) : (
                            <p>{message}</p>
                          ))}
                        <p class="forge-detail__meta">
                          {time(config, entry.createdAt)} · {entry.author}
                        </p>
                      </div>
                      {canWrite && !isCurrent && (
                        <Action
                          action="restore-revision"
                          label={t('restoreRevision')}
                          fields={{ revision: entry.number, artefactId: artefact.id }}
                        />
                      )}
                    </li>
                  )
                })}
              </ol>
            ) : (
              <p class="forge-empty">{t('noResults')}</p>
            )}
            {nextPage(path, history.nextCursor, t('nextRevisions'), params, 'revisions')}
          </div>
          {canWrite && (
            <aside class="forge-detail__aside" aria-label={labels.settings}>
              <section class="forge-panel-card">
                <h2>{labels.access}</h2>
                <div class="forge-access">
                  <Action
                    action="access"
                    label={labels.save}
                    variant="primary"
                    fields={{ artefactId: artefact.id }}
                  >
                    <fieldset class="forge-access__options" aria-label={labels.access}>
                      {access.options.map((option) => (
                        <label>
                          <input
                            type="radio"
                            name="access"
                            value={option}
                            checked={option === currentAccess}
                          />
                          <span>
                            <strong>{t(option)}</strong>
                            <small>{labels.accessHelp[option]}</small>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  </Action>
                  {count > 0 && (
                    <Action
                      action="access"
                      label={labels.save}
                      variant="danger"
                      fields={{ access: 'private', revoke: count, artefactId: artefact.id }}
                      confirm={{
                        title: labels.privateTitle,
                        body: labels.privateBody(count),
                        label: labels.privateConfirm,
                        cancel: confirmation.cancel,
                      }}
                    />
                  )}
                </div>
              </section>
              <section class="forge-panel-card">
                <h2>{t('shareLinks')}</h2>
                <p>{t('shareWarning')}</p>
                {count ? (
                  // biome-ignore lint/a11y/noRedundantRoles: Safari removes unstyled lists from the accessibility tree.
                  <ul class="forge-share-links" role="list">
                    {artefact.shareLinks.map((share) => {
                      const label = share.label || t('unlabeled')
                      return (
                        <li>
                          <strong>{label}</strong>
                          <p class="forge-detail__meta">
                            {t('created')} {time(config, share.createdAt)}
                            {share.creator && (
                              <>
                                {' '}
                                {labels.by} {share.creator}
                              </>
                            )}
                          </p>
                          <p class="forge-detail__meta">
                            <span aria-hidden="true">•••• · </span>
                            {labels.maskedLink}
                          </p>
                          <div class="forge-detail__actions">
                            <Action action="reveal-share" label={t('showShare')} fields={{ id: share.id }} />
                            <Action
                              action="revoke-share"
                              label={t('revokeShare')}
                              fields={{ id: share.id }}
                              confirm={{
                                title: labels.revokeTitle(label),
                                body: labels.revokeBody,
                                label: t('revokeShare'),
                                cancel: confirmation.cancel,
                              }}
                            />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p class="forge-empty">{labels.emptyShares}</p>
                )}
                <details>
                  <summary>{labels.addLink}</summary>
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
                </details>
              </section>
              <section class="forge-panel-card">
                <h2>{t('rename')}</h2>
                <p>{labels.renameHint}</p>
                <Action action="rename" label={t('rename')} fields={{ artefactId: artefact.id }}>
                  <label>
                    {t('newSlug')} <input name="slug" required maxlength={64} />
                  </label>
                </Action>
              </section>
              <section class="forge-panel-card">
                <h2>{t('delete')}</h2>
                <p>{t('deleteHelp')}</p>
                <Action
                  action="delete"
                  variant="danger"
                  label={t('delete')}
                  fields={{ artefactId: artefact.id }}
                  confirm={{
                    title: confirmation.deleteTitle(artefact.title.trim() || artefact.slug),
                    body: confirmation.deleteBody(deletedRetentionMs / (24 * 60 * 60 * 1_000)),
                    label: confirmation.deleteLabel,
                    cancel: confirmation.cancel,
                  }}
                />
              </section>
            </aside>
          )}
        </div>
      </>,
      {
        beforeTitle: (
          <nav class="forge-breadcrumb" aria-label={labels.breadcrumb}>
            <a href={cataloguePath}>{t('artefacts')}</a>
            <span aria-hidden="true"> › </span>
            <span aria-current="page">{currentSlug}</span>
          </nav>
        ),
      },
    )
  }),
)

adminPages.post(
  '/artefacts/:slug',
  browser('publisher', async (c, session, actor, t) => {
    const slugValue = slug.safeParse(c.req.param('slug'))
    if (!slugValue.success) return manageError(c.env.config, 400, t('malformed'), { home: '/artefacts' })
    const currentSlug = slugValue.data
    return runAction(
      c,
      session,
      t,
      detailPath(currentSlug),
      artefactAction,
      async (input) => {
        switch (input.action) {
          case 'access': {
            const { url } = await setAccess(
              c.env,
              actor,
              currentSlug,
              input.access,
              input.artefactId,
              input.revoke,
            )
            return { message: url ? 'shareCreated' : 'accessSaved', secret: url }
          }
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
    const now = Date.now()
    const cursor = c.req.query('cursor')
    const actionPath = cursor ? `${deletedPath}?${new URLSearchParams({ cursor })}` : deletedPath
    const { artefacts, nextCursor } = await listDeletedArtefacts(c.env, actor, cursor, now)
    const { adminSheets, confirmation } = messages(c.env.config)
    return page(
      c,
      session,
      t('deleted'),
      <>
        {table(
          [t('title'), { folded: t('deletedAt') }, { folded: t('status') }, t('actions')],
          artefacts.map((entry) => {
            const deletedAt = time(c.env.config, entry.deletedAt)
            const title = entry.title?.trim()
            const deadline = entry.deletedAt === null ? null : entry.deletedAt + deletedRetentionMs
            const remaining = deadline === null ? 0 : deadline - now
            const unit = remaining >= dayMs ? 'day' : 'hour'
            const quantity = Math.floor(remaining / (unit === 'day' ? dayMs : hourMs))
            const status = (
              <>
                <Badge variant={entry.purging ? 'warn' : entry.restorable ? 'ok' : 'muted'}>
                  {t(entry.purging ? 'purging' : entry.restorable ? 'restorable' : 'expired')}
                </Badge>
                {entry.restorable && (
                  <small class="forge-admin-meta" title={absoluteTime(c.env.config, deadline)}>
                    {adminSheets.restoreWindow(quantity, unit)}
                  </small>
                )}
              </>
            )
            return (
              <tr>
                <td title={title || entry.slug}>
                  {title && <strong>{title}</strong>}
                  <code class="forge-admin-meta">{entry.slug}</code>
                  <Fold label={t('deletedAt')}>{deletedAt}</Fold>
                  <Fold>{status}</Fold>
                </td>
                <td class="forge-col--folded">{deletedAt}</td>
                <td class="forge-col--folded">{status}</td>
                <td>
                  <div class="forge-row-actions">
                    {entry.restorable && (
                      <Action
                        path={actionPath}
                        action="restore"
                        label={t('restoreDeleted')}
                        fields={{ slug: entry.slug, artefactId: entry.id }}
                      />
                    )}
                    <Action
                      path={actionPath}
                      action="purge"
                      variant="danger"
                      label={t(entry.purging ? 'resumePurge' : 'purge')}
                      fields={{ id: entry.id, slug: entry.slug }}
                      confirm={
                        entry.purging
                          ? undefined
                          : {
                              title: confirmation.purgeTitle(entry.title?.trim() || entry.slug),
                              body: confirmation.purgeBody,
                              label: confirmation.purgeLabel,
                              cancel: confirmation.cancel,
                            }
                      }
                    />
                  </div>
                </td>
              </tr>
            )
          }),
          t,
        )}
        {nextPage(deletedPath, nextCursor, t('next'))}
      </>,
      { lead: t('purgeHelp') },
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
    const cursor = c.req.query('cursor')
    const actionPath = cursor ? `${tokensPath}?${new URLSearchParams({ cursor })}` : tokensPath
    const { tokens, nextCursor } = await listOwnTokens(c.env.env.DB, actor.id, cursor)
    const { adminSheets, confirmation, legacy } = messages(c.env.config)
    return page(
      c,
      session,
      t('tokens'),
      <>
        <p class="forge-admin-meta">
          {t('connectHint')} <a href={connectPath}>{t('connect')}</a>
        </p>
        {tokens.length ? (
          <Table
            columns={[
              t('ownCredentialName'),
              { folded: t('ownCredentialPrefix') },
              { folded: t('created') },
              { folded: t('lastUsed') },
              { folded: t('status') },
              t('actions'),
            ]}
          >
            {tokens.map((token) => {
              const prefix = <code>{token.prefix}…</code>
              const created = time(c.env.config, token.createdAt)
              const lastUsed =
                token.lastUsedAt === null ? t('neverUsed') : time(c.env.config, token.lastUsedAt)
              const active = token.revokedAt === null
              const status = (
                <>
                  <Badge variant={active ? 'ok' : 'muted'}>{active ? legacy.active : legacy.revoked}</Badge>
                  {!active && (
                    <small class="forge-admin-meta">
                      {t('revokedOn')} {time(c.env.config, token.revokedAt)}
                    </small>
                  )}
                </>
              )
              return (
                <tr key={token.id}>
                  <td title={token.name}>
                    <strong>{token.name}</strong>
                    <Fold>{prefix}</Fold>
                    <Fold label={t('created')}>{created}</Fold>
                    <Fold label={t('lastUsed')}>{lastUsed}</Fold>
                    <Fold>{status}</Fold>
                  </td>
                  <td class="forge-col--folded">{prefix}</td>
                  <td class="forge-col--folded">{created}</td>
                  <td class="forge-col--folded">{lastUsed}</td>
                  <td class="forge-col--folded">{status}</td>
                  <td>
                    {active && (
                      <div class="forge-row-actions">
                        <Action
                          path={actionPath}
                          action="revoke"
                          variant="danger"
                          label={t('revokeCredential')}
                          fields={{ id: token.id }}
                          confirm={{
                            title: adminSheets.revokeTokenTitle(token.name),
                            body: adminSheets.revokeTokenBody,
                            label: t('revokeCredential'),
                            cancel: confirmation.cancel,
                          }}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </Table>
        ) : (
          <p class="forge-empty">{t('noOwnCredentials')}</p>
        )}
        {nextPage(tokensPath, nextCursor, t('next'))}
      </>,
      {
        lead: t('ownCredentialHelp'),
        actions: (
          <Action
            path={actionPath}
            action="create"
            variant="primary"
            label={t('createCredential')}
            sheet={{
              title: t('createCredential'),
              label: t('createCredential'),
              cancel: confirmation.cancel,
            }}
          >
            <label>
              {t('ownCredentialName')} <input name="name" required maxlength={maxNameLength} />
            </label>
          </Action>
        ),
      },
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
    const cursor = c.req.query('cursor')
    const actionPath = cursor ? `${redirectsPath}?${new URLSearchParams({ cursor })}` : redirectsPath
    const { redirects, nextCursor } = await listRedirects(c.env, actor, cursor)
    const { adminSheets, confirmation } = messages(c.env.config)
    return page(
      c,
      session,
      t('redirects'),
      <div class="forge-admin-split">
        <aside class="forge-admin-panel forge-admin-panel--first" aria-labelledby="new-redirect">
          <h2 id="new-redirect">{t('newRedirect')}</h2>
          <Action action="add" variant="primary" label={t('addRedirect')}>
            <div>
              <label>
                {t('fromPrefix')}
                <input
                  name="fromPrefix"
                  required
                  maxlength={maxRedirectPrefix}
                  placeholder="/a/old/"
                  aria-describedby="redirect-from-hint"
                />
              </label>
              <small class="forge-admin-meta" id="redirect-from-hint">
                {t('redirectFromHint')}
              </small>
            </div>
            <div>
              <label>
                {t('toPrefix')}
                <input
                  name="toPrefix"
                  required
                  maxlength={maxRedirectPrefix}
                  placeholder="/a/new/"
                  aria-describedby="redirect-to-hint"
                />
              </label>
              <small class="forge-admin-meta" id="redirect-to-hint">
                {t('redirectToHint')}
              </small>
            </div>
          </Action>
        </aside>
        <section aria-label={t('redirects')}>
          {redirects.length ? (
            <Table columns={[t('redirectRoute'), { folded: t('createdBy') }, t('actions')]}>
              {redirects.map((entry) => {
                const creator = (
                  <>
                    {entry.creatorName && <>{entry.creatorName} · </>}
                    {time(c.env.config, entry.createdAt)}
                  </>
                )
                return (
                  <tr key={entry.fromPrefix}>
                    <td>
                      <div class="forge-redirect-route">
                        <code>{entry.fromPrefix}</code>
                        <span aria-hidden="true">→</span>
                        <span class="forge-sr-only">{t('redirectTo')}</span>
                        <code>{entry.toPrefix}</code>
                      </div>
                      <Fold label={t('createdBy')}>{creator}</Fold>
                    </td>
                    <td class="forge-col--folded">{creator}</td>
                    <td>
                      <div class="forge-row-actions">
                        <Action
                          action="remove"
                          path={actionPath}
                          variant="danger"
                          label={t('removeRedirect')}
                          fields={{ fromPrefix: entry.fromPrefix }}
                          confirm={{
                            title: adminSheets.removeRedirectTitle(entry.fromPrefix),
                            body: adminSheets.removeRedirectBody,
                            label: t('removeRedirect'),
                            cancel: confirmation.cancel,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </Table>
          ) : (
            <p class="forge-empty">{t('noRedirects')}</p>
          )}
          {nextPage(redirectsPath, nextCursor, t('next'))}
        </section>
      </div>,
      { lead: t('redirectHelp') },
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

function ConnectClient({
  labels,
  name,
  kind,
  steps,
  open,
}: {
  labels: CopyLabels
  name: string
  kind: string
  steps: readonly (readonly [instruction: string, snippet?: string])[]
  open?: boolean
}) {
  return (
    <details class="forge-connect-client" name="forge-client" open={open}>
      <summary>
        {name} <small>{kind}</small>
      </summary>
      <ol class="forge-steps">
        {steps.map(([instruction, snippet]) => (
          <li>
            {instruction}
            {snippet && <CopyField value={snippet} labels={labels} block />}
          </li>
        ))}
      </ol>
    </details>
  )
}

adminPages.get(
  connectPath,
  browser('viewer', async (c, session, _actor, t) => {
    const origin = c.env.config.manageOrigin
    const labels = messages(c.env.config)
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
        <section class="forge-connect-endpoint" aria-labelledby="connect-endpoint">
          <h2 id="connect-endpoint">{t('endpoint')}</h2>
          <CopyField value={url} labels={labels} />
          <p>{t('endpointNote')}</p>
        </section>
        <section aria-labelledby="connect-clients">
          <h2 id="connect-clients">{t('yourClient')}</h2>
          <ConnectClient
            labels={labels}
            name="claude.ai"
            kind={t('clientWeb')}
            steps={[[t('claudeAiIndividual')], [t('claudeAiTeam')], [t('claudeAiAuthorize')]]}
          />
          <ConnectClient
            labels={labels}
            name="Claude Desktop"
            kind={t('clientDesktop')}
            steps={[[t('claudeDesktop')]]}
          />
          <ConnectClient
            labels={labels}
            name="Claude Code"
            kind={t('clientTerminal')}
            steps={[
              [t('claudeCodeRun'), `claude mcp add --transport http forge ${url}`],
              [t('claudeCodeAuthorize')],
            ]}
            open
          />
          <ConnectClient
            labels={labels}
            name="Codex"
            kind={t('clientTerminal')}
            steps={[[t('codex'), `codex mcp add forge --url ${url}\ncodex mcp login forge`]]}
          />
          <ConnectClient
            labels={labels}
            name="OMP"
            kind={t('clientTerminal')}
            steps={[
              [t('ompConfig'), JSON.stringify({ mcpServers: { forge: omp } }, null, 2)],
              [t('ompReload')],
              [t('ompAuthorize')],
            ]}
          />
          <ConnectClient
            labels={labels}
            name="Hermes"
            kind={t('clientRobot')}
            steps={[
              [t('hermesCredentials')],
              [t('hermesEnv'), `${variable}=…`],
              [
                t('hermesConfig'),
                `mcp_servers:\n  forge:\n    url: ${JSON.stringify(url)}\n    headers:\n      Authorization: "Bearer \${${variable}}"`,
              ],
            ]}
          />
        </section>
        <Notice config={c.env.config} tone="info" title={t('verifyConnection')}>
          <p>{t('verifyAgent')}</p>
        </Notice>
      </>,
    )
  }),
)
