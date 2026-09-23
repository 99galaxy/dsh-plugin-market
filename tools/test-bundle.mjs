// Verify the permanent bundle in a mock host context — WITHOUT installing it.
//
//   node tools/test-bundle.mjs
//
// Checks three things:
//   1. index.js loads and its `apply` registers exactly the two expected routes,
//      through the real `ctx.inject(['webServer'])` deferred-activation path.
//   2. GET /list answers with a well-formed payload built from the real cached
//      catalog (the helper runs for real).
//   3. POST /install refuses a malformed command without running pnpm.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { stripComments } from './strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = root

// The host writes its helper copy and its capture files into DSH_MARKET_DIR. Point
// that at a scratch directory so this test never touches the real ~/.dsh state and
// stays inside the sandbox workspace.
const scratch = join(root, '.bundle-test-state')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
process.env.DSH_MARKET_DIR = scratch
process.env.DSH_HOME = join(scratch, 'home')

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

// ---- mock a host context ---------------------------------------------------
const routes = new Map()
const effects = []
let injects = 0

const webServer = {
  register (route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const services = {
  webServer,
  shell: {
    resolve: (r) => r,
    run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, sandbox: null }),
  },
}

const getService = (n) => services[n]

// Cordis hands an `inject(services, cb)` callback a context where each injected
// service is available BOTH as a property and through get(), so the mock must too.
function makeChild () {
  const child = {
    get: getService,
    effect (fn, label) {
      const dispose = fn()
      effects.push({ fn: () => dispose, label })
      return () => {}
    },
    inject (deps, cb) { cb(makeChildFor(deps)) },
  }
  for (const key of Object.keys(services)) child[key] = services[key]
  return child
}

function makeChildFor (deps) {
  const child = makeChild()
  return child
}

function makeCtx () {
  return {
    get: getService,
    effect (fn, label) { effects.push({ fn, label }); return () => {} },
    inject (deps, cb) { injects += 1; cb(makeChildFor(deps || [])) },
  }
}

// ---- load and apply --------------------------------------------------------
const mod = await import(new URL('../index.js', import.meta.url).href)
check('exports a name', mod.name === '@99galaxy/dsh-plugin-market', String(mod.name))
check('exports apply()', typeof mod.apply === 'function')

mod.apply(makeCtx())
check('used the deferred inject path', injects === 1, 'injects=' + injects)
check('registered the list route', routes.has('/dsh-plugin-market/list'))
check('registered the install route', routes.has('/dsh-plugin-market/install'))
check('registered exactly two routes', routes.size === 2, [...routes.keys()].join(', '))
for (const [path, route] of routes) {
  check(path + ' is kind:"exact" with a handler', route.kind === 'exact' && typeof route.handler === 'function')
}

// ---- exercise GET /list ----------------------------------------------------
function mockResponse () {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead (status, headers) { state.status = status; state.headers = headers },
    end (chunk) { state.body = chunk === undefined ? '' : String(chunk) },
  }
}

const listRoute = routes.get('/dsh-plugin-market/list')
const res = mockResponse()
await listRoute.handler({ method: 'GET', url: '/dsh-plugin-market/list?limit=5&sort=stars&only=all' }, res)
check('GET /list answered 200', res.state.status === 200, 'status=' + res.state.status + ' body=' + res.state.body.slice(0, 240))

let payload = null
try { payload = JSON.parse(res.state.body) } catch (e) { payload = null }
check('answer is JSON', payload !== null)
if (payload && payload.ok === true) {
  const p = payload.payload
  check('payload has items', Array.isArray(p.items) && p.items.length > 0, 'items=' + (p.items ? p.items.length : 'n/a'))
  check('payload reports the catalog total', p.total > 1000, 'total=' + p.total)
  check('payload has categories', Array.isArray(p.categories) && p.categories.length > 0, 'cats=' + (p.categories ? p.categories.length : 'n/a'))
  check('honoured the limit', p.items.length <= 5, 'items=' + p.items.length)
  check('every item carries a category label', p.items.every((i) => i.categoryZh))
  check('every item carries an install command', p.items.every((i) => i.install))
  check('reports installed state', typeof p.installedTotal === 'number', 'installedTotal=' + p.installedTotal)
  console.log('  sample: ' + p.items.slice(0, 3).map((i) => i.name + '[' + i.categoryZh + ']').join(', '))
} else {
  console.log('  body: ' + res.state.body.slice(0, 400))
}

