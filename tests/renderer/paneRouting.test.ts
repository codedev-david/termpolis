import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeTerminalOutput, type OutputApi } from '../../src/renderer/src/lib/paneRouting'
import { SWITCH_DATA_ROUTING } from '../../src/renderer/src/lib/paneSwitches'

// Which preload API a pane listens through (1.54.5, plan package P9), and that it fails open to the all-terminal one.
// Negative control: with the kill switch the same pane makes the all-terminal listener the base had, and hears the same.

function api(withFor = true): OutputApi & { all: Array<(id: string, data: string, end?: number) => void>; forCalls: string[] } {
  const all: Array<(id: string, data: string, end?: number) => void> = []
  const forCalls: string[] = []
  const a: OutputApi & { all: typeof all; forCalls: string[] } = {
    all,
    forCalls,
    onTerminalData: vi.fn((cb) => { all.push(cb); return vi.fn(() => { all.splice(all.indexOf(cb), 1) }) }),
  }
  if (withFor) {
    a.onTerminalDataFor = vi.fn((id: string, cb) => {
      forCalls.push(id)
      return vi.fn()
    })
  }
  return a
}

describe('subscribeTerminalOutput', () => {
  beforeEach(() => { window.localStorage.clear() })
  afterEach(() => { window.localStorage.clear() })

  it('uses the routed API when the bridge has it: one terminal, no all-terminal listener', () => {
    const a = api()
    const cb = vi.fn()
    subscribeTerminalOutput(a, 'term-1', cb)
    expect(a.onTerminalDataFor).toHaveBeenCalledWith('term-1', cb)
    expect(a.onTerminalData).not.toHaveBeenCalled()
  })

  it('returns the routed API\'s own unsubscribe', () => {
    const a = api()
    const off = vi.fn()
    a.onTerminalDataFor = vi.fn(() => off)
    subscribeTerminalOutput(a, 'term-1', vi.fn())()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE CONTROL: with the kill switch off it makes the all-terminal listener, and passes only its own terminal on', () => {
    window.localStorage.setItem(SWITCH_DATA_ROUTING, '0')
    const a = api()
    const cb = vi.fn()
    const off = subscribeTerminalOutput(a, 'term-1', cb)
    expect(a.onTerminalDataFor).not.toHaveBeenCalled()
    expect(a.onTerminalData).toHaveBeenCalledTimes(1)
    a.all[0]('term-2', 'not mine', 1)
    a.all[0]('term-1', 'mine', 5)
    a.all[0]('term-1', 'banner')
    expect(cb.mock.calls).toEqual([['term-1', 'mine', 5], ['term-1', 'banner', undefined]])
    off()
    expect(a.all).toHaveLength(0)
  })

  it('a bridge without onTerminalDataFor (an older preload, a test double) falls back to the all-terminal listener', () => {
    const a = api(false)
    const cb = vi.fn()
    subscribeTerminalOutput(a, 'term-1', cb)
    a.all[0]('term-1', 'x', 2)
    a.all[0]('other', 'y', 3)
    expect(cb.mock.calls).toEqual([['term-1', 'x', 2]])
  })

  it('a routed API that throws before subscribing falls back to the all-terminal listener: the pane is never deaf', () => {
    const a = api()
    a.onTerminalDataFor = vi.fn(() => { throw new Error('bridge is not what it claims') })
    const cb = vi.fn()
    subscribeTerminalOutput(a, 'term-1', cb)
    expect(a.onTerminalData).toHaveBeenCalledTimes(1)
    a.all[0]('term-1', 'x', 2)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('any value but "0" leaves routing on, and storage that throws leaves it on', () => {
    for (const v of ['1', '', 'false', 'off']) {
      window.localStorage.setItem(SWITCH_DATA_ROUTING, v)
      const a = api()
      subscribeTerminalOutput(a, 't', vi.fn())
      expect(a.onTerminalDataFor, `value ${JSON.stringify(v)}`).toHaveBeenCalledTimes(1)
    }
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      const a = api()
      subscribeTerminalOutput(a, 't', vi.fn())
      expect(a.onTerminalDataFor).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
