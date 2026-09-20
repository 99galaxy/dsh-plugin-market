// Run every guard that covers the SHIPPED artifact, stopping at the first failure.
//
//   node tools/check-all.mjs
//
// Scope is deliberate: only checks that say something about the shipped plugin — the
// package at the repo root. Anything that existed purely to build or verify the
// retired dynamic-plugin form lives on disk but is not part of this suite.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const steps = [
  ['the committed helper matches its source', 'check-sync.mjs'],
  ['the helper runs for real (catalog, TTL, inventory)', 'test-market-core.mjs'],
  ['the install command shape (regression on the pnpm refusal)', 'test-install.mjs'],
  ['the artifact npm would publish actually installs', 'check-publish.mjs'],
  ['host routes in a mock context + client source invariants', 'test-bundle.mjs'],
  ['the three settings tabs render and behave differently', 'test-bundle-tabs.mjs'],
  ['catalog field coverage', 'coverage.mjs'],
  ['README has no stale claims', 'check-readme.mjs'],
  ['the declared screenshots exist and obey the list\'s rules', 'check-screenshots.mjs'],
  ['the local profile agrees with the helper (skips without a profile)', 'check-helper-version.mjs'],
]

let failed = 0
for (const [label, script] of steps) {
  process.stdout.write('--- ' + label + '  (' + script + ')\n')
  try {
    execFileSync(process.execPath, [join(here, script)], { stdio: 'inherit' })
    process.stdout.write('    PASSED\n')
  } catch (e) {
    failed += 1
    process.stdout.write('    FAILED (exit ' + (e.status === undefined || e.status === null ? '?' : e.status) + ')\n')
  }
}

console.log('\n' + (failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'))
process.exit(failed === 0 ? 0 : 1)
