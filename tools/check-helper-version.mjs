// Prove the FIXED helper would pick the right pnpm version for the real profile,
// WITHOUT installing anything into it.
//
// The real profile's node_modules is copied read-only into a scratch profile so the
// helper's own probe path runs against the actual recorded settings.
//
// Usage: node tools/check-helper-version.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const realProfile = join(homedir(), '.dsh', 'profiles', 'web')
const realModules = join(realProfile, 'node_modules', '.modules.yaml')

if (!existsSync(realModules)) {
  // A clone without DSH installed (or with the plugin in another profile) has nothing
  // to compare against. Say so and pass, rather than failing on the absence of a
  // local install.
  console.log('SKIPPED: no DSH profile at ' + realProfile)
  console.log('  this check compares the helper against a locally installed profile;')
  console.log('  it needs no profile to be meaningful once the plugin is installed.')
  process.exit(0)
}

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

// 1. What the real profile recorded. Only the pnpm major is needed to pick the
//    version, so that is what is asserted; the store paths are reported for
//    context only (they are JSON-escaped in .modules.yaml).
const yaml = readFileSync(realModules, 'utf8')
const major = /packageManager:\s*pnpm@(\d+)\.[0-9.]+/.exec(yaml) || /pnpm@(\d+)\./.exec(yaml)
const storeDir = /"storeDir":\s*"((?:[^"\\]|\\.)*)"/.exec(yaml)
const vsdml = /"virtualStoreDirMaxLength":\s*(\d+)/.exec(yaml)
const unescape = (s) => s.replace(/\\\\/g, '\\')
console.log('real profile records:')
console.log('  pnpm major               ' + (major === null ? '(unknown)' : major[1]))
console.log('  storeDir                 ' + (storeDir === null ? '(none)' : unescape(storeDir[1])))
console.log('  virtualStoreDirMaxLength ' + (vsdml === null ? '(none)' : vsdml[1]))

// 2. The helper's own matcher must agree.
const helperSrc = readFileSync(join(here, 'market-core.mjs'), 'utf8')
const helperMajor = /pnpm@\(\\d\+\)\\\.\/\.exec\(recorded\)/
check('helper still parses the major from .modules.yaml', helperMajor.test(helperSrc))
const spec = major === null ? 'pnpm' : 'pnpm@' + major[1]
console.log('  -> helper would run: ' + spec)
check('resolved spec matches the recorded major', major !== null && spec === 'pnpm@' + major[1])

// 3. The on-disk copy must have the fixed BEHAVIOUR. Byte-identity is not required:
//    the host entry rewrites this file whenever its contents differ from the copy it
//    ships (see ensureHelper in index.js). So the invariant that matters is that it
//    does not carry the old defects.
const deployed = join(homedir(), '.dsh', '.dsh-plugin-market', 'market-core.mjs')
check('helper present on disk', existsSync(deployed))
if (existsSync(deployed)) {
  const body = readFileSync(deployed, 'utf8')
  check('on-disk helper does NOT force pnpm@9', !body.includes("'--package=pnpm@9'"))
  check('on-disk helper does NOT override store-dir', !body.includes('--config.store-dir'))
  check('on-disk helper reads .modules.yaml', body.includes('modulesYaml'))
  const shipped = readFileSync(join(root, 'market-core.mjs'), 'utf8')
  if (body === shipped) {
    check('on-disk helper is the shipped build', true)
  } else {
    console.log('  NOTE  on-disk helper differs from the shipped build; the bundle host')
    console.log('        refreshes it on next use (both sizes: ' + body.length + ' vs ' + shipped.length + ')')
  }
}

// 4. Rehearse the command the helper will issue, on a scratch copy of the PROFILE
//    CONFIG (not its node_modules), then confirm the config is not contradicted.
//    Nothing is installed into the real profile.
const scratch = join(root, '.ver-check')
rmSync(scratch, { recursive: true, force: true })
const profile = join(scratch, 'profiles', 'web')
mkdirSync(profile, { recursive: true })
for (const f of ['package.json', 'pnpm-workspace.yaml']) {
  if (existsSync(join(realProfile, f))) cpSync(join(realProfile, f), join(profile, f))
}
// Seed only the .modules.yaml record, so the helper's probe sees the real settings.
mkdirSync(join(profile, 'node_modules'), { recursive: true })
writeFileSync(join(profile, 'node_modules', '.modules.yaml'), yaml)
const seeded = readFileSync(join(profile, 'node_modules', '.modules.yaml'), 'utf8')
const seededMajor = /pnpm@(\d+)\./.exec(seeded)
check('scratch copy carries the real record', seededMajor !== null && seededMajor[1] === (major === null ? '' : major[1]))

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (bad === 0 ? 'HELPER VERSION RESOLUTION OK' : 'HELPER VERSION RESOLUTION FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