// wrong method must be refused
const res405 = mockResponse()
await listRoute.handler({ method: 'POST', url: '/dsh-plugin-market/list' }, res405)
check('GET route rejects POST with 405', res405.state.status === 405, 'status=' + res405.state.status)

// ---- exercise POST /install ------------------------------------------------
const installRoute = routes.get('/dsh-plugin-market/install')

/** A POST as a browser sends it: headers AND a body. */
function mockPost (body, headers) {
  const listeners = {}
  const req = {
    method: 'POST',
    headers: Object.assign({
      host: '127.0.0.1:1234',
      origin: 'http://127.0.0.1:1234',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    }, headers),
    on (evt, cb) { listeners[evt] = cb; return req },
    destroy () {},
  }
  req.deliver = () => {
    if (listeners.data) listeners.data(Buffer.from(body, 'utf8'))
    if (listeners.end) listeners.end()
  }
  return req
}

async function postInstall (body, headers) {
  const req = mockPost(body, headers)
  const res = mockResponse()
  const done = installRoute.handler(req, res)
  req.deliver()
  await done
  return res
}

const resBad = await postInstall(JSON.stringify({ install: 'rm -rf /' }))
check('install route refuses a non-dsh command', resBad.state.status === 400, 'status=' + resBad.state.status + ' body=' + resBad.state.body.slice(0, 200))

// argv-level injection, not shell injection: the spec becomes ONE argument to pnpm,
// so a leading dash would be read as a pnpm OPTION (--global, --config.*, -C …). The
// install command comes from a remote catalog, so an option-shaped spec is refused.
const resDash = await postInstall(JSON.stringify({ install: 'dsh plugin add --global' }))
check('install route refuses an option-shaped spec', resDash.state.status === 400,
  'status=' + resDash.state.status + ' body=' + resDash.state.body.slice(0, 200))

// This plugin registers straight on webServer, which carries none of DSH's /api
// browser-trust fence — so the route refuses foreign callers itself. Without this,
// any page the user happens to have open could POST here and install a package.
const resCrossSite = await postInstall(JSON.stringify({ install: 'dsh plugin add a' }),
  { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })
check('install route refuses a cross-site caller', resCrossSite.state.status === 403,
  'status=' + resCrossSite.state.status)

const resForeignOrigin = await postInstall(JSON.stringify({ install: 'dsh plugin add a' }),
  { origin: 'http://127.0.0.1:9999' })
check('install route refuses a foreign Origin', resForeignOrigin.state.status === 403,
  'status=' + resForeignOrigin.state.status)

// A form or a no-cors fetch cannot send application/json without a preflight, and
// this server answers no preflight.
const resForm = await postInstall(JSON.stringify({ install: 'dsh plugin add a' }),
  { 'content-type': 'text/plain' })
check('install route requires JSON', resForm.state.status === 415, 'status=' + resForm.state.status)

const resForeignList = mockResponse()
await listRoute.handler({ method: 'GET', url: '/dsh-plugin-market/list', headers: { 'sec-fetch-site': 'cross-site' } }, resForeignList)
check('list route refuses a cross-site caller', resForeignList.state.status === 403, 'status=' + resForeignList.state.status)

const resBadMethod = mockResponse()
await installRoute.handler({ method: 'GET', url: '/dsh-plugin-market/install', headers: {} }, resBadMethod)
check('install route rejects GET with 405', resBadMethod.state.status === 405, 'status=' + resBadMethod.state.status)

