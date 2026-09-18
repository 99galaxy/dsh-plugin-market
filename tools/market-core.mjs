// @99galaxy/dsh-plugin-market — market helper
//
// Standalone CLI, kept as a real file so the Cordis Host half does not have to
// embed a 23 KB script. The host writes this file to its state directory and
// then runs it with `node`.
//
// Commands (each prints exactly one line starting with the marker):
//   node market-core.mjs catalog   [--force 1] [--url U] [--mirror U]
//   node market-core.mjs installed [--profile web]
//   node market-core.mjs install   <spec> [--profile web]
//
// Design notes:
//  * The catalog is ~2.8 MB, so it is written to disk and never transported over
//    stdout; only a small summary line is printed.
//  * `plugins.json` is fetched from three sources in order: the official domain,
//    a mirror of it, then the npm package's raw file (via the registry's JSON
//    metadata, so no tarball parsing is needed).
//  * The catalog is reused while it is younger than CACHE_MS; `--force 1` is the
//    only thing that bypasses that.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, openSync, closeSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MARKER = '__MARKET_JSON__'
const CATALOG_URL = '__CATALOG__'
const MIRROR = '__MIRROR__'
const CDN = '__CDN__'
const NPM_META = 'https://registry.npmjs.org/dsh-plugin-catalog'
const CACHE_MS = 3600000
const PROFILE_DEFAULT = 'web'

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const STATE_DIR = process.env.DSH_MARKET_DIR || join(HOME, '.dsh-plugin-market')
const CATALOG_PATH = join(STATE_DIR, 'catalog.json')
const INSTALLED_PATH = join(STATE_DIR, 'installed.json')

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.slice(0, 2) === '--') { flags[a.slice(2)] = argv[i + 1]; i += 1 } else rest.push(a)
  }
  return { flags, rest }
}

const parsed = parseArgs(process.argv.slice(2))
const flags = parsed.flags
const action = parsed.rest[0] || ''

const out = (value) => console.log(MARKER + JSON.stringify(value))

function ensureDir() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    return true
  } catch (e) {
    return false
  }
}

// One catalog entry, slimmed to the fields the UI needs.
function slim(p) {
  const d = p.description || {}
  return {
    name: p.name || '',
    owner: p.owner || '',
    url: p.url || '',
    page: p.page || '',
    category: p.category || '',
    zh: (d.zh || '').slice(0, 300),
    en: (d.en || '').slice(0, 300),
    npm: p.npm || '',
    version: p.version || '',
    stars: typeof p.stars === 'number' ? p.stars : 0,
    downloads: typeof p.downloads === 'number' ? p.downloads : 0,
    install: p.install || '',
    added: p.added || '',
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': '@99galaxy/dsh-plugin-market', Accept: 'application/json' },
  })
  if (res.status !== 200) return { ok: false, why: 'http' + res.status }
  try {
    return { ok: true, data: JSON.parse(await res.text()) }
  } catch (e) {
    return { ok: false, why: 'bad-json' }
  }
}

