import { describe, it, expect } from 'vitest'
import { SAFETY_WORDS } from '../../src/main/remoteBridge/wordlist'

describe('safety wordlist', () => {
  // 256 is not a round number picked for looks. One digest byte indexes the list
  // with no modulo, so every word carries exactly 8 bits and the derivation is
  // unbiased for free. 255 words would silently reintroduce modulo bias; 257
  // would leave a word unreachable.
  it('is exactly 256 words', () => {
    expect(SAFETY_WORDS).toHaveLength(256)
  })

  it('has no duplicates', () => {
    // The failure mode that costs entropy silently: the list still has 256
    // entries, the code still runs, and two byte values collide forever.
    expect(new Set(SAFETY_WORDS).size).toBe(256)
  })

  it('is lowercase ascii, three to eight letters', () => {
    for (const w of SAFETY_WORDS) expect(w).toMatch(/^[a-z]{3,8}$/)
  })

  it('has a unique three-letter prefix per word', () => {
    // Read aloud over a bad phone line, "cactus" and "cactoid" are one word.
    // Unique prefixes are what make a mishearing a mismatch rather than a false
    // confirmation -- which is the only outcome that matters here.
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const w of SAFETY_WORDS) {
      const p = w.slice(0, 3)
      const prev = seen.get(p)
      if (prev) collisions.push(`${prev}/${w}`)
      else seen.set(p, w)
    }
    expect(collisions).toEqual([])
  })

  it('is sorted, so a human can audit it', () => {
    // Order is not load-bearing for the derivation -- index i is index i either
    // way -- but an unsorted list is one a reviewer cannot scan for duplicates.
    expect([...SAFETY_WORDS]).toEqual([...SAFETY_WORDS].sort())
  })
})
