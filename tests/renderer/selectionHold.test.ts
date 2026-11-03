import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { holdOutput, holdOutputLegacy, HOLD_CAP_CHARS, HOLD_CAP_LEGACY_CHARS } from '../../src/renderer/src/lib/selectionHold'
import { createChunkQueue } from '../../src/renderer/src/lib/chunkQueue'
import { createOutputThrottle } from '../../src/renderer/src/lib/outputThrottle'

// The selection hold (1.54.5, plan package P2). While the user has text selected, output is held back
// so it cannot scroll the selection away. The hold used to be one string capped at 1,000,000 chars;
// the first key typed after the selection ended released ALL of it in front of that key's echo: 16
// throttle ticks of 64 KB, 0.3 to 1.6 s plus the parse. It is now a chunk list capped at 256 KB, which
// the throttle drains in four ticks. The price (a decision for David): a very heavy burst lets go of
// the selection sooner.

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('the caps', () => {
  it('256 KB is exactly four 64 KB throttle ticks; the old cap was sixteen', () => {
    expect(HOLD_CAP_CHARS).toBe(4 * 65_536)
    expect(HOLD_CAP_LEGACY_CHARS).toBe(1_000_000)
  })
})

describe('holdOutput', () => {
  it('holds output that fits under the cap and says nothing needs writing now', () => {
    const hold = createChunkQueue()
    expect(holdOutput(hold, 'abc', 100)).toBe('')
    expect(holdOutput(hold, 'def', 100)).toBe('')
    expect(hold.length).toBe(6)
    expect(hold.takeAll()).toBe('abcdef')
  })

  it('holds up to exactly the cap', () => {
    const hold = createChunkQueue()
    expect(holdOutput(hold, 'x'.repeat(60), 100)).toBe('')
    expect(holdOutput(hold, 'y'.repeat(40), 100)).toBe('')
    expect(hold.length).toBe(100)
  })

  it('past the cap it lets go of what it held, in order, and keeps the new chunk', () => {
    const hold = createChunkQueue()
    holdOutput(hold, 'x'.repeat(60), 100)
    const through = holdOutput(hold, 'y'.repeat(60), 100)
    expect(through).toBe('x'.repeat(60))
    expect(hold.length).toBe(60) // the hold never holds more than its cap
    expect(hold.takeAll()).toBe('y'.repeat(60))
  })

  it('a single chunk bigger than the cap is not held at all: it goes out behind what was held', () => {
    const hold = createChunkQueue()
    holdOutput(hold, 'a'.repeat(30), 100)
    const through = holdOutput(hold, 'B'.repeat(500), 100)
    expect(through).toBe('a'.repeat(30) + 'B'.repeat(500))
    expect(hold.length).toBe(0)
  })

  it('a huge chunk into an empty hold passes straight through', () => {
    const hold = createChunkQueue()
    const big = 'z'.repeat(HOLD_CAP_CHARS + 1)
    expect(holdOutput(hold, big, HOLD_CAP_CHARS)).toBe(big)
    expect(hold.length).toBe(0)
  })

  for (const seed of [1, 4, 9, 16, 25, 36, 49, 64, 81, 100]) {
    it(`seed ${seed}: nothing is lost, repeated or reordered, and the hold never exceeds the cap`, () => {
      const rand = prng(seed)
      const hold = createChunkQueue()
      const sent: string[] = []
      const written: string[] = []
      let worst = 0
      for (let i = 0; i < 400; i++) {
        const data = `<${i}>` + 'x'.repeat(Math.floor(rand() * rand() * 150_000))
        sent.push(data)
        const through = holdOutput(hold, data, HOLD_CAP_CHARS)
        if (through) written.push(through)
        worst = Math.max(worst, hold.length)
        if (rand() < 0.03) written.push(hold.takeAll()) // the selection ended
      }
      written.push(hold.takeAll())
      expect(written.join('')).toBe(sent.join(''))
      expect(worst).toBeLessThanOrEqual(HOLD_CAP_CHARS)
    })
  }
})

