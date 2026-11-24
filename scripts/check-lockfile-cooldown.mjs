import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  cooldownCandidates,
  evaluateCooldown,
  packageVersion,
  validateInstallInputs,
} from './lockfile-cooldown.mjs'

const root = join(import.meta.dirname, '..')
const lockfile = 'package-lock.json'
const shrinkwrap = 'npm-shrinkwrap.json'
const exceptions = 'config/lockfile-cooldown-allowlist.json'
const dayMs = 86_400_000

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function read(path, ref) {
  return ref ? git('show', `${ref}:${path}`) : readFileSync(join(root, path), 'utf8')
}

async function loadReleases(candidates) {
  const packages = new Map()
  for (const { name, version } of candidates) {
    if (!packages.has(name)) packages.set(name, new Set())
    packages.get(name).add(version)
  }
  const releases = new Map()
  const entries = packages.entries()
  await Promise.all(
    Array.from({ length: Math.min(packages.size, 8) }, async () => {
      for (const [name, versions] of entries) {
        try {
          const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`
          const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const { time, versions: metadata } = await response.json()
          for (const version of versions) {
            const dist = metadata?.[version]?.dist
            releases.set(packageVersion({ name, version }), {
              published: Date.parse(time?.[version]),
              integrity: dist?.integrity,
              tarball: dist?.tarball,
            })
          }
        } catch (error) {
          throw new Error(
            `npm registry lookup failed for ${name} (${[...versions].join(', ')}): ${error.message}`,
          )
        }
      }
    }),
  )
  return releases
}

async function check(base, tip) {
  const now = Date.now()
  const hasShrinkwrap = tip
    ? Boolean(git('ls-tree', '-z', tip, '--', shrinkwrap))
    : Boolean(lstatSync(join(root, shrinkwrap), { throwIfNoEntry: false }))
  const allowlist = JSON.parse(read(exceptions, tip))
  validateInstallInputs(hasShrinkwrap, allowlist, now)
  const mergeBase = git('merge-base', base, tip ?? 'HEAD').trim()
  const before = read(lockfile, mergeBase)
  const after = read(lockfile, tip)
  if (before === after) {
    console.log('lockfile-cooldown: package-lock.json unchanged')
    return
  }
  const candidates = cooldownCandidates(JSON.parse(before), JSON.parse(after))
  const releases = await loadReleases(candidates)
  const offenders = evaluateCooldown(candidates, now, releases, allowlist)
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
    const head = git('rev-parse', 'HEAD').trim()
    if (git('status', '--porcelain', '--untracked-files=normal')) {
      throw new Error('pre-push checks require a clean worktree; commit or stash local changes first')
    }
    const updates = readFileSync(0, 'utf8').trim()
    for (const line of updates ? updates.split('\n') : []) {
      const [, oid, remoteRef, previous] = line.trim().split(/\s+/)
      if (/^0+$/.test(oid)) continue
      if (oid !== head) throw new Error(`pre-push checks cover HEAD only; ${remoteRef} points to ${oid}`)
      const defaultRef = `refs/heads/${process.env.COOLDOWN_DEFAULT_BRANCH ?? 'main'}`
      const pushBase = remoteRef === defaultRef ? (/^0+$/.test(previous) ? `${head}^1` : previous) : base
      await check(pushBase, oid)
    }
  } else {
    await check(base, values.head)
  }
} catch (error) {
  console.error(`lockfile-cooldown: ${error.message}`)
  process.exit(1)
}
