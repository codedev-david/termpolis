// The relaunch lock map tells listeners when a hold is set or lifted (src/main/accountSwitch.ts, 1.61.0): the pty host
// takes typing straight from the renderer, so it must hear of every hold to send what is typed under it through main.
import { describe, it, expect, vi } from 'vitest'
import { LockMap } from '../../src/main/accountSwitch'

describe('LockMap', () => {
  it('tells listeners of a set, a delete of a held id, and every id a clear lifts', () => {
    const m = new LockMap()
    const seen: Array<[string, unknown]> = []
    m.onChange((id, hold) => seen.push([id, hold]))
    const hold = { until: 5, kind: 'account' as const }
    expect(m.set('a', hold)).toBe(m)
    m.set('b', hold)
    expect(m.delete('a')).toBe(true)
    expect(m.delete('zz')).toBe(false) // nothing held: nothing said
    m.clear()
    expect(seen).toEqual([['a', hold], ['b', hold], ['a', undefined], ['b', undefined]])
    expect(m.size).toBe(0)
  })

  it('a listener that throws neither stops the map nor the other listeners', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = new LockMap()
    const ok = vi.fn()
    m.onChange(() => { throw new Error('boom') })
    m.onChange(ok)
    m.set('a', { until: 1, kind: 'account' })
    expect(m.get('a')?.until).toBe(1)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
