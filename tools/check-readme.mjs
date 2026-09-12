// The README must not drift away from the code.
//
// Two kinds of claim are checked:
//   STALE    — phrases that were true of a superseded design or of old numbers, and
//              that must never come back (they have misled readers before).
//   REQUIRED — contracts a reader depends on: if one disappears, the README stopped
//              describing what actually ships.
//
// Usage: node tools/check-readme.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const text = readFileSync(join(root, 'README.md'), 'utf8')

let bad = 0
console.log('README.md  ' + Buffer.byteLength(text) + ' bytes\n')

const STALE = [
  ['6 小时', 'the catalog TTL was reduced to 1 hour'],
  ['3363', 'an older catalog size'],
  ['0.8 MB', 'the catalog download is ~2.8 MB'],
  ['动态 Cordis 插件', 'this is now a permanent bundle, not a dynamic Cordis plugin'],
  // The code form, not a bare mention: the README legitimately says the transport is
  // "not host.call", and that explanation is worth keeping.
  ['host.call(', 'a bundle cannot use the dynamic-plugin RPC'],
  ['harness.handle', 'that belonged to the dynamic Host half'],
  ['styles.insert', 'a bundle inserts its own CSS'],
  ['dsh-plugin-market-installed', 'installed is an in-page tab, not a second settings entry'],
  ['refresh?', 'the force flag is `bypass`'],
]

const REQUIRED = [
  ['1 小时', 'the catalog cache TTL'],
  ['bypass', 'the only force-refresh flag'],
  ['已安装', 'the installed tab'],
  ['settings.section', 'how the page is registered'],
  ['market-core.mjs', 'the helper the host runs'],
  ['check-all.mjs', 'how to run the guards'],
  ['dsh.bundle', 'the declaration that makes it load'],
  ['MIT', 'the licence'],
]

for (const [needle, why] of STALE) {
  const hit = text.includes(needle)
  if (hit) bad += 1
  console.log((hit ? '  STALE     ' : '  clean     ') + JSON.stringify(needle) + '   (' + why + ')')
}
console.log('')
for (const [needle, why] of REQUIRED) {
  const hit = text.includes(needle)
  if (!hit) bad += 1
  console.log((hit ? '  present   ' : '  MISSING   ') + JSON.stringify(needle) + '   (' + why + ')')
}

// Machine-specific paths must never be published.
const machinePaths = text.match(/[A-Z]:[\\/](Users|ProgramData)[\\/][^\s`)"']*/g) || []
if (machinePaths.length > 0) {
  bad += 1
  console.log('\n  STALE     machine-specific path(s): ' + machinePaths.slice(0, 3).join(', '))
}

console.log('\n' + (bad === 0 ? 'README OK' : 'README HAS ' + bad + ' PROBLEM(S)'))
process.exit(bad === 0 ? 0 : 1)
