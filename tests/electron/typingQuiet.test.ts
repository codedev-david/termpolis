// "Nothing starts within 500 ms of a keystroke." noteTyping() is the only thing on the typing path (one
// store of a number); the waiting is done by background work, under a cap so a busy line never starves it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QUIET_MAX_WAIT_MS, QUIET_MS, msSinceTyping, noteTyping, resetTypingQuiet, typingGateStats, whenTypingQuiet } from '../../src/main/typingQuiet'

beforeEach(() => { resetTypingQuiet() })

/** A virtual clock whose sleep advances it, so a wait costs no real time. */
function clock(start = 1_000_000) {
  const k = {
    t: start,
    sleeps: [] as number[],
    now: () => k.t,
    sleep: async (ms: number) => { k.sleeps.push(ms); k.t += ms },
  }
  return k
}

describe('noteTyping', () => {
  it('is one number stored: no timer, no promise, no allocation worth the name', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 10_000; i++) noteTyping(i)
      expect(vi.getTimerCount()).toBe(0)
      expect(msSinceTyping(10_100)).toBe(10_100 - 9_999)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says "never typed" before the first key', () => {
    expect(msSinceTyping(5)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('whenTypingQuiet', () => {
  it('returns at once, without a timer, when nobody has typed for the quiet period', async () => {
    const k = clock()
    expect(await whenTypingQuiet({ now: k.now, sleep: k.sleep })).toEqual({ waitedMs: 0, capped: false })
    noteTyping(k.t - QUIET_MS - 1)
    expect(await whenTypingQuiet({ now: k.now, sleep: k.sleep })).toEqual({ waitedMs: 0, capped: false })
    expect(k.sleeps).toEqual([])
  })

  it('waits exactly until 500 ms after the last key', async () => {
    const k = clock()
    noteTyping(k.t - 100)
    const r = await whenTypingQuiet({ now: k.now, sleep: k.sleep })
    expect(k.sleeps).toEqual([QUIET_MS - 100])
    expect(r).toEqual({ waitedMs: QUIET_MS - 100, capped: false })
  })

  it('a key typed while it waits starts the quiet period again', async () => {
    const k = clock()
    noteTyping(k.t)
    let typed = 0
    const sleep = async (ms: number): Promise<void> => {
      await k.sleep(ms)
      if (typed++ < 2) noteTyping(k.t - 10) // someone is still typing
    }
    const r = await whenTypingQuiet({ now: k.now, sleep })
    expect(k.sleeps.length).toBe(3)
    expect(r.capped).toBe(false)
    expect(msSinceTyping(k.t)).toBeGreaterThanOrEqual(QUIET_MS)
  })

  it('gives up waiting after the cap (default 2 s) and says so: a line that never goes quiet must not starve the work', async () => {
    const k = clock()
    noteTyping(k.t)
    const sleep = async (ms: number): Promise<void> => { await k.sleep(ms); noteTyping(k.t) } // a key after every sleep
    const r = await whenTypingQuiet({ now: k.now, sleep })
    expect(r.capped).toBe(true)
    expect(r.waitedMs).toBeGreaterThanOrEqual(QUIET_MAX_WAIT_MS)
    expect(r.waitedMs).toBeLessThan(QUIET_MAX_WAIT_MS + QUIET_MS + 1)
  })

  // NEGATIVE CONTROL: with a larger cap the same endless typing is waited out longer; the cap is what stops it.
  it('control: the cap is a parameter, not a coincidence', async () => {
    const k = clock()
    noteTyping(k.t)
    const sleep = async (ms: number): Promise<void> => { await k.sleep(ms); noteTyping(k.t) }
    const r = await whenTypingQuiet({ now: k.now, sleep, maxWaitMs: 5_000 })
    expect(r.waitedMs).toBeGreaterThanOrEqual(5_000)
  })

  it('counts how often it waited, for how long, and how often it gave up', async () => {
    const k = clock()
    noteTyping(k.t - 200)
    await whenTypingQuiet({ now: k.now, sleep: k.sleep })
    await whenTypingQuiet({ now: k.now, sleep: k.sleep }) // quiet now: not a wait
    noteTyping(k.t)
    await whenTypingQuiet({ now: k.now, sleep: async (ms) => { await k.sleep(ms); noteTyping(k.t) }, maxWaitMs: 600 })
    expect(typingGateStats()).toEqual({ waits: 2, waitedMs: expect.any(Number), capped: 1 })
    expect(typingGateStats().waitedMs).toBeGreaterThanOrEqual(300 + 600)
  })

  it('the real clock and real timers work too (a short quiet period)', async () => {
    noteTyping(Date.now())
    const t0 = Date.now()
    const r = await whenTypingQuiet({ quietMs: 40, maxWaitMs: 1_000 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30)
    expect(r.capped).toBe(false)
  })

  it('a clock that jumps backwards does not make it wait forever', async () => {
    const k = clock()
    noteTyping(k.t + 10_000_000) // a key "from the future"
    const r = await whenTypingQuiet({ now: k.now, sleep: k.sleep })
    expect(r.capped).toBe(true)
    expect(r.waitedMs).toBeLessThan(QUIET_MAX_WAIT_MS + QUIET_MS + 1)
  })
})