// Official domain, then a mirror of it, then the npm package's raw file. The npm
// route reads the file through the registry's JSON API rather than downloading a
// tarball, so no tar parsing is required.
async function fetchCatalog() {
  const custom = flags.url === undefined ? '' : String(flags.url).trim()
  const requested = custom !== '' ? custom : CATALOG_URL
  // Attempt order: what was asked for, then any explicitly configured mirror, then
  // a well-known HTTPS CDN of the same published file, then the npm registry's own
  // metadata (last resort).
  const attempts = [{ name: 'official', url: requested }]
  if (MIRROR !== '') attempts.push({ name: 'mirror', url: MIRROR + requested })
  if (CDN !== '') attempts.push({ name: 'cdn', url: CDN })
  attempts.push({ name: 'npm', url: 'npm:' + NPM_META })

  const tried = []
  for (const attempt of attempts) {
    try {
      let data = null
      let version = ''
      if (attempt.url.slice(0, 4) === 'npm:') {
        const meta = await getJson(attempt.url.slice(4))
        if (!meta.ok) { tried.push(attempt.name + '=' + meta.why); continue }
        const latest = meta.data['dist-tags'] && meta.data['dist-tags'].latest
        if (!latest) { tried.push(attempt.name + '=no-latest'); continue }
        const raw = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog@' + latest + '/plugins.json'
        const file = await getJson(raw)
        if (!file.ok) { tried.push(attempt.name + '=' + file.why); continue }
        data = file.data
        version = latest
      } else {
        const got = await getJson(attempt.url)
        if (!got.ok) { tried.push(attempt.name + '=' + got.why); continue }
        data = got.data
        version = (data && data.updated) || ''
      }
      if (!data || !Array.isArray(data.plugins)) { tried.push(attempt.name + '=bad-shape'); continue }
      const payload = {
        version,
        updated: data.updated || '',
        fetchedAt: Date.now(),
        categories: data.categories || {},
        plugins: data.plugins.map(slim),
      }
      if (!ensureDir()) { tried.push(attempt.name + '=no-state-dir'); continue }
      writeFileSync(CATALOG_PATH, JSON.stringify(payload))
      return {
        ok: true, source: attempt.name, tried, version, updated: payload.updated,
        count: payload.plugins.length, path: CATALOG_PATH, bytes: statSync(CATALOG_PATH).size,
      }
    } catch (e) {
      tried.push(attempt.name + '=' + (e && e.message ? e.message : 'error'))
    }
  }
  return { ok: false, tried }
}

function loadCache() {
  try {
    if (!existsSync(CATALOG_PATH)) return null
    const j = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
    if (!j || !Array.isArray(j.plugins)) return null
    return j
  } catch (e) {
    return null
  }
}

async function doCatalog() {
  const force = String(flags.force || '') === '1'
  let cache = loadCache()
  const ageMs = cache ? Date.now() - (cache.fetchedAt || 0) : Infinity
  const isFresh = cache && !force && ageMs < CACHE_MS
  let note = ''
  let source = 'local'
  let tried = []
  let bytes = 0

  if (!isFresh) {
    const got = await fetchCatalog()
    tried = got.tried || []
    if (got.ok) {
      source = got.source
      bytes = got.bytes
      cache = loadCache()
    } else if (cache) {
      // Re-fetch failed but there is still usable data: keep serving it, and say so.
      source = 'local'
      note = '目录重新获取失败，继续使用本地目录（已保存 ' + Math.round(ageMs / 60000) + ' 分钟；' + tried.join(' | ') + '）'
    } else {
      return { ok: false, message: '无法获取插件目录：' + tried.join(' | ') }
    }
  }
  if (!cache) cache = loadCache()
  if (!cache) return { ok: false, message: '目录缓存不可读' }
  try { bytes = statSync(CATALOG_PATH).size } catch (e) { bytes = 0 }
  return {
    ok: true, source, tried, fromCache: !!isFresh, version: cache.version || '',
    updated: cache.updated || '', fetchedAt: cache.fetchedAt || 0,
    ageMs: isFinite(ageMs) ? ageMs : 0, count: (cache.plugins || []).length,
    path: CATALOG_PATH, bytes, note,
  }
}

