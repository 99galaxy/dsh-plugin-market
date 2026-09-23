// The single definition of how the deployable helper is produced from its source.
//
// Shared by tools/build-helper.mjs (which writes it) and tools/check-sync.mjs (which
// verifies the committed copy matches). Keeping one function is what stops the two
// from drifting — the same mistake that once let a stale script be reused.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments.mjs'

const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
// A plain HTTPS CDN of the same published file: no redirect guessing, so it is a
// more dependable second attempt than a generic proxy.
const CDN = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog@latest/plugins.json'
const MIRROR = 'https://gh-proxy.com/'

/** Replace the source's template placeholders and drop its comments. */
export function buildHelper (source) {
  return stripComments(source.replace(/\r\n/g, '\n'))
    .split('__CATALOG__').join(CATALOG_URL)
    .split('__CDN__').join(CDN)
    .split('__MIRROR__').join(MIRROR) + '\n'
}

/** Every problem that would make the built helper unusable, as a list of strings. */
export function helperProblems (built) {
  const problems = []
  for (const token of ['__CATALOG__', '__CDN__', '__MIRROR__']) {
    if (built.includes(token)) problems.push('token ' + token + ' survived')
  }
  if (!built.includes(CATALOG_URL)) problems.push('the catalog URL is missing')
  if (!built.includes(CDN)) problems.push('the CDN URL is missing')
  if (!built.includes(MIRROR)) problems.push('the mirror URL is missing')
  if (!built.includes('__MARKET_JSON__')) problems.push('the output marker is missing')
  return problems
}

/** Read the helper source from the tools directory. */
export function readHelperSource (here) {
  return readFileSync(join(here, 'market-core.mjs'), 'utf8')
}
