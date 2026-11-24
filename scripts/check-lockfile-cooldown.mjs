import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { cooldownCandidates, evaluateCooldown, packageVersion } from './lockfile-cooldown.mjs'

const root = join(import.meta.dirname, '..')
const lockfile = 'package-lock.json'
const exceptions = 'config/lockfile-cooldown-allowlist.json'
const dayMs = 86_400_000

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function read(path, ref) {
  return ref ? git('show', `${ref}:${path}`) : readFileSync(join(root, path), 'utf8')
}

async function loadPublishTimes(candidates) {
  const packages = new Map()
  for (const { name, version } of candidates) {
    if (!packages.has(name)) packages.set(name, new Set())
    packages.get(name).add(version)
  }
  const times = new Map()
  const entries = packages.entries()
  await Promise.all(
    Array.from({ length: Math.min(packages.size, 8) }, async () => {
      for (const [name, versions] of entries) {
        try {
          const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`
          const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const { time } = await response.json()
          for (const version of versions) {
            times.set(packageVersion({ name, version }), Date.parse(time?.[version]))
          }
        } catch (error) {
          throw new Error(
            `npm registry lookup failed for ${name} (${[...versions].join(', ')}): ${error.message}`,
          )
        }
      }
    }),
  )
  return times
}

async function check(base, tip) {
  const mergeBase = git('merge-base', base, tip ?? 'HEAD').trim()
  const before = read(lockfile, mergeBase)
  const after = read(lockfile, tip)
  if (before === after) {
    console.log('lockfile-cooldown: package-lock.json unchanged')
    return
  }
  const candidates = cooldownCandidates(
    JSON.parse(before),
    JSON.parse(after),
    JSON.parse(read(exceptions, tip)),
  )
  const times = await loadPublishTimes(candidates)
  const offenders = evaluateCooldown(candidates, Date.now(), times)
  if (!offenders.length) {
    console.log(`lockfile-cooldown: ${candidates.length} package entries cleared`)
    return
  }
  for (const offender of offenders) {
    const age = (offender.ageMs / dayMs).toFixed(3)
    console.error(
      `${packageVersion(offender)}: age ${age} days; requires ${offender.requiredDays} days (${offender.path})`,
    )
  }
  console.error(
    `lockfile-cooldown: wait for the cooldown or document a deliberate exception in ${exceptions}`,
  )
  process.exitCode = 1
}

try {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, head: { type: 'string' }, 'pre-push': { type: 'boolean' } },
  })
  const base = values.base ?? process.env.COOLDOWN_BASE ?? 'origin/main'
  if (values['pre-push']) {
    const updates = readFileSync(0, 'utf8').trim()
    for (const line of updates ? updates.split('\n') : []) {
      const [, oid, remoteRef] = line.trim().split(/\s+/)
      if (remoteRef.startsWith('refs/heads/') && !/^0+$/.test(oid)) await check(base, oid)
    }
  } else {
    await check(base, values.head)
  }
} catch (error) {
  console.error(`lockfile-cooldown: ${error.message}`)
  process.exit(1)
}
