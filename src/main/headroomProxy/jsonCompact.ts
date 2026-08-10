/**
 * JSON-aware wire compression.
 *
 * A line window is close to useless on JSON: minified payloads are one enormous line, so the window
 * never fires at all and the block goes out whole, while pretty-printed ones put the interesting
 * keys in the middle where head/tail throws them away. This pass understands the shape instead —
 * long arrays keep their first entries and report how many were elided, long string fields are
 * truncated in place, deep nesting is pruned, and the survivors are re-emitted MINIFIED so none of
 * the budget is spent on indentation. What comes out is a faithful sample of the structure rather
 * than an arbitrary slice of the text.
 *
 * ── THE BIG-INTEGER TRAP ────────────────────────────────────────────────────────────────────────
 * `JSON.parse` → `JSON.stringify` is NOT lossless. Any integer above 2^53 comes back changed:
 *
 *     JSON.stringify(JSON.parse('{"id":12345678901234567890}'))  →  '{"id":12345678901234567000}'
 *
 * Termpolis has been bitten by exactly this before (v1.29, on request bodies). A corrupted ID in a
 * tool result is worse than an uncompressed one: the agent reads it, believes it, and acts on it.
 * `hasUnsafeNumbers` therefore refuses the whole payload when any numeric literal is long enough to
 * be at risk, and the caller falls back to the line window. Detection is on the RAW TEXT, before
 * parsing, because after parsing the evidence is already gone.
 *
 * CACHE SAFETY. Pure and deterministic — key order comes from the parse (which preserves source
 * order for string keys), and every limit is a constant. Same bytes in, same bytes out.
 *
 * SHRINK-ONLY. Returns null unless the result is genuinely smaller.
 */

/** Arrays longer than this are sampled rather than sent whole. */
export const JSON_ARRAY_KEEP = 3
/** String values longer than this are truncated in place. */
export const JSON_STR_MAX = 200
/** Nesting deeper than this becomes a placeholder — deep trees are structure, not content. */
export const JSON_MAX_DEPTH = 6
/** Below this there is nothing to win. */
export const JSON_MIN_CHARS = 400
/** Digits at which a JSON integer literal may not survive a parse/stringify round trip. */
export const UNSAFE_DIGITS = 16

/**
 * Any numeric literal with enough digits to lose precision. Matches in value position only (after
 * `:` `,` or `[`) so a 16-digit number inside a string or a key name doesn't veto the payload.
 */
const UNSAFE_NUM_RE = new RegExp(`[:,\\[]\\s*-?\\d{${UNSAFE_DIGITS},}`)

export function hasUnsafeNumbers(raw: string): boolean {
  return UNSAFE_NUM_RE.test(raw)
}

/**
 * Cheap structural check before paying for a parse. Requires a JSON container, not a bare scalar —
 * a tool result that is just `"true"` or a number has nothing to compact.
 */
export function looksLikeJson(text: string): boolean {
  const t = text.trim()
  if (t.length < JSON_MIN_CHARS) return false
  const a = t[0]
  const z = t[t.length - 1]
  return (a === '{' && z === '}') || (a === '[' && z === ']')
}

interface Counts { arrays: number; strings: number; depth: number }

function walk(v: unknown, depth: number, c: Counts): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (v.length <= JSON_STR_MAX) return v
    c.strings++
    return `${v.slice(0, JSON_STR_MAX)}… (+${v.length - JSON_STR_MAX} chars)`
  }
  if (depth >= JSON_MAX_DEPTH) {
    c.depth++
    return Array.isArray(v) ? `… (${v.length} items, depth elided)` : '… (object, depth elided)'
  }
  if (Array.isArray(v)) {
    if (v.length <= JSON_ARRAY_KEEP) return v.map((x) => walk(x, depth + 1, c))
    c.arrays++
    const kept = v.slice(0, JSON_ARRAY_KEEP).map((x) => walk(x, depth + 1, c))
    return [...kept, `… (${v.length - JSON_ARRAY_KEEP} more items elided)`]
  }
  // Whatever is left is a plain object: null, number, boolean, string and array are all handled
  // above, and JSON.parse yields nothing else.
  const src = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // Object.keys preserves insertion order for string keys, and JSON.parse inserts in source
  // order — so the output key order is a pure function of the input bytes.
  for (const k of Object.keys(src)) out[k] = walk(src[k], depth + 1, c)
  return out
}

/**
 * Compact a JSON tool result. Returns null when the payload is not safe to touch, is not JSON, or
 * would not actually shrink — the caller then falls through to the line window unchanged.
 *
 * `elided` distinguishes the two ways this wins. False means nothing was dropped and the saving is
 * pure whitespace, so the result is semantically the whole payload and needs no retrieve token;
 * true means content was sampled away and the caller must stash the original.
 */
export function compactJson(text: string): { text: string; elided: boolean } | null {
  if (!looksLikeJson(text)) return null
  // Refuse rather than risk a silently corrupted identifier. See the header.
  if (hasUnsafeNumbers(text)) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  const counts: Counts = { arrays: 0, strings: 0, depth: 0 }
  const reduced = walk(parsed, 0, counts)
  let out: string
  /* v8 ignore next -- the catch is unreachable: `reduced` is built from JSON.parse output, so it
     holds only serialisable values. Kept so a future walk() change cannot crash the proxy. */
  try { out = JSON.stringify(reduced) } catch { return null }
  if (out.length >= text.length) return null
  return { text: out, elided: counts.arrays > 0 || counts.strings > 0 || counts.depth > 0 }
}
