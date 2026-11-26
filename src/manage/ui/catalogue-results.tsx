import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'
import type { Config } from '../../config'
import type { CatalogueEntry } from '../../core/catalogue'
import { previewPrefix } from '../../core/gallery-previews'
import { time } from '../../dates'
import { Gallery, type GalleryView } from '../../gallery'
import type { AdminTranslate } from '../../i18n'
import { TagChips } from '../../tag-chips'
import { catalogueScrollScript } from './catalogue-scroll'
import { AccessBadge, Fold, Table } from './page'

export function CatalogueResults({
  artefacts,
  previews,
  config,
  t,
  view,
  next,
  empty,
}: {
  artefacts: readonly CatalogueEntry[]
  previews: ReadonlySet<string>
  config: Config
  t: AdminTranslate
  view: GalleryView
  next: Child
  empty: string
}) {
  const entries = artefacts.map((entry) => ({
    ...entry,
    href: `/artefacts/${entry.slug}`,
    title: entry.title.trim() || entry.slug,
    preview: previews.has(entry.slug) ? `${previewPrefix}${entry.slug}` : undefined,
    updated: time(config, entry.updatedAt),
    badge: <AccessBadge access={entry.access} label={t(entry.access)} />,
  }))
  return (
    <div data-catalogue-feed={view}>
      <div data-catalogue-results="" tabindex={-1}>
        {!entries.length ? (
          <p class="forge-empty">{empty}</p>
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
            {entries.map(({ id, href, slug, title, preview, updated, badge, revision, tags }) => (
              <tr data-artefact-id={id}>
                <td title={title}>
                  <a class="forge-catalogue-link" href={href}>
                    {preview && <img class="forge-thumb" src={preview} alt="" loading="lazy" />}
                    <span>{title}</span>
                  </a>
                  <TagChips tags={tags} />
                  <Fold>
                    <code>{slug}</code>
                  </Fold>
                  <Fold>
                    <span class="forge-catalogue-meta">
                      <span>
                        {updated} · v{revision}
                      </span>
                      {badge}
                    </span>
                  </Fold>
                </td>
                <td class="forge-col--folded" title={slug}>
                  <code>{slug}</code>
                </td>
                <td class="forge-col--folded">{badge}</td>
                <td class="forge-col--folded">v{revision}</td>
                <td class="forge-col--folded">{updated}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Gallery
            label={t('artefacts')}
            items={entries.map(({ id, href, slug, title, preview, updated, badge, revision, tags }) => ({
              artefactId: id,
              href,
              title,
              preview: preview ? slug : undefined,
              detail: (
                <>
                  <code class="forge-catalogue-slug">{slug}</code>
                  <span class="forge-catalogue-meta">
                    <span>
                      {updated} · v{revision}
                    </span>
                    {badge}
                  </span>
                  <TagChips tags={tags} />
                </>
              ),
            }))}
          />
        )}
      </div>
      {next}
      {next && <script>{raw(catalogueScrollScript)}</script>}
    </div>
  )
}
