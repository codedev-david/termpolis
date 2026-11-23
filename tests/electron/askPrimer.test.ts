// WPA item 1 and 3: the Ask's primer comes from the cache under the ask's signal, and a missing one says why.
import { describe, it, expect, vi } from 'vitest'
import { createAskPrimer } from '../../src/main/askPrimer'

function setup(over: { get?: (...a: unknown[]) => Promise<string | null>; hostDown?: boolean; locked?: boolean } = {}) {
  const get = vi.fn(over.get ?? (async () => 'digest'))
  const isLocked = vi.fn(async () => over.locked === true)
  const hostDown = vi.fn(() => over.hostDown === true)
  const primer = createAskPrimer({ cache: { get: get as never }, limit: () => 12, hostDown, isLocked })
  return { primer, get, isLocked, hostDown }
}

describe('createAskPrimer', () => {
  it('serves the cached digest at the primer size, with the ask\'s signal, and asks nothing else', async () => {
    const { primer, get, isLocked, hostDown } = setup()
    const ctl = new AbortController()
    expect(await primer('C:/repo', ctl.signal)).toBe('digest')
    expect(get).toHaveBeenCalledWith('C:/repo', 12, { signal: ctl.signal })
    expect(isLocked).not.toHaveBeenCalled()
    expect(hostDown).not.toHaveBeenCalled()
  })

  it('without a signal it passes none', async () => {
    const { primer, get } = setup()
    await primer('C:/repo')
    expect(get).toHaveBeenCalledWith('C:/repo', 12, {})
  })

  it('no digest from a working, open store is no notes: null, no reason', async () => {
    const { primer } = setup({ get: async () => null })
    expect(await primer('C:/repo')).toBeNull()
  })

  it('no digest with the memory process down says down; locked says locked', async () => {
    await expect(setup({ get: async () => null, hostDown: true }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'down' })
    await expect(setup({ get: async () => null, locked: true }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'locked' })
  })

  it('a build that fails says down', async () => {
    await expect(setup({ get: async () => { throw new Error('host exited') } }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'down' })
  })

  it('a cancelled ask is owed no reason: null, and nothing more is asked', async () => {
    const ctl = new AbortController()
    const a = setup({ get: async () => { ctl.abort(); return null }, locked: true })
    expect(await a.primer('C:/repo', ctl.signal)).toBeNull()
    expect(a.isLocked).not.toHaveBeenCalled()
    const ctl2 = new AbortController()
    const b = setup({ get: async () => { ctl2.abort(); throw new Error('memory call cancelled') } })
    expect(await b.primer('C:/repo', ctl2.signal)).toBeNull()
  })
})
