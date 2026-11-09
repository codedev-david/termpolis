/**
 * Part of a stashed result, for a `retrieve_full` that names `grep` or `lines` (v1.55.0).
 *
 * The model asks back for about two thirds of what the wire proxy elides, and until now it always got
 * the whole result back. Most of those asks want a few lines: an error, a function, one file's hunk.
 * This answers them with only those lines, numbered, so a follow-up can name an exact range.
 *
 * Pure and deterministic: no I/O, no clock (src/main/headroom is swept for both). The text is one the
 * CCR store already holds, so its size is already capped there; the pattern is capped here.
 */

/** Longest pattern compiled. A longer one is cut, which can only widen a literal match. */
export const GREP_PATTERN_CAP = 200
/** Lines of context shown on each side of a match. */
export const GREP_CONTEXT = 2
/** Most lines one answer carries; the note after them says how to ask for the rest. */
export const SLICE_MAX_LINES = 400

export interface SliceAsk { grep?: unknown; lines?: unknown }

const given = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** True when the ask names a part; with neither, `retrieve_full` returns the whole result as before. */
export function wantsSlice(ask?: SliceAsk): boolean {
  return !!ask && (given(ask.grep) || given(ask.lines))
}

/** `/body/` is a case-insensitive regex; anything else, or a regex that will not compile, is a literal. */
export function lineMatcher(pattern: string): (line: string) => boolean {
  const p = pattern.trim().slice(0, GREP_PATTERN_CAP)
  const re = /^\/(.+)\/[a-z]*$/s.exec(p)
  if (re) {
    try {
      const compiled = new RegExp(re[1], 'i')
      return (line) => compiled.test(line)
    } catch { /* not a valid regex: match it as written */ }
  }
  const lit = p.toLowerCase()
  return (line) => line.toLowerCase().includes(lit)
}

/** "120-180", "120-" (to the end) or "120", 1-based and clamped to the text; null when unreadable. */
export function parseLineRange(s: string, total: number): { from: number; to: number } | null {
  const m = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(s)
  if (!m) return null
  const from = Math.max(1, Number(m[1]))
  const to = m[2] === undefined ? from : m[2] === '' ? total : Number(m[2])
  if (from > total || to < from) return null
  return { from, to: Math.min(to, total) }
}

/** The part of `text` the ask names, numbered like `grep -n` (`12:` a match, `11-` context). */
export function sliceResult(text: string, ask: SliceAsk): string {
  const all = text.split(/\r?\n/)
  const total = all.length
  let from = 1
  let to = total
  if (given(ask.lines)) {
    const r = parseLineRange(ask.lines, total)
    if (!r) return `Could not read lines "${ask.lines.trim()}": use a range like 120-180. The result has ${total} lines.`
    from = r.from
    to = r.to
  }
  const shown: number[] = []
  const hits = new Set<number>()
  if (given(ask.grep)) {
    const match = lineMatcher(ask.grep)
    for (let n = from; n <= to; n++) if (match(all[n - 1])) hits.add(n)
    if (hits.size === 0) {
      return `No line matches "${ask.grep.trim()}" in lines ${from}-${to} of ${total}. Call again without grep for the whole result.`
    }
    let last = 0
    for (const n of hits) {
      for (let k = Math.max(from, n - GREP_CONTEXT, last + 1); k <= Math.min(to, n + GREP_CONTEXT); k++) shown.push(k)
      last = Math.max(last, Math.min(to, n + GREP_CONTEXT))
    }
  } else {
    for (let n = from; n <= to; n++) shown.push(n)
  }
  const out: string[] = [given(ask.grep)
    ? `[${hits.size} matching line${hits.size === 1 ? '' : 's'} of ${total}]`
    : `[lines ${from}-${to} of ${total}]`]
  let prev = 0
  for (const n of shown.slice(0, SLICE_MAX_LINES)) {
    if (prev && n !== prev + 1) out.push('--')
    out.push(`${n}${hits.has(n) ? ':' : given(ask.grep) ? '-' : ':'}${all[n - 1]}`)
    prev = n
  }
  if (shown.length > SLICE_MAX_LINES) out.push(`[… ${shown.length - SLICE_MAX_LINES} more lines: ask for lines ${prev + 1}-${to}]`)
  return out.join('\n')
}