// What is installed in a profile: declared dependency names AND the directories
// actually present under node_modules. The latter catches a package installed
// under a different name than the catalog lists.
function doInstalled() {
  const profile = flags.profile || PROFILE_DEFAULT
  const profileDir = join(HOME, 'profiles', profile)
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, message: '没有找到 profile：' + profileDir }
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    return { ok: false, message: 'profile package.json 解析失败：' + (e && e.message) }
  }
  // name -> the spec the profile actually records, NOT name -> name. The reader
  // (index.js installedMaps) digs `github:owner/repo` out of the spec to build its
  // repo table, and the catalog lists half its entries in exactly that form: with
  // name -> name the table stays empty and those entries can never show as installed.
  const deps = manifest.dependencies || {}
  const specs = {}
  for (const name of Object.keys(deps)) specs[name] = typeof deps[name] === 'string' ? deps[name] : name

  const dirNames = []
  const nm = join(profileDir, 'node_modules')
  try {
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.slice(0, 1) === '.') continue
      if (entry.name.slice(0, 1) === '@') {
        try {
          for (const sub of readdirSync(join(nm, entry.name), { withFileTypes: true })) {
            if (sub.isDirectory()) dirNames.push(entry.name + '/' + sub.name)
          }
        } catch (e) { /* unreadable scope dir */ }
      } else {
        dirNames.push(entry.name)
      }
    }
  } catch (e) { /* no node_modules yet */ }

  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []

  // name -> installed version, for the update check. Deliberately NOT for every
  // directory under node_modules: most of them are DSH's own transitive
  // dependencies, and reading all of them costs ~100 ms against ~1 ms for the few
  // that can be a plugin. `bundles` is included because a bundle need not be a
  // declared dependency. A name that cannot be read simply gets no entry, and the
  // reader reports that plugin's version as unknown rather than guessing.
  const versions = {}
  for (const name of Object.keys(deps).concat(bundles)) {
    if (versions[name] !== undefined) continue
    try {
      const m = JSON.parse(readFileSync(join(nm, name, 'package.json'), 'utf8'))
      if (m && typeof m.version === 'string' && m.version !== '') versions[name] = m.version
    } catch (e) { /* not installed under that name */ }
  }

  const payload = {
    profile,
    profileDir,
    generatedAt: Date.now(),
    bundles,
    specs,
    dirNames,
    versions,
  }
  if (!ensureDir()) return { ok: false, message: '无法创建状态目录' }
  writeFileSync(INSTALLED_PATH, JSON.stringify(payload))
  return {
    ok: true, profile, specCount: Object.keys(specs).length, dirCount: dirNames.length,
    versionCount: Object.keys(versions).length,
    path: INSTALLED_PATH, specs: Object.keys(specs),
  }
}

// Installing is a shell concern, so the host runs pnpm itself; this CLI only
// records the result and reconciles dsh.profile.bundles.

// pnpm records how it built a modules directory in node_modules/.modules.yaml.
// Reading it is the only reliable way to reuse the same settings; guessing
// produces the "different virtual-store-dir-max-length" refusal.
function modulesYaml(profileDir) {
  try {
    return readFileSync(join(profileDir, 'node_modules', '.modules.yaml'), 'utf8')
  } catch (e) {
    return ''
  }
}

