import { readFileSync } from 'node:fs'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const metrics = ['statements', 'branches', 'functions', 'lines']

try {
  const floors = read('../config/coverage-floors.json')
  const { total } = read('../coverage/coverage-summary.json')
  for (const metric of metrics) {
    const floor = floors[metric]
    if (!Number.isInteger(floor) || floor < 0 || floor > 100) {
      throw new Error(`${metric}: expected an integer floor between 0 and 100`)
    }
    const count = total?.[metric]
    if (
      !Number.isSafeInteger(count?.total) ||
      count.total <= 0 ||
      !Number.isSafeInteger(count.covered) ||
      count.covered < 0 ||
      count.covered > count.total
    ) {
      throw new Error(`${metric}: missing or invalid Istanbul coverage counts`)
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
