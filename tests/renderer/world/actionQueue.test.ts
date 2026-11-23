import { describe, it, expect, vi } from 'vitest'
import { createActionQueue, ACTION_GAP_MS } from '../../../src/renderer/src/world/engine/actionQueue'
import type { WorldAction } from '../../../src/shared/world/types'

const acts = (...ids: string[]): WorldAction[] => ids.map((id) => ({ type: 'openCard', id }))
const ids = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => (c[0] as { id: string }).id)

/** A clock whose sleeps resolve only when the test says so. */
const fakeClock = () => {
  const waits: { ms: number; done: () => void }[] = []
  return {
    waits,
    sleep: (ms: number) => new Promise<void>((resolve) => { waits.push({ ms, done: resolve }) }),
    release: async () => { waits.shift()!.done(); await flush() },
  }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('createActionQueue', () => {
  it('plays actions in order with a pause between them', async () => {
    const clock = fakeClock()
    const exec = vi.fn(async () => {})
    const q = createActionQueue(exec, clock)
    const p = q.play(acts('a', 'b'))
    await flush()
    expect(q.busy()).toBe(true)
    expect(ids(exec)).toEqual(['a'])
    expect(clock.waits[0].ms).toBe(ACTION_GAP_MS)
    await clock.release()
    await p
    expect(ids(exec)).toEqual(['a', 'b'])
    expect(clock.waits).toHaveLength(0)
    expect(q.busy()).toBe(false)
  })

  it('a second play cancels the first', async () => {
    const clock = fakeClock()
    const exec = vi.fn(async () => {})
    const q = createActionQueue(exec, clock)
    const first = q.play(acts('a1', 'a2', 'a3'))
    await flush()
    const second = q.play(acts('b1'))
    await clock.release() // first's sleep ends: it must stop
    await first
    await second
    expect(ids(exec)).toEqual(['a1', 'b1'])
    expect(q.busy()).toBe(false)
  })

  it('cancel() mid-tour stops it, and cancel during exec stops before the pause', async () => {
    const clock = fakeClock()
    const exec = vi.fn(async () => {})
    const q = createActionQueue(exec, clock)
    const p = q.play(acts('a', 'b'))
    await flush()
    q.cancel()
    expect(q.busy()).toBe(false)
    await clock.release()
    await p
    expect(ids(exec)).toEqual(['a'])

    let finish!: () => void
    const slow = vi.fn((_a: WorldAction, _o: { reducedMotion: boolean }) => new Promise<void>((r) => { finish = r }))
    const q2 = createActionQueue(slow, clock)
    const p2 = q2.play(acts('x', 'y'))
    await flush()
    q2.cancel()
    finish()
    await p2
    expect(slow).toHaveBeenCalledTimes(1)
    expect(clock.waits).toHaveLength(0)
  })

  it('passes reducedMotion to exec and skips the pause', async () => {
    const exec = vi.fn(async (_a: WorldAction, _o: { reducedMotion: boolean }) => {})
    const clock = { sleep: vi.fn(async () => {}) }
    await createActionQueue(exec, clock, { reducedMotion: true }).play(acts('a', 'b'))
    expect(exec.mock.calls.map((c) => c[1])).toEqual([{ reducedMotion: true }, { reducedMotion: true }])
    expect(clock.sleep).not.toHaveBeenCalled()
    const plain = vi.fn(async (_a: WorldAction, _o: { reducedMotion: boolean }) => {})
    await createActionQueue(plain, { sleep: async () => {} }).play(acts('a'))
    expect(plain.mock.calls[0][1]).toEqual({ reducedMotion: false })
  })

  it('reads reducedMotion before each action when given as a function: switched on mid-play, the rest follow at once', async () => {
    let reduced = false
    const exec = vi.fn(async (_a: WorldAction, _o: { reducedMotion: boolean }) => { reduced = true })
    const clock = { sleep: vi.fn(async () => {}) }
    await createActionQueue(exec, clock, { reducedMotion: () => reduced }).play(acts('a', 'b', 'c'))
    expect(exec.mock.calls.map((c) => c[1])).toEqual([{ reducedMotion: false }, { reducedMotion: true }, { reducedMotion: true }])
    expect(clock.sleep).not.toHaveBeenCalled() // read after the first action: already reduced, so no pause
  })

  it('uses real timers by default and survives an empty play', async () => {
    vi.useFakeTimers()
    try {
      const exec = vi.fn(async () => {})
      const q = createActionQueue(exec)
      const p = q.play(acts('a', 'b'))
      await vi.advanceTimersByTimeAsync(ACTION_GAP_MS)
      await p
      expect(ids(exec)).toEqual(['a', 'b'])
      await q.play([])
    } finally { vi.useRealTimers() }
  })

  it('a failing exec rejects the play and clears busy', async () => {
    const q = createActionQueue(async () => { throw new Error('boom') }, { sleep: async () => {} })
    await expect(q.play(acts('a'))).rejects.toThrow('boom')
    expect(q.busy()).toBe(false)
  })
})
