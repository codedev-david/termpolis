// WPA item 1: the memory host's interactive fast lane, and the host's own priority while it is in use.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createHostLane, abortError, LANE_LINGER_MS, BACKGROUND_MAX_WAIT_MS, memoryTimeoutError, isMemoryTimeout, MEMORY_TIMEOUT_CODE,
} from '../../src/main/hostLane'
import { setLanePriority } from '../../src/main/hostPriority'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('createHostLane', () => {
  it('an interactive call starts at once; background calls wait until the lane is empty, then go in arrival order', async () => {
    const lane = createHostLane()
    const order: string[] = []
    const out = await lane.enter('interactive')
    const b1 = lane.enter('background').then((r) => { order.push('b1'); return r })
    const b2 = lane.enter('background').then((r) => { order.push('b2'); return r })
    await tick()
    expect(order).toEqual([])
    expect(lane.waiting()).toBe(2)
    const i2 = await lane.enter('interactive') // a second interactive call goes ahead of the waiting background ones
    order.push('i2')
    out()
    await tick()
    expect(order).toEqual(['i2']) // still one interactive call in the lane
    i2()
    i2() // a release is idempotent
    await Promise.all([b1, b2])
    expect(order).toEqual(['i2', 'b1', 'b2'])
    expect(lane.interactive()).toBe(0)
  })

  it('a background call with no interactive call in the lane starts at once', async () => {
    const lane = createHostLane()
    const r = await lane.enter('background')
    r()
    expect(lane.waiting()).toBe(0)
  })

  it('raises on the first interactive call and lowers when the last one leaves, once each', async () => {
    const seen: boolean[] = []
    const lane = createHostLane((on) => seen.push(on))
    const a = await lane.enter('interactive')
    const b = await lane.enter('interactive')
    expect(seen).toEqual([true])
    a()
    expect(seen).toEqual([true])
    b()
    expect(seen).toEqual([true, false])
    const c = await lane.enter('interactive')
    c()
    expect(seen).toEqual([true, false, true, false])
    const bg = await lane.enter('background')
    bg()
    expect(seen).toHaveLength(4) // background never touches the priority
  })

  describe('with a linger (the memory host)', () => {
    afterEach(() => { vi.useRealTimers() })

    it('stays raised for the linger after the last call leaves, so the next call of the same primer is not starved', async () => {
      vi.useFakeTimers()
      const seen: boolean[] = []
      const lane = createHostLane((on) => seen.push(on), { lingerMs: LANE_LINGER_MS })
      const search = await lane.enter('interactive')
      search()
      expect(seen).toEqual([true]) // not lowered yet
      vi.advanceTimersByTime(LANE_LINGER_MS - 1)
      const recent = await lane.enter('interactive') // the primer's second read, inside the linger: no flap
      recent()
      expect(seen).toEqual([true])
      vi.advanceTimersByTime(LANE_LINGER_MS - 1)
      expect(seen).toEqual([true])
      vi.advanceTimersByTime(1)
      expect(seen).toEqual([true, false]) // lowered once the lane has been empty for the whole linger
      vi.advanceTimersByTime(LANE_LINGER_MS * 2)
      expect(seen).toEqual([true, false])
    })

    it('background calls waiting on the lane still start as soon as it empties, not after the linger', async () => {
      vi.useFakeTimers()
      const lane = createHostLane(() => {}, { lingerMs: LANE_LINGER_MS })
      const i = await lane.enter('interactive')
      let started = false
      const bg = lane.enter('background').then((r) => { started = true; return r })
      i()
      ;(await bg)()
      expect(started).toBe(true)
      expect(lane.interactive()).toBe(0)
    })

    it('a linger timer does not keep the process alive', async () => {
      vi.useFakeTimers()
      const unref = vi.fn()
      const real = globalThis.setTimeout
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const t = real(fn, ms) as unknown as { unref?: () => void }
        t.unref = unref
        return t
      }) as never)
      const lane = createHostLane(() => {}, { lingerMs: 50 })
      ;(await lane.enter('interactive'))()
      expect(unref).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('a timer handle without unref (a plain number) is fine', async () => {
      const handles: Array<() => void> = []
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { handles.push(fn); return 7 }) as never)
      const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((() => {}) as never)
      const seen: boolean[] = []
      const lane = createHostLane((on) => seen.push(on), { lingerMs: 50 })
      ;(await lane.enter('interactive'))()
      ;(await lane.enter('interactive'))() // inside the linger: the pending lower is cleared, no second raise
      expect(clear).toHaveBeenCalledWith(7)
      handles[handles.length - 1]()
      expect(seen).toEqual([true, false])
      spy.mockRestore()
      clear.mockRestore()
    })

    it("the linger is a couple of seconds: longer than the gap between a primer's reads, short enough to give background work its priority back", () => {
      expect(LANE_LINGER_MS).toBeGreaterThanOrEqual(1_000)
      expect(LANE_LINGER_MS).toBeLessThanOrEqual(5_000)
    })
  })

  it('a waiting background call is dropped when its caller cancels, and never starts', async () => {
    const lane = createHostLane()
    const i = await lane.enter('interactive')
    const ctl = new AbortController()
    let started = false
    const w = lane.enter('background', ctl.signal).then(() => { started = true })
    await tick()
    ctl.abort()
    await expect(w).rejects.toMatchObject({ name: 'AbortError' })
    expect(lane.waiting()).toBe(0)
    i()
    await tick()
    expect(started).toBe(false)
  })

  it('a background call cancelled before it asks is refused at once', async () => {
    const lane = createHostLane()
    const ctl = new AbortController()
    ctl.abort()
    await expect(lane.enter('background', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a background call whose signal never fires starts normally after the lane empties', async () => {
    const lane = createHostLane()
    const i = await lane.enter('interactive')
    const ctl = new AbortController()
    const w = lane.enter('background', ctl.signal)
    i()
    await expect(w).resolves.toBeTypeOf('function')
    ctl.abort() // too late to matter
  })

  it('idle() resolves at once with an empty lane, and when the lane empties otherwise', async () => {
    const lane = createHostLane()
    await lane.idle()
    const i = await lane.enter('interactive')
    let free = false
    const p = lane.idle().then(() => { free = true })
    await tick()
    expect(free).toBe(false)
    i()
    await p
    expect(free).toBe(true)
  })

  describe('no starvation (WPA fix I4)', () => {
    afterEach(() => { vi.useRealTimers() })

    it('a background call under an endless stream of interactive calls starts after the max wait, not never', async () => {
      vi.useFakeTimers()
      const lane = createHostLane()
      let started = false
      // Each interactive call enters before the one before it leaves: the lane is never empty.
      let cur = await lane.enter('interactive')
      const bg = lane.enter('background').then((r) => { started = true; return r })
      for (let t = 0; t < BACKGROUND_MAX_WAIT_MS - 100; t += 100) {
        const next = await lane.enter('interactive')
        cur()
        cur = next
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(started).toBe(false)
      expect(lane.interactive()).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(started).toBe(true)
      expect(lane.waiting()).toBe(0) // its timer took it off the waiters
      ;(await bg)()
      cur()
    })

    it('idle() under an endless stream resolves after the max wait too (a Weave batch keeps going)', async () => {
      vi.useFakeTimers()
      const lane = createHostLane(() => {}, { maxWaitMs: 300 })
      const i = await lane.enter('interactive')
      let free = false
      const p = lane.idle().then(() => { free = true })
      await vi.advanceTimersByTimeAsync(299)
      expect(free).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(free).toBe(true)
      expect(lane.waiting()).toBe(0)
      i()
    })

    it('a call that waited its max and went is not run again when the lane later empties', async () => {
      vi.useFakeTimers()
      const lane = createHostLane(() => {}, { maxWaitMs: 50 })
      const i = await lane.enter('interactive')
      let runs = 0
      const bg = lane.enter('background').then(() => { runs++ })
      await vi.advanceTimersByTimeAsync(50)
      await bg
      i()
      await vi.advanceTimersByTimeAsync(100)
      expect(runs).toBe(1)
    })

    it('a cancel while waiting clears the max-wait timer: nothing fires later', async () => {
      vi.useFakeTimers()
      const lane = createHostLane(() => {}, { maxWaitMs: 50 })
      const i = await lane.enter('interactive')
      const ctl = new AbortController()
      const bg = lane.enter('background', ctl.signal)
      ctl.abort()
      await expect(bg).rejects.toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
      i()
    })

    it('the max wait is short: about a second', () => {
      expect(BACKGROUND_MAX_WAIT_MS).toBeGreaterThanOrEqual(250)
      expect(BACKGROUND_MAX_WAIT_MS).toBeLessThanOrEqual(2_000)
    })
  })

  it('memoryTimeoutError keeps the message it always had and carries a code isMemoryTimeout knows', () => {
    const e = memoryTimeoutError('memorySearch', 60_000)
    expect(e.message).toBe('memory host timed out after 60000ms (fn "memorySearch")')
    expect(e.code).toBe(MEMORY_TIMEOUT_CODE)
    expect(isMemoryTimeout(e)).toBe(true)
    expect(isMemoryTimeout(new Error('memory host timed out after 5ms'))).toBe(false)
    expect(isMemoryTimeout(null)).toBe(false)
    expect(isMemoryTimeout('MEMORY_TIMEOUT')).toBe(false)
  })

  it('abortError is an AbortError', () => {
    expect(abortError()).toMatchObject({ name: 'AbortError', message: 'memory call cancelled' })
  })
})

describe('setLanePriority (this process only)', () => {
  const fake = () => {
    const calls: Array<[number, number]> = []
    return { calls, os: { setPriority: (pid: number, p: number) => { calls.push([pid, p]) }, constants: { priority: { PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0 } } } }
  }
  it('normal while interactive, below normal after, always pid 0', () => {
    const { os, calls } = fake()
    expect(setLanePriority(true, { os, env: {}, host: 'memory' })).toBe('set')
    expect(setLanePriority(false, { os, env: {}, host: 'memory' })).toBe('set')
    expect(calls).toEqual([[0, 0], [0, 10]])
  })
  it('the kill switch leaves it alone; a refusal is swallowed', () => {
    const { os, calls } = fake()
    expect(setLanePriority(true, { os, env: { TERMPOLIS_NO_HOST_PRIORITY: 'memory' }, host: 'memory' })).toBe('disabled')
    expect(calls).toEqual([])
    const refusing = { setPriority: () => { throw new Error('EACCES') }, constants: { priority: { PRIORITY_NORMAL: 0 } } }
    expect(setLanePriority(true, { os: refusing, env: {} })).toBe('failed')
  })
})
