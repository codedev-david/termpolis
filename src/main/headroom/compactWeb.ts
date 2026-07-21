// Deterministic, content-aware reduction of HTML / web tool_result text. Pure
// string transforms only — no DOM, no parser — so the output is byte-stable for a
// given input (cache-safe) and can only ever SHRINK. It strips <script>/<style>/
// comments and other non-content containers, unwraps tags to text while preserving
// block boundaries as newlines, decodes a few common entities, and collapses
// whitespace. It is LOSSY: callers stash the ORIGINAL for retrieve_full before
// applying it. The head/tail window (compactText) still runs on top afterwards.

// Block-level closers become a newline so the flattened text keeps its shape.
const BLOCK_CLOSE =
  /<\/(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|li|tr|table|thead|tbody|h[1-6]|blockquote|pre|figure|figcaption|dd|dt)\s*>/gi
const LINE_BREAK = /<(?:br|hr)\s*\/?>/gi
// Whole containers whose contents are noise (scripts/styles/markup), removed wholesale.
const DROP_BLOCKS = /<(script|style|svg|noscript|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi

const NAMED_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&nbsp;', ' '],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&amp;', '&'], // decoded LAST so we never re-introduce a decodable entity
]

/**
 * Cheap, conservative HTML detector. Fires on a document marker (DOCTYPE/html/
 * body/head) or a meaningful density of distinct structural tags. The `\b` guards
 * keep it from mis-firing on code that merely uses `<` and `>` (TS generics such as
 * `Array<string>` or `Map<K, V>` do not match `<div`, `<span`, etc.).
 */
export function looksLikeHtml(s: string): boolean {
  if (/<!doctype\s+html/i.test(s) || /<html[\s>]/i.test(s) || /<body[\s>]/i.test(s) || /<head[\s>]/i.test(s)) {
    return true
  }
  const tags = s.match(
    /<(?:script|style|div|span|p|a|table|tr|td|th|li|ul|ol|h[1-6]|img|meta|link|nav|header|footer|section|article|form|input|button)\b/gi,
  )
  return !!tags && tags.length >= 8
}

/** Reduce HTML/web markup to its readable text. Deterministic and shrink-only. */
export function compactWeb(s: string): string {
  let t = s
  t = t.replace(/<!--[\s\S]*?-->/g, ' ') // comments
  t = t.replace(DROP_BLOCKS, ' ') // script/style/svg/... containers + their contents
  t = t.replace(LINE_BREAK, '\n') // <br>/<hr> -> newline
  t = t.replace(BLOCK_CLOSE, '\n') // block boundaries -> newline
  t = t.replace(/<[^>]+>/g, '') // strip any remaining tags
  for (const [name, ch] of NAMED_ENTITIES) t = t.split(name).join(ch)
  t = t.replace(/&#(\d{1,7});/g, (_m, d: string) => {
    const n = Number(d)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '
  })
  t = t.replace(/[^\S\n]+/g, ' ') // collapse inline whitespace (keep newlines)
  t = t.replace(/ *\n */g, '\n') // trim around newlines
  t = t.replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
  return t.trim()
}
