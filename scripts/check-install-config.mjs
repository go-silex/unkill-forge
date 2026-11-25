import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(import.meta.url)
const root = join(dirname(file), '..')
const lifecycle = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
]
const codeOptions = new Set(['node-options', 'script-shell', 'onload-script'])

export function checkInstallConfig() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = lifecycle.filter((name) => Object.hasOwn(pkg.scripts ?? {}, name))
  if (declared.length)
    throw new Error(`package.json declares unsupported install scripts: ${declared.join(', ')}`)
  if (lstatSync(join(root, 'binding.gyp'), { throwIfNoEntry: false })) {
    throw new Error('binding.gyp can trigger an implicit npm install script')
  }
  const npmrc = join(root, '.npmrc')
  const info = lstatSync(npmrc, { throwIfNoEntry: false })
  if (!info) return
  if (!info.isFile()) throw new Error('.npmrc must be a regular file')
  for (const line of readFileSync(npmrc, 'utf8').split(/\r?\n/)) {
    const key = /^\s*([\w-]+)(?:\[\])?\s*(?:=|$)/.exec(line)?.[1]?.toLowerCase()
    if (codeOptions.has(key)) throw new Error(`.npmrc declares unsupported npm option: ${key}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === file) {
  try {
    checkInstallConfig()
  } catch (error) {
    console.error(`check-install-config: ${error.message}`)
    process.exitCode = 1
  }
}
