import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const lock = '{"packages":{}}'

function makeRepo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-cooldown-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Forge test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Forge test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
  const localEnv = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
  for (const name of localEnv.trim().split('\n')) {
    delete env[name]
  }
  git('init', '--quiet')
  mkdirSync(join(cwd, 'scripts'))
  mkdirSync(join(cwd, 'config'))
  for (const file of ['check-lockfile-cooldown.mjs', 'lockfile-cooldown.mjs']) {
    copyFileSync(join(import.meta.dirname, file), join(cwd, 'scripts', file))
  }
  writeFileSync(join(cwd, 'config/lockfile-cooldown-allowlist.json'), '{}')
  writeFileSync(join(cwd, 'package-lock.json'), lock)
  git('add', 'config', 'package-lock.json')
  const base = git('commit-tree', git('write-tree'), '-m', 'fixture base')
  git('update-ref', 'HEAD', base)
  return {
    check: (...args) =>
      spawnSync(process.execPath, ['scripts/check-lockfile-cooldown.mjs', '--base', base, ...args], {
        cwd,
        encoding: 'utf8',
        env,
      }),
    link: (file) => {
      rmSync(join(cwd, file), { force: true })
      writeFileSync(join(cwd, lock), lock)
      symlinkSync(lock, join(cwd, file))
      git('add', file)
      return git('commit-tree', git('write-tree'), '-p', base, '-m', 'fixture symlink')
    },
  }
}

for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
  test(`rejects a symlinked ${file} from the checkout and from Git`, (t) => {
    const { check, link } = makeRepo(t)
    const tip = link(file)
    for (const result of [check(), check('--head', tip)]) {
      assert.equal(result.status, 1, result.stdout || result.stderr)
      assert.match(result.stderr, new RegExp(`${file} must be a regular file`))
    }
  })
}
