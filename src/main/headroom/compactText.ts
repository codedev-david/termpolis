export interface CompactTextOpts { headLines: number; tailLines: number; maxChars: number }

/**
 * Share of the character budget the head keeps when a block has to be clamped by chars. The head
 * names what a result IS — the command, the first rows, the error class — so it takes the larger
 * share; the tail still keeps enough to carry the exit status and the final lines, which is the
 * whole reason this is a window and not a prefix.
 */
const HEAD_BUDGET_SHARE = 0.6

/** Marker for a char-level cut. Distinct from the line marker so a reader can tell them apart. */
const CHAR_ELISION = '\n… [chars elided] …\n'

/**
 * Back `i` off so `s.slice(0, i)` cannot end on a high surrogate whose pair is being cut. Slicing
 * a JS string is a UTF-16 code-unit operation, so an emoji or any astral character straddling the
 * boundary would otherwise ship as a lone surrogate — invalid UTF-8 on the wire.
 */
function safeEnd(s: string, i: number): number {
  if (i <= 0) return 0
  if (i >= s.length) return s.length
  const c = s.charCodeAt(i - 1)
  return c >= 0xd800 && c <= 0xdbff ? i - 1 : i
}

/** Mirror of safeEnd for `s.slice(i)`: never start on the low half of a pair. */
function safeStart(s: string, i: number): number {
  if (i <= 0) return 0
  if (i >= s.length) return s.length
  const c = s.charCodeAt(i)
  return c >= 0xdc00 && c <= 0xdfff ? i + 1 : i
}

export function compactText(s: string, opts: CompactTextOpts): { text: string; elided: boolean } {
  let elided = false

  // 1) Collapse runs of identical consecutive lines (log spam).
  const rawLines = s.split('\n')
  const collapsed: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    let run = 1
    while (i + 1 < rawLines.length && rawLines[i + 1] === line) { run++; i++ }
    collapsed.push(line)
    if (run > 1) { collapsed.push(`… (×${run - 1} identical lines)`); elided = true }
  }

  // 2) Head/tail window, driven by LINE COUNT ONLY.
  //
  // The guard matters. Windowing a block that is already within the line budget makes head and
  // tail OVERLAP: every line lands in both slices, the elided count goes negative, and the
  // "compacted" text comes back LONGER than the input. The wire layer rejects anything that
  // doesn't shrink, so that path scored a permanent 0% on exactly the blocks it was meant to
  // help — few lines, each enormous. Those are now the char clamp's job, in step 3.
  let text = collapsed.join('\n')
  if (collapsed.length > opts.headLines + opts.tailLines) {
    const head = collapsed.slice(0, opts.headLines)
    const tail = collapsed.slice(collapsed.length - opts.tailLines)
    text = [...head, `… [${collapsed.length - head.length - tail.length} lines elided] …`, ...tail].join('\n')
    elided = true
  }

  // 3) Character clamp. maxChars used to be only a trigger for step 2 and never a bound, so a
  //    minified bundle, a one-line JSON blob or a base64 payload rode the wire at full length no
  //    matter what the mode asked for. Clamped as head+tail rather than a prefix slice: the
  //    window above exists to preserve the END of a result, and a plain slice(0, maxChars) would
  //    decapitate precisely that.
  if (text.length > opts.maxChars) {
    const budget = opts.maxChars - CHAR_ELISION.length
    if (budget > 0) {
      const headEnd = safeEnd(text, Math.floor(budget * HEAD_BUDGET_SHARE))
      const tailStart = safeStart(text, text.length - (budget - headEnd))
      const clamped = text.slice(0, headEnd) + CHAR_ELISION + text.slice(tailStart)
      // Shrink-only: a maxChars smaller than the marker itself must not make things worse.
      if (clamped.length < text.length) { text = clamped; elided = true }
    }
  }

  return { text, elided }
}
