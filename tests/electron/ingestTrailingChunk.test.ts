// F16 — the 90s active-session re-ingest deposited a new overlapping superset chunk on
// every turn, because chunkTurns flushed a not-yet-full trailing buffer that grows each
// pass. `sealedOnly` omits that unstable tail on the incremental pass.
import { describe, it, expect } from 'vitest'
import { chunkTurns, type IngestTurn } from '../../src/main/conversationIngest'

const mk = (n: number, textLen = 20): IngestTurn[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `turn ${i} `.padEnd(textLen, 'x'),
    source: 'claude' as const,
    sessionId: 's',
  }))

describe('F16: sealedOnly drops the unstable trailing partial', () => {
  it('a growing session deposits NO partial chunks across passes when sealedOnly', () => {
    // Small turns that never fill a 2000-char chunk → the only output would be the trailing partial.
    const pass1 = chunkTurns(mk(3), { maxChars: 2000, sealedOnly: true })
    const pass2 = chunkTurns(mk(4), { maxChars: 2000, sealedOnly: true }) // one more turn later
    expect(pass1).toHaveLength(0) // nothing sealed yet → nothing persisted
    expect(pass2).toHaveLength(0) // still nothing sealed → no growing superset duplicate
  })

  it('without sealedOnly the same growing session DOES deposit distinct (superset) partials', () => {
    const pass1 = chunkTurns(mk(3), { maxChars: 2000 })
    const pass2 = chunkTurns(mk(4), { maxChars: 2000 })
    expect(pass1).toHaveLength(1)
    expect(pass2).toHaveLength(1)
    expect(pass1[0].hash).not.toBe(pass2[0].hash) // the trailing chunk grew → a new hash → a duplicate
  })

  it('sealedOnly still emits FULL sealed chunks, only omitting the trailing tail', () => {
    const big = 'x'.repeat(1500)
    const turns: IngestTurn[] = [
      { role: 'user', text: big, source: 'claude', sessionId: 's' },
      { role: 'assistant', text: big, source: 'claude', sessionId: 's' }, // pushes the first over 2000 → seals it
      { role: 'user', text: 'a short trailing tail', source: 'claude', sessionId: 's' },
    ]
    const sealed = chunkTurns(turns, { maxChars: 2000, sealedOnly: true })
    const full = chunkTurns(turns, { maxChars: 2000 })
    expect(sealed.length).toBeGreaterThanOrEqual(1) // the sealed chunk survives
    expect(sealed.length).toBe(full.length - 1)     // exactly the trailing partial is omitted
  })
})
