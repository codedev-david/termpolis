import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROGRESS_PACE_MS, paceProgress } from '../../src/main/world/progressPace'
import type { WorldProgressEvent } from '../../src/shared/world/types'

const ev = (pct: number, stage = 'structure', projectKey = 'k'): WorldProgressEvent => ({ root: 'C:/repo', projectKey, stage, pct })

// TYPEFLAKE: a compile's reads post progress in twentieths of a point, up to 700 a pass, and the load project's pass
// takes about half a second: some 1,400 events a second, each one an IPC to the page and a render of the whole world
// pane, while the person types on a machine with nothing to spare. The page shows one bar; ten moves a second is all
// it can use.
describe('paceProgress', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends a project\'s first event at once', () => {
    const send = vi.fn()
    paceProgress(send).push(ev(5))
    expect(send.mock.calls).toEqual([[ev(5)]])
  })

  it('sends at most one event per pace interval in a stage, and the latest one at its end', () => {
    const send = vi.fn()
    const p = paceProgress(send)
    p.push(ev(5))
    for (let i = 1; i <= 50; i++) p.push(ev(5 + i / 20))
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PROGRESS_PACE_MS - 1)
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(send.mock.calls).toEqual([[ev(5)], [ev(7.5)]])
    vi.advanceTimersByTime(PROGRESS_PACE_MS * 3)
    expect(send).toHaveBeenCalledTimes(2) // nothing new: nothing sent
  })

  it('sends at once once the interval has passed since the last send', () => {
    const send = vi.fn()
    const p = paceProgress(send)
    p.push(ev(5))
    vi.advanceTimersByTime(PROGRESS_PACE_MS)
    p.push(ev(6))
    expect(send.mock.calls).toEqual([[ev(5)], [ev(6)]])
  })

  it('a pending event waits only the rest of the interval', () => {
    const send = vi.fn()
    const p = paceProgress(send)
    p.push(ev(5))
    vi.advanceTimersByTime(60)
    p.push(ev(6))
    vi.advanceTimersByTime(PROGRESS_PACE_MS - 60)
    expect(send.mock.calls).toEqual([[ev(5)], [ev(6)]])
  })

  it('sends a new stage, and the end (100), at once, dropping a pending event they supersede', () => {
    const send = vi.fn()
    const p = paceProgress(send)
    p.push(ev(5))
    p.push(ev(30))
    p.push(ev(41, 'layout'))
    p.push(ev(60, 'layout'))
    p.push(ev(100, 'layout'))
    vi.advanceTimersByTime(PROGRESS_PACE_MS * 2)
    expect(send.mock.calls).toEqual([[ev(5)], [ev(41, 'layout')], [ev(100, 'layout')]])
  })

  it('paces each project on its own', () => {
    const send = vi.fn()
    const p = paceProgress(send)
    p.push(ev(5, 'structure', 'a'))
    p.push(ev(5, 'structure', 'b'))
    p.push(ev(6, 'structure', 'a'))
    expect(send.mock.calls).toEqual([[ev(5, 'structure', 'a')], [ev(5, 'structure', 'b')]])
    vi.advanceTimersByTime(PROGRESS_PACE_MS)
    expect(send).toHaveBeenLastCalledWith(ev(6, 'structure', 'a'))
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('stop drops what is pending and sends nothing more', () => {
    const send = vi.fn()
    const p = paceProgress(send)
    p.push(ev(5))
    p.push(ev(6))
    p.push(ev(5, 'structure', 'idle')) // a lane with nothing pending
    p.stop()
    vi.advanceTimersByTime(PROGRESS_PACE_MS * 2)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('takes its interval from the caller', () => {
    const send = vi.fn()
    const p = paceProgress(send, 20)
    p.push(ev(5))
    p.push(ev(6))
    vi.advanceTimersByTime(20)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
