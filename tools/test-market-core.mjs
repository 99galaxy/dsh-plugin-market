// Exercise tools/market-core.mjs the way the Host will: substitute the template
// placeholders, write it to a scratch state dir, and run each command.
//
// Usage: node tools/test-market-core.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptureSync } from './capture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const scratch = join(root, '.core-test')

const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const MIRROR = 'https://gh-proxy.com/'
const CDN = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog@latest/plugins.json'

const src = readFileSync(join(here, 'market-core.mjs'), 'utf8')
  .split('__CATALOG__').join(CATALOG_URL)
  .split('__MIRROR__').join(MIRROR)
  .split('__CDN__').join(CDN)

// A surviving token would only surface as a confusing fetch error at runtime (it
// did: `cdn=Failed to parse URL from __CDN__`), so refuse to test such a script.
const leftover = ['__CATALOG__', '__MIRROR__', '__CDN__'].filter((t) => src.includes(t))
if (leftover.length > 0) {
  console.log('FAIL: these template tokens were not substituted: ' + leftover.join(', '))
  process.exit(2)
}

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
const script = join(scratch, 'market-core.mjs')
writeFileSync(script, src)

const MARKER = '__MARKET_JSON__'
const stateDir = join(scratch, 'state')
const env = Object.assign({}, process.env, { DSH_MARKET_DIR: stateDir, DSH_HOME: join(scratch, 'home') })

function run(args, expectExit = 0) {
  const started = Date.now()
  // Captured through file descriptors, not pipes: DSH's confined sandbox denies
  // piped stdio. See tools/capture.mjs.
  const r = runCaptureSync(process.execPath, [script].concat(args), { env })
  const stdout = r.stdout + r.stderr
  const status = r.error === null || r.error === undefined ? (r.status === null ? 1 : r.status) : 1
  const ms = Date.now() - started
  const line = stdout.split('\n').filter((l) => l.includes(MARKER)).pop() || ''
  let json = null
  if (line) { try { json = JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length)) } catch (e) { json = null } }
  return { status, ms, json, stdout }
}

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

console.log('--- cold catalog (downloads) ---')
const cold = run(['catalog'])
check('exit 0', cold.status === 0, 'status=' + cold.status)
check('printed a parseable summary', cold.json !== null, cold.stdout.slice(-200))
if (cold.json) {
  check('ok=true', cold.json.ok === true, JSON.stringify(cold.json).slice(0, 200))
  check('has plugins', cold.json.count > 1000, 'count=' + cold.json.count)
  check('reported a source', ['official', 'mirror', 'npm'].includes(cold.json.source), cold.json.source)
  check('fromCache=false on cold run', cold.json.fromCache === false, String(cold.json.fromCache))
  check('catalog.json written', existsSync(join(stateDir, 'catalog.json')))
  console.log('       source=' + cold.json.source + ' count=' + cold.json.count + ' bytes=' + cold.json.bytes + ' in ' + cold.ms + 'ms')
}

console.log('\n--- warm catalog (must reuse local) ---')
const warm = run(['catalog'])
check('exit 0', warm.status === 0, 'status=' + warm.status)
if (warm.json) {
  check('fromCache=true', warm.json.fromCache === true, String(warm.json.fromCache))
  check('served the same count', warm.json.count === (cold.json && cold.json.count), String(warm.json.count))
  check('warm run is fast', warm.ms < cold.ms, warm.ms + 'ms vs ' + cold.ms + 'ms cold')
  console.log('       ageMs=' + warm.json.ageMs + ' in ' + warm.ms + 'ms')
}

console.log('\n--- --force 1 (must refetch) ---')
const forced = run(['catalog', '--force', '1'])
check('exit 0', forced.status === 0, 'status=' + forced.status)
if (forced.json) check('fromCache=false', forced.json.fromCache === false, String(forced.json.fromCache))

