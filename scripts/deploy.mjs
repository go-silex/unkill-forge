import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--config' || !args[1])) {
  console.error('Usage: npm run deploy -- [--config <path>]')
  process.exit(2)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js')
const copy = args[1] && join(root, `.wrangler-deploy-${process.pid}.jsonc`)
if (copy) writeFileSync(copy, readFileSync(args[1]), { mode: 0o600, flag: 'wx' })

try {
  for (const command of [
    ['d1', 'migrations', 'apply', 'DB', '--remote'],
    ['d1', 'migrations', 'list', 'DB', '--remote'],
    ['deploy'],
  ]) {
    const listing = command[2] === 'list'
    const result = spawnSync(process.execPath, [wrangler, ...command, ...(copy ? ['--config', copy] : [])], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['inherit', listing ? 'pipe' : 'inherit', 'inherit'],
      ...(listing ? { env: { ...process.env, FORCE_COLOR: '0' } } : {}),
    })
    if (listing) process.stdout.write(result.stdout ?? '')
    if (result.status !== 0) {
      if (result.error) console.error(result.error.message)
      process.exitCode = result.status ?? 1
      break
    }
    // The pinned Wrangler CLI can return success after a declined apply. Fail closed on unknown output.
    if (
      listing &&
      !result.stdout?.split(/\r?\n/).some((line) => line.trim() === '✅ No migrations to apply!')
    ) {
      console.error('Deployment aborted: Wrangler did not confirm that all D1 migrations are applied.')
      process.exitCode = 1
      break
    }
  }
} finally {
  if (copy) unlinkSync(copy)
}
