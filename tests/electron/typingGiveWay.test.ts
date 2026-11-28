// TYPEFLAKE: while someone types, the world host's reads go in short slices with rests between, so a compile on a
// busy machine leaves the keyboard's processes the CPU; nobody typing costs nothing (no timer, no wait).

import { describe, it, expect } from 'vitest'
import { createGiveWay, GIVE_WAY_QUIET_MS, GIVE_WAY_REST_MS, GIVE_WAY_SLICE_MS } from '../../src/main/world/typingGiveWay'

/** A clock moved by hand, and a sleep that waits until the test lets it go. */
function clock(start = 1_000_000) {
  const k = {
    t: start,
    sleeps: [] as number[],
    wake: [] as (() => void)[],
    now: () => k.t,
    sleep: (ms: number) => new Promise<void>((resolve) => { k.sleeps.push(ms); k.wake.push(resolve) }),
  }
  return k
}

/** True once the turn is free: null (go now) at once, a rest once it has ended. */
const settled = async (p: Promise<unknown> | null): Promise<boolean> => {
  if (p === null) return true
  let done = false
  void p.then(() => (done = true))
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return done
}

describe('createGiveWay', () => {
  it("shares typingQuiet's quiet period; a slice is a quarter of a slice and its rest", () => {
    expect(GIVE_WAY_QUIET_MS).toBe(500)
    expect(GIVE_WAY_SLICE_MS).toBe(10)
    expect(GIVE_WAY_REST_MS).toBe(30)
  })

  it('nobody has typed: every turn is now (null), with no sleep', async () => {
    const k = clock()
    const g = createGiveWay({ now: k.now, sleep: k.sleep })
    for (let i = 0; i < 50; i++) {
      k.t += 5
      expect(g.turn()).toBeNull()
    }
    expect(k.sleeps).toEqual([])
  })

  it('while someone types, work runs for a slice, then every waiter rests together, then a new slice starts', async () => {
    const k = clock()
    const g = createGiveWay({ now: k.now, sleep: k.sleep })
    g.typed()
    // The slice starts at the first wait and lasts GIVE_WAY_SLICE_MS.
    expect(await settled(g.turn())).toBe(true)
    k.t += GIVE_WAY_SLICE_MS - 1
    expect(await settled(g.turn())).toBe(true)
    k.t += 1
    // Used up: this wait and any that come while it rests share one rest.
    const a = g.turn()
    const b = g.turn()
    expect(k.sleeps).toEqual([GIVE_WAY_REST_MS])
    expect(await settled(a)).toBe(false)
    expect(await settled(b)).toBe(false)
    k.t += GIVE_WAY_REST_MS
    k.wake[0]()
    expect(await settled(a)).toBe(true)
    expect(await settled(b)).toBe(true)
    // After the rest a new slice starts from the next wait.
    expect(await settled(g.turn())).toBe(true)
    k.t += GIVE_WAY_SLICE_MS
    void g.turn()
    expect(k.sleeps).toEqual([GIVE_WAY_REST_MS, GIVE_WAY_REST_MS])
  })

  it('once nobody has typed for the quiet period, waits go at once again and the next typing starts a fresh slice', async () => {
    const k = clock()
    const g = createGiveWay({ now: k.now, sleep: k.sleep })
    g.typed()
    expect(await settled(g.turn())).toBe(true)
    k.t += GIVE_WAY_QUIET_MS
    for (let i = 0; i < 5; i++) {
      k.t += GIVE_WAY_SLICE_MS
      expect(await settled(g.turn())).toBe(true)
    }
    expect(k.sleeps).toEqual([])
    // Typing again: the slice is timed from now, not from the slice before the quiet.
    g.typed()
    expect(await settled(g.turn())).toBe(true)
    k.t += GIVE_WAY_SLICE_MS - 1
    expect(await settled(g.turn())).toBe(true)
    expect(k.sleeps).toEqual([])
  })

  it('fails open: a clock or sleep that throws lets the work go ahead', async () => {
    const g = createGiveWay({ now: () => { throw new Error('no clock') } })
    g.typed()
    expect(await settled(g.turn())).toBe(true)
    let t = 0
    const s = createGiveWay({ now: () => t, sleep: () => { throw new Error('no timer') } })
    s.typed()
    await s.turn()
    t += GIVE_WAY_SLICE_MS
    expect(await settled(s.turn())).toBe(true)
    // A rejected sleep is no rest either, and the next slice still starts.
    const r = createGiveWay({ now: () => t, sleep: async () => { throw new Error('gone') } })
    r.typed()
    await r.turn()
    t += GIVE_WAY_SLICE_MS
    await r.turn()
    expect(await settled(r.turn())).toBe(true)
  })

  it('with the real clock, a wait just after a keystroke starts a slice and goes at once', async () => {
    const g = createGiveWay()
    g.typed()
    expect(await settled(g.turn())).toBe(true)
  })

  it('the real sleep rests for the rest period', async () => {
    let t = 0
    const g = createGiveWay({ now: () => t })
    g.typed()
    await g.turn()
    t += GIVE_WAY_SLICE_MS
    const start = Date.now()
    await g.turn()
    expect(Date.now() - start).toBeGreaterThanOrEqual(GIVE_WAY_REST_MS - 5)
  })
})