console.log('\n--- installed ---')
// Give the scratch HOME a realistic profile: declared deps (one npm, one GitHub
// spec) plus node_modules directories, including a scoped package.
const fakeHome = join(scratch, 'home')
const profileDir = join(fakeHome, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@scope', 'pkg'), { recursive: true })
mkdirSync(join(profileDir, 'node_modules', 'plain-dep'), { recursive: true })
// The two installed packages carry a version; `gh-dep` has no directory at all, so
// its version must come back missing rather than invented.
writeFileSync(join(profileDir, 'node_modules', 'plain-dep', 'package.json'),
  JSON.stringify({ name: 'plain-dep', version: '1.2.3' }))
writeFileSync(join(profileDir, 'node_modules', '@scope', 'pkg', 'package.json'),
  JSON.stringify({ name: '@scope/pkg', version: '2.0.1' }))
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'web',
  dependencies: {
    'plain-dep': '^1.0.0',
    'gh-dep': 'github:someowner/somerepo',
    '@scope/pkg': '^2.0.0',
  },
  dsh: { profile: { bundles: ['plain-dep'] } },
}, null, 2))

const inst = run(['installed', '--profile', 'web'])
check('exit 0', inst.status === 0, 'status=' + inst.status)
if (inst.json) {
  console.log('       ' + JSON.stringify(inst.json))
  check('reports the profile', inst.json.profile === 'web', String(inst.json.profile))
  check('found all three deps', inst.json.specCount === 3, 'specCount=' + inst.json.specCount)
  check('found the node_modules dirs', inst.json.dirCount === 2, 'dirCount=' + inst.json.dirCount)
  check('listed every spec name', Array.isArray(inst.json.specs) && inst.json.specs.length === 3, JSON.stringify(inst.json.specs))
  const written = JSON.parse(readFileSync(join(stateDir, 'installed.json'), 'utf8'))
  // The VALUE must be the recorded spec, not the name. The host half reads the
  // github URL back out of it to build its repo table; name -> name leaves that
  // table empty, so the ~46% of catalog entries whose install command is
  // `dsh plugin add github:owner/repo` could never be marked as installed.
  check('wrote installed.json keeping the GitHub spec',
    written.specs && written.specs['gh-dep'] === 'github:someowner/somerepo', JSON.stringify(written.specs))
  check('wrote installed.json keeping a plain spec',
    written.specs && written.specs['plain-dep'] === '^1.0.0', JSON.stringify(written.specs))
  check('recorded dsh.profile.bundles', JSON.stringify(written.bundles) === '["plain-dep"]', JSON.stringify(written.bundles))
  check('recorded scoped dir name', written.dirNames.includes('@scope/pkg'), JSON.stringify(written.dirNames))
  // Installed versions, for the market's update check. Without these the host can
  // only say "cannot judge", which is exactly what it must not do by default.
  check('recorded the installed version of a plain dep',
    written.versions && written.versions['plain-dep'] === '1.2.3', JSON.stringify(written.versions))
  check('recorded the installed version of a scoped dep',
    written.versions && written.versions['@scope/pkg'] === '2.0.1', JSON.stringify(written.versions))
  check('invented no version for the package that is not installed',
    written.versions && written.versions['gh-dep'] === undefined, JSON.stringify(written.versions))
  check('reported the version count', inst.json.versionCount === 2, String(inst.json.versionCount))
}

console.log('\n--- unknown action (must fail loudly) ---')
const bogus = run(['nope'])
check('non-zero exit', bogus.status !== 0, 'status=' + bogus.status)

console.log('\n--- catalog entry shape ---')
if (existsSync(join(stateDir, 'catalog.json'))) {
  const d = JSON.parse(readFileSync(join(stateDir, 'catalog.json'), 'utf8'))
  const e = (d.plugins || [])[0] || {}
  const need = ['name', 'owner', 'url', 'page', 'category', 'zh', 'en', 'npm', 'version', 'stars', 'downloads', 'install', 'added']
  const missing = need.filter((k) => !(k in e))
  check('every field the UI reads is present', missing.length === 0, missing.join(','))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (bad === 0 ? 'MARKET-CORE TEST PASSED' : 'MARKET-CORE TEST FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
