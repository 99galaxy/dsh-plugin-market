// A stale catalog must never block the first page behind a network refresh.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-market-latency-'))
const pluginDir = join(scratch, 'plugin')
const home = join(scratch, 'home')
const state = join(scratch, 'state')
const profile = join(home, 'profiles', 'web')
mkdirSync(pluginDir, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(state, { recursive: true })
copyFileSync(new URL('../index.js', import.meta.url), join(pluginDir, 'index.js'))
writeFileSync(join(pluginDir, 'market-core.mjs'), String.raw`
import fs from 'node:fs'
import path from 'node:path'
const action = process.argv[2]
const state = process.env.DSH_MARKET_DIR
const home = process.env.DSH_HOME
const profile = process.env.DSH_PROFILE || 'web'
if (action === 'catalog') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
  fs.writeFileSync(path.join(state, 'catalog.json'), JSON.stringify({
    fetchedAt: Date.now(), updated: 'fresh', categories: {}, plugins: [{
      name: 'fresh-item', install: 'dsh plugin add fresh-item', version: '1.0.0',
    }],
  }))
  console.log('__MARKET_JSON__' + JSON.stringify({ ok: true, count: 1, source: 'test' }))
} else if (action === 'installed') {
  const dir = path.join(home, 'profiles', profile)
  fs.mkdirSync(path.join(state, 'installed'), { recursive: true })
  fs.writeFileSync(path.join(state, 'installed', profile + '.json'), JSON.stringify({
    profile, profileDir: dir, generatedAt: Date.now(), bundles: [], specs: {}, dirNames: [], versions: {},
  }))
  console.log('__MARKET_JSON__' + JSON.stringify({ ok: true, profile }))
} else {
  process.exit(2)
}
`)
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
}))
writeFileSync(join(state, 'catalog.json'), JSON.stringify({
  fetchedAt: 0, updated: 'stale', categories: {}, plugins: [{
    name: 'stale-item', install: 'dsh plugin add stale-item', version: '1.0.0',
  }],
}))
const installedDir = join(state, 'installed')
mkdirSync(installedDir, { recursive: true })
writeFileSync(join(installedDir, 'web.json'), JSON.stringify({
  profile: 'web', profileDir: profile, generatedAt: Date.now(), bundles: [], specs: {}, dirNames: [], versions: {},
}))
process.env.DSH_HOME = home
process.env.DSH_MARKET_DIR = state
process.env.DSH_PROFILE = 'web'

const routes = new Map()
const ctx = {
  get: () => null,
  effect: fn => fn(),
  inject: (deps, fn) => fn(ctx),
  webServer: { register: route => { routes.set(route.path, route); return () => {} } },
}
const mod = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
mod.apply(ctx)
const response = {
  status: 0,
  body: '',
  writeHead (status) { this.status = status },
  end (body) { this.body = body },
}
const started = performance.now()
await routes.get('/dsh-plugin-market/list').handler({
  method: 'GET',
  url: '/dsh-plugin-market/list?limit=100&offset=0',
}, response)
const elapsed = performance.now() - started
let payload = null
try { payload = JSON.parse(response.body) } catch (e) { payload = null }
let freshCatalog = false
for (let i = 0; i < 20; i += 1) {
  const catalog = JSON.parse(readFileSync(join(state, 'catalog.json'), 'utf8'))
  if (catalog.updated === 'fresh') { freshCatalog = true; break }
  await new Promise(resolve => setTimeout(resolve, 150))
}
rmSync(scratch, { recursive: true, force: true })
let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? ' -> ' + detail : ''))
}
check('a stale catalog returns the cached page immediately', elapsed < 500, Math.round(elapsed) + 'ms')
check('the immediate response comes from the stale cache', payload?.payload?.items?.[0]?.name === 'stale-item', JSON.stringify(payload?.payload?.items?.map(item => item.name)))
check('the refresh continues in the background', freshCatalog)
console.log('\n' + (bad === 0 ? 'MARKET LATENCY TEST PASSED' : 'MARKET LATENCY TEST FAILED (' + bad + ')'))
process.exitCode = bad === 0 ? 0 : 1
