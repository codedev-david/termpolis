// singleFlight.ts: one run per key at a time, and for a short time after. Counters only: how many times the expensive
// call ran, never how long anything took.
import { describe, it, expect, vi } from 'vitest'
import { createSingleFlight } from '../../src/main/singleFlight'

function clock() {
  let t = 1000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('singleFlight', () => {
  it('shares one run between callers that ask while it is running', async () => {
    const sf = createSingleFlight(clock().now)
    let release: (v: number) => void = () => {}
    const fn = vi.fn(() => new Promise<number>((r) => { release = r }))
    const a = sf.run('k', 1500, fn)
    const b = sf.run('k', 1500, fn)
    const c = sf.run('k', 1500, fn)
    expect(fn).toHaveBeenCalledTimes(1)
    release(7)
    expect(await Promise.all([a, b, c])).toEqual([7, 7, 7])
  })

  it('keeps an answer for the TTL, and runs again after it', async () => {
    const c = clock()
    const sf = createSingleFlight(c.now)
    const fn = vi.fn(async () => 'answer')
    await sf.run('k', 1500, fn)
    c.advance(1499)
    await sf.run('k', 1500, fn)
    expect(fn).toHaveBeenCalledTimes(1)
    c.advance(1)
    await sf.run('k', 1500, fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('keys are separate', async () => {
    const sf = createSingleFlight(clock().now)
    const fn = vi.fn(async () => 1)
    await Promise.all([sf.run('a', 1500, fn), sf.run('b', 1500, fn)])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not keep an answer that keep() refuses (a failure is never replayed)', async () => {
    const sf = createSingleFlight(clock().now)
    const fn = vi.fn(async () => null as number | null)
    await sf.run('k', 1500, fn, (v) => v !== null)
    await sf.run('k', 1500, fn, (v) => v !== null)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sf.size()).toBe(0)
  })

  it('does not keep a rejection, and passes it on to everyone who shared the run', async () => {
    const sf = createSingleFlight(clock().now)
    const fn = vi.fn(async () => { throw new Error('boom') })
    const results = await Promise.allSettled([sf.run('k', 1500, fn), sf.run('k', 1500, fn)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sf.size()).toBe(0)
    await expect(sf.run('k', 1500, async () => 'ok')).resolves.toBe('ok')
  })

  it('with a TTL of 0 only shares what is running', async () => {
    const sf = createSingleFlight(clock().now)
    const fn = vi.fn(async () => 1)
    await sf.run('k', 0, fn)
    await sf.run('k', 0, fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(sf.size()).toBe(0)
  })

  it('forgets expired entries as it goes: the table is bounded by the keys in use', async () => {
    const c = clock()
    const sf = createSingleFlight(c.now)
    for (let i = 0; i < 500; i++) {
      await sf.run(`pid:${i}`, 1500, async () => i)
      c.advance(1500) // each is expired by the time the next is asked
    }
    expect(sf.size()).toBeLessThanOrEqual(1)
  })
})
