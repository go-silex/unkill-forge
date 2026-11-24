import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, matchesGlob } from 'node:path'
import { unstable_readConfig } from 'wrangler'
import { inCoverageScope, inLengthScope, worktreePaths } from './source-scope.mjs'

const root = join(import.meta.dirname, '..')
// Resolve Wrangler's esbuild explicitly; the version hoisted by npm may belong to Vite.
const { build } = createRequire(import.meta.resolve('wrangler'))('esbuild')

try {
  const { main, tsconfig } = unstable_readConfig({ config: join(root, 'wrangler.jsonc') })
  if (!main) throw new Error('Wrangler has no Worker entry point')
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: [main],
    tsconfig,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'],
    logLevel: 'silent',
  })
  const paths = worktreePaths()
  const knip = JSON.parse(readFileSync(join(root, 'knip.jsonc'), 'utf8'))
  const omitted = Object.keys(metafile.inputs)
    .filter((path) => !path.startsWith('node_modules/'))
    .filter(
      (path) =>
        !paths.has(path) ||
        !lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile() ||
        !inLengthScope(path) ||
        !inCoverageScope(path) ||
        !knip.project.some((pattern) => matchesGlob(path, pattern)) ||
        knip.ignore?.some((pattern) => matchesGlob(path, pattern)),
    )
    .sort()
  if (omitted.length) {
    for (const path of omitted) {
      console.error(`check-worker-scope: ${path} is bundled but outside file-length, coverage or Knip scope`)
    }
    process.exitCode = 1
  } else {
    console.log('check-worker-scope: all bundled first-party inputs are in scope')
  }
} catch (error) {
  console.error(`check-worker-scope: ${error.message}`)
  process.exit(1)
}