describe('releasing the hold in front of a typed key', () => {
  let frames: Array<() => void> = []
  beforeEach(() => {
    frames = []
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  /** Fill a hold with a selection-long burst, release it into a real throttle, count the frames it takes to drain. */
  function ticksToRelease(cap: number, seed: number): { ticks: number; released: number } {
    const rand = prng(seed)
    const hold = createChunkQueue()
    const throttle = createOutputThrottle(() => undefined)
    for (let i = 0; i < 200; i++) {
      // Output the hold lets go of early (past its cap) is not what this measures: only what is still held when the selection ends.
      holdOutput(hold, 'x'.repeat(2000 + Math.floor(rand() * 40_000)), cap)
    }
    // The selection ends; the first key typed is about to be echoed. Everything held goes in front of it.
    const released = hold.takeAll()
    throttle(released)
    let ticks = 0
    while (throttle.pending() > 0) {
      const cb = frames.shift()
      if (!cb) vi.advanceTimersByTime(100)
      else { cb(); ticks++ }
    }
    return { ticks, released: released.length }
  }

  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    it(`seed ${seed}: the held output drains in at most four throttle ticks`, () => {
      const { ticks, released } = ticksToRelease(HOLD_CAP_CHARS, seed)
      expect(released).toBeGreaterThan(0)
      expect(ticks).toBeLessThanOrEqual(4)
    })
  }

  it('NEGATIVE CONTROL: with the 1.54.4 cap of 1,000,000 chars the same burst takes more than four ticks (up to sixteen)', () => {
    const worst = Math.max(...[1, 2, 3, 5, 8, 13, 21, 34].map((seed) => ticksToRelease(HOLD_CAP_LEGACY_CHARS, seed).ticks))
    expect(worst).toBeGreaterThan(4)
    expect(worst).toBeLessThanOrEqual(16)
  })
})

describe('holdOutputLegacy (the 1.54.4 rule, behind the kill switch)', () => {
  it('holds everything up to the cap', () => {
    const hold = createChunkQueue()
    expect(holdOutputLegacy(hold, 'x'.repeat(60), 100)).toBe('')
    expect(holdOutputLegacy(hold, 'y'.repeat(40), 100)).toBe('')
    expect(hold.length).toBe(100)
  })

  it('past the cap it writes everything it holds AND the chunk that took it past, and keeps nothing', () => {
    const hold = createChunkQueue()
    holdOutputLegacy(hold, 'x'.repeat(60), 100)
    const through = holdOutputLegacy(hold, 'y'.repeat(60), 100)
    expect(through).toBe('x'.repeat(60) + 'y'.repeat(60))
    expect(hold.length).toBe(0)
  })

  it('a single chunk bigger than the cap passes straight through', () => {
    const hold = createChunkQueue()
    expect(holdOutputLegacy(hold, 'z'.repeat(500), 100)).toBe('z'.repeat(500))
    expect(hold.length).toBe(0)
  })

  it('NEGATIVE CONTROL: the 256 KB rule keeps the chunk that took it past the cap, the 1.54.4 rule does not', () => {
    const modern = createChunkQueue()
    const legacy = createChunkQueue()
    for (const hold of [modern, legacy]) hold.push('x'.repeat(60))
    expect(holdOutput(modern, 'y'.repeat(60), 100)).toBe('x'.repeat(60))
    expect(modern.length).toBe(60)
    expect(holdOutputLegacy(legacy, 'y'.repeat(60), 100)).toBe('x'.repeat(60) + 'y'.repeat(60))
    expect(legacy.length).toBe(0)
  })

  for (const seed of [2, 6, 10, 14, 18]) {
    it(`seed ${seed}: the same text comes out, in the same order, as the 1.54.4 string rule`, () => {
      const rand = prng(seed)
      const hold = createChunkQueue()
      let oracleHold = ''
      const written: string[] = []
      const oracleWritten: string[] = []
      for (let i = 0; i < 150; i++) {
        const data = `<${i}>` + 'x'.repeat(Math.floor(rand() * rand() * 300_000))
        const through = holdOutputLegacy(hold, data, HOLD_CAP_LEGACY_CHARS)
        if (through) written.push(through)
        // the 1.54.4 code, verbatim
        oracleHold += data
        if (oracleHold.length > HOLD_CAP_LEGACY_CHARS) {
          oracleWritten.push(oracleHold)
          oracleHold = ''
        }
      }
      expect(written).toEqual(oracleWritten)
      expect(hold.length).toBe(oracleHold.length)
    })
  }
})
