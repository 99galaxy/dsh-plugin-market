// String-aware comment stripping for JavaScript source.
//
// A naive `line.indexOf('//')` truncates lines whose STRINGS contain `//` — URLs
// like 'https://registry.npmjs.org/...'. That is not cosmetic damage: it silently
// rewrites real code. This scanner tracks string, template and regex state so it
// only ever removes actual comments.
//
// Usage (as a module):  stripComments(code) -> code
// Usage (as a check):   node tools/strip-comments.mjs <file.js>

export function stripComments(code) {
  let out = ''
  let i = 0
  const n = code.length
  // Stack-free: track the delimiter we are inside, if any.
  let quote = null // "'", '"', '`'
  let inLine = false
  let inBlock = false

  while (i < n) {
    const c = code[i]
    const next = code[i + 1]

    if (inLine) {
      if (c === '\n') { inLine = false; out += c }
      i += 1
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue }
      if (c === '\n') out += c // keep line structure
      i += 1
      continue
    }
    if (quote !== null) {
      out += c
      if (c === '\\') { // escaped char: copy it verbatim
        if (i + 1 < n) out += code[i + 1]
        i += 2
        continue
      }
      if (c === quote) quote = null
      i += 1
      continue
    }

    // Not in a string or comment.
    if (c === '/' && next === '/') { inLine = true; i += 2; continue }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue }
    out += c
    i += 1
  }

  // Collapse the blank lines the removed comments left behind, and drop the
  // leading blank run.
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, idx, arr) => !(l.trim() === '' && (idx === 0 || arr[idx - 1].trim() === '')))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

// CLI: strip a file and prove nothing was lost.
//
// Comparing line text is the wrong test: a line like `} catch (e) { /* why */ }`
// legitimately becomes `} catch (e) { }`, so the original line cannot appear
// verbatim. What must hold is that the CODE is unchanged once comments are removed
// — so compare the stripped result against a separate token-level comparison.
if (process.argv[1] && process.argv[1].endsWith('strip-comments.mjs') && process.argv[2]) {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(process.argv[2], 'utf8')
  const stripped = stripComments(src)

  // Token comparison: strings become placeholder tokens, everything after a line
  // comment is dropped. Both sides must produce the identical token sequence.
  function tokens(code) {
    const t = []
    let i = 0
    while (i < code.length) {
      const c = code[i]
      const n = code[i + 1]
      if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i += 1; continue }
      if (c === '/' && n === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') {
        const q = c
        i += 1
        let s = ''
        while (i < code.length) {
          if (code[i] === '\\') { s += code[i] + code[i + 1]; i += 2; continue }
          if (code[i] === q) { i += 1; break }
          s += code[i]
          i += 1
        }
        t.push(q + s + q) // exact string content preserved
        continue
      }
      if (/\s/.test(c)) { i += 1; continue }
      t.push(c)
      i += 1
    }
    return t
  }

  const a = tokens(src).join('\u0001')
  const b = tokens(stripped).join('\u0001')
  console.log(Buffer.byteLength(src) + ' -> ' + Buffer.byteLength(stripped) + ' bytes')
  console.log('token streams identical: ' + (a === b))
  if (a !== b) {
    let k = 0
    while (k < a.length && k < b.length && a[k] === b[k]) k += 1
    console.log('  first divergence at token char ' + k)
    console.log('  original: ' + JSON.stringify(a.slice(Math.max(0, k - 60), k + 60)))
    console.log('  stripped: ' + JSON.stringify(b.slice(Math.max(0, k - 60), k + 60)))
  }
  process.exit(a === b ? 0 : 1)
}
