import { collect, lineAt, type Boundary } from './common'

// provide: UPPER_CASE TOP-LEVEL keys of an `env: { ... }` object (braces are counted, so
//          nested objects and `${}` in template values are skipped, not fatal) and
//          `process.env.KEY = ...` assignments.
// consume: any other `process.env.KEY` / `process.env['KEY']` read.
const OBJECT_OPEN = /\benv\s*:\s*\{/g
const KEY_IN_OBJECT = /(?<![\w.$])['"]?([A-Z][A-Z0-9_]*)['"]?\s*:/g
const ACCESS = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\])(\s*=(?!=))?/

/**
 * Copy of the object starting at text[open] === '{' (same offsets) with everything deeper
 * than the top level blanked. Strings are skipped whole, so braces inside them don't count.
 */
function topLevelOnly(text: string, open: number): string {
  const out: string[] = []
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]
    let end = i
    if (c === "'" || c === '"' || c === '`') {
      end = i + 1
      while (end < text.length && text[end] !== c) end += text[end] === '\\' ? 2 : 1
    } else if (c === '{') {
      depth++
    }
    const nested = depth > 1
    if (c === '}') depth--
    const chunk = text.slice(i, end + 1)
    out.push(nested ? chunk.replace(/[^\n]/g, ' ') : chunk)
    i = end + 1
    if (depth === 0) break
  }
  return out.join('')
}

export function detectEnv(file: string, text: string): Boundary[] {
  const out = collect(file, text, ACCESS, (m) => ({
    kind: 'env',
    key: m[1] ?? m[2],
    side: m[3] ? 'provide' : 'consume'
  }))
  for (const o of text.matchAll(OBJECT_OPEN)) {
    const open = o.index + o[0].length - 1
    for (const k of topLevelOnly(text, open).matchAll(KEY_IN_OBJECT)) {
      out.push({ kind: 'env', key: k[1], side: 'provide', file, line: lineAt(text, open + k.index) })
    }
  }
  return out
}
