import type { Child } from 'hono/jsx'
import { previewPrefix } from './core/gallery-previews'

export function Gallery({
  items,
  label,
}: {
  items: readonly { href: string; title: string; preview?: string; detail?: Child }[]
  label: string
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari removes unstyled lists from the accessibility tree.
    <ul class="forge-gallery" role="list" aria-label={label}>
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
