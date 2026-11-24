import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cooldownCandidates, evaluateCooldown } from './lockfile-cooldown.mjs'

const now = Date.UTC(2026, 10, 24)
const day = 86_400_000
const entry = (version) => ({ version })
const base = { packages: { '': entry('1.0.0'), 'node_modules/example': entry('1.2.3') } }
const path = 'node_modules/example'

function check(version, age, { previous = base, allowlist = {}, timestamp } = {}) {
  const current = { packages: { [path]: entry(version) } }
  const candidates = cooldownCandidates(previous, current, allowlist)
  return evaluateCooldown(candidates, now, new Map([[`example@${version}`, timestamp ?? now - age]]))
}

test('a new dependency needs three full days; exact threshold passes', () => {
  const previous = { packages: {} }
  assert.deepEqual(check('9.0.0', 3 * day - 1, { previous }), [
    { path, name: 'example', version: '9.0.0', requiredDays: 3, ageMs: 3 * day - 1 },
  ])
  assert.deepEqual(check('9.0.0', 3 * day, { previous }), [])
})

test('minor changes wait three days while major changes wait seven', () => {
  assert.deepEqual(check('1.3.0', 4 * day), [])
  assert.equal(check('2.0.0-rc.1', 7 * day - 1)[0].requiredDays, 7)
  assert.deepEqual(check('2.0.0', 7 * day), [])
  assert.equal(check('0.9.0', day)[0].requiredDays, 7)
})

test('a reason allows exactly one package version', () => {
  const allowlist = { 'example@2.0.0': 'Reviewed expedited upgrade' }
  assert.deepEqual(check('2.0.0', 0, { allowlist }), [])
  assert.equal(check('2.0.1', 0, { allowlist }).length, 1)
  assert.throws(() => check('2.0.0', 0, { allowlist: { 'example@2.0.0': ' ' } }), /reason/)
  assert.throws(
    () => check('2.0.0', 0, { allowlist: { '1.2.3': 'Missing package name' } }),
    /package@version/,
  )
})

test('ignores unchanged entries, removals and the root; checks alias and metadata changes', () => {
  const alias = 'node_modules/parent/node_modules/local-alias'
  const original = { ...base.packages, 'node_modules/removed': entry('1.0.0') }
  const current = {
    ...base.packages,
    '': entry('2.0.0'),
    [alias]: { name: '@scope/actual', version: '1.0.0' },
  }
  assert.deepEqual(cooldownCandidates({ packages: original }, { packages: current }, {}), [
    { path: alias, name: '@scope/actual', version: '1.0.0', requiredDays: 3 },
  ])
  current[path] = { ...current[path], optional: true }
  assert.equal(cooldownCandidates({ packages: original }, { packages: current }, {})[0].name, 'example')
})

test('cannot clear missing or invalid registry timestamps', () => {
  for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, 'yesterday']) {
    assert.throws(() => check('2.0.0', 0, { timestamp }), /publish time.*example@2.0.0/)
  }
  const candidates = cooldownCandidates(base, { packages: { [path]: entry('2.0.0') } }, {})
  assert.throws(() => evaluateCooldown(candidates, now, new Map()), /publish time.*example@2.0.0/)
})
