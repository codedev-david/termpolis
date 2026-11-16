// Lumopolis import recovery: the relative imports a JS/TS file writes, read from its text.
//
// The code graph's tree-sitter path records symbols but no import specifiers, so a snapshot can
// arrive with empty `fileImports` for every TS/JS file. The compiler already reads each file for the
// boundary detectors; this pulls the relative specifiers out of that same text so grouping and test
// linking see the project's real import graph. Pure: no fs, no Electron.
import type { GraphSnapshot } from '../codeGraph'
import { stripComments } from './detectors'

/** Files whose text is scanned: JavaScript and TypeScript, including .mjs/.cts/.jsx/.tsx. */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
// `from './x'`, `import './x'`, `import('./x')`, `require('./x')`; linear (no nested quantifiers).
const RELATIVE_SPEC = /\b(?:from|import|require)\s*(?:\(\s*)?['"`](\.{1,2}(?:\/[^'"`\s]*)?)['"`]/g

/** The relative import specifiers in a script's text, in order of first appearance; comments ignored. */
export function relativeImports(file: string, text: string): string[] {
  if (!SCRIPT_FILE.test(file)) return []
  const out = new Set<string>()
  for (const m of stripComments(text).matchAll(RELATIVE_SPEC)) out.add(m[1])
  return [...out]
}

/**
 * The snapshot with `found` specifiers merged into `fileImports`: the graph's own specifiers first,
 * then any new ones from the text. Files with nothing found are left as they were.
 */
export function withImports(snap: GraphSnapshot, found: ReadonlyMap<string, readonly string[]>): GraphSnapshot {
  if (found.size === 0) return snap
  const fileImports: Record<string, string[]> = { ...snap.fileImports }
  for (const [f, specs] of found) {
    const own = Object.prototype.hasOwnProperty.call(snap.fileImports, f) ? snap.fileImports[f] : []
    fileImports[f] = [...new Set([...own, ...specs])]
  }
  return { ...snap, fileImports }
}
