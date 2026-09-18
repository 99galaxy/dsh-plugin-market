// Install the permanent bundle into a DSH profile, with a provable rollback.
//
// Order is deliberate: back up the two files pnpm will rewrite, THEN install, then
// report. tools/rollback-bundle.mjs restores the backup.
//
// Usage:
//   node tools/install-bundle.mjs            # show what would happen
//   node tools/install-bundle.mjs --apply    # actually install
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { runCaptureSync } from './capture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
// The plugin package IS the repo root, so it also installs from GitHub directly
// (`pnpm add github:<owner>/<repo>`). pnpm packs a directory dependency through the
// package's `files` field, so tools/ and .git/ never reach node_modules.
const pkgDir = root
const profileDir = join(homedir(), '.dsh', 'profiles', 'web')
const backupDir = join(here, '.bundle-backup')
const APPLY = process.argv.includes('--apply')

const PKG_NAME = '@99galaxy/dsh-plugin-market'
const backupFiles = ['package.json', 'pnpm-lock.yaml']

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

function runPnpm (args) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) throw new Error('npm-cli.js not found: ' + npmCli)
  // Use the profile's recorded pnpm major, exactly as the market's own installer does.
  let spec = 'pnpm'
  try {
    const y = readFileSync(join(profileDir, 'node_modules', '.modules.yaml'), 'utf8')
    const m = /pnpm@(\d+)\./.exec(y)
    if (m !== null) spec = 'pnpm@' + m[1]
  } catch (e) { /* default to latest */ }
  console.log('  running: npx --yes ' + spec + ' ' + args.join(' '))
  // Output is captured through file descriptors (never pipes, and never a shell) so
  // it can be inspected for pnpm's refusal code; it is echoed afterwards.
  const r = runCaptureSync(
    process.execPath,
    [npmCli, 'exec', '--yes', '--package=' + spec, '--', 'pnpm'].concat(args),
    { cwd: profileDir, env: Object.assign({}, process.env, { npm_config_yes: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }) },
  )
  const output = r.stdout + r.stderr
  if (output !== '') process.stdout.write(output)
  const status = (r.error !== null && r.error !== undefined) || typeof r.status !== 'number' ? 1 : r.status
  return { status, output }
}

// ---- preconditions ---------------------------------------------------------
console.log('--- package under test ---')
for (const f of ['package.json', 'cordis.patch.yml', 'index.js', 'market-core.mjs', join('client', 'client.js')]) {
  check(f + ' exists', existsSync(join(pkgDir, f)))
}
const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
check('declares dsh.bundle.patch', pkgJson.dsh && pkgJson.dsh.bundle && pkgJson.dsh.bundle.patch === './cordis.patch.yml', JSON.stringify(pkgJson.dsh))
check('declares dsh.client.platform web', pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.platform === 'web')
check('exports ./client', pkgJson.exports && pkgJson.exports['./client'] === './client/client.js')
check('package name', pkgJson.name === PKG_NAME, pkgJson.name)

console.log('\n--- profile ---')
check('profile exists', existsSync(profileDir), profileDir)
const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
console.log('  bundles now: ' + ((profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || []).join(', '))
const already = !!((profilePkg.dependencies || {})[PKG_NAME])
console.log('  already a dependency: ' + already)

if (bad > 0) {
  console.log('\nPRECONDITIONS FAILED (' + bad + ') — nothing changed')
  process.exit(1)
}

if (!APPLY) {
  console.log('\nDRY RUN. Nothing was changed.')
  console.log('Re-run with --apply to install into ' + profileDir)
  process.exit(0)
}

// ---- backup ---------------------------------------------------------------
console.log('\n--- backup ---')
mkdirSync(backupDir, { recursive: true })
for (const f of backupFiles) {
  const src = join(profileDir, f)
  if (!existsSync(src)) { console.log('  (no ' + f + ' to back up)'); continue }
  copyFileSync(src, join(backupDir, f))
  console.log('  saved ' + f + ' (' + readFileSync(src).length + ' bytes)')
}
writeFileSync(join(backupDir, 'profile.txt'), profileDir)
console.log('  rollback: node tools/rollback-bundle.mjs')

// ---- install --------------------------------------------------------------
console.log('\n--- pnpm add ---')
let install = runPnpm(['add', 'file:' + pkgDir, '-w', '--dir', profileDir])

// strictDepBuilds defaults to true, so pnpm EXITS NON-ZERO when any dependency has
// an unreviewed build script — a profile merely containing one (node-pty here) would
// otherwise make every install impossible. pnpm 12 ignores
// --config.strict-dep-builds / npm_config_strict_dep_builds for this, so retry with
// --ignore-scripts, which is only reached after pnpm has actually refused (an
// approved build still runs on the first attempt).
if (install.status !== 0 && install.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
  console.log('  pnpm refused: a dependency has an unreviewed build script.')
  console.log('  retrying with --ignore-scripts (nothing is built, nothing is approved)')
  install = runPnpm(['add', 'file:' + pkgDir, '-w', '--dir', profileDir, '--ignore-scripts'])
}
if (install.status !== 0) {
  console.log('\nINSTALL FAILED (exit ' + install.status + ')')
  console.log('The profile manifest may be half-updated; restore it with:')
  console.log('  node tools/rollback-bundle.mjs')
  process.exit(1)
}

// ---- add to the bundle layer list -----------------------------------------
console.log('\n--- dsh.profile.bundles ---')
const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const deps = after.dependencies || {}
const declaresBundle = (() => {
  try {
    const m = JSON.parse(readFileSync(join(profileDir, 'node_modules', PKG_NAME, 'package.json'), 'utf8'))
    return !!(m.dsh && m.dsh.bundle)
  } catch (e) { return false }
})()
check('installed into node_modules', existsSync(join(profileDir, 'node_modules', PKG_NAME)))
check('dependency recorded', !!deps[PKG_NAME], JSON.stringify(deps[PKG_NAME]))
check('declares dsh.bundle after install', declaresBundle)

const bundles = (after.dsh && after.dsh.profile && after.dsh.profile.bundles) || []
if (declaresBundle && bundles.indexOf(PKG_NAME) < 0) {
  bundles.push(PKG_NAME)
  after.dsh = Object.assign({}, after.dsh, {
    profile: Object.assign({}, after.dsh && after.dsh.profile, { bundles: bundles }),
  })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(after, null, 2) + '\n')
  console.log('  added ' + PKG_NAME + ' to dsh.profile.bundles')
} else if (bundles.indexOf(PKG_NAME) >= 0) {
  console.log('  already listed in dsh.profile.bundles')
} else {
  console.log('  NOT added: the installed package does not declare dsh.bundle')
}
console.log('  bundles now: ' + bundles.join(', '))

console.log('\n' + (bad === 0 ? 'INSTALL COMPLETE — restart DSH to load it' : 'INSTALL HAD PROBLEMS (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
