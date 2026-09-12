// Render the market page and drive its IN-PAGE tabs.
//
//   node tools/test-bundle-tabs.mjs
//
// The requirement: the plugin contributes ONE settings page, and that page holds a
// tab bar whose "已安装" tab lists only installed plugins. It must NOT add a second
// entry to the settings navigation.
//
// This runs the real bundle with a minimal React renderer and a stub fetch, then
// clicks the tabs, so the assertions are about what the page actually requests and
// renders.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(root, 'pkg', 'dsh-plugin-market', 'client', 'client.js')
const src = readFileSync(bundlePath, 'utf8')

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

// ---- environment stubs -----------------------------------------------------
global.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
}

let fetchCalls = []
let nextPayload = null
global.fetch = async (url) => {
  fetchCalls.push(String(url))
  return { status: 200, json: async () => nextPayload }
}

function payloadFor (items, matched, installedTotal) {
  return {
    ok: true,
    payload: {
      items,
      categories: [{ id: 'ui', zh: '界面', en: 'UI', count: 10 }, { id: 'tools', zh: '工具', en: 'Tools', count: 5 }],
      count: items.length,
      total: 3561,
      matched,
      installedTotal,
      offset: 0,
      sort: 'stars',
      only: 'all',
      category: '',
      q: '',
      catalogFromCache: true,
      fetchedAt: Date.now(),
      catalogUpdated: '2026-09-12',
      source: 'local',
      note: '',
    },
  }
}

// ---- minimal React ---------------------------------------------------------
const stateStore = []
const refs = []
let hookIndex = 0
let pendingEffects = []

const React = {
  createElement (type, props, ...children) { return { type, props: props || {}, children } },
  useState (initial) {
    const i = hookIndex
    hookIndex += 1
    if (!(i in stateStore)) stateStore[i] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => { stateStore[i] = typeof next === 'function' ? next(stateStore[i]) : next }
    return [stateStore[i], setter]
  },
  useRef (initial) {
    const i = hookIndex
    hookIndex += 1
    if (!(i in refs)) refs[i] = { current: typeof initial === 'function' ? initial() : initial }
    return refs[i]
  },
  useCallback (fn) { hookIndex += 1; return fn },
  useEffect (fn) { hookIndex += 1; pendingEffects.push(fn) },
}

// ---- load the bundle -------------------------------------------------------
let definition = null
global.window = { __ModuleLoader__: { load: (def) => { definition = def } } }
new Function('window', src)(global.window)
check('bundle registered a factory', definition !== null)
check('bundle id', definition !== null && definition.id === 'dsh-plugin-market', definition && definition.id)

const mod = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('exports apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))

// ---- what the plugin registers --------------------------------------------
const sections = []
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  slots: { inject: (n, cb) => cb(), register: (cfg, Component) => { sections.push({ cfg, Component }); return () => {} } },
}
mod.apply(ctx)

check('contributes exactly ONE settings section', sections.length === 1, 'count=' + sections.length)
check('no second nav entry for installed',
  sections.length === 1 && sections[0].cfg.id === 'dsh-plugin-market',
  sections.map((s) => s.cfg.id).join(', '))
check('its label is DSH 插件市场', sections.length === 1 && sections[0].cfg.label === 'DSH 插件市场')

// ---- render harness --------------------------------------------------------
function renderElement (node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) return node.map(renderElement)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderElement(node.type(node.props))
  return { type: node.type, props: node.props, children: renderElement(node.children) }
}
function walk (node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  if (typeof node !== 'object') { out.push(node); return out }
  out.push(node)
  walk(node.children, out)
  return out
}
const cls = (n) => (n.props && n.props.className) || ''
const classList = (n) => cls(n).split(/\s+/).filter(Boolean)
const textsOf = (tree) => walk(tree).filter((n) => typeof n === 'string').join(' ')
// Exact class match: `indexOf('dsxpm-tab')` would also hit the container
// (`dsxpm-tabs`) and the count span (`dsxpm-tab-n`), which made this click the
// wrong node.
const tabButtons = (tree) => walk(tree).filter((n) => n.type === 'button' && classList(n).includes('dsxpm-tab'))
const cardNames = (tree) => walk(tree).filter((n) => cls(n) === 'dsxpm-name').map((n) => n.children[0])

const Component = sections[0].Component
function draw () {
  hookIndex = 0
  pendingEffects = []
  return renderElement(React.createElement(Component, {}))
}
const tick = () => new Promise((r) => setTimeout(r, 0))
async function settle (tree) {
  const run = pendingEffects.slice()
  pendingEffects = []
  for (const fn of run) fn()
  await tick()
  await tick()
  return draw()
}

