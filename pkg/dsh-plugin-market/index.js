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
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs'
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

// Distinguishes concurrent helper runs' capture files.
let seqRun = 0

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
  const target = join(stateDir(), SCRIPT_NAME)
  try {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== readFileSync(HELPER_PATH, 'utf8')) {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(target, readFileSync(HELPER_PATH, 'utf8'))
    }
    return { ok: true, script: target, cwd: stateDir() }
  } catch (e) {
    // Fall back to running the shipped copy in place.
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
      finish({
        ok: false,
        message: '辅助脚本未返回结果（退出码 ' + String(code) + '）',
        stdout: out.slice(-2000),
        stderr: err.slice(-2000),
      })
    })
  })
}

/** Read the cached catalog. The helper writes it; the host serves it. */
function readCatalog () {
  const path = join(stateDir(), 'catalog.json')
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || !Array.isArray(data.plugins)) return { ok: false, message: 'catalog.json 形状异常' }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, message: '无法读取目录缓存：' + (e && e.message ? e.message : 'unknown') }
  }
}

const textOf = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v))
const numOf = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
const safeSort = (v) => (['downloads', 'name', 'added'].indexOf(textOf(v)) >= 0 ? textOf(v) : 'stars')
const safeOnly = (v) => (['installed', 'notinstalled'].indexOf(textOf(v)) >= 0 ? textOf(v) : 'all')

function safeSpec (install) {
  const m = /^dsh\s+plugin(?:\s+--profile\s+[A-Za-z0-9._-]+)?\s+add\s+([^\s].{0,299})$/.exec(textOf(install).trim())
  if (m === null) return null
  const spec = m[1].trim()
  if (spec === '' || spec.length > 300 || spec.indexOf('..') >= 0) return null
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

function matchInstalled (p, maps) {
  const m = /^dsh\s+plugin(?:\s+--profile\s+\S+)?\s+add\s+(.+)$/.exec(textOf(p.install))
  const spec = m === null ? '' : m[1].trim()
  if (spec !== '') {
    const direct = maps.bySpec[spec.toLowerCase()]
    if (direct !== undefined) return direct
    const g = /^(?:github:)?([^/]+\/[^/#?]+)$/i.exec(spec)
    if (g !== null) {
      const hit = maps.byRepo[g[1].replace(/\.git$/i, '').toLowerCase()]
      if (hit !== undefined) return hit
    }
  }
  const repo = repoOf(p.url).toLowerCase()
  if (repo !== '' && maps.byRepo[repo] !== undefined) return maps.byRepo[repo]
  return ''
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
            const sourceUrl = textOf(url.searchParams.get('sourceUrl')).trim()

            const args = ['catalog']
            if (bypass) args.push('--force', '1')
            if (sourceUrl !== '') args.push('--url', sourceUrl)
            const summary = await runHelper(args, 300000)
            if (summary.ok !== true) {
              sendJson(response, 502, {
                ok: false,
                message: summary.message || '无法获取插件目录',
                detail: (summary.tried || []).join(' | ') || summary.stderr || '',
              })
              return
            }

            // Refresh the inventory so the installed badges are current.
            await runHelper(['installed', '--profile', PROFILE], 60000)
            const maps = installedMaps(readInstalled())

            const got = readCatalog()
            if (got.ok !== true) {
              sendJson(response, 500, { ok: false, message: got.message })
              return
            }
            const data = got.data
            const all = data.plugins
            const catMap = data.categories || {}

            const tagged = all.map((p) => {
              const owner = matchInstalled(p, maps)
              const cat = textOf(p.category)
              const label = catMap[cat] || {}
              return {
                name: textOf(p.name),
                owner: textOf(p.owner),
                url: textOf(p.url),
                page: textOf(p.page),
                category: cat,
                categoryZh: textOf(label.zh) || cat,
                zh: textOf(p.zh),
                en: textOf(p.en),
                npm: textOf(p.npm),
                version: textOf(p.version),
                stars: numOf(p.stars),
                downloads: numOf(p.downloads),
                install: textOf(p.install),
                added: textOf(p.added),
                installed: owner !== '',
                installedAs: owner,
              }
            })
            const installedTotal = tagged.filter((p) => p.installed).length

            let rows = tagged
            if (category !== '') rows = rows.filter((p) => p.category === category)
            if (only === 'installed') rows = rows.filter((p) => p.installed)
            if (only === 'notinstalled') rows = rows.filter((p) => !p.installed)
            if (q !== '') {
              rows = rows.filter((p) =>
                p.name.toLowerCase().indexOf(q) >= 0 ||
                p.zh.toLowerCase().indexOf(q) >= 0 ||
                p.en.toLowerCase().indexOf(q) >= 0 ||
                p.owner.toLowerCase().indexOf(q) >= 0)
            }
            const matched = rows.length
            rows = rows.slice().sort((a, b) => {
              if (sort === 'downloads') return b.downloads - a.downloads
              if (sort === 'name') return a.name.localeCompare(b.name)
              if (sort === 'added') return b.added.localeCompare(a.added)
              return b.stars - a.stars
            })
            const page = rows.slice(offset, offset + limit)

            const counts = {}
            for (const p of tagged) counts[p.category || 'other'] = (counts[p.category || 'other'] || 0) + 1
            const categories = Object.keys(counts).map((id) => {
              const c = catMap[id] || {}
              return { id, zh: textOf(c.zh) || id, en: textOf(c.en) || id, count: counts[id] }
            }).sort((a, b) => b.count - a.count)

            sendJson(response, 200, {
              ok: true,
              payload: {
                items: page,
                categories,
                count: page.length,
                total: numOf(summary.count) || all.length,
                matched,
                installedTotal,
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
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          try {
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
            if (result.ok === true || result.exitCode === 0) {
              sendJson(response, 200, { ok: true, spec, seconds: took, log: textOf(result.stdout).slice(-4000) })
              return
            }
            sendJson(response, 500, {
              ok: false,
              spec,
              seconds: took,
              message: result.message || '安装失败',
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
