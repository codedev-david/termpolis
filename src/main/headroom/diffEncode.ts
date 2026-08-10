/**
 * Near-duplicate tool results, sent as a patch instead of in full.
 *
 * Exact-duplicate collapse already existed: a byte-identical block that appeared earlier in the
 * same request body becomes a one-line reference stub. But the common case in an editing loop is
 * NEAR-identical, not identical — read a file, edit three lines, read it again — and byte
 * equality misses every one of those, so the whole file goes over the wire a second time.
 *
 * The transform is a common-prefix/common-suffix trim: find how many leading and trailing lines
 * the two results share and emit only the region between them. That is O(n), needs no LCS table,
 * and captures the dominant real shape (localized edits inside otherwise identical content).
 * Scattered changes leave a large middle, the patch fails the size test below, and the caller
 * falls back to ordinary compaction — so this never makes a result bigger.
 *
 * DETERMINISM is a cache-safety requirement, not a nicety: the output is a pure function of the
 * request body (the base is another block in that same body, chosen by a fixed left-to-right
 * scan), so re-compressing the same conversation next turn produces byte-identical output and the
 * Anthropic prompt cache survives. Reversal is the usual content-hash token — the caller stashes
 * the true original, so `retrieve_full` still returns the unmodified result.
 */

export interface DiffPatch {
  text: string
  /** Lines that actually differ — surfaced for tests and diagnostics. */
  changedLines: number
}

/** One earlier block, kept with its split lines so a body with many blocks doesn't re-split. */
export interface DiffCandidate {
  text: string
  lines: string[]
}

/** A patch has to be a clear win, not a marginal one, or the framing isn't worth the confusion. */
export const DIFF_MAX_RATIO = 0.6
/** Under this many lines the full result is already cheap — patching adds framing for nothing. */
export const DIFF_MIN_LINES = 12
/** Newest-first scan cap, so cost stays bounded on a long conversation. */
export const DIFF_MAX_CANDIDATES = 24

export function makeCandidate(text: string): DiffCandidate {
  return { text, lines: text.split('\n') }
}

function commonPrefix(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

function commonSuffix(a: string[], b: string[], skip: number): number {
  const max = Math.min(a.length, b.length) - skip
  let i = 0
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/**
 * Build a patch turning `prev` into `next`, or null when a patch isn't clearly worth it —
 * identical inputs, too few lines to matter, no shared framing, or a changed region that is
 * most of the content anyway.
 */
export function diffAgainst(prevLines: string[], nextLines: string[], nextLength: number, token: string): DiffPatch | null {
  if (nextLines.length < DIFF_MIN_LINES) return null

  const head = commonPrefix(prevLines, nextLines)
  const tail = commonSuffix(prevLines, nextLines, head)
  const removed = prevLines.slice(head, prevLines.length - tail)
  const added = nextLines.slice(head, nextLines.length - tail)
  // Nothing between the shared head and shared tail → the two are identical, which is the
  // caller's exact-duplicate stub path, not ours.
  if (removed.length === 0 && added.length === 0) return null
  // No shared framing at all → these two merely happen to be similar in size. A "patch" here is
  // just the whole result with '+' in front of every line.
  if (head === 0 && tail === 0) return null

  const out: string[] = [
    '[headroom] Identical to an earlier tool result in this conversation except for the lines below.',
    `@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@ (${head} identical lines before, ${tail} identical lines after)`,
  ]
  for (const l of removed) out.push(`-${l}`)
  for (const l of added) out.push(`+${l}`)
  out.push('', `[headroom] Full result cached — call the retrieve_full tool with token "${token}" to expand it.`)
  const text = out.join('\n')
  if (text.length >= nextLength * DIFF_MAX_RATIO) return null // not a clear win → caller compacts normally
  return { text, changedLines: removed.length + added.length }
}

/**
 * Best patch for `next` among blocks already seen in THIS body.
 *
 * Candidates are scanned newest-first (the most recent read of a file is the likeliest base) and
 * capped. Lengths outside a 2x band are skipped without splitting or scanning: past that ratio the
 * trim cannot clear DIFF_MAX_RATIO, and skipping keeps this linear in practice.
 */
export function bestDiff(candidates: DiffCandidate[], nextLines: string[], nextLength: number, token: string): DiffPatch | null {
  let best: DiffPatch | null = null
  let examined = 0
  for (let i = candidates.length - 1; i >= 0 && examined < DIFF_MAX_CANDIDATES; i--) {
    const cand = candidates[i]
    if (cand.text.length * 2 < nextLength || nextLength * 2 < cand.text.length) continue
    examined++
    const p = diffAgainst(cand.lines, nextLines, nextLength, token)
    if (p && (!best || p.text.length < best.text.length)) best = p
  }
  return best
}
