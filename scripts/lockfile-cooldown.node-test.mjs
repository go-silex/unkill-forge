import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cooldownCandidates, evaluateCooldown, validateInstallInputs } from './lockfile-cooldown.mjs'

const now = Date.UTC(2026, 10, 24)
const day = 86_400_000
const integrity = 'sha512-example'
const entry = (version) => ({
  version,
  resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
  integrity,
})
const base = { packages: { '': entry('1.0.0'), 'node_modules/example': entry('1.2.3') } }
const path = 'node_modules/example'

function check(
  version,
  age,
  { previous = base, allowlist = {}, timestamp, locked = {}, registry = {} } = {},
) {
  const current = { packages: { [path]: { ...entry(version), ...locked } } }
  const release = {
    published: timestamp ?? now - age,
    integrity,
    tarball: entry(version).resolved,
    ...registry,
  }
  validateInstallInputs(false, allowlist, now)
  return evaluateCooldown(
    cooldownCandidates(previous, current),
    now,
    new Map([[`example@${version}`, release]]),
    allowlist,
  )
}

test('a new dependency needs three full days; exact threshold passes', () => {
  const previous = { packages: {} }
  assert.equal(check('9.0.0', 3 * day - 1, { previous })[0].ageMs, 3 * day - 1)
  assert.deepEqual(check('9.0.0', 3 * day, { previous }), [])
})

test('minor changes wait three days while major changes wait seven', () => {
  assert.deepEqual(check('1.3.0', 4 * day), [])
  assert.equal(check('2.0.0-rc.1', 7 * day - 1)[0].requiredDays, 7)
  assert.deepEqual(check('2.0.0', 7 * day), [])
  assert.equal(check('0.9.0', day)[0].requiredDays, 7)
})

test('a dated reason allows exactly one package version but never overrides artifact checks', () => {
  const exception = { reason: 'Reviewed expedited upgrade', expires: '2026-11-25' }
  const allowlist = { 'example@2.0.0': exception }
  assert.deepEqual(check('2.0.0', 0, { allowlist }), [])
  assert.equal(check('2.0.1', 0, { allowlist }).length, 1)
  assert.throws(() => check('2.0.0', 0, { allowlist, locked: { integrity: 'sha512-other' } }), /integrity/)
  assert.throws(
    () => validateInstallInputs(false, { 'example@2.0.0': { ...exception, reason: '' } }, now),
    /reason/,
  )
  assert.throws(() => validateInstallInputs(false, { '1.2.3': exception }, now), /package@version/)
})

test('rejects missing, invalid and expired exceptions even without changed entries', () => {
  for (const expires of [undefined, '2026-02-31', '2026-11-24']) {
    const allowlist = { 'example@2.0.0': { reason: 'Reviewed', expires } }
    assert.throws(() => validateInstallInputs(false, allowlist, now), /expires|expired/)
  }
})

test('rejects an npm shrinkwrap before evaluating package-lock changes', () => {
  assert.throws(() => validateInstallInputs(true, {}, now), /npm-shrinkwrap\.json/)
})

test('checks that the locked tarball and integrity identify the release aged by the gate', () => {
  assert.throws(
    () => check('2.0.0', 8 * day, { locked: { resolved: 'https://not-registry.example/example.tgz' } }),
    /canonical/,
  )
  assert.throws(() => check('2.0.0', 8 * day, { registry: { integrity: 'sha512-other' } }), /integrity/)
  assert.throws(() => check('2.0.0', 8 * day, { registry: { integrity: undefined } }), /integrity/)
})

test('compares majors even after a dependency moves between install paths', () => {
  const moved = { packages: { 'node_modules/parent/node_modules/example': entry('2.0.0') } }
  const candidates = cooldownCandidates(base, moved)
  const releases = new Map([
    ['example@2.0.0', { published: now - 4 * day, integrity, tarball: entry('2.0.0').resolved }],
  ])
  assert.equal(evaluateCooldown(candidates, now, releases)[0].requiredDays, 7)
})

test('ignores unchanged entries, removals and the root; checks alias and metadata changes', () => {
  const alias = 'node_modules/parent/node_modules/local-alias'
  const original = { ...base.packages, 'node_modules/removed': entry('1.0.0') }
  const current = {
    ...base.packages,
    '': entry('2.0.0'),
    [alias]: { name: '@scope/actual', version: '1.0.0' },
  }
  const candidates = cooldownCandidates({ packages: original }, { packages: current })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, '@scope/actual')
  current[path] = { ...current[path], optional: true }
  assert.equal(cooldownCandidates({ packages: original }, { packages: current })[0].name, 'example')
})

test('cannot clear missing or invalid registry timestamps', () => {
  for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, 'yesterday']) {
    assert.throws(() => check('2.0.0', 0, { timestamp }), /publish time.*example@2.0.0/)
  }
  const candidates = cooldownCandidates(base, { packages: { [path]: entry('2.0.0') } })
  assert.throws(() => evaluateCooldown(candidates, now, new Map()), /publish time.*example@2.0.0/)
})
