// Offline regressions for inventory isolation, activation, and mutation exclusion.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-market-review-'))
const home = join(scratch, 'home')
const state = join(scratch, 'state')
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? ' -> ' + detail : ''))
}
const write = (path, value) => writeFileSync(path, JSON.stringify(value))
process.env.DSH_HOME = home
process.env.DSH_MARKET_DIR = state
for (const key of ['DSH_PROFILE', 'DSH_PACKAGE_MANAGER_COMMAND', 'DSH_PACKAGE_MANAGER_ARGS', 'DSH_PACKAGE_MANAGER_ENV']) delete process.env[key]
mkdirSync(state, { recursive: true })
for (const [profile, name] of [['web', 'web-only'], ['desktop', 'desktop-only']]) {
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  write(join(dir, 'package.json'), {
    name: profile, private: true,
    dependencies: {
      [name]: '1.0.0', dormant: '1.0.0', '@review/dormant': '1.0.0',
      'update-target': '^1.0.0',
      'git-a': 'github:review/mono#path:packages/a',
      'git-b': 'github:review/mono#path:packages/b',
    },
    dsh: { profile: { bundles: [name] } },
  })
  for (const pkg of [name, 'dormant', '@review/dormant', 'update-target', 'git-a', 'git-b']) {
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true })
    write(join(dir, 'node_modules', pkg, 'package.json'), {
      name: pkg, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  }
}
write(join(state, 'catalog.json'), {
  fetchedAt: Date.now(), categories: {},
  plugins: [
    { name: 'web-only', version: '1.0.0', install: 'dsh plugin add web-only' },
    { name: 'desktop-only', version: '1.0.0', install: 'dsh plugin add desktop-only' },
    { name: 'update-target', version: '1.2.0', install: 'dsh plugin add update-target' },
    { name: 'git-a', url: 'https://github.com/review/mono', version: '2.0.0', install: 'dsh plugin add github:review/mono#path:packages/a' },
  ],
})
const manager = `
const fs = require('node:fs');
const args = process.argv.slice(1);
fs.appendFileSync('manager-args.log', JSON.stringify(args) + '\\n');
const aliases = {
  'github:review/mono#path:packages/a': 'git-a',
};
const spec = args[1];
let name = aliases[spec] || spec;
let version = '1.0.0';
const versioned = /^(@[^/]+\\/[^@]+|[^@]+)@([^@]+)$/.exec(name);
if (versioned) { name = versioned[1]; version = versioned[2]; }
const manifest = JSON.parse(fs.readFileSync('package.json'));
manifest.dependencies[name] = spec.startsWith('github:') ? spec : '^' + version;
fs.writeFileSync('package.json', JSON.stringify(manifest));
fs.mkdirSync('node_modules/' + name, { recursive: true });
fs.writeFileSync('node_modules/' + name + '/package.json', JSON.stringify({name, version, dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
`
let entered, release
const started = new Promise(resolve => { entered = resolve })
const gate = new Promise(resolve => { release = resolve })
const hmr = { runExclusive: fn => fn(), reconcileProfile: async () => { entered(); await gate; return { warnings: [], pending: [] } } }
async function makeHost (profile) {
  const routes = new Map()
  const profileContext = { name: profile, packageManager: { command: process.execPath, args: ['-e', manager], env: {} } }
  const ctx = {
    get: name => ({ profileContext, hmr })[name],
    effect: fn => fn(), inject: (deps, fn) => fn(ctx),
    webServer: { register: route => { routes.set(route.path, route); return () => {} } },
  }
  const mod = await import(new URL('../index.js?review=' + profile, import.meta.url))
  mod.apply(ctx)
  return async (route, body = {}) => {
    let status, result
    const response = { writeHead: code => { status = code }, end: text => { result = JSON.parse(text) } }
    const request = {
      method: route === 'list' ? 'GET' : 'POST', url: '/dsh-plugin-market/' + route + '?only=installed&limit=100',
      headers: { 'content-type': 'application/json' },
      on: (event, fn) => { if (event === 'data') fn(Buffer.from(JSON.stringify(body))); if (event === 'end') fn() },
    }
    await routes.get('/dsh-plugin-market/' + route).handler(request, response)
    return { status, ...result }
  }
}
try {
  const web = await makeHost('web'), desktop = await makeHost('desktop')
  await web('list')
  await desktop('list')
  const again = await web('list')
  check('web inventory remains isolated after a desktop request', again.payload.items.map(x => x.name).join(',') === 'web-only,update-target,git-a', JSON.stringify(again.payload.items.map(x => x.name)))
  const inventoryPath = join(state, 'installed', 'web.json')
  const ownSnapshot = readFileSync(inventoryPath, 'utf8')
  const foreignSnapshot = JSON.parse(ownSnapshot)
  foreignSnapshot.profile = 'desktop'
  write(inventoryPath, foreignSnapshot)
  const foreign = await web('list')
  check('a snapshot with the wrong profile owner is never used', foreign.payload.items.length === 0)
  writeFileSync(inventoryPath, ownSnapshot)

  const reload = web('reload')
  await started
  const blocked = await web('install', { install: 'dsh plugin add newplugin' })
  check('install is refused while profile reload is pending', blocked.status === 409, String(blocked.status))
  check('a second reload is refused while reload is pending', (await web('reload')).status === 409)
  release()
  await reload
  const installing = web('install', { install: 'dsh plugin add newplugin' })
  await Promise.resolve()
  const duringInstall = await web('reload')
  check('reload is refused while installation is pending', duringInstall.status === 409)
  const installed = await installing
  check('install works after profile reload completes', installed.ok === true)
  const manifestPath = join(home, 'profiles', 'web', 'package.json')
  let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('new target bundle is enabled', manifest.dsh.profile.bundles.includes('newplugin'))
  check('unrelated disabled bundle stays disabled', !manifest.dsh.profile.bundles.includes('dormant'))
  await web('install', { install: 'dsh plugin add dormant@1.0.0' })
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('explicit reinstall enables its target bundle', manifest.dsh.profile.bundles.includes('dormant'))
  await web('install', { install: 'dsh plugin add @review/dormant@1.0.0' })
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('a scoped versioned reinstall enables its target', manifest.dsh.profile.bundles.includes('@review/dormant'))
  await web('install', { install: 'dsh plugin add github:review/mono#path:packages/a' })
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('a GitHub subdirectory reinstall enables its target', manifest.dsh.profile.bundles.includes('git-a'))
  check('a sibling GitHub bundle remains disabled', !manifest.dsh.profile.bundles.includes('git-b'))
  await web('install', { install: 'dsh plugin add update-target', update: true })
  const updatedVersion = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'node_modules', 'update-target', 'package.json'), 'utf8')).version
  check('an update request installs the catalog version instead of preserving the old range', updatedVersion === '1.2.0', updatedVersion)
  await web('install', { install: 'dsh plugin add github:review/mono#path:packages/a', update: true })
  const managerCalls = readFileSync(join(home, 'profiles', 'web', 'manager-args.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const gitUpdate = managerCalls.at(-1)
  check('a non-registry update forces pnpm to resolve it again', gitUpdate.includes('--force'), JSON.stringify(gitUpdate))

  const clone = join(scratch, 'clone')
  mkdirSync(join(clone, 'tools'), { recursive: true })
  for (const file of ['README.md', 'tools/check-readme.mjs', 'tools/coverage.mjs', 'tools/check-helper-version.mjs']) {
    writeFileSync(join(clone, file), readFileSync(new URL('../' + file, import.meta.url)))
  }
  const env = { ...process.env, DSH_HOME: join(scratch, 'empty-home'), DSH_MARKET_DIR: join(scratch, 'empty-state') }
  const notesCheck = spawnSync(process.execPath, [join(clone, 'tools/check-readme.mjs')], { cwd: clone, env, encoding: 'utf8' })
  check('README checks work without local-only notes', notesCheck.status === 0 && notesCheck.stdout.includes('SKIPPED'), notesCheck.stdout.split('\n').filter(x => x.includes('FAIL')).join('; '))
  const coverageCheck = spawnSync(process.execPath, [join(clone, 'tools/coverage.mjs')], { cwd: clone, env, encoding: 'utf8' })
  check('catalog coverage explicitly skips when no local cache exists', coverageCheck.status === 0 && coverageCheck.stdout.includes('SKIPPED'), coverageCheck.stdout.trim())
  const helperCheck = spawnSync(process.execPath, [join(clone, 'tools/check-helper-version.mjs')], { cwd: clone, env, encoding: 'utf8' })
  check('local profile checks respect the configured empty DSH home', helperCheck.status === 0 && helperCheck.stdout.includes('SKIPPED'), helperCheck.stdout.trim().slice(0, 200))
} finally {
  release()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(bad === 0 ? 'REVIEW REGRESSIONS PASSED' : `${bad} REVIEW REGRESSION(S) FAILED`)
process.exitCode = bad === 0 ? 0 : 1
