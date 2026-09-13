import { describe, it, expect } from 'vitest'
import { compactText } from '../../src/main/headroom/compactText'

/**
 * maxChars used to be a TRIGGER and never a BOUND.
 *
 * Two consequences, both live. A result made of a few enormous lines — a minified bundle, a
 * one-line JSON blob, a base64 payload — sits under the line budget, so the window never fired and
 * it rode the wire at full length no matter which mode the user had picked. And when maxChars WAS
 * exceeded under the line budget, the old code fell through to the window anyway: head and tail
 * overlapped, every line was emitted twice, the elided count went negative (masked to zero by a
 * Math.max), and the "compacted" text came back LONGER than its input. wireCompress rejects
 * anything that fails to shrink, so that was a permanent 0% on exactly the class it should help.
 */
const W = { headLines: 12, tailLines: 6, maxChars: 1000 }
const MARKER = '\n… [chars elided] …\n'

describe('compactText — the character bound', () => {
  it('clamps a single enormous line, which no line window can reach', () => {
    const s = 'x'.repeat(50_000)
    const r = compactText(s, W)
    expect(r.elided).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(W.maxChars)
  })

  it('never returns more than it was given — the overlap regression', () => {
    // Few lines, each long: under the line budget, over the char budget. The exact shape that used
    // to come back doubled.
    const s = Array.from({ length: 4 }, (_, i) => `${i}:${'y'.repeat(4000)}`).join('\n')
    const r = compactText(s, W)
    expect(r.text.length).toBeLessThan(s.length)
    expect(r.text).not.toContain('[0 lines elided]')
  })

  it('keeps the head AND the tail, not a bare prefix', () => {
    // The window exists to preserve the END of a result — the exit status, the error, the answer.
    // A plain slice(0, maxChars) would throw away precisely that.
    const s = `STARTMARK${'m'.repeat(40_000)}ENDMARK`
    const r = compactText(s, W)
    expect(r.text.startsWith('STARTMARK')).toBe(true)
    expect(r.text.endsWith('ENDMARK')).toBe(true)
  })

  it('gives the head the larger share of the budget', () => {
    const [head, tail] = compactText('z'.repeat(20_000), W).text.split(MARKER)
    expect(head.length).toBeGreaterThan(tail.length)
  })

  it('never splits a surrogate pair', () => {
    // Astral characters occupy two UTF-16 code units. Cutting between them emits a lone surrogate,
    // which has no UTF-8 encoding and corrupts the request body. The leading 'a' shifts the pairs
    // off even offsets; the varied budgets put the cut on both halves.
    const s = 'a' + '👍'.repeat(20_000)
    for (const maxChars of [999, 1000, 1001, 1002]) {
      const { text } = compactText(s, { ...W, maxChars })
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false)
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false)
    }
  })

  it('leaves a block inside both budgets exactly alone', () => {
    expect(compactText('one\ntwo\nthree', W)).toEqual({ text: 'one\ntwo\nthree', elided: false })
  })

  it('still applies the line window, with a non-negative count', () => {
    const s = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    expect(compactText(s, { ...W, maxChars: 100_000 }).text).toContain('… [182 lines elided] …')
  })

  it('degrades safely when maxChars cannot even fit the marker', () => {
    const s = 'q'.repeat(500)
    expect(compactText(s, { ...W, maxChars: 5 }).text.length).toBeLessThanOrEqual(s.length)
  })
})
