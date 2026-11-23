import { brandMark, themeStylesheet } from './brand'
import type { Config } from './config'

export function DocumentHead({ title, config }: { title: string; config: Config }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="icon" href={brandMark(config, 'favicon')} />
      <link rel="stylesheet" href="/style.css" />
      {config.theme && <link rel="stylesheet" href={themeStylesheet} />}
    </head>
  )
}
