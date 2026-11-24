import { isDeepStrictEqual } from 'node:util'

const dayMs = 86_400_000
const npmName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/
export const packageVersion = ({ name, version }) => `${name}@${version}`

function packageName(path, entry) {
  return entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

export function cooldownCandidates(base, current, allowlist) {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) {
    throw new Error('The cooldown allowlist must map package@version to a written reason')
  }
  for (const [key, reason] of Object.entries(allowlist)) {
    const separator = key.lastIndexOf('@')
    if (separator <= 0 || !npmName.test(key.slice(0, separator)) || !semver.test(key.slice(separator + 1))) {
      throw new Error(`Invalid cooldown allowlist entry: ${key}; expected package@version`)
    }
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`Missing cooldown reason for ${key}`)
  }
  if (!base.packages || !current.packages) throw new Error('Expected npm lockfiles with a packages map')

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
    if (Object.hasOwn(allowlist, packageVersion({ name, version }))) continue
    const oldMajor =
      previous && packageName(path, previous) === name ? semver.exec(previous.version)?.[1] : undefined
    const requiredDays = oldMajor !== undefined && oldMajor !== major ? 7 : 3
    candidates.push({ path, name, version, requiredDays })
  }
  return candidates
}

export function evaluateCooldown(candidates, now, publishTimes) {
  return candidates.flatMap((candidate) => {
    const key = packageVersion(candidate)
    const published = publishTimes.get(key)
    if (!Number.isFinite(published))
      throw new Error(`Missing or invalid npm registry publish time for ${key}`)
    const ageMs = now - published
    return ageMs < candidate.requiredDays * dayMs ? [{ ...candidate, ageMs }] : []
  })
}
