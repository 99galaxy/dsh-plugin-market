// Verify the screenshots this repository declares to storefronts.
//
//   node tools/check-screenshots.mjs
//
// The list's contributing.md fixes the contract: the file sits next to `package.json`,
// lists 1-8 images, paths are relative to the file, may not leave the plugin's
// directory, and an absolute URL must be https on GitHub hosting (third-party image
// hosts are rejected for user-privacy reasons).
//
// It also records why this deserves a guard: 41 of 773 published screenshots had
// become 404s, because a link nobody checks can only rot silently. Relative paths
// break visibly in this repository — this makes them break loudly in CI instead.
//
// Declaring screenshots is OPTIONAL (a repo that declares none is fine: storefronts
// fall back to images in the README). Only a declaration that is wrong fails here.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, isAbsolute, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const manifestPath = join(root, 'screenshots.json')

let bad = 0
const check = (label, ok, detail) => { if (!ok) bad += 1; console.log((ok ? '  OK    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : '')) }

if (!existsSync(manifestPath)) {
  console.log('  OK    screenshots.json 未声明（可选：不声明时市场从 README 抽图）')
  console.log('\nSCREENSHOTS OK (nothing declared)')
  process.exit(0)
}

let declared = null
try {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  declared = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.screenshots) ? raw.screenshots : null)
} catch (e) {
  declared = null
}
check('screenshots.json 是合法 JSON（数组或 {screenshots:[…]}）', declared !== null)
if (declared === null) {
  console.log('\nSCREENSHOTS HAS 1 PROBLEM')
  process.exit(1)
}

check('声明的张数在 1-8 之间', declared.length >= 1 && declared.length <= 8, declared.length + ' 张')

// https on GitHub hosting only — anything else is refused by the list.
const GITHUB_HOSTED = /^https:\/\/(raw\.githubusercontent\.com|user-images\.githubusercontent\.com|camo\.githubusercontent\.com|github\.com)\//
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']

declared.forEach((entry, i) => {
  const label = '第 ' + (i + 1) + ' 张 '
  if (typeof entry !== 'string' || entry === '') {
    check(label + '是非空字符串', false, JSON.stringify(entry))
    return
  }
  if (/^https?:\/\//i.test(entry)) {
    check(label + '绝对 URL 是 GitHub 托管的 https', GITHUB_HOSTED.test(entry), entry.slice(0, 90))
    return
  }
  check(label + '不是绝对路径', !isAbsolute(entry) && entry.slice(0, 1) !== '/', entry)
  check(label + '没有 .. （不能跳出插件目录）', !entry.split(/[\\/]/).includes('..'), entry)
  check(label + '是浏览器认得的图片扩展名', IMAGE_EXT.includes(extname(entry).toLowerCase()), extname(entry) || '(无扩展名)')
  const full = join(root, entry)
  check(label + '指向的文件真的存在', existsSync(full), full)
})

console.log('\n' + (bad === 0 ? 'SCREENSHOTS OK' : 'SCREENSHOTS HAS ' + bad + ' PROBLEM(S)'))
process.exit(bad === 0 ? 0 : 1)
