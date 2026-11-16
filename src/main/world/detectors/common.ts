// Shared types and helpers for the boundary detectors. Pure: no imports from
// codeGraph (it pulls in tree-sitter) so these can run in a utility process.

export type BoundaryKind =
  | 'ipc'
  | 'port'
  | 'fork'
  | 'worker'
  | 'spawn'
  | 'http-out'
  | 'http-listen'
  | 'env'
  | 'mcp'
  | 'watch'

export interface Boundary {
  kind: BoundaryKind
  key: string
  side: 'provide' | 'consume'
  file: string
  /** 1-based line of the match. */
  line: number
}

/** A detector sees comment-stripped text (same offsets and line numbers as the original). */
export type Detector = (file: string, text: string) => Boundary[]

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

/** Basename without its extension: `./a/memoryHost.js` -> `memoryHost`. */
export function baseKey(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name.replace(/\.[^.]*$/, '')
}

/** Run a global regex over text and map each match to a Boundary. */
export function collect(
  file: string,
  text: string,
  re: RegExp,
  build: (m: RegExpExecArray) => { kind: BoundaryKind; key: string; side: 'provide' | 'consume' }
): Boundary[] {
  const out: Boundary[] = []
  for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
    const { kind, key, side } = build(m as RegExpExecArray)
    out.push({ kind, key, side, file, line: lineAt(text, m.index) })
  }
  return out
}

/**
 * Replace comment characters with spaces, keeping every newline and offset.
 * String and template literals are skipped, so `'https://x.io/y'` is not a
 * comment. Loose by design: regex literals and `${}` nesting are not parsed.
 */
export function stripComments(text: string): string {
  const out = text.split('')
  const n = text.length
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = text[k] === '\n' ? '\n' : ' '
  }
  let i = 0
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && d === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      blank(i, end)
      i = end
    } else if (c === "'" || c === '"' || c === '`') {
      i++
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++
        else if (c !== '`' && text[i] === '\n') break
        i++
      }
      i++
    } else {
      i++
    }
  }
  return out.join('')
}
