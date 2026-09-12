// Recompute catalog field coverage against the CURRENT local catalog.
// Usage: node tools/coverage.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const p = join(HOME, '.dsh-plugin-market', 'catalog.json')
if (!existsSync(p)) { console.log('no catalog at ' + p); process.exit(1) }

const d = JSON.parse(readFileSync(p, 'utf8'))
const all = d.plugins ?? []
const has = (f) => all.filter((x) => typeof f(x) === 'string' && f(x) !== '').length
const num = (f) => all.filter((x) => typeof f(x) === 'number' && f(x) > 0).length

const total = all.length
const rows = [
  ['total', total],
  ['install', has((x) => x.install)],
  ['url', has((x) => x.url)],
  ['page', has((x) => x.page)],
  ['zh', has((x) => x.zh)],
  ['en', has((x) => x.en)],
  ['npm', has((x) => x.npm)],
  ['version', has((x) => x.version)],
  ['downloads>0', num((x) => x.downloads)],
  ['stars>0', num((x) => x.stars)],
  ['added', has((x) => x.added)],
  ['category', has((x) => x.category)],
]
for (const [k, v] of rows) {
  console.log(String(k).padEnd(13) + String(v).padStart(6) + ' / ' + total + '   ' + (100 * v / total).toFixed(1) + '%')
}
const cats = new Set(all.map((x) => x.category).filter(Boolean))
console.log('\ncategories: ' + cats.size)
console.log('updated:    ' + d.updated)
console.log('version:    ' + d.version)
