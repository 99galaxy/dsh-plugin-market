/**
 * dsh-plugin-market host entry.
 *
 * Mounts two HTTP routes under `/dsh-plugin-market/` once the profile composes
 * the `webServer` service, and delegates the actual market work to the standalone
 * helper `market-core.mjs` (catalog fetch + cache, profile inventory, pnpm install).
 *
 * WHY HTTP AND NOT A REMOTE NAMESPACE: `ctx.remote.<ns>` methods come from DSH's
 * generated Typert pipeline, so a locally authored plugin cannot register one by
 * hand. The webserver's named-route registry is a public service and is the
 * supported way for a plugin to expose host behaviour to its own browser half.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const name = 'dsh-plugin-market'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_PATH = join(HERE, 'market-core.mjs')
const SCRIPT_NAME = 'market-core.mjs'
const MARKER = '__MARKET_JSON__'
const PROFILE = 'web'
const ROUTE_LIST = '/dsh-plugin-market/list'
const ROUTE_INSTALL = '/dsh-plugin-market/install'

// The helper's own TTL (tools/market-core.mjs CACHE_MS). Skipping the helper is only
// sound when the helper would itself have decided the cache is fresh, so the two
// numbers must agree — tools/test-bundle.mjs asserts that they do.
const CATALOG_CACHE_MS = 3600000
// The inventory changes only when the profile's manifest or node_modules does, and
// re-reading it costs a process spawn per request. Short enough that a change made
// outside the UI shows up almost at once; an install invalidates it outright.
const INSTALLED_TTL_MS = 5000

// Distinguishes concurrent helper runs' capture files.
let seqRun = 0

// Memoises the helper-sync check. The key carries the shipped file's size and mtime,
// so a long-lived process verifies the state-dir copy once instead of reading two
// 13 KB files on every run — and still notices a helper that has been replaced.
let helperMemo = { key: '', env: null }

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const stateDir = () => process.env.DSH_MARKET_DIR || join(home(), '.dsh-plugin-market')

function sendJson (response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function readBody (request) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > 64 * 1024) {
        resolve('')
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(''))
  })
}

/** The helper is the source of truth; copy it into the state dir so a state-dir
 *  run is always the same file this package ships. */
function ensureHelper () {
  const dir = stateDir()
  const target = join(dir, SCRIPT_NAME)
  let srcKey = ''
  try {
    const st = statSync(HELPER_PATH)
    srcKey = String(st.size) + ':' + String(st.mtimeMs)
  } catch (e) {
    srcKey = ''
  }
  const key = dir + '|' + srcKey
  if (helperMemo.key === key && helperMemo.env !== null) return helperMemo.env
  try {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== readFileSync(HELPER_PATH, 'utf8')) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(target, readFileSync(HELPER_PATH, 'utf8'))
    }
    const env = { ok: true, script: target, cwd: dir }
    helperMemo = { key, env }
    return env
  } catch (e) {
    // Fall back to running the shipped copy in place. Deliberately NOT memoised: a
    // transient failure to write the state dir must not pin the degraded path.
    if (existsSync(HELPER_PATH)) return { ok: true, script: HELPER_PATH, cwd: HERE }
    return { ok: false, why: e && e.message ? e.message : 'helper unavailable' }
  }
}

