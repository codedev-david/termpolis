import { describe, it, expect } from 'vitest'
const { diffAgainst, bestDiff, makeCandidate, DIFF_MIN_LINES, DIFF_MAX_RATIO, DIFF_MAX_CANDIDATES } =
  await import('../../src/main/headroom/diffEncode')

const TOKEN = 'hr_deadbeefdeadbeef'
const lines = (n: number, tag = 'x'): string[] =>
  Array.from({ length: n }, (_, i) => `line ${i} ${tag} some content that makes this worth compressing`)
const join = (a: string[]): string => a.join('\n')

/** Shorthand: diff prev→next using next's real length, as the caller does. */
function diff(prev: string[], next: string[]) {
  return diffAgainst(prev, next, join(next).length, TOKEN)
}

describe('diffEncode — near-duplicate tool results', () => {
  it('emits a patch for a localized edit inside otherwise identical content', () => {
    const prev = lines(60)
    const next = [...prev]
    next[30] = 'line 30 EDITED'
    const p = diff(prev, next)
    expect(p).not.toBeNull()
    expect(p!.changedLines).toBe(2) // one removed, one added
    expect(p!.text).toContain('-line 30 x')
    expect(p!.text).toContain('+line 30 EDITED')
    expect(p!.text).toContain(TOKEN)
    expect(p!.text.length).toBeLessThan(join(next).length * DIFF_MAX_RATIO)
  })

  it('reports the shared framing honestly in the hunk header', () => {
    const prev = lines(40)
    const next = [...prev]
    next.splice(10, 0, 'brand new line') // 10 identical before, 30 identical after
    const p = diff(prev, next)
    expect(p!.text).toContain('@@ -11,0 +11,1 @@ (10 identical lines before, 30 identical lines after)')
  })

  it('handles a pure deletion (added side empty)', () => {
    const prev = lines(40)
    const next = [...prev]
    next.splice(20, 3)
    const p = diff(prev, next)
    expect(p).not.toBeNull()
    expect(p!.changedLines).toBe(3)
    expect(p!.text).toContain('@@ -21,3 +21,0 @@')
  })

  it('declines when the result is short enough that framing costs more than it saves', () => {
    const prev = lines(DIFF_MIN_LINES - 1)
    const next = [...prev]
    next[2] = 'changed'
    expect(diff(prev, next)).toBeNull()
  })

  it('declines for identical content — that is the exact-duplicate stub path, not this one', () => {
    const same = lines(60)
    expect(diff(same, [...same])).toBeNull()
  })

  it('declines when nothing at all is shared — a "patch" would be the whole result with + prefixes', () => {
    expect(diff(lines(60, 'alpha'), lines(60, 'beta'))).toBeNull()
  })

  it('declines when the changed region is most of the content anyway', () => {
    const prev = lines(60)
    const next = [...prev]
    for (let i = 5; i < 55; i++) next[i] = `line ${i} totally rewritten content here for bulk`
    const p = diff(prev, next)
    expect(p).toBeNull() // patch would be ~2x the original — never emit something bigger
  })

  it('NEVER returns a patch that is not a clear win over the original', () => {
    // Property check across a spread of edit sizes: whatever comes back must clear the ratio gate.
    for (let edits = 1; edits <= 40; edits++) {
      const prev = lines(60)
      const next = [...prev]
      for (let i = 0; i < edits; i++) next[10 + i] = `line ${10 + i} EDITED ${i}`
      const len = join(next).length
      const p = diffAgainst(prev, next, len, TOKEN)
      if (p) expect(p.text.length).toBeLessThan(len * DIFF_MAX_RATIO)
    }
  })

  it('is DETERMINISTIC — identical inputs produce byte-identical output (prompt-cache safety)', () => {
    const prev = lines(60)
    const next = [...prev]
    next[7] = 'line 7 EDITED'
    expect(diff(prev, next)!.text).toBe(diff(prev, next)!.text)
  })
})

describe('bestDiff — choosing a base among earlier blocks', () => {
  it('picks the smallest patch, not merely the first candidate that works', () => {
    const base = lines(60)
    const far = [...base]; for (let i = 0; i < 20; i++) far[20 + i] = `line ${20 + i} FAR EDIT ${i}`
    const near = [...base]; near[30] = 'line 30 NEAR EDIT'
    const next = [...near]; next[31] = 'line 31 ONE MORE'
    const cands = [makeCandidate(join(far)), makeCandidate(join(near))]
    const p = bestDiff(cands, next, join(next).length, TOKEN)
    expect(p).not.toBeNull()
    expect(p!.changedLines).toBe(2) // matched `near` (1 line apart), not `far`
  })

  it('skips candidates outside a 2x length band without pretending to have matched them', () => {
    const tiny = makeCandidate(join(lines(13, 'tiny')))
    const next = lines(400)
    expect(bestDiff([tiny], next, join(next).length, TOKEN)).toBeNull()
  })

  it('scans newest-first and stops at the candidate cap', () => {
    // DIFF_MAX_CANDIDATES + 10 near-misses newest-first, then the perfect base buried at index 0.
    // The cap must bite: the buried base is never reached, so no patch comes back.
    const base = lines(60)
    const next = [...base]; next[30] = 'line 30 EDITED'
    const decoys = Array.from({ length: DIFF_MAX_CANDIDATES + 10 }, (_, i) =>
      makeCandidate(join(lines(60, `decoy${i}`))))
    expect(bestDiff([makeCandidate(join(base)), ...decoys], next, join(next).length, TOKEN)).toBeNull()
    // With the same base within reach, it is found.
    expect(bestDiff([...decoys.slice(0, 3), makeCandidate(join(base))], next, join(next).length, TOKEN)).not.toBeNull()
  })

  it('returns null for an empty candidate list', () => {
    const next = lines(60)
    expect(bestDiff([], next, join(next).length, TOKEN)).toBeNull()
  })
})
