export function DocumentHead({ title }: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="icon" href="/favicon.svg" />
      <link rel="stylesheet" href="/style.css" />
    </head>
  )
}