/** Run the helper and return its last marker line as an object. */
function runHelper (args, timeoutMs) {
  return new Promise((resolve) => {
    const env = ensureHelper()
    if (!env.ok) {
      resolve({ ok: false, message: '市场辅助脚本不可用：' + env.why })
      return
    }

    // Capture the helper's output through FILE DESCRIPTORS, not pipes:
    //   - pipes are denied outright in DSH's confined sandbox modes, and a plain
    //     pipe can also deadlock once the buffer fills;
    //   - routing through a shell instead would let the install spec — which comes
    //     from a remote catalog — inject commands.
    const runDir = join(env.cwd, '.runs')
    seqRun += 1
    const tag = Date.now().toString(36) + '-' + seqRun
    const outPath = join(runDir, tag + '.out')
    const errPath = join(runDir, tag + '.err')
    let ofd = 0
    let efd = 0
    try {
      mkdirSync(runDir, { recursive: true })
      ofd = openSync(outPath, 'w')
      efd = openSync(errPath, 'w')
    } catch (e) {
      if (ofd !== 0) closeSync(ofd)
      if (efd !== 0) closeSync(efd)
      resolve({ ok: false, message: '无法创建辅助脚本运行目录：' + (e && e.message) })
      return
    }

    const readFile = (p) => { try { return readFileSync(p, 'utf8') } catch (e) { return '' } }
    const cleanup = () => {
      try { rmSync(outPath, { force: true }) } catch (e) { /* best effort */ }
      try { rmSync(errPath, { force: true }) } catch (e) { /* best effort */ }
    }

    let child
    try {
      child = spawn(process.execPath, [env.script].concat(args), {
        cwd: env.cwd,
        stdio: ['ignore', ofd, efd],
      })
    } catch (e) {
      closeSync(ofd)
      closeSync(efd)
      cleanup()
      resolve({ ok: false, message: '无法启动辅助脚本：' + (e && e.message) })
      return
    }
    // The child holds its own descriptors; the parent's are done once spawned.
    closeSync(ofd)
    closeSync(efd)

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (e) { /* already gone */ }
      finish({
        ok: false,
        message: '辅助脚本超时（' + Math.round(timeoutMs / 1000) + ' 秒）',
        stderr: readFile(errPath).slice(-2000),
      })
    }, timeoutMs)

    child.on('error', (e) => finish({ ok: false, message: '辅助脚本执行失败：' + (e && e.message) }))
    child.on('close', (code) => {
      const out = readFile(outPath)
      const err = readFile(errPath)
      const lines = out.split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const at = lines[i].indexOf(MARKER)
        if (at < 0) continue
        try {
          finish(Object.assign({ exitCode: code }, JSON.parse(lines[i].slice(at + MARKER.length).trim())))
        } catch (e) {
          finish({ ok: false, message: '辅助脚本输出无法解析', stdout: out.slice(-2000), stderr: err.slice(-2000) })
        }
        return
      }
      // The exit code must travel with the result. `install` never prints a marker,
      // so a SUCCESSFUL install lands here with code 0 — and the install route's
      // success test is `result.ok === true || result.exitCode === 0`. Drop the field
      // and every install, successful or not, reports as a failure.
      finish({
        ok: false,
        exitCode: code,
        message: '辅助脚本没有输出结果行（退出码 ' + String(code) + '）',
        stdout: out.slice(-2000),
        stderr: err.slice(-2000),
      })
    })
  })
}

// Parsed catalog, memoised on the file's size+mtime key. Re-reading and re-parsing
// the ~2.6 MB file on every request was ~27 ms of the ~315 ms a request cost.
let catalogMemo = { key: '', data: null }

/**
 * Read the cached catalog. The helper writes it; the host serves it.
 * @returns {{ok: true, data: object, key: string} | {ok: false, message: string}}
 */
function readCatalog () {
  const path = join(stateDir(), 'catalog.json')
  let key
  try {
    const st = statSync(path)
    key = String(st.size) + ':' + String(st.mtimeMs)
  } catch (e) {
    return { ok: false, message: '无法读取目录缓存：' + (e && e.message ? e.message : 'unknown') }
  }
  if (catalogMemo.key === key && catalogMemo.data !== null) return { ok: true, data: catalogMemo.data, key }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || !Array.isArray(data.plugins)) return { ok: false, message: 'catalog.json 形状异常' }
    catalogMemo = { key, data }
    return { ok: true, data, key }
  } catch (e) {
    return { ok: false, message: '无法读取目录缓存：' + (e && e.message ? e.message : 'unknown') }
  }
}

/** What the helper would have reported for a cache hit, without spawning it. */
function cachedSummary (data) {
  return {
    ok: true,
    source: 'local',
    fromCache: true,
    fetchedAt: numOf(data.fetchedAt),
    updated: textOf(data.updated),
    count: (data.plugins || []).length,
    note: '',
    tried: [],
  }
}

const textOf = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v))
const numOf = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
const safeSort = (v) => (['downloads', 'name', 'added'].indexOf(textOf(v)) >= 0 ? textOf(v) : 'stars')
const safeOnly = (v) => (['installed', 'notinstalled', 'updatable'].indexOf(textOf(v)) >= 0 ? textOf(v) : 'all')

