import { Hono } from 'hono'
import type { Config } from '../config'

export const read = new Hono<{ Bindings: Config }>()
read.get('/', (c) =>
  c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{c.env.name}</title>
      </head>
      <body>
        <main>
          <h1>{c.env.name}</h1>
        </main>
      </body>
    </html>,
  ),
)
