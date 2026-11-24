import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { unstable_readConfig } from 'wrangler'
import { inCoverageScope, inLengthScope, worktreePaths } from './source-scope.mjs'

const root = join(import.meta.dirname, '..')
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js')
const configNames = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']
const dataTypes = new Set([
  'application/json',
  'application/octet-stream',
  'application/source-map',
  'text/plain',
])

async function uploadParts(path, outdir) {
  const bytes = readFileSync(path)
  const boundary = /^--([^\r\n]+)\r\n/.exec(bytes.subarray(0, 256).toString())?.[1]
  if (!boundary) throw new Error('Wrangler did not produce a multipart upload inventory')
  const response = new Response(bytes, {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  })
  return new Map(
    [...(await response.formData())].flatMap(([name, part]) =>
      typeof part === 'string' ? [] : [[relative(outdir, resolve(outdir, name)), part]],
    ),
  )
}

let temporary

try {
  const configs = configNames.filter((name) => lstatSync(join(root, name), { throwIfNoEntry: false }))
  if (configs.length !== 1) {
    throw new Error(`expected exactly one root Wrangler config; found ${configs.join(', ') || 'none'}`)
  }
  // Use the same cwd and default config discovery as the deployment script.
  process.chdir(root)
  const config = unstable_readConfig({})
  if (!config.main) throw new Error('Wrangler has no Worker entry point')
  temporary = mkdtempSync(join(tmpdir(), 'forge-worker-scope-'))
  const outdir = join(temporary, 'out')
  const metafile = join(temporary, 'meta.json')
  const outfile = join(temporary, 'upload')
  const result = spawnSync(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--outdir', outdir, '--metafile', metafile, '--outfile', outfile],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || 'Wrangler dry run failed')
  }
  const { inputs, outputs } = JSON.parse(readFileSync(metafile, 'utf8'))
  if (!Object.keys(inputs).length || !Object.keys(outputs).length) {
    throw new Error('Wrangler metafile did not contain a Worker bundle')
  }
  const bundled = new Set(Object.keys(inputs).map((path) => relative(root, resolve(root, path))))
  const generated = new Set(Object.keys(outputs).map((path) => relative(outdir, resolve(root, path))))
  const parts = await uploadParts(outfile, outdir)
  const emitted = new Set([
    ...readdirSync(outdir, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(outdir, join(entry.parentPath, entry.name))),
    ...parts.keys(),
  ])
  const moduleRoot = config.base_dir ?? dirname(config.main)
  const attachedCode = new Set()
  for (const path of emitted) {
    if (path === '..' || path.startsWith('../')) {
      throw new Error(`Wrangler emitted a module outside its output directory: ${path}`)
    }
    if (generated.has(path) || (path === 'README.md' && !parts.has(path))) continue
    // Wrangler can attach a module without esbuild visiting it. Use the native
    // upload MIME type so an executable can't opt out by using a data extension.
    if (dataTypes.has(parts.get(path)?.type)) continue
    const origin = resolve(moduleRoot, path)
    if (
      !lstatSync(origin, { throwIfNoEntry: false })?.isFile() ||
      !readFileSync(origin).equals(readFileSync(join(outdir, path)))
    ) {
      throw new Error(`cannot identify the first-party source for emitted module ${path}`)
    }
    const source = relative(root, origin)
    attachedCode.add(source)
    bundled.add(source)
  }
  const paths = worktreePaths()
  const knip = JSON.parse(readFileSync(join(root, 'knip.jsonc'), 'utf8'))
  const omitted = [...bundled]
    .filter((path) => !path.startsWith('node_modules/'))
    .filter(
      (path) =>
        !paths.has(path) ||
        !lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile() ||
        ((attachedCode.has(path) || !path.endsWith('.json')) &&
          (!inLengthScope(path) ||
            !inCoverageScope(path) ||
            !knip.project.some((pattern) => matchesGlob(path, pattern)) ||
            knip.ignore?.some((pattern) => matchesGlob(path, pattern)))),
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
  process.exitCode = 1
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}
