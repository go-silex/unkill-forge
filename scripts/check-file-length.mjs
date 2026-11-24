import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const max = 300
const root = join(import.meta.dirname, '..')
const ledger = 'config/file-length-exemptions.json'

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const gitPaths = (...args) =>
  git(...args)
    .split('\0')
    .filter(Boolean)
const lines = (text) => (text.match(/\n/g)?.length ?? 0) + Number(text.length > 0 && !text.endsWith('\n'))
const inScope = (path) =>
  /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) &&
  !/(?:^|\/)(?:test|tests|__tests__|__fixtures__)\//.test(path) &&
  !/\.(?:test|spec|node-test|d)\.[^.]+$/.test(path)

function readLedger(text) {
  const caps = JSON.parse(text)
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new Error(`${ledger} must be an object`)
  return caps
}

try {
  const { values } = parseArgs({ options: { base: { type: 'string' } } })
  const base = values.base ?? git('merge-base', 'origin/main', 'HEAD').trim()
  const exemptions = new Map(Object.entries(readLedger(readFileSync(join(root, ledger), 'utf8'))))
  const basePaths = new Set(gitPaths('ls-tree', '-r', '-z', '--name-only', base))
  const baseCaps = basePaths.has(ledger) ? readLedger(git('show', `${base}:${ledger}`)) : null
  const errors = []
  for (const [path, cap] of exemptions) {
    if (!inScope(path) || !Number.isSafeInteger(cap) || cap <= max) {
      errors.push(`${ledger}: invalid exemption for ${path}; expected a source file and a cap above ${max}`)
      continue
    }
    // On the commit introducing the gate, only source already over the cap may be grandfathered.
    const oldCap = baseCaps
      ? Object.hasOwn(baseCaps, path) && baseCaps[path]
      : basePaths.has(path) && lines(git('show', `${base}:${path}`))
    if (!oldCap || oldCap <= max) errors.push(`${ledger}: ${path} is not grandfathered; split it instead`)
    else if (cap > oldCap)
      errors.push(`${ledger}: ${path} cap raised from ${oldCap} to ${cap}; caps only go down`)
  }

  const paths = new Set(gitPaths('ls-files', '-z', '--cached', '--others', '--exclude-standard'))
  for (const path of paths) {
    if (!inScope(path) || !lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile()) continue
    const size = lines(readFileSync(join(root, path), 'utf8'))
    const cap = exemptions.get(path)
    if (size > (cap ?? max)) errors.push(`${path}: ${size} lines, over ${cap ?? max}; split the file`)
    if (cap !== undefined && size <= max)
      errors.push(`${ledger}: ${path} is at or below ${max}; remove its cap`)
    exemptions.delete(path)
  }
  for (const path of exemptions.keys())
    errors.push(`${ledger}: ${path} is not a current source file; remove its cap`)
  if (errors.length) {
    for (const error of errors) console.error(`check-file-length: ${error}`)
    process.exitCode = 1
  } else console.log(`check-file-length: clean (${max} lines)`)
} catch (error) {
  console.error(`check-file-length: ${error.message}`)
  process.exit(1)
}