function doInstall() {
  const spec = parsed.rest[1] || ''
  const profile = flags.profile || PROFILE_DEFAULT
  const profileDir = join(HOME, 'profiles', profile)
  if (!existsSync(join(profileDir, 'package.json'))) {
    console.error('market: no profile at ' + profileDir)
    process.exit(2)
  }
  if (spec === '') {
    console.error('market: no spec')
    process.exit(2)
  }
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) {
    console.error('market: npm-cli.js not found: ' + npmCli)
    process.exit(3)
  }
  const manifestPath = join(profileDir, 'package.json')
  const before = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const beforeDeps = new Set(Object.keys(before.dependencies || {}))

  const env = Object.assign({}, process.env, {
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // pnpm resolves GitHub specs to git+ssh, which fails without SSH keys.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git+ssh://git@github.com/',
  })

  // Use the same pnpm MAJOR the profile's node_modules was built with. Asking for a
  // different version is how "ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF" happens:
  // pnpm refuses to touch a modules directory whose recorded settings differ.
  //
  // The profile's own configuration must also be left alone. It already states
  // `nodeLinker: hoisted` and `autoInstallPeers: false` in pnpm-workspace.yaml, so
  // passing them again on the command line (as this used to) only creates
  // contradictions — and it also overrode storeDir with a profile-local path that
  // did not match the recorded one.
  const recorded = modulesYaml(profileDir)
  const major = /pnpm@(\d+)\./.exec(recorded)
  const pnpmSpec = major === null ? 'pnpm' : 'pnpm@' + major[1]

  const baseArgs = ['add', spec, '-w', '--dir', profileDir]

  // Run pnpm with its output captured to FILES (never pipes, and never through a
  // shell: the spec comes from a remote catalog, so a shell would be an injection
  // hole). The output is echoed back afterwards so the caller still sees the log.
  function runPnpm (extraArgs) {
    if (!ensureDir()) return { status: 1, error: null, output: '无法创建状态目录' }
    const runDir = join(STATE_DIR, '.runs')
    let ofd = 0
    let efd = 0
    const outPath = join(runDir, 'install-' + Date.now() + '.out')
    const errPath = join(runDir, 'install-' + Date.now() + '.err')
    try {
      mkdirSync(runDir, { recursive: true })
      ofd = openSync(outPath, 'w')
      efd = openSync(errPath, 'w')
    } catch (e) {
      if (ofd !== 0) closeSync(ofd)
      if (efd !== 0) closeSync(efd)
      return { status: 1, error: null, output: '无法创建运行目录：' + (e && e.message) }
    }
    let r
    try {
      r = spawnSync(
        process.execPath,
        [npmCli, 'exec', '--yes', '--package=' + pnpmSpec, '--', 'pnpm'].concat(baseArgs).concat(extraArgs || []),
        { cwd: profileDir, stdio: ['ignore', ofd, efd], env },
      )
    } finally {
      closeSync(ofd)
      closeSync(efd)
    }
    const read = (p) => { try { return readFileSync(p, 'utf8') } catch (e) { return '' } }
    const output = read(outPath) + read(errPath)
    try { rmSync(outPath, { force: true }) } catch (e) { /* best effort */ }
    try { rmSync(errPath, { force: true }) } catch (e) { /* best effort */ }
    return { status: r.status, error: r.error, output }
  }

  let result = runPnpm([])

  // strictDepBuilds defaults to true, so pnpm EXITS NON-ZERO when any dependency has
  // an unreviewed build script (ERR_PNPM_IGNORED_BUILDS) — a profile that merely
  // contains such a package (node-pty, say) would then fail EVERY market install.
  //
  // pnpm 12 does not honour --config.strict-dep-builds / npm_config_strict_dep_builds
  // for this, so the fallback is --ignore-scripts. That is only reached when pnpm
  // would otherwise refuse: an install whose builds ARE approved still runs them,
  // because the first attempt succeeds. And it approves nothing — the scripts stay
  // unrun, which is the same posture pnpm already enforces for unapproved packages.
  if (result.error === null || result.error === undefined) {
    if (result.status !== 0 && result.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
      console.log('market: pnpm refused because a dependency has an unreviewed build script.')
      console.log('market: retrying with --ignore-scripts (nothing gets built, nothing is approved).')
      console.log('market: to build such a package deliberately, run `pnpm approve-builds` in the profile.')
      const retry = runPnpm(['--ignore-scripts'])
      result = { status: retry.status, error: retry.error, output: result.output + '\n' + retry.output }
    }
  }

  // Surface the full log either way: the host returns it as the job's output.
  if (result.output !== '') console.log(result.output)
  if (result.error) {
    console.error('market: spawn failed: ' + result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status)

  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = (after.dsh && after.dsh.profile && after.dsh.profile.bundles) || []
  let changed = false
  for (const name of Object.keys(after.dependencies || {})) {
    let isBundle = false
    try {
      const m = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
      isBundle = !!(m.dsh && m.dsh.bundle)
    } catch (e) {
      isBundle = false
    }
    if (isBundle && bundles.indexOf(name) < 0) {
      bundles.push(name)
      changed = true
    }
  }
  if (changed) {
    after.dsh = Object.assign({}, after.dsh, {
      profile: Object.assign({}, after.dsh && after.dsh.profile, { bundles }),
    })
    writeFileSync(manifestPath, JSON.stringify(after, null, 2) + '\n')
    console.log('market: updated dsh.profile.bundles')
  }
  const added = Object.keys(after.dependencies || {}).filter((n) => !beforeDeps.has(n))
  console.log('market: installed=[' + added.join(', ') + ']')
  console.log('market: bundles=[' + bundles.join(', ') + ']')
  process.exit(0)
}

if (action === 'catalog') {
  out(await doCatalog())
} else if (action === 'installed') {
  out(doInstalled())
} else if (action === 'install') {
  doInstall()
} else {
  console.error('market: unknown action')
  process.exit(2)
}
