import { brandMark } from './brand'
import type { Config } from './config'

export function BrandBlock({ config, variant }: { config: Config; variant?: 'heading' | 'home-link' }) {
  const content = (
    <>
      <img class="forge-brand__logo" src={brandMark(config, 'logo')} alt="" />
      {config.brand.label ?? config.name}
    </>
  )
  if (variant === 'heading') return <h1 class="forge-brand forge-title">{content}</h1>
  if (variant === 'home-link')
    return (
      <a class="forge-brand" href="/">
        {content}
      </a>
    )
  return <div class="forge-brand">{content}</div>
}
