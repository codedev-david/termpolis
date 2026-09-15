import { describe, it, expect } from 'vitest'
const { compactText } = await import('../../src/main/headroom/compactText')

describe('compactText', () => {
  it('leaves small text untouched', () => {
    const r = compactText('a\nb\nc', { headLines: 10, tailLines: 10, maxChars: 1000 })
    expect(r).toEqual({ text: 'a\nb\nc', elided: false })
  })

  it('collapses runs of identical consecutive lines', () => {
    const r = compactText('x\nx\nx\ny', { headLines: 10, tailLines: 10, maxChars: 1000 })
    expect(r.text).toBe('x\n… (×2 identical lines)\ny')
    expect(r.elided).toBe(true)
  })

  it('applies a head/tail window when over the line budget', () => {
    const src = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
    const r = compactText(src, { headLines: 2, tailLines: 2, maxChars: 100000 })
    expect(r.elided).toBe(true)
    expect(r.text.startsWith('line0\nline1\n')).toBe(true)
    expect(r.text.endsWith('\nline98\nline99')).toBe(true)
    expect(r.text).toContain('lines elided')
  })

  /**
   * Error-biased retention. The window keeps what ran and how it ended; everything below is
   * about the middle, which is where a failing build puts the only lines worth reading.
   */
  describe('error-biased retention', () => {
    const TIGHT = { headLines: 2, tailLines: 2, maxChars: 100000 }

    /** 100 numbered lines with `failure` planted at index 50, deep inside the elided middle. */
    function withMiddleLine(failure: string): string {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`)
      lines[50] = failure
      return lines.join('\n')
    }

    // One per toolchain the app is meant to cover. The CamelCase names are the reason this
    // cannot be a plain /\berror\b/: there is no word boundary inside "AssertionError".
    it.each([
      ['AssertionError: expected 3 to be 4'],
      ['TypeError: x is not a function'],
      ['java.lang.NullPointerException'],
      ['panic: runtime error: index out of range [5]'],
      ['Traceback (most recent call last):'],
      ['npm ERR! code ELIFECYCLE'],
      ['--- FAIL: TestParse (0.00s)'],
      ['error CS0103: The name x does not exist'],
      ["thread 'main' panicked at src/main.rs:4:5"],
      ['FAILED tests/test_parser.py::test_tokens'],
      ['Segmentation fault (core dumped)'],
      ['  ✗ renders the header'],
    ])('rescues %s from the middle', (failure) => {
      expect(compactText(withMiddleLine(failure), TIGHT).text).toContain(failure)
    })

    it('still keeps the head and tail around a rescued line', () => {
      const r = compactText(withMiddleLine('panic: boom'), TIGHT)
      expect(r.text.startsWith('line0\nline1\n')).toBe(true)
      expect(r.text.endsWith('\nline98\nline99')).toBe(true)
      expect(r.elided).toBe(true)
    })

    it('costs nothing on clean output — byte-identical to the blind window', () => {
      const src = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
      expect(compactText(src, TIGHT).text).toBe('line0\nline1\n… [96 lines elided] …\nline98\nline99')
    })

    it('counts each gap separately once a rescue splits the middle', () => {
      // Kept: 0,1 (head), 50 (rescued), 98,99 (tail). Gaps are 2..49 and 51..97.
      expect(compactText(withMiddleLine('panic: boom'), TIGHT).text).toBe(
        'line0\nline1\n… [48 lines elided] …\npanic: boom\n… [47 lines elided] …\nline98\nline99',
      )
    })

    it('spends no more than the tail budget, however many lines fail', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `error ${i}: on fire`)
      lines[0] = 'head0'; lines[1] = 'head1'
      lines[98] = 'tail98'; lines[99] = 'tail99'
      const r = compactText(lines.join('\n'), TIGHT)
      const kept = r.text.split('\n').filter((l) => !l.includes('elided'))
      expect(kept).toHaveLength(6) // 2 head + 2 tail + at most tailLines(2) rescued
    })

    it('does not claim elision when the middle is rescued in full', () => {
      // The window fires (5 > 2+2) but the lone middle line is salient, so nothing is dropped.
      // Claiming `elided` here would stash a retrieve token for content already present.
      const r = compactText('a\nb\npanic: boom\nc\nd', TIGHT)
      expect(r.text).toBe('a\nb\npanic: boom\nc\nd')
      expect(r.elided).toBe(false)
    })

    it('matches the same line the same way twice (no sticky regex state)', () => {
      const src = withMiddleLine('error: boom')
      expect(compactText(src, TIGHT).text).toBe(compactText(src, TIGHT).text)
    })
  })
})