// ---- mount: the browse tab -------------------------------------------------
console.log('--- 默认：全部插件 ---')
stateStore.length = 0
refs.length = 0
fetchCalls = []
nextPayload = payloadFor([{ name: 'a1', category: 'ui', categoryZh: '界面', install: 'dsh plugin add a1' }], 3561, 3)
let tree = await settle(draw())

check('the page issued a list request', fetchCalls.length >= 1 && fetchCalls[0].includes('/dsh-plugin-market/list'), fetchCalls[0])
check('default range is all', fetchCalls[0].includes('only=all'), fetchCalls[0])
const tabs0 = tabButtons(tree)
check('renders an in-page tab bar with two tabs', tabs0.length === 2, 'tabs=' + tabs0.length)
if (tabs0.length === 2) {
  check('tab labels are 全部插件 / 已安装',
    textsOf(tabs0[0]).includes('全部插件') && textsOf(tabs0[1]).includes('已安装'),
    tabs0.map((t) => textsOf(t)).join(' | '))
  check('the browse tab is the active one', classList(tabs0[0]).includes('dsxpm-tab-on') && !classList(tabs0[1]).includes('dsxpm-tab-on'))
  check('the installed tab carries the count', textsOf(tabs0[1]).includes('3'), textsOf(tabs0[1]))
}
const text0 = textsOf(tree)
check('offers the range selector on the browse tab', text0.includes('仅未安装'))
check('shows the catalog size', text0.includes('目录 3561 个'), text0.slice(0, 160))
check('renders the browse item', cardNames(tree).join(',') === 'a1', cardNames(tree).join(','))

// ---- click the installed tab ----------------------------------------------
console.log('\n--- 切到「已安装」标签 ---')
fetchCalls = []
nextPayload = payloadFor([
  { name: 'dshmarket', category: 'tools', categoryZh: '工具', install: 'dsh plugin add dshmarket', installed: true, installedAs: 'dshmarket' },
], 1, 1)
tabButtons(tree)[1].props.onClick()
tree = await settle(draw())

check('switching tabs issued a new request', fetchCalls.length >= 1, 'calls=' + fetchCalls.length)
check('the request pins only=installed', fetchCalls.length >= 1 && fetchCalls[0].includes('only=installed'), fetchCalls[0])
const tabs1 = tabButtons(tree)
check('the installed tab is now active', classList(tabs1[1]).includes('dsxpm-tab-on') && !classList(tabs1[0]).includes('dsxpm-tab-on'))
const text1 = textsOf(tree)
check('lists only the installed plugin', cardNames(tree).join(',') === 'dshmarket', cardNames(tree).join(','))
check('marks it as installed', text1.includes('已安装'))
check('shows an installed count in the meta line', text1.includes('已安装 1 个'), text1.slice(0, 200))
check('HIDES the range selector on the installed tab', !text1.includes('仅未安装'), text1.slice(0, 200))
check('still shows the tab bar', tabButtons(tree).length === 2)

// ---- click back to the browse tab -----------------------------------------
console.log('\n--- 切回「全部插件」标签 ---')
fetchCalls = []
nextPayload = payloadFor([{ name: 'b1', category: 'ui', categoryZh: '界面', install: 'dsh plugin add b1' }], 3561, 1)
tabButtons(tree)[0].props.onClick()
tree = await settle(draw())

check('switching back issued a request', fetchCalls.length >= 1, 'calls=' + fetchCalls.length)
check('it asks for only=all again', fetchCalls.length >= 1 && fetchCalls[0].includes('only=all'), fetchCalls[0])
check('the browse tab is active again', classList(tabButtons(tree)[0]).includes('dsxpm-tab-on'))
const text2 = textsOf(tree)
check('the range selector returns', text2.includes('仅未安装'))
check('shows the new item', cardNames(tree).join(',') === 'b1', cardNames(tree).join(','))

// ---- empty installed tab ---------------------------------------------------
console.log('\n--- 已安装为空 ---')
stateStore.length = 0
refs.length = 0
fetchCalls = []
nextPayload = payloadFor([], 0, 0)
let tree2 = await settle(draw())
nextPayload = payloadFor([], 0, 0)
tabButtons(tree2)[1].props.onClick()
tree2 = await settle(draw())
const emptyText = textsOf(tree2)
check('explains how to get plugins', emptyText.includes('还没有安装任何插件'), emptyText.slice(0, 200))
check('the installed tab shows 0', emptyText.includes('已安装 0 个'), emptyText.slice(0, 200))

console.log('\n' + (bad === 0 ? 'TAB TEST PASSED' : 'TAB TEST FAILED (' + bad + ')'))
process.exit(bad === 0 ? 0 : 1)
