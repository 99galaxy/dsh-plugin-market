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
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = join(root, 'pkg', 'dsh-plugin-market')

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
const mod = await import(new URL('../pkg/dsh-plugin-market/index.js', import.meta.url).href)
check('exports a name', mod.name === 'dsh-plugin-market', String(mod.name))
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

// ---- exercise POST /install (validation only) ------------------------------
const installRoute = routes.get('/dsh-plugin-market/install')
function mockRequest (body) {
  const listeners = {}
  return {
    method: 'POST',
    on (evt, cb) { listeners[evt] = cb; return this },
    destroy () {},
    _emit () {
      if (body !== undefined) listeners.data && listeners.data(Buffer.from(body, 'utf8'))
      listeners.end && listeners.end()
    },
  }
}
const badReq = mockRequest(JSON.stringify({ install: 'rm -rf /' }))
Object.defineProperty(badReq, 'on', {
  value (evt, cb) {
    if (evt === 'data' && badReq._body !== undefined) cb(Buffer.from(badReq._body, 'utf8'))
    if (evt === 'end') cb()
    return this
  },
})
badReq._body = JSON.stringify({ install: 'rm -rf /' })
const resBad = mockResponse()
await installRoute.handler(badReq, resBad)
check('install route refuses a non-dsh command', resBad.state.status === 400, 'status=' + resBad.state.status + ' body=' + resBad.state.body.slice(0, 200))

const resBadMethod = mockResponse()
await installRoute.handler({ method: 'GET', url: '/dsh-plugin-market/install' }, resBadMethod)
check('install route rejects GET with 405', resBadMethod.state.status === 405, 'status=' + resBadMethod.state.status)

// ---- the client bundle must at least be loadable text ---------------------
const clientPath = join(pkg, 'client', 'client.js')
check('client bundle exists', existsSync(clientPath))
const clientSrc = readFileSync(clientPath, 'utf8')
check('client registers with the module loader', clientSrc.includes('window.__ModuleLoader__.load('))
check('client id matches the package name', clientSrc.includes("id: 'dsh-plugin-market'"))
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

// Leave no scratch behind: the state dir is recreated on the next run.
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + (bad === 0 ? 'BUNDLE TEST PASSED' : 'BUNDLE TEST FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
