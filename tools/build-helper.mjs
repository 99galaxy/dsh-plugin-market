// Produce the deployable helper from its source and install it into the package.
//
// The source (tools/market-core.mjs) keeps its placeholders and comments — it is the
// source of truth, and tools/test-market-core.mjs substitutes the placeholders
// itself. What ships must be the finished form: leaving '__CATALOG__' in place would
// make every fetch request that literal string.
//
// The output is the repo-root market-core.mjs, committed so the plugin installs
// straight from a clone. tools/check-sync.mjs fails if it stops matching this source.
//
// Usage: node tools/build-helper.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildHelper, helperProblems, readHelperSource } from './helper-build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const source = readHelperSource(here)
const built = buildHelper(source)

const problems = helperProblems(built)
if (problems.length > 0) {
  console.log('FAIL: ' + problems.join('; '))
  process.exit(1)
}

const dest = join(root, 'market-core.mjs')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, built)

console.log('helper built')
console.log('  source     ' + Buffer.byteLength(source) + ' bytes  (tools/market-core.mjs)')
console.log('  deployable ' + Buffer.byteLength(built) + ' bytes')
console.log('  sha256     ' + createHash('sha256').update(built, 'utf8').digest('hex'))
console.log('  written    ' + dest)
