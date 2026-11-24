import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const metrics = ['statements', 'branches', 'functions', 'lines']
const root = join(import.meta.dirname, '..')

function expectedFiles(scope) {
  const trackedAndNew = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  return [...new Set(trackedAndNew.split('\0'))]
    .filter(
      (path) =>
        scope.include.some((pattern) => matchesGlob(path, pattern)) &&
        !scope.exclude.some((pattern) => matchesGlob(path, pattern)) &&
        existsSync(join(root, path)),
    )
    .map((path) => join(root, path))
}

function counts(count, label) {
  if (
    !Number.isSafeInteger(count?.total) ||
    count.total < 0 ||
    !Number.isSafeInteger(count.covered) ||
    count.covered < 0 ||
    count.covered > count.total
  ) {
    throw new Error(`${label}: missing or invalid Istanbul coverage counts`)
  }
  return count
}

try {
  const floors = read('../config/coverage-floors.json')
  const { total, ...reports } = read('../coverage/coverage-summary.json')
  const files = expectedFiles(read('../config/coverage-scope.json'))
  if (!files.length) throw new Error('no first-party source files found')
  for (const path of files) {
    if (!Object.hasOwn(reports, path)) throw new Error(`missing Istanbul coverage record for ${path}`)
  }
  for (const metric of metrics) {
    const floor = floors[metric]
    if (!Number.isInteger(floor) || floor < 0 || floor > 100) {
      throw new Error(`${metric}: expected an integer floor between 0 and 100`)
    }
    const count = counts(total?.[metric], metric)
    let fileTotal = 0
    let fileCovered = 0
    for (const path of files) {
      const file = counts(reports[path][metric], `${path}: ${metric}`)
      fileTotal += file.total
      fileCovered += file.covered
    }
    if (!count.total || count.total !== fileTotal || count.covered !== fileCovered) {
      throw new Error(`${metric}: report totals do not match first-party file coverage`)
    }
    if (count.covered * 100 < floor * count.total) {
      const measured = ((count.covered * 100) / count.total).toFixed(2)
      console.error(
        `check-coverage-floors: ${metric} ${measured}% (${count.covered}/${count.total}) < ${floor}%`,
      )
      process.exitCode = 1
    }
  }
  if (!process.exitCode) console.log('check-coverage-floors: all four baseline floors met')
} catch (error) {
  console.error(`check-coverage-floors: ${error.message}`)
  process.exit(1)
}
