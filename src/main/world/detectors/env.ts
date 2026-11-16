import { collect, lineAt, type Boundary } from './common'

// provide: UPPER_CASE keys of an `env: { ... }` object (flat; a nested object ends the scan)
//          and `process.env.KEY = ...` assignments.
// consume: any other `process.env.KEY` / `process.env['KEY']` read.
const OBJECT = /\benv\s*:\s*\{([^{}]*)\}/
const KEY_IN_OBJECT = /(?<![\w.$])['"]?([A-Z][A-Z0-9_]*)['"]?\s*:/g
const ACCESS = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\])(\s*=(?!=))?/

export function detectEnv(file: string, text: string): Boundary[] {
  const out = collect(file, text, ACCESS, (m) => ({
    kind: 'env',
    key: m[1] ?? m[2],
    side: m[3] ? 'provide' : 'consume'
  }))
  for (const obj of text.matchAll(new RegExp(OBJECT.source, 'g'))) {
    // Offset of the text between the braces, so keys map back to the right line.
    const base = obj.index + obj[0].length - 1 - obj[1].length
    for (const k of obj[1].matchAll(KEY_IN_OBJECT)) {
      out.push({ kind: 'env', key: k[1], side: 'provide', file, line: lineAt(text, base + k.index) })
    }
  }
  return out
}
