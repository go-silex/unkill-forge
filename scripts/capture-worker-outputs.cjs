const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const { resolve } = require('node:path')

const metafile = process.env.FORGE_SCOPE_METAFILE
const snapshot = process.env.FORGE_SCOPE_SNAPSHOT
const writeFileSync = fs.writeFileSync
const writeFile = fs.promises.writeFile
const generated = new Set()

// Pinned Wrangler writes the metafile after esbuild and before copying its
// separately collected modules. Capture the exact bytes at that boundary.
fs.writeFileSync = (path, content, ...args) => {
  const result = writeFileSync(path, content, ...args)
  if (path === metafile) {
    const hashes = Object.entries(JSON.parse(content).outputs).map(([output, { bytes }]) => {
      const absolute = resolve(output)
      const content = fs.readFileSync(absolute)
      if (content.length !== bytes) throw new Error(`esbuild output size mismatch: ${output}`)
      generated.add(absolute)
      return [output, createHash('sha256').update(content).digest('hex')]
    })
    writeFileSync(snapshot, JSON.stringify(Object.fromEntries(hashes)), { flag: 'wx' })
  }
  return result
}
fs.promises.writeFile = (path, ...args) => {
  if (typeof path === 'string' && generated.has(resolve(path))) {
    throw new Error(`Wrangler attachment collides with esbuild output: ${path}`)
  }
  return writeFile(path, ...args)
}
syncBuiltinESMExports()
