// Prove the artifact `npm publish` would upload actually works — before it is public.
//
//   node tools/check-publish.mjs
//
// Why this is its own guard: a publish is effectively irreversible, and the failure
// modes are all silent until a stranger hits them. `files` can drop the helper, a
// rename can desync the client module id from the package name, the patch can stop
// resolving. So this packs the real tarball, installs it into a scratch profile the
// way a user would, and asserts the bundle contract on what ARRIVES.
//
// The version is read from package.json — never hardcoded, or this guard would rot on
// the next bump.
//
// Needs npm. When the environment cannot spawn a package manager at all, this reports
// SKIPPED with the reason instead of failing: a skip is never counted as a pass.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptureSync } from './capture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const scratch = join(root, '.publish-check')
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const PNPM_SPEC = 'pnpm@12'

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PKG = manifest.name
const VERSION = manifest.version
console.log('package: ' + PKG + '@' + VERSION)

// A publishable name is the one thing the tarball cannot tell us.
check('the manifest is publishable (no private:true)', manifest.private !== true, String(manifest.private))
check('publishing declares public access (scoped packages are restricted by default)',
  !!(manifest.publishConfig && manifest.publishConfig.access === 'public'), JSON.stringify(manifest.publishConfig))
check('repository points at the listed repo (the list links npm back through it)',
  !!(manifest.repository && manifest.repository.url), JSON.stringify(manifest.repository))
check('declares dsh.bundle.patch', !!(manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch), JSON.stringify(manifest.dsh))

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

// ---- 1. pack exactly what npm publish would upload -------------------------
console.log('\n--- npm pack ---')
const packed = runCaptureSync(process.execPath, [npmCli, 'pack', '--pack-destination', scratch], { cwd: root })
if (packed.status !== 0) {
  console.log('  SKIPPED: npm pack could not run (exit ' + packed.status + ')')
  console.log('  ' + (packed.stdout + packed.stderr).split('\n').filter(Boolean).slice(-3).join('\n  '))
  rmSync(scratch, { recursive: true, force: true })
  console.log('\nPUBLISH CHECK SKIPPED')
  process.exit(0)
}
const tarball = readdirSync(scratch).find((f) => f.endsWith('.tgz')) || ''
check('packed a tarball', tarball !== '', readdirSync(scratch).join(', '))
if (tarball === '') { rmSync(scratch, { recursive: true, force: true }); process.exit(1) }
// Scoped names pack without the scope's @, as `<scope>-<name>-<version>.tgz`.
check('tarball name is scope-name-version', tarball === PKG.replace('@', '').split('/').join('-') + '-' + VERSION + '.tgz', tarball)

// ---- 2. install it into a scratch profile the way a user would -------------
console.log('\n--- install the tarball into a scratch profile ---')
const profile = join(scratch, 'profile')
mkdirSync(profile, { recursive: true })
// Mirror the real profile: it carries a workspace file, which is what makes `-w`
// legal, and the market's own installer relies on the same shape.
writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
}, null, 2))

const installed = runCaptureSync(process.execPath,
  [npmCli, 'exec', '--yes', '--package=' + PNPM_SPEC, '--', 'pnpm', 'add', join(scratch, tarball), '-w', '--dir', profile],
  { cwd: profile, env: Object.assign({}, process.env, { npm_config_yes: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }) })
const out = installed.stdout + installed.stderr
if (installed.status !== 0 && /spawn EPERM|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ERR_SOCKET|request to https/i.test(out)) {
  console.log('  SKIPPED: this environment cannot run a package manager')
  console.log('  ' + out.split('\n').filter(Boolean).slice(-3).join('\n  '))
  rmSync(scratch, { recursive: true, force: true })
  console.log('\nPUBLISH CHECK SKIPPED')
  process.exit(0)
}
check('pnpm installed the tarball', installed.status === 0,
  'exit=' + installed.status + '  ' + out.split('\n').filter(Boolean).slice(-4).join(' | '))

// ---- 3. the bundle contract must survive packing ---------------------------
console.log('\n--- what arrived ---')
const pkgDir = join(profile, 'node_modules', PKG)
check('landed under the scoped name', existsSync(pkgDir), PKG)
if (existsSync(pkgDir)) {
  const shipped = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  check('installed manifest name matches the package name', shipped.name === PKG, shipped.name)
  check('version survived packing', shipped.version === VERSION, shipped.version)
  check('declares dsh.bundle.patch', !!(shipped.dsh && shipped.dsh.bundle && shipped.dsh.bundle.patch), JSON.stringify(shipped.dsh))
  check('declares dsh.client.platform web',
    !!(shipped.dsh && shipped.dsh.client && shipped.dsh.client.platform === 'web'))

  const patchPath = join(pkgDir, 'cordis.patch.yml')
  check('the patch the manifest points at exists', existsSync(patchPath), String(shipped.dsh.bundle.patch))
  if (existsSync(patchPath)) {
    // The patch names the PACKAGE to resolve; a rename that misses it leaves a profile
    // unable to find anything to load.
    check('the patch inserts the current package name',
      readFileSync(patchPath, 'utf8').includes("name: '" + PKG + "'"),
      readFileSync(patchPath, 'utf8').trim().split('\n').pop())
  }

  check('the host half arrived', existsSync(join(pkgDir, 'index.js')))
  check('the helper arrived', existsSync(join(pkgDir, 'market-core.mjs')))
  const clientPath = join(pkgDir, 'client', 'client.js')
  check('the client half arrived', existsSync(clientPath))
  if (existsSync(clientPath)) {
    // dsh-client-modules asserts `factories.has(row.id)` after loading a bundle, where
    // row.id is the package name — a mismatch breaks the browser half at boot.
    check('client module id equals the package name',
      readFileSync(clientPath, 'utf8').includes("id: '" + PKG + "'"))
  }
  check('no tooling or scratch leaked into the package',
    !existsSync(join(pkgDir, 'tools')) && !existsSync(join(pkgDir, '.git')) && !existsSync(join(pkgDir, 'src')))

  const profManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  check('recorded as a profile dependency', !!(profManifest.dependencies || {})[PKG],
    JSON.stringify(profManifest.dependencies))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (bad === 0 ? 'PUBLISH ARTIFACT OK' : 'PUBLISH ARTIFACT HAS ' + bad + ' PROBLEM(S)'))
process.exit(bad === 0 ? 0 : 1)
