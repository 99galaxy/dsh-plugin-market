// Restore the profile manifest a bundle install rewrote, then remove the package.
//
// The backup is written by tools/install-bundle.mjs before pnpm runs, so this is
// the documented way out if the bundle misbehaves (for example if it breaks profile
// boot and DSH no longer starts).
//
// Usage: node tools/rollback-bundle.mjs [--force]
import { readFileSync, copyFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const backupDir = join(here, '.bundle-backup')
const PKG_NAME = 'dsh-plugin-market'

if (!existsSync(backupDir)) {
  console.log('no backup at ' + backupDir)
  console.log('nothing to roll back (install-bundle.mjs writes one before it changes anything)')
  process.exit(1)
}

const profileTxt = join(backupDir, 'profile.txt')
const profileDir = existsSync(profileTxt) ? readFileSync(profileTxt, 'utf8').trim() : join(homedir(), '.dsh', 'profiles', 'web')
console.log('restoring ' + profileDir)

for (const f of ['package.json', 'pnpm-lock.yaml']) {
  const src = join(backupDir, f)
  if (!existsSync(src)) { console.log('  (no backed-up ' + f + ')'); continue }
  copyFileSync(src, join(profileDir, f))
  console.log('  restored ' + f)
}

// Remove the installed copy so a stale node_modules entry cannot shadow the restore.
const installed = join(profileDir, 'node_modules', PKG_NAME)
if (existsSync(installed)) {
  try {
    rmSync(installed, { recursive: true, force: true })
    console.log('  removed node_modules/' + PKG_NAME)
  } catch (e) {
    console.log('  could not remove node_modules/' + PKG_NAME + ': ' + (e && e.message))
  }
}

console.log('\nrestored profile manifest:')
const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
console.log('  dependencies: ' + Object.keys(pkg.dependencies || {}).join(', '))
console.log('  bundles:      ' + (((pkg.dsh || {}).profile || {}).bundles || []).join(', '))
console.log('\nRestart DSH. If it still fails to boot, remove the backup dir listing above and check cordis.patch.yml.')
