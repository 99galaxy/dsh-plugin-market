// Two documentation invariants, both of which have been violated before:
//
//   1. README.md must not carry stale claims, and must not carry the maintainer-only
//      sections (how to run the guards, the pitfall notes) — those are published
//      separately on purpose.
//   2. LOCAL-NOTES.md must still HOLD those sections, and must be git-ignored, so the
//      knowledge survives locally without ever reaching GitHub.
//
// Usage: node tools/check-readme.mjs
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let bad = 0
const fail = (msg) => { bad += 1; console.log('  FAIL  ' + msg) }
const pass = (msg) => console.log('  OK    ' + msg)

const readmePath = join(root, 'README.md')
if (!existsSync(readmePath)) {
  console.log('  FAIL  README.md is missing')
  process.exit(1)
}
const readme = readFileSync(readmePath, 'utf8')
const notesPath = join(root, 'LOCAL-NOTES.md')
const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : ''

console.log('README.md       ' + Buffer.byteLength(readme) + ' bytes')
console.log('LOCAL-NOTES.md  ' + (notes === '' ? '(missing)' : Buffer.byteLength(notes) + ' bytes') + '\n')

// ---- README must not carry superseded facts -------------------------------
console.log('-- README: superseded facts --')
const STALE = [
  ['6 小时', 'the catalog TTL is 1 hour'],
  ['3363', 'an older catalog size'],
  ['0.8 MB', 'the catalog download is ~2.8 MB'],
  ['动态 Cordis 插件', 'this is a permanent bundle now'],
  ['harness.handle', 'that belonged to the dynamic Host half'],
  ['styles.insert', 'a bundle inserts its own CSS'],
  ['dsh-plugin-market-installed', 'installed is an in-page tab, not a second settings entry'],
  ['refresh?', 'the force flag is `bypass`'],
  ['pkg/dsh-plugin-market', 'the package is at the repo root now'],
]
for (const [needle, why] of STALE) {
  if (readme.includes(needle)) fail(JSON.stringify(needle) + '  (' + why + ')')
  else pass(JSON.stringify(needle) + ' absent')
}

// ---- README must NOT carry the maintainer-only sections -------------------
console.log('\n-- README: maintainer sections must stay out --')
for (const [needle, why] of [
  ['## 开发', 'the development section is local-only'],
  ['## 设计笔记', 'the pitfall notes are local-only'],
  ['check-all.mjs', 'the guards are documented locally, not publicly'],
  ['ERR_PNPM_IGNORED_BUILDS', 'a pitfall note'],
  ['VIRTUAL_STORE_DIR_MAX_LENGTH', 'a pitfall note'],
]) {
  if (readme.includes(needle)) fail(JSON.stringify(needle) + ' leaked into README  (' + why + ')')
  else pass(JSON.stringify(needle) + ' not in README')
}

// ---- README must state the contracts a user needs -------------------------
console.log('\n-- README: user-facing contracts --')
for (const [needle, why] of [
  ['1 小时', 'the catalog cache TTL'],
  ['bypass', 'the only force-refresh flag'],
  ['已安装', 'the installed tab'],
  ['settings.section', 'how the page is registered'],
  ['market-core.mjs', 'the helper the host runs'],
  ['dsh.bundle', 'the declaration that makes it load'],
  ['github:99galaxy/dsh-plugin-market', 'the install command'],
  ['MIT', 'the licence'],
]) {
  if (readme.includes(needle)) pass(JSON.stringify(needle) + ' present')
  else fail(JSON.stringify(needle) + ' missing  (' + why + ')')
}

// ---- the local notes must still hold what was removed ---------------------
console.log('\n-- LOCAL-NOTES: keeps what was removed --')
if (notes === '') {
  fail('LOCAL-NOTES.md is missing — the removed sections would be lost')
} else {
  for (const [needle, why] of [
    ['## 开发', 'the development section'],
    ['## 设计笔记', 'the pitfall notes'],
    ['check-all.mjs', 'how to run the guards'],
    ['ERR_PNPM_IGNORED_BUILDS', 'the pnpm refusal pitfall'],
    ['VIRTUAL_STORE_DIR_MAX_LENGTH', 'the pnpm config pitfall'],
    ['文件描述符', 'the subprocess-capture pitfall'],
  ]) {
    if (notes.includes(needle)) pass(JSON.stringify(needle) + ' kept locally')
    else fail(JSON.stringify(needle) + ' missing from LOCAL-NOTES.md  (' + why + ')')
  }
}

// ---- and it must never be published ---------------------------------------
console.log('\n-- LOCAL-NOTES: must stay untracked --')
try {
  execFileSync('git', ['check-ignore', '-q', 'LOCAL-NOTES.md'], { cwd: root, stdio: 'ignore' })
  pass('LOCAL-NOTES.md is git-ignored')
} catch (e) {
  // check-ignore exits 1 when the path is NOT ignored.
  if (e.status === 1) fail('LOCAL-NOTES.md is NOT git-ignored — it would be published')
  else pass('git unavailable; skipped the ignore check')
}

// ---- no machine-specific paths in either file -----------------------------
console.log('')
const machine = /[A-Z]:[\\/](Users|ProgramData|DSHWorkFold)[\\/]/
for (const [name, text] of [['README.md', readme], ['LOCAL-NOTES.md', notes]]) {
  if (machine.test(text)) fail('machine-specific path in ' + name)
  else pass('no machine-specific path in ' + name)
}

console.log('\n' + (bad === 0 ? 'README OK' : 'README HAS ' + bad + ' PROBLEM(S)'))
process.exit(bad === 0 ? 0 : 1)
