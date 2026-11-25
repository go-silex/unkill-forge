import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'

const root = join(import.meta.dirname, '..')
const coverage = JSON.parse(readFileSync(join(root, 'config/coverage-scope.json'), 'utf8'))

export function worktreePaths() {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
  return new Set(paths.split('\0').filter(Boolean))
}

export const inLengthScope = (path) =>
  /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) &&
  !/(?:^|\/)(?:test|tests|__tests__|__fixtures__)\//.test(path) &&
  !/\.(?:test|spec|node-test|d)\.[^.]+$/.test(path)

export const inCoverageScope = (path) =>
  coverage.include.some((pattern) => matchesGlob(path, pattern)) &&
  !coverage.exclude.some((pattern) => matchesGlob(path, pattern))
