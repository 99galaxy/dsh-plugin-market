// Exercise the bundle with the profile context and package manager shape used by
// DeepSeek Harness desktop 0.2.x, without touching the user's real ~/.dsh.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const scratch = join(root, '.desktop-compat-test')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
const home = join(scratch, 'home')
const state = join(scratch, 'state')
const profileDir = join(home, 'profiles', 'desktop')
mkdirSync(join(profileDir, 'node_modules', 'desktop-only'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: { 'desktop-only': '1.0.0' },
  dsh: { profile: { bundles: ['desktop-only'] } },
}, null, 2))
writeFileSync(join(profileDir, 'node_modules', 'desktop-only', 'package.json'), JSON.stringify({
  name: 'desktop-only',
  version: '1.0.0',
}))
mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'web-only'), { recursive: true })
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { 'web-only': '1.0.0' },
  dsh: { profile: { bundles: ['web-only'] } },
}, null, 2))
writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'web-only', 'package.json'), JSON.stringify({
  name: 'web-only',
  version: '1.0.0',
}))
mkdirSync(state, { recursive: true })
writeFileSync(join(state, 'catalog.json'), JSON.stringify({
  fetchedAt: Date.now(),
  updated: '2026-10-01',
  categories: [],
  plugins: [
    { name: 'desktop-only', npm: 'desktop-only', version: '1.0.0', install: 'dsh plugin --profile desktop add desktop-only' },
  ],
}))

let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad += 1
  console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
}

process.env.DSH_HOME = home
process.env.DSH_MARKET_DIR = state
// The injected profileContext decides the profile and manager here. Clear the
// ambient copies so a real desktop session (DSH_PROFILE=desktop) cannot change
// what this test is exercising.
delete process.env.DSH_PROFILE
delete process.env.DSH_PACKAGE_MANAGER_COMMAND
delete process.env.DSH_PACKAGE_MANAGER_ARGS
delete process.env.DSH_PACKAGE_MANAGER_ENV
// DSH passes `command` + `args` that already name pnpm (desktop: Electron with
// pnpm.mjs). The helper must append pnpm's own argv — never a literal "pnpm" — or
// pnpm runs whatever `pnpm` is on PATH and the version DSH pinned is lost.
const fakeManager = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(1)
if (args[0] !== 'add' || args[1] !== 'desktop-installed') process.exit(41)
const manifestPath = path.join(process.cwd(), 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dependencies = Object.assign({}, manifest.dependencies, { 'desktop-installed': '1.0.0' })
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'desktop-installed'), { recursive: true })
fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'desktop-installed', 'package.json'), JSON.stringify({ name: 'desktop-installed', version: '1.0.0' }))
`

const routes = new Map()
const webServer = {
  register (route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}
const profileContext = {
  name: 'desktop',
  packageManager: { command: process.execPath, args: ['-e', fakeManager], env: {} },
}
const makeChild = () => ({
  get (name) { return name === 'profileContext' ? profileContext : name === 'webServer' ? webServer : undefined },
  effect (fn) { return fn() },
  inject (deps, callback) { callback(makeChild()) },
  webServer,
})
const ctx = {
  get (name) { return name === 'profileContext' ? profileContext : name === 'webServer' ? webServer : undefined },
  effect () { return () => {} },
  inject (deps, callback) { callback(makeChild()) },
}

const mod = await import(new URL('../index.js?desktop-compat', import.meta.url).href)
mod.apply(ctx)
const response = () => {
  const state = { status: 0, body: '' }
  return { state, writeHead (status) { state.status = status }, end (body) { state.body = body || '' } }
}
const listResponse = response()
await routes.get('/dsh-plugin-market/list').handler({ method: 'GET', url: '/dsh-plugin-market/list?only=installed' }, listResponse)
let list = null
try { list = JSON.parse(listResponse.state.body) } catch (e) { list = null }
check('desktop inventory uses the injected desktop profile', list?.ok === true && list.payload.items.some((item) => item.name === 'desktop-only'), JSON.stringify(list?.payload))

const installResponse = response()
await routes.get('/dsh-plugin-market/install').handler({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  url: '/dsh-plugin-market/install',
  on (event, callback) {
    if (event === 'data') callback(Buffer.from(JSON.stringify({ install: 'dsh plugin --profile desktop add desktop-installed' })))
    if (event === 'end') callback()
  },
}, installResponse)
let install = null
try { install = JSON.parse(installResponse.state.body) } catch (e) { install = null }
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
check('desktop package manager completes the install', installResponse.state.status === 200 && install?.ok === true && 'desktop-installed' in manifest.dependencies, JSON.stringify(install))

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + (bad === 0 ? 'DESKTOP COMPAT TEST PASSED' : 'DESKTOP COMPAT TEST FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
