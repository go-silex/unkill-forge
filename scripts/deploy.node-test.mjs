import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const fixture = `
const { readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const [command, , operation] = args
if (readFileSync(args.at(-1), 'utf8') !== '{ "name": "fixture" }') process.exit(2)
if (command === 'd1' && operation === 'apply') console.log('apply called')
if (command === 'd1' && operation === 'list') console.log(process.env.FIXTURE_LISTING)
if (command === 'deploy') console.log('deploy called')
`

for (const [listing, allowed] of [
  ['✅ No migrations to apply!', true],
  ['Migrations to be applied:\n0001_schema.sql', false],
  ['Unexpected successful output', false],
]) {
  test(`deploy ${allowed ? 'accepts' : 'refuses'} Wrangler listing: ${listing}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-deploy-test-'))
    try {
      const script = join(root, 'scripts/deploy.mjs')
      const config = join(root, 'operator.jsonc')
      const wrangler = join(root, 'node_modules/wrangler/bin')
      mkdirSync(join(root, 'scripts'))
      mkdirSync(wrangler, { recursive: true })
      copyFileSync(new URL('./deploy.mjs', import.meta.url), script)
      writeFileSync(join(wrangler, 'wrangler.js'), fixture)
      writeFileSync(config, '{ "name": "fixture" }')
      const result = spawnSync(process.execPath, [script, '--config', config], {
        encoding: 'utf8',
        env: { ...process.env, FIXTURE_LISTING: listing },
      })
      assert.equal(result.status, allowed ? 0 : 1, result.stderr)
      assert.ok(result.stdout.includes('apply called'))
      assert.ok(result.stdout.includes(listing))
      assert.equal(result.stdout.includes('deploy called'), allowed)
      assert.equal(
        readdirSync(root).some((name) => name.startsWith('.wrangler-deploy-')),
        false,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
