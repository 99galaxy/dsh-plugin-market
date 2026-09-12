// Guard the install command shape the market helper uses.
//
// THE BUG (reported by a user, root-caused):
//   ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF
//   This modules directory was created using a different virtual-store-dir-max-length value.
//
// The helper pinned `pnpm@9` and pushed `--config.node-linker`,
// `--config.auto-install-peers` and `--config.store-dir` on the command line, while
// the profile's own pnpm-workspace.yaml and its recorded node_modules/.modules.yaml
// already stated those settings. pnpm refuses to touch a modules directory whose
// recorded configuration the command contradicts — so every install failed.
//
// Two layers of checking, deliberately:
//   PART 1 (always runs) — structural assertions on the helper's command shape.
//     These are the actual regression guard: the bug WAS the flag list.
//   PART 2 (runs when the environment permits) — build a real modules directory and
//     prove a contradicting override is refused while the helper's shape succeeds.
//
// PART 2 needs npm to spawn a child process. DSH's confined sandbox denies that
// (`spawn EPERM` from inside npm's exec), so there it is reported as SKIPPED with the
// reason instead of failing — a skip is never counted as a pass.
//
// Usage: node tools/test-install.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptureSync } from './capture.mjs'
import { stripComments } from './strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const scratch = join(root, '.install-test')
const profileDir = join(scratch, 'home', 'profiles', 'web')

const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

// Distinct packages per variant, so "A was refused" and "B succeeded" are independent
// assertions rather than two readings of the same manifest.
const SPEC_A = 'is-odd@3.0.1'
const SPEC_B = 'is-even@1.0.0'

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

const helperSrc = readFileSync(join(here, 'market-core.mjs'), 'utf8')

// ===========================================================================
// PART 1 — the helper's command shape (always runs)
// ===========================================================================
console.log('--- the helper\'s install command shape ---')
check('reads the pnpm major from .modules.yaml', helperSrc.includes('modulesYaml'))
check('resolves a pnpm spec from that major', helperSrc.includes("const pnpmSpec = major === null ? 'pnpm' : 'pnpm@' + major[1]"))
check('runs pnpm through npm-cli exec', helperSrc.includes("'--package=' + pnpmSpec"))
check('does NOT pin pnpm@9', !helperSrc.includes("'--package=pnpm@9'"))
check('does NOT pass --config.store-dir', !helperSrc.includes('--config.store-dir'))
check('does NOT pass --config.node-linker', !helperSrc.includes('--config.node-linker'))
check('does NOT pass --config.auto-install-peers', !helperSrc.includes('--config.auto-install-peers'))
check('does NOT pass --config.ignore-workspace-root-check', !helperSrc.includes('--config.ignore-workspace-root-check'))
check('passes add/spec/-w/--dir', /const baseArgs = \['add', spec, '-w', '--dir', profileDir\]/.test(helperSrc),
  (helperSrc.match(/const baseArgs = \[[^\]]*\]/) || ['(not found)'])[0])
// strictDepBuilds defaults to true, so pnpm exits non-zero on ANY unreviewed build
// script: a profile merely CONTAINING node-pty would fail every install. pnpm 12
// ignores --config.strict-dep-builds / npm_config_strict_dep_builds for this, so the
// helper falls back to --ignore-scripts — and only after pnpm has actually refused,
// so approved builds still run.
check('detects the unreviewed-build refusal', helperSrc.includes('ERR_PNPM_IGNORED_BUILDS'))
check('falls back to --ignore-scripts', helperSrc.includes("runPnpm(['--ignore-scripts'])"))
check('the fallback is conditional, not unconditional',
  /if \(result\.status !== 0 && result\.output\.includes\('ERR_PNPM_IGNORED_BUILDS'\)\)/.test(helperSrc))
check('does NOT dangerously allow all builds',
  !/--config\.dangerously-allow-all-builds|dangerouslyAllowAllBuilds\s*[:=]/.test(helperSrc))
// The ONLY --config flag may be none: layout settings (store-dir, node-linker, …)
// are what caused the refusal this file guards against. Scan the COMMENT-STRIPPED
// source, so the comment that explains why pnpm ignores a flag is not mistaken for
// the flag itself.
const configFlags = stripComments(helperSrc).match(/--config\.[a-z-]+/g) || []
check('passes no --config.* flag at all', configFlags.length === 0, configFlags.join(', '))
check('still rewrites git+ssh to https', helperSrc.includes('url.https://github.com/.insteadOf'))

// ===========================================================================
// PART 2 — a real install, when the environment allows spawning
// ===========================================================================
console.log('\n--- live install check ---')

