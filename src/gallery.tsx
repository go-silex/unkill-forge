import type { Child } from 'hono/jsx'
import { previewPrefix } from './core/gallery-previews'

export type GalleryView = 'grid' | 'list'

const views = ['grid', 'list'] as const

/** Reads the `view` query value; anything other than `list` keeps the default grid. */
export function galleryView(value: string | null | undefined): GalleryView {
  return value === 'list' ? 'list' : 'grid'
}

export function GalleryViews({
  path,
  params,
  view,
  labels,
}: {
  path: string
  params?: URLSearchParams
  view: GalleryView
  labels: Record<GalleryView | 'label', string>
}) {
  return (
    <nav class="forge-views" aria-label={labels.label}>
      {views.map((choice) => {
        const query = new URLSearchParams(params)
        query.delete('view')
        if (choice === 'list') query.set('view', 'list')
        const search = query.toString()
        return (
          <a href={search ? `${path}?${search}` : path} aria-current={choice === view ? 'page' : undefined}>
            {labels[choice]}
          </a>
        )
      })}
    </nav>
  )
}

export function Gallery({
  items,
  label,
  view = 'grid',
}: {
  items: readonly { href: string; title: string; preview?: string; detail?: Child }[]
  label: string
  view?: GalleryView
}) {
  const modifier = view === 'list' ? ' forge-gallery--list' : ''
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari removes unstyled lists from the accessibility tree.
    <ul class={`forge-gallery${modifier}`} role="list" aria-label={label}>
      {items.map(({ href, title, preview, detail }) => (
        <li class="forge-gallery__item" key={href}>
          <a class="forge-gallery__card" href={href}>
            {preview && (
              <img class="forge-gallery__preview" src={`${previewPrefix}${preview}`} alt="" loading="lazy" />
            )}
            <span class="forge-gallery__caption">
              <span class="forge-gallery__title">{title}</span>
            </span>
          </a>
          {detail != null && <div class="forge-gallery__detail">{detail}</div>}
        </li>
      ))}
    </ul>
  )
}
