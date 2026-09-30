/**
 * Harness instructions that ride INSIDE tool results.
 *
 * Claude Code appends `<system-reminder>` blocks to the text of a tool_result — the commit
 * attribution rules, a newly loaded tool, a note that a file changed underneath the agent. They
 * are addressed to the model, not part of the tool's output, and a head/tail window has no idea
 * which is which: a 60-char Bash result with a 900-char reminder behind it was compacted to its
 * first and last lines, which cut the reminder's opening tag and most of its instructions out of
 * the model's view. Prefix decay did the same thing wholesale, one aged-out stub at a time.
 *
 * So the transforms only ever see the text BETWEEN reminders. Each reminder is copied through
 * byte-for-byte, in place. An opening tag with no closing tag protects everything after it —
 * over-protecting costs a few saved bytes, under-protecting silently rewrites instructions.
 *
 * Pure and deterministic: the split is a function of the text alone, so compression stays
 * byte-stable across turns and the prompt cache holds.
 */

const REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g

export interface SegmentResult { text: string; changed: boolean }

/**
 * Apply `fn` to every stretch of `text` outside a `<system-reminder>` block, leaving the blocks
 * themselves untouched. Text with no reminder goes to `fn` whole, exactly as before.
 */
export function mapOutsideReminders(text: string, fn: (segment: string) => SegmentResult): SegmentResult {
  if (!text.includes('<system-reminder>')) return fn(text)
  let out = ''
  let changed = false
  let last = 0
  for (const m of text.matchAll(REMINDER)) {
    const at = m.index as number
    if (at > last) {
      const r = fn(text.slice(last, at))
      out += r.text
      changed = changed || r.changed
    }
    out += m[0]
    last = at + m[0].length
  }
  if (last < text.length) {
    const r = fn(text.slice(last))
    out += r.text
    changed = changed || r.changed
  }
  return { text: out, changed }
}