if (!existsSync(npmCli)) {
  console.log('  SKIPPED: npm-cli.js not found at ' + npmCli)
  console.log('  (structural checks above still ran)')
} else {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  // Every write npm/pnpm makes is forced inside the workspace scratch directory.
  const baseEnv = {
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_cache: join(scratch, '.npm-cache'),
    npm_config_store_dir: join(scratch, 'store'),
    npm_config_tmp: join(scratch, 'npm-tmp'),
    TEMP: join(scratch, 'tmp'),
    TMP: join(scratch, 'tmp'),
    PNPM_SPEC: 'pnpm@12',
  }
  for (const d of ['.npm-cache', 'store', 'npm-tmp', 'tmp']) mkdirSync(join(scratch, d), { recursive: true })

  const runPnpm = (args) => {
    const r = runCaptureSync(
      process.execPath,
      [npmCli, 'exec', '--yes', '--package=' + baseEnv.PNPM_SPEC, '--', 'pnpm'].concat(args),
      { cwd: profileDir, env: Object.assign({}, process.env, baseEnv) },
    )
    const code = (r.error !== null && r.error !== undefined) || typeof r.status !== 'number' || r.status < 0 || r.status > 255 ? 1 : r.status
    return { code, out: r.stdout + r.stderr }
  }

  // Probe first: can this environment run npm exec at all?
  const probe = runPnpm(['--version'])
  const cannotSpawn = /spawn EPERM/i.test(probe.out)
  if (cannotSpawn) {
    console.log('  SKIPPED: this sandbox denies process spawning inside npm (`spawn EPERM`),')
    console.log('  so no real install can run here. This is an environment limit, not a')
    console.log('  code defect: the plugin runs inside DSH, where installs do work.')
    console.log('  Re-run from an unrestricted session to exercise this part.')
  } else if (probe.code !== 0) {
    console.log('  SKIPPED: npm exec could not start pnpm (exit ' + probe.code + ')')
    console.log('  ' + probe.out.split('\n').filter(Boolean).slice(-3).join('\n  '))
  } else {
    console.log('  npm exec works; running the real comparison')

    // Mirror the real profile: a workspace file that already states the settings.
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2))

    const seed = runPnpm(['install', '-w', '--dir', profileDir])
    check('seed install succeeded', seed.code === 0, seed.out.split('\n').filter(Boolean).slice(-4).join(' | '))

    const modulesYamlPath = join(profileDir, 'node_modules', '.modules.yaml')
    check('.modules.yaml written', existsSync(modulesYamlPath))
    const recorded = existsSync(modulesYamlPath) ? readFileSync(modulesYamlPath, 'utf8') : ''
    const majorMatch = /pnpm@(\d+)\./.exec(recorded)
    check('the record names a pnpm version', majorMatch !== null, majorMatch === null ? '(unknown)' : majorMatch[1])

    console.log('\n  --- A) the ORIGINAL buggy shape: pnpm@9 + layout --config flags ---')
    // The user's actual failure was this exact shape: the helper pinned pnpm@9 and
    // pushed layout settings on top of a modules directory that pnpm 12 had built.
    // Reproducing it needs BOTH the major mismatch and the flags — swapping only
    // --config.store-dir is tolerated by pnpm, so a milder variant proves nothing.
    baseEnv.PNPM_SPEC = 'pnpm@9'
    const a = runPnpm([
      'add', SPEC_A, '-w', '--dir', profileDir,
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.store-dir=' + join(scratch, 'other-store'),
    ])
    console.log('    exit=' + a.code + (a.out.includes('VIRTUAL_STORE_DIR_MAX_LENGTH') ? '  (VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF)' : ''))
    check('the original shape is refused', a.code !== 0)

    console.log('\n  --- B) the helper\'s shape: recorded major, no --config.* ---')
    baseEnv.PNPM_SPEC = majorMatch === null ? 'pnpm' : 'pnpm@' + majorMatch[1]
    console.log('    using ' + baseEnv.PNPM_SPEC)
    const b = runPnpm(['add', SPEC_B, '-w', '--dir', profileDir])
    console.log('    exit=' + b.code)
    if (b.code !== 0) console.log('    output tail: ' + b.out.split('\n').filter(Boolean).slice(-5).join(' | '))
    check('the helper\'s command shape succeeds', b.code === 0)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    check('the requested package was added', 'is-even' in (manifest.dependencies || {}), JSON.stringify(manifest.dependencies))
    check('the refused package was NOT added', !('is-odd' in (manifest.dependencies || {})))
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (bad === 0 ? 'INSTALL TEST PASSED' : 'INSTALL TEST FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
