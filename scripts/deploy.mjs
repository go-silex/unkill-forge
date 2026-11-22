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
  for (const command of [['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy']]) {
    const result = spawnSync(process.execPath, [wrangler, ...command, ...(copy ? ['--config', copy] : [])], {
      cwd: root,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      if (result.error) console.error(result.error.message)
      process.exitCode = result.status ?? 1
      break
    }
  }
} finally {
  if (copy) unlinkSync(copy)
}