/**
 * A version as its numeric segments plus its prerelease identifiers, or null when
 * the string is not a version at all.
 * @returns {{parts: number[], pre: string[]} | null}
 */
function versionParts (value) {
  const text = textOf(value).trim()
  const m = /^[~^=v]*\s*(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (m === null) return null
  const parts = m[1].split('.').map((n) => Number(n))
  while (parts.length < 3) parts.push(0)
  return { parts, pre: m[2] === undefined ? [] : m[2].split('.') }
}

/** Semver's prerelease rule: identifiers compare pairwise (numeric as numbers,
 *  alphanumeric as strings), and a release outranks any prerelease of itself. */
function comparePre (a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * Is the catalog's version newer than what the profile has?
 *
 * Both sides come from data we do not control, so an unreadable version is
 * reported as 'unknown' rather than assumed up to date — the UI counts those
 * separately instead of silently claiming there is nothing to do.
 *
 * @returns {'update' | 'latest' | 'unknown'}
 */
function updateState (installed, candidate) {
  const a = versionParts(installed)
  const b = versionParts(candidate)
  if (a === null || b === null) return 'unknown'
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return b.parts[i] > a.parts[i] ? 'update' : 'latest'
  }
  const c = comparePre(a.pre, b.pre)
  return c < 0 ? 'update' : 'latest'
}

/**
 * Reject callers that are not this page.
 *
 * WHY THE PLUGIN GUARDS ITS OWN ROUTES: DSH's browser-trust fence wraps only the
 * channels registered through the connection service, i.e. paths under `/api`. A
 * route registered straight on `webServer` gets none of it — and `POST /install`
 * runs pnpm with a spec taken from a remote catalog, so without this any page the
 * user happens to have open could trigger a real install.
 *
 * `Sec-Fetch-Site: cross-site` is what a browser sends with another site's fetch.
 * The Origin/Host comparison catches what that header does not: older browsers, and
 * a different local port — which is same-site but not same-origin.
 *
 * @returns a reason to refuse, or '' to proceed.
 */
function foreignCaller (request) {
  const headers = request.headers === undefined ? {} : request.headers
  if (textOf(headers['sec-fetch-site']) === 'cross-site') return 'Sec-Fetch-Site: cross-site'
  const origin = textOf(headers.origin)
  if (origin === '') return ''
  let host = ''
  try {
    host = new URL(origin).host
  } catch (e) {
    return 'Origin 无法解析：' + origin
  }
  const self = textOf(headers.host)
  if (self !== '' && host !== self) return 'Origin ' + host + ' 与本机 ' + self + ' 不符'
  return ''
}

/** The install route accepts JSON only. A cross-origin page cannot send this
 *  content type without a preflight, and this server answers no preflight. */
function isJsonRequest (request) {
  const headers = request.headers === undefined ? {} : request.headers
  return textOf(headers['content-type']).toLowerCase().indexOf('application/json') === 0
}

function safeSpec (install) {
  const m = /^dsh\s+plugin(?:\s+--profile\s+[A-Za-z0-9._-]+)?\s+add\s+([^\s].{0,299})$/.exec(textOf(install).trim())
  if (m === null) return null
  const spec = m[1].trim()
  if (spec === '' || spec.length > 300 || spec.indexOf('..') >= 0) return null
  // The spec is handed to pnpm as ONE argv element, never through a shell — so the
  // injection to refuse here is not shell metacharacters but a leading dash, which
  // pnpm would read as an OPTION (--global, --config.*, -C, --dir …). The catalog is
  // remote data; nothing in it has any business starting with '-'.
  if (spec.slice(0, 1) === '-') return null
  return spec
}

function safeInt (v, fallback, min, max) {
  const n = Number(v)
  if (!isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** Read the profile's install snapshot the helper wrote. */
function readInstalled () {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'installed.json'), 'utf8'))
  } catch (e) {
    return null
  }
}

function repoOf (url) {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(textOf(url))
  return m === null ? '' : (m[1] + '/' + m[2]).replace(/\.git$/i, '')
}

/**
 * One catalog entry with its install command already parsed. The regexes used to run
 * per entry per request (3,627 × 2); they now run once per catalog version.
 */