// ---- the contracts that were silently broken -------------------------------
// `install` prints no result marker, so its exit code IS the verdict. The runner must
// carry that code out of the no-marker branch: without it the route's `exitCode === 0`
// test can never be true, and EVERY install — successful or not — answered HTTP 500
// while the package had in fact been installed.
const indexSrc = readFileSync(join(pkg, 'index.js'), 'utf8')
// Comment-stripped for the absence checks below: the comments explaining WHY
// `sourceUrl` is gone would otherwise be mistaken for the parameter itself.
const indexCode = stripComments(indexSrc)
check('the helper runner reports the exit code without a marker',
  /finish\(\{\s*ok: false,\s*exitCode: code,/.test(indexCode),
  (indexCode.match(/finish\(\{\s*ok: false,[\s\S]{0,50}/) || ['(no marker-less finish found)'])[0].replace(/\n\s*/g, ' '))
check('the install route treats exit 0 as success', /result\.exitCode === 0/.test(indexCode))
// The host skips the catalog helper when the cache is fresh, which is only sound if it
// uses the SAME freshness rule the helper would have used.
const helperSource = readFileSync(join(here, 'market-core.mjs'), 'utf8')
const helperTtl = /const CACHE_MS = (\d+)/.exec(helperSource)
const hostTtl = /const CATALOG_CACHE_MS = (\d+)/.exec(indexCode)
check('host and helper agree on the catalog TTL',
  helperTtl !== null && hostTtl !== null && helperTtl[1] === hostTtl[1],
  'helper=' + (helperTtl && helperTtl[1]) + ' host=' + (hostTtl && hostTtl[1]))
// `sourceUrl` let the route fetch any URL handed to it, on a route with no session.
check('the list route takes no source URL', !/sourceUrl/.test(indexCode))

// ---- the client bundle must at least be loadable text ---------------------
const clientPath = join(pkg, 'client', 'client.js')
check('client bundle exists', existsSync(clientPath))
const clientSrc = readFileSync(clientPath, 'utf8')
check('client registers with the module loader', clientSrc.includes('window.__ModuleLoader__.load('))
check('client id matches the package name', clientSrc.includes("id: '@99galaxy/dsh-plugin-market'"))
check('client requires react at runtime', clientSrc.includes('require("react")'))
check('client calls the host list route', clientSrc.includes('/dsh-plugin-market/list'))
check('client calls the host install route', clientSrc.includes('/dsh-plugin-market/install'))
// Look for an actual invocation, not the word in a comment explaining its absence.
check('client never invokes host.call', !/\bhost\s*\.\s*call\s*\(/.test(clientSrc))

// ---- card key uniqueness ---------------------------------------------------
// The catalog is NOT unique by plugin name (dsh-memory appears nine times; one
// 100-item page repeated a name four times). A name-only React key makes the
// reconciler reuse the wrong nodes and keep stale rows, so the UI shows old cards
// while the data has already updated — the bug that took the longest to find.
//
// The invariant, not the spelling: the card's key must carry BOTH the name and the
// row index, and no card may be keyed by the name alone.
check('the card list maps with an index', /list\.map\(function \(it,\s*idx\)/.test(clientSrc))
check('the card key includes name AND index',
  /key:\s*spec\s*\+\s*'#'\s*\+\s*String\(idx\)/.test(clientSrc),
  (clientSrc.match(/key:\s*spec[^,]*/) || ['(no card key found)'])[0])
check('no card is keyed by name alone', !/key:\s*spec\s*[,}]/.test(clientSrc))

// ---- a REAL install through the route --------------------------------------
// Every install check above stops before pnpm. That is exactly how a route which
// reported every SUCCESS as HTTP 500 shipped unnoticed: only exit code 0 from a real
// install can tell "the package went in" apart from "the request failed". So drive
// the whole path — real profile, real pnpm — and read the exit code's verdict.
console.log('\n--- live install through the route ---')
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const liveProfile = join(process.env.DSH_HOME, 'profiles', 'web')
if (!existsSync(npmCli)) {
  console.log('  SKIPPED: npm-cli.js not found at ' + npmCli)
} else {
  mkdirSync(liveProfile, { recursive: true })
  writeFileSync(join(liveProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(liveProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2))
  // Point npm's own caches at the scratch. pnpm still keeps its content-addressable
  // store wherever ITS config says, so the store may be shared with the user's — but
  // the install lands in the scratch profile, which is what this test owns.
  process.env.npm_config_cache = join(scratch, '.npm-cache')
  process.env.npm_config_store_dir = join(scratch, 'store')
  process.env.npm_config_tmp = join(scratch, 'npm-tmp')
  mkdirSync(join(scratch, 'npm-tmp'), { recursive: true })

  const installBody = JSON.stringify({ install: 'dsh plugin --profile web add is-even@1.0.0' })
  const firstInstall = postInstall(installBody)
  const resConcurrent = await postInstall(installBody)
  check('a second install is refused while the profile is being modified',
    resConcurrent.state.status === 409, 'status=' + resConcurrent.state.status)
  const resLive = await firstInstall
  let live = null
  try { live = JSON.parse(resLive.state.body) } catch (e) { live = null }
  const liveLog = live === null ? resLive.state.body : String(live.log || '')
  // An environment that cannot reach a registry is not a code defect — report it as a
  // skip with the reason, the way tools/test-install.mjs does. A skip is never a pass.
  if (resLive.state.status !== 200 && /spawn EPERM|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ERR_SOCKET|request to https/i.test(liveLog)) {
    console.log('  SKIPPED: this environment cannot run a real install')
    console.log('  ' + liveLog.split('\n').filter(Boolean).slice(-3).join('\n  '))
  } else {
    check('a real install answers 200', resLive.state.status === 200,
      'status=' + resLive.state.status + ' body=' + String(resLive.state.body).slice(0, 300))
    check('the install reports ok', live !== null && live.ok === true,
      live === null ? '(unparseable body)' : JSON.stringify(live).slice(0, 200))
    let manifest = null
    try { manifest = JSON.parse(readFileSync(join(liveProfile, 'package.json'), 'utf8')) } catch (e) { manifest = null }
    check('the package landed in the profile',
      manifest !== null && 'is-even' in (manifest.dependencies || {}),
      manifest === null ? '(manifest unreadable)' : JSON.stringify(manifest.dependencies))
  }
}

// ---- the update verdicts, on a catalog we control ---------------------------
// The real catalog can only ever exercise the cases that happen to be in it, and it
// costs a network fetch to read. This builds its own profile and its own catalog, so
// every branch of the version comparison is pinned — including the ones that only
// appear when the data is odd.
console.log('\n--- update verdicts (synthetic catalog, offline) ---')
{
  const synthHome = join(scratch, 'synth-home')
  const synthState = join(scratch, 'synth-state')
  const synthProfile = join(synthHome, 'profiles', 'web')
  mkdirSync(join(synthProfile, 'node_modules'), { recursive: true })
  mkdirSync(synthState, { recursive: true })

  // name, declared spec, what the profile HAS, what the catalog OFFERS
  const fixture = [
    ['alpha', '^1.0.0', '1.0.0', '1.2.0'], // catalog ahead -> update
    ['beta', '^2.0.0', '2.0.0', '2.0.0'], // identical -> current
    ['gamma', '^3.0.0', '3.1.0', '3.0.0'], // profile ahead -> current, NOT a downgrade
    ['delta', '^0.1.0', '0.1.0', ''], // the catalog carries no version -> unknown
    ['epsilon', '^1.0.0-rc.1', '1.0.0-rc.1', '1.0.0-rc.3'], // prerelease -> prerelease
    ['zeta', '^1.0.0', '1.0.0', '1.0.0-rc.3'], // a release outranks its prerelease
    ['eta', '^1.0.0', '1.0.0', null], // installed bundle absent from catalog -> unknown
    ['ordinary-library', '^1.0.0', '1.0.0', null], // not a plugin -> excluded
  ]
  const deps = {}
  for (const [name, spec, installed] of fixture) {
    deps[name] = spec
    mkdirSync(join(synthProfile, 'node_modules', name), { recursive: true })
    writeFileSync(join(synthProfile, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: installed }))
  }
  writeFileSync(join(synthProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles: ['eta'] } },
  }, null, 2))

  writeFileSync(join(synthState, 'catalog.json'), JSON.stringify({
    version: 'test',
    updated: '2026-09-18',
    fetchedAt: Date.now(), // fresh: the host must not reach for the network
    categories: {},
    plugins: fixture.filter(([, , , offered]) => offered !== null).map(([name, , , offered]) => ({
      name,
      owner: 'fixture',
      url: 'https://github.com/fixture/' + name,
      page: '',
      category: 'tools',
      zh: name + ' 简介',
      en: name + ' description',
      npm: name,
      version: offered,
      install: 'dsh plugin --profile web add ' + name,
      stars: 1,
      downloads: 1,
      added: '2026-01-01',
    })),
  }))

  process.env.DSH_HOME = synthHome
  process.env.DSH_MARKET_DIR = synthState

  async function getList (query) {
    const res = mockResponse()
    await listRoute.handler({
      method: 'GET',
      url: '/dsh-plugin-market/list?' + query,
      headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', 'sec-fetch-site': 'same-origin' },
    }, res)
    let body = null
    try { body = JSON.parse(res.state.body) } catch (e) { body = null }
    return { status: res.state.status, body }
  }

  const syn = await getList('limit=100&sort=name')
  check('the synthetic list answers 200', syn.status === 200 && syn.body !== null, 'status=' + syn.status + ' body=' + String(syn.body).slice(0, 200))
  if (syn.body !== null && syn.body.payload) {
    const p = syn.body.payload
    const byName = {}
    for (const it of p.items) byName[it.name] = it
    check('catalog total is the synthetic one', p.total === 6, 'total=' + p.total)
    // Rows, not profile entries: `eta` is installed but the catalog has no row for it,
    // so it can appear in neither the installed nor the updatable list.
    check('counted the installed rows', p.installedTotal === 6, 'installedTotal=' + p.installedTotal)
    check('counted exactly the updatable ones', p.updatableTotal === 2, 'updatableTotal=' + p.updatableTotal)
    // Two, from two different causes: `delta` has a row with no version, and `eta` has
    // no row at all. Counting only the first would understate the blind spot by
    // exactly the plugins the catalog has never heard of.
    check('counted BOTH blind-spot causes, not just the versionless row',
      p.unknownTotal === 2, 'unknownTotal=' + p.unknownTotal)

    check('a catalog that is ahead offers an update',
      byName.alpha && byName.alpha.update === true && byName.alpha.installedVersion === '1.0.0',
      JSON.stringify(byName.alpha))
    check('an identical version is current', byName.beta && byName.beta.update === false, JSON.stringify(byName.beta))
    check('a profile AHEAD of the catalog is not offered a downgrade',
      byName.gamma && byName.gamma.update === false, JSON.stringify(byName.gamma))
    check('a plugin the catalog has no version for is not claimed current',
      byName.delta && byName.delta.update === false && byName.delta.installedVersion === '0.1.0',
      JSON.stringify(byName.delta))
    check('a prerelease ahead of a prerelease counts as an update',
      byName.epsilon && byName.epsilon.update === true, JSON.stringify(byName.epsilon))
    check('a release is NOT updated down to a prerelease',
      byName.zeta && byName.zeta.update === false, JSON.stringify(byName.zeta))
    check('a plugin absent from the catalog does not appear', byName.eta === undefined)

    const upd = await getList('limit=100&only=updatable&sort=name')
    const names = upd.body && upd.body.payload ? upd.body.payload.items.map((i) => i.name).join(',') : '(none)'
    check('only=updatable returns exactly those two', names === 'alpha,epsilon', names)
    check('and reports the same totals', upd.body.payload.updatableTotal === 2 && upd.body.payload.unknownTotal === 2,
      JSON.stringify({ up: upd.body.payload.updatableTotal, unk: upd.body.payload.unknownTotal }))
    check('every row it returns really carries an update',
      upd.body.payload.items.every((i) => i.update === true && i.installed === true))
  }
}

// Leave no scratch behind: the state dir is recreated on the next run.
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + (bad === 0 ? 'BUNDLE TEST PASSED' : 'BUNDLE TEST FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
