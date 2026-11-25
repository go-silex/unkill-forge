import { isDeepStrictEqual } from 'node:util'

const dayMs = 86_400_000
const npmName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/
export const packageVersion = ({ name, version }) => `${name}@${version}`

function packageName(path, entry) {
  return entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

export function validateInstallInputs(hasShrinkwrap, allowlist, now) {
  if (hasShrinkwrap) throw new Error('npm-shrinkwrap.json overrides package-lock.json; remove it')
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) {
    throw new Error('The cooldown allowlist must map package@version to a reason and expiry')
  }
  for (const [key, exception] of Object.entries(allowlist)) {
    const separator = key.lastIndexOf('@')
    if (separator <= 0 || !npmName.test(key.slice(0, separator)) || !semver.test(key.slice(separator + 1))) {
      throw new Error(`Invalid cooldown allowlist entry: ${key}; expected package@version`)
    }
    if (typeof exception?.reason !== 'string' || !exception.reason.trim()) {
      throw new Error(`Missing cooldown reason for ${key}`)
    }
    const expiry = Date.parse(exception.expires)
    if (
      typeof exception.expires !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) ||
      !Number.isFinite(expiry) ||
      new Date(expiry).toISOString().slice(0, 10) !== exception.expires
    ) {
      throw new Error(`${key}: cooldown exception expires must be a valid UTC date (YYYY-MM-DD)`)
    }
    if (now >= expiry) throw new Error(`${key}: cooldown exception expired on ${exception.expires} UTC`)
  }
}

export function cooldownCandidates(base, current) {
  if (!base.packages || !current.packages) throw new Error('Expected npm lockfiles with a packages map')
  const baseMajors = new Map()
  for (const [path, entry] of Object.entries(base.packages)) {
    if (!path) continue
    const major = semver.exec(entry.version)?.[1]
    if (major === undefined) continue
    const name = packageName(path, entry)
    if (!baseMajors.has(name)) baseMajors.set(name, new Set())
    baseMajors.get(name).add(major)
  }

  const candidates = []
  for (const [path, entry] of Object.entries(current.packages)) {
    const previous = base.packages[path]
    if (!path || isDeepStrictEqual(entry, previous)) continue
    const name = packageName(path, entry)
    const { version } = entry
    const major = semver.exec(version)?.[1]
    if (!npmName.test(name) || major === undefined) {
      throw new Error(`Cannot check ${path}: expected an npm package name and exact semver version`)
    }
    const oldMajor =
      previous && packageName(path, previous) === name ? semver.exec(previous.version)?.[1] : undefined
    const knownMajors = baseMajors.get(name)
    const majorChanged = oldMajor !== undefined ? oldMajor !== major : knownMajors && !knownMajors.has(major)
    const requiredDays = majorChanged ? 7 : 3
    candidates.push({
      path,
      name,
      version,
      requiredDays,
      resolved: entry.resolved,
      integrity: entry.integrity,
    })
  }
  return candidates
}

export function evaluateCooldown(candidates, now, releases, allowlist = {}) {
  return candidates.flatMap((candidate) => {
    const key = packageVersion(candidate)
    const { name, version, resolved, integrity } = candidate
    const release = releases.get(key)
    if (!Number.isFinite(release?.published)) {
      throw new Error(`Missing or invalid npm registry publish time for ${key}`)
    }
    const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
    if (resolved !== tarball || release.tarball !== tarball) {
      throw new Error(`${key} (${candidate.path}): expected canonical npm registry tarball ${tarball}`)
    }
    if (typeof release.integrity !== 'string' || !release.integrity || integrity !== release.integrity) {
      throw new Error(`${key} (${candidate.path}): lockfile integrity must match npm registry dist.integrity`)
    }
    if (Object.hasOwn(allowlist, key)) return []
    const ageMs = now - release.published
    return ageMs < candidate.requiredDays * dayMs ? [{ ...candidate, ageMs }] : []
  })
}