function prepareRow (p, catMap) {
  const install = textOf(p.install)
  const m = /^dsh\s+plugin(?:\s+--profile\s+\S+)?\s+add\s+(.+)$/.exec(install)
  const spec = m === null ? '' : m[1].trim()
  const g = spec === '' ? null : /^(?:github:)?([^/]+\/[^/#?]+)$/i.exec(spec)
  const category = textOf(p.category)
  const label = catMap[category] || {}
  return {
    name: textOf(p.name),
    owner: textOf(p.owner),
    url: textOf(p.url),
    page: textOf(p.page),
    category,
    categoryZh: textOf(label.zh) || category,
    zh: textOf(p.zh),
    en: textOf(p.en),
    npm: textOf(p.npm),
    version: textOf(p.version),
    stars: numOf(p.stars),
    downloads: numOf(p.downloads),
    install,
    added: textOf(p.added),
    spec,
    specKey: spec.toLowerCase(),
    specRepo: g === null ? '' : g[1].replace(/\.git$/i, '').toLowerCase(),
    repo: repoOf(p.url).toLowerCase(),
  }
}

/**
 * The installed package a catalog row corresponds to, or '' when none does.
 * @param row - a row from {@link prepareRow}.
 * @param maps - the profile's inventory, from {@link installedMaps}.
 */
function installedOwner (row, maps) {
  if (row.specKey !== '') {
    const direct = maps.bySpec[row.specKey]
    if (direct !== undefined) return direct
    if (row.specRepo !== '' && maps.byRepo[row.specRepo] !== undefined) return maps.byRepo[row.specRepo]
  }
  if (row.repo !== '' && maps.byRepo[row.repo] !== undefined) return maps.byRepo[row.repo]
  return ''
}

/** One row in the shape the browser half reads. Internal fields stay internal. */
function itemOf (row, owner, versions) {
  const installedVersion = owner === '' ? '' : textOf(versions[owner])
  return {
    name: row.name,
    owner: row.owner,
    url: row.url,
    page: row.page,
    category: row.category,
    categoryZh: row.categoryZh,
    zh: row.zh,
    en: row.en,
    npm: row.npm,
    version: row.version,
    stars: row.stars,
    downloads: row.downloads,
    install: row.install,
    added: row.added,
    installed: owner !== '',
    installedAs: owner,
    installedVersion,
    update: owner !== '' && updateState(installedVersion, row.version) === 'update',
  }
}

// Rows and category counts for one catalog version, keyed like the catalog memo.
let preparedMemo = { key: '', rows: null, categories: null }

function preparedCatalog (data, key) {
  if (preparedMemo.key === key && preparedMemo.rows !== null) return preparedMemo
  const catMap = data.categories || {}
  const rows = data.plugins.map((p) => prepareRow(p, catMap))
  const counts = {}
  for (const row of rows) {
    const id = row.category || 'other'
    counts[id] = (counts[id] || 0) + 1
  }
  const categories = Object.keys(counts)
    .map((id) => {
      const c = catMap[id] || {}
      return { id, zh: textOf(c.zh) || id, en: textOf(c.en) || id, count: counts[id] }
    })
    .sort((a, b) => b.count - a.count)
  preparedMemo = { key, rows, categories }
  return preparedMemo
}

// The inventory snapshot, memoised: it changes only when the profile does.
let installedMemo = { at: 0, key: '', result: null }

function invalidateInstalled () {
  installedMemo = { at: 0, key: '', result: null }
}

/** Changes whenever the profile's manifest does — or when it appears at all. */
function profileKey () {
  try {
    const st = statSync(join(home(), 'profiles', PROFILE, 'package.json'))
    return String(st.size) + ':' + String(st.mtimeMs)
  } catch (e) {
    return 'absent'
  }
}

/**
 * Re-read the profile's inventory, at most once per INSTALLED_TTL_MS — and
 * immediately whenever the manifest changes, so an install is never reported
 * against a snapshot taken before it.
 */
async function refreshInstalled (force) {
  const now = Date.now()
  const key = profileKey()
  if (!force && installedMemo.result !== null && installedMemo.key === key && now - installedMemo.at < INSTALLED_TTL_MS) {
    return installedMemo.result
  }
  const result = await runHelper(['installed', '--profile', PROFILE], 60000)
  installedMemo = { at: Date.now(), key, result }
  return result
}

function installedMaps (installed) {
  const bySpec = {}
  const byRepo = {}
  const specs = installed && installed.specs ? installed.specs : {}
  for (const key of Object.keys(specs)) {
    bySpec[textOf(key).toLowerCase()] = textOf(key)
    const spec = textOf(specs[key])
    const m = /(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)([^/]+)\/([^/#?]+)/i.exec(spec)
    if (m !== null) byRepo[(m[1] + '/' + m[2]).replace(/\.git$/i, '').toLowerCase()] = textOf(key)
  }
  const dirs = installed && Array.isArray(installed.dirNames) ? installed.dirNames : []
  for (const d of dirs) {
    const k = textOf(d).toLowerCase()
    if (bySpec[k] === undefined) bySpec[k] = textOf(d)
  }
  return { bySpec, byRepo }
}

/**
 * Register the market's routes.
 * @param ctx - host context that composes `webServer`.
 */
export function apply (ctx) {
  // `shell` is only needed for installs, so it is read per request: the route must
  // mount even on a profile that has not composed it yet.
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposes = []

      disposes.push(host.webServer.register({
        kind: 'exact',
        path: ROUTE_LIST,
        handler: async (request, response) => {
          const foreign = foreignCaller(request)
          if (foreign !== '') {
            sendJson(response, 403, { ok: false, message: '已拒绝跨站请求：' + foreign })
            return
          }
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          try {
            const url = new URL(request.url, 'http://127.0.0.1')
            const bypass = url.searchParams.get('bypass') === '1'
            const category = textOf(url.searchParams.get('category')).trim()
            const q = textOf(url.searchParams.get('q')).trim().toLowerCase()
            const sort = safeSort(url.searchParams.get('sort'))
            const only = safeOnly(url.searchParams.get('only'))
            const limit = safeInt(url.searchParams.get('limit'), 100, 1, 5000)
            const offset = safeInt(url.searchParams.get('offset'), 0, 0, 1000000)

            // A fresh cache is exactly what the helper would have decided; spawning it
            // (~150 ms on Windows) only to be told so is pure cost. There is no
            // `sourceUrl` parameter: the UI never sent one, and taking a URL to fetch
            // from a query string is an open door on a route that has no session.
            const cached = readCatalog()
            let summary
            if (!bypass && cached.ok === true && Date.now() - numOf(cached.data.fetchedAt) < CATALOG_CACHE_MS) {
              summary = cachedSummary(cached.data)
            } else {
              summary = await runHelper(bypass ? ['catalog', '--force', '1'] : ['catalog'], 300000)
              if (summary.ok !== true) {
                sendJson(response, 502, {
                  ok: false,
                  message: summary.message || '无法获取插件目录',
                  detail: (summary.tried || []).join(' | ') || summary.stderr || '',
                })
                return
              }
            }

            // Refresh the inventory so the installed badges are current.
            await refreshInstalled(bypass)
            const snapshot = readInstalled()
            const maps = installedMaps(snapshot)
            const versions = snapshot && snapshot.versions ? snapshot.versions : {}

            const catalog = readCatalog()
            if (catalog.ok !== true) {
              sendJson(response, 500, { ok: false, message: catalog.message })
              return
            }
            const prepared = preparedCatalog(catalog.data, catalog.key)
            const all = prepared.rows

            // 'unknown' is its own answer, not a silent "up to date": a plugin the
            // catalog does not carry a version for cannot be judged either way.
            const verdictOf = (row) => {
              const owner = installedOwner(row, maps)
              if (owner === '') return { owner, state: '' }
              return { owner, state: updateState(textOf(versions[owner]), row.version) }
            }

            let installedTotal = 0
            let updatableTotal = 0
            let unknownTotal = 0
            const claimed = new Set()
            for (const row of all) {
              const v = verdictOf(row)
              if (v.owner === '') continue
              claimed.add(v.owner.toLowerCase())
              installedTotal += 1
              if (v.state === 'update') updatableTotal += 1
              else if (v.state === 'unknown') unknownTotal += 1
            }
            // Installed packages that no catalog row claims: a plugin the list has
            // never heard of. Those are the largest blind spot of all — by being
            // absent they would otherwise look perfectly up to date.
            for (const name of Object.keys(versions)) {
              if (!claimed.has(name.toLowerCase())) unknownTotal += 1
            }

            let rows = all
            if (category !== '') rows = rows.filter((r) => r.category === category)
            if (only === 'installed') rows = rows.filter((r) => installedOwner(r, maps) !== '')
            if (only === 'notinstalled') rows = rows.filter((r) => installedOwner(r, maps) === '')
            if (only === 'updatable') rows = rows.filter((r) => verdictOf(r).state === 'update')
            if (q !== '') {
              rows = rows.filter((r) =>
                r.name.toLowerCase().indexOf(q) >= 0 ||
                r.zh.toLowerCase().indexOf(q) >= 0 ||
                r.en.toLowerCase().indexOf(q) >= 0 ||
                r.owner.toLowerCase().indexOf(q) >= 0)
            }
            const matched = rows.length
            const sorted = rows.slice().sort((a, b) => {
              if (sort === 'downloads') return b.downloads - a.downloads
              if (sort === 'name') return a.name.localeCompare(b.name)
              if (sort === 'added') return b.added.localeCompare(a.added)
              return b.stars - a.stars
            })
            const page = sorted.slice(offset, offset + limit).map((r) => itemOf(r, installedOwner(r, maps), versions))

            sendJson(response, 200, {
              ok: true,
              payload: {
                items: page,
                categories: prepared.categories,
                count: page.length,
                total: numOf(summary.count) || all.length,
                matched,
                installedTotal,
                updatableTotal,
                unknownTotal,
                offset,
                sort,
                only,
                category,
                q,
                catalogFromCache: summary.fromCache === true,
                fetchedAt: numOf(summary.fetchedAt),
                catalogUpdated: textOf(summary.updated),
                source: textOf(summary.source),
                note: textOf(summary.note),
              },
            })
          } catch (e) {
            sendJson(response, 500, { ok: false, message: textOf(e && e.message) })
          }
        },
      }))

      disposes.push(host.webServer.register({
        kind: 'exact',
        path: ROUTE_INSTALL,
        handler: async (request, response) => {
          // THE route that most needs this guard: it runs pnpm. See foreignCaller.
          const foreign = foreignCaller(request)
          if (foreign !== '') {
            sendJson(response, 403, { ok: false, message: '已拒绝跨站请求：' + foreign })
            return
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          try {
            if (!isJsonRequest(request)) {
              sendJson(response, 415, { ok: false, message: 'Content-Type 必须是 application/json' })
              return
            }
            const raw = await readBody(request)
            let body = {}
            try { body = raw === '' ? {} : JSON.parse(raw) } catch (e) { body = {} }
            const spec = safeSpec(body.install)
            if (spec === null) {
              sendJson(response, 400, { ok: false, message: '安装命令无法解析或不安全，已拒绝执行' })
              return
            }
            const started = Date.now()
            const result = await runHelper(['install', spec, '--profile', PROFILE], 900000)
            const took = Math.round((Date.now() - started) / 1000)
            // `install` prints no result marker, so the exit code is the verdict.
            if (result.ok === true || result.exitCode === 0) {
              // The badge must not stay stale for the TTL after a successful install.
              invalidateInstalled()
              sendJson(response, 200, { ok: true, spec, seconds: took, log: textOf(result.stdout).slice(-4000) })
              return
            }
            const code = typeof result.exitCode === 'number' ? result.exitCode : null
            sendJson(response, 500, {
              ok: false,
              spec,
              seconds: took,
              message: code === null ? (result.message || '安装失败') : ('安装失败：pnpm 退出码 ' + String(code)),
              log: (textOf(result.stderr) + '\n' + textOf(result.stdout)).slice(-4000),
            })
          } catch (e) {
            sendJson(response, 500, { ok: false, message: textOf(e && e.message) })
          }
        },
      }))

      return () => {
        for (const dispose of disposes) {
          try { dispose() } catch (e) { /* already gone */ }
        }
      }
    }, 'dsh-plugin-market: http routes')
  })
}
