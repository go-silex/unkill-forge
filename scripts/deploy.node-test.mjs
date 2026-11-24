import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const fixture = `
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
const [command, , operation] = args
const config = readFileSync(args.at(-1), 'utf8')
if (process.env.FIXTURE_ASSETS) {
  assert.deepEqual(JSON.parse(config), {
    name: 'fixture',
    main: 'src/index.ts',
    assets: { directory: process.env.FIXTURE_ASSETS, binding: 'THEME', run_worker_first: true },
  })
} else {
  assert.equal(config, '{ "name": "fixture" }')
}
if (command === 'd1' && operation === 'apply') console.log('apply called', process.env.WRANGLER_LOG)
if (command === 'd1' && operation === 'list' && process.env.WRANGLER_LOG === 'log') {
  console.log(process.env.FIXTURE_LISTING)
}
if (command === 'deploy') console.log('deploy called', process.env.WRANGLER_LOG)
`

for (const [listing, allowed, withTheme] of [
  ['✅ No migrations to apply!', true],
  ['Migrations to be applied:\n0001_schema.sql', false],
  ['Unexpected successful output', false],
  ['✅ No migrations to apply!', true, true],
]) {
  const name = withTheme
    ? 'resolves a relative asset directory in an external JSONC config'
    : `deploy ${allowed ? 'accepts' : 'refuses'} Wrangler listing with a quiet parent: ${listing}`
  test(name, () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-deploy-test-'))
    try {
      const script = join(root, 'scripts/deploy.mjs')
      const operator = join(root, 'operator')
      const config = join(operator, 'wrangler.jsonc')
      const wrangler = join(root, 'node_modules/wrangler/bin')
      mkdirSync(join(root, 'scripts'))
      mkdirSync(join(operator, 'theme'), { recursive: true })
      mkdirSync(wrangler, { recursive: true })
      copyFileSync(new URL('./deploy.mjs', import.meta.url), script)
      writeFileSync(join(wrangler, '../package.json'), JSON.stringify({ exports: './reader.mjs' }))
      writeFileSync(
        join(wrangler, '../reader.mjs'),
        `export { experimental_readRawConfig } from ${JSON.stringify(import.meta.resolve('wrangler'))}`,
      )
      writeFileSync(join(wrangler, 'wrangler.js'), fixture)
      writeFileSync(
        config,
        withTheme
          ? `{
              // Engine paths remain checkout-relative.
              "name": "fixture",
              "main": "src/index.ts",
              "assets": { "directory": "theme", "binding": "THEME", "run_worker_first": true },
            }`
          : '{ "name": "fixture" }',
      )
      const result = spawnSync(process.execPath, [script, '--config', config], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FIXTURE_LISTING: listing,
          WRANGLER_LOG: 'warn',
          ...(withTheme ? { FIXTURE_ASSETS: join(operator, 'theme') } : {}),
        },
      })
      assert.equal(result.status, allowed ? 0 : 1, result.stderr)
      assert.ok(result.stdout.includes('apply called warn'))
      assert.ok(result.stdout.includes(listing))
      assert.equal(result.stdout.includes('deploy called warn'), allowed)
      assert.equal(
        readdirSync(root).some((name) => name.startsWith('.wrangler-deploy-')),
        false,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
