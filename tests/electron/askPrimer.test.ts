// WPA item 1 and 3: the Ask's primer comes from the cache under the ask's signal, and a missing one says why.
import { describe, it, expect, vi } from 'vitest'
import { createAskPrimer, lockAwareBuild, createAskPrimerWarm, trackWrittenProjects } from '../../src/main/askPrimer'
import { memoryTimeoutError } from '../../src/main/hostLane'
import { memoryUnavailable } from '../../src/main/world/askRunner'
import { createPrimerCache } from '../../src/main/primerCache'

function setup(over: { get?: (...a: unknown[]) => Promise<string | null>; hostDown?: boolean; locked?: boolean; expand?: (r: string) => Promise<string> } = {}) {
  const get = vi.fn(over.get ?? (async () => 'digest'))
  const isLocked = vi.fn(async () => over.locked === true)
  const hostDown = vi.fn(() => over.hostDown === true)
  const primer = createAskPrimer({ cache: { get: get as never }, limit: () => 12, hostDown, isLocked, ...(over.expand ? { expand: over.expand } : {}) })
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

  it('no digest from a working, open store says empty: no saved notes matched (WPA2 M8)', async () => {
    const a = setup({ get: async () => null })
    await expect(a.primer('C:/repo')).rejects.toMatchObject({ noMemory: 'empty' })
    expect(a.hostDown).toHaveBeenCalledTimes(1)
    expect(a.isLocked).toHaveBeenCalledTimes(1) // asked first: a locked store also gives no digest, and says so
  })

  it('a digest of nothing but white space is no digest: empty, or down or locked when that is why (WPA2 M8)', async () => {
    await expect(setup({ get: async () => '' }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'empty' })
    await expect(setup({ get: async () => ' \n\t ' }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'empty' })
    await expect(setup({ get: async () => '  ', hostDown: true }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'down' })
    await expect(setup({ get: async () => '', locked: true }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'locked' })
  })

  it('a cancel that lands while the lock is asked after an empty digest is owed no reason (WPA2 M8)', async () => {
    const ctl = new AbortController()
    const get = vi.fn(async () => null)
    const primer = createAskPrimer({ cache: { get: get as never }, limit: () => 12, hostDown: () => false, isLocked: async () => { ctl.abort(); return false } })
    expect(await primer('C:/repo', ctl.signal)).toBeNull()
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

  it('a memory process that is restarting (its calls failed with it) says down, not no notes (WPA fix I2)', async () => {
    const a = setup({ get: async () => { throw new Error('memory host exited (code 1)') } })
    await expect(a.primer('C:/repo')).rejects.toMatchObject({ noMemory: 'down' })
    expect(a.isLocked).toHaveBeenCalledTimes(1) // asked, since a reload that locked the store fails its calls too
  })

  it('a single memory call that ran out of time says timeout (WPA fix I2)', async () => {
    const a = setup({ get: async () => { throw memoryTimeoutError('memorySearch', 60_000) } })
    await expect(a.primer('C:/repo')).rejects.toMatchObject({ noMemory: 'timeout' })
    expect(a.isLocked).not.toHaveBeenCalled()
  })

  it('a build that failed while the store is locked says locked; a reason the build gave is kept as it is', async () => {
    await expect(setup({ get: async () => { throw new Error('cannot open') }, locked: true }).primer('C:/repo')).rejects.toMatchObject({ noMemory: 'locked' })
    const a = setup({ get: async () => { throw memoryUnavailable('locked') } })
    await expect(a.primer('C:/repo')).rejects.toMatchObject({ noMemory: 'locked' })
    expect(a.isLocked).not.toHaveBeenCalled()
  })

  it('looks the folder up by its long name (expand), and a cancel during the expand asks nothing', async () => {
    const a = setup({ expand: async (r) => r.replace('DAVIDE~1', 'DavidEngelhart') })
    await a.primer('C:/Users/DAVIDE~1/repo')
    expect(a.get).toHaveBeenCalledWith('C:/Users/DavidEngelhart/repo', 12, {})
    const ctl = new AbortController()
    const b = setup({ expand: async (r) => { ctl.abort(); return r } })
    expect(await b.primer('C:/repo', ctl.signal)).toBeNull()
    expect(b.get).not.toHaveBeenCalled()
  })
})

describe('lockAwareBuild (WPA fix I1)', () => {
  it('a digest built while the store is locked is refused as locked; asked beside the build, with the lane and signal passed on', async () => {
    const build = vi.fn(async () => 'digest')
    const ctl = new AbortController()
    await expect(lockAwareBuild(build, async () => true)('/r', 9, ctl.signal, 'background')).rejects.toMatchObject({ noMemory: 'locked' })
    expect(build).toHaveBeenCalledWith('/r', 9, ctl.signal, 'background')
    expect(await lockAwareBuild(build, async () => false)('/r', 9)).toBe('digest')
    expect(await lockAwareBuild(build, async () => { throw new Error('status failed') })('/r', 9)).toBe('digest')
    expect(await lockAwareBuild(async () => null, async () => true)('/r', 9)).toBeNull()
  })

  it('with the cache: a locked store is never served a cached digest, and the ask says locked', async () => {
    let locked = false
    const cache = createPrimerCache({ build: lockAwareBuild(async () => 'digest', async () => locked) })
    const primer = createAskPrimer({ cache, limit: () => 12, hostDown: () => false, isLocked: async () => locked })
    expect(await primer('/srv/repo')).toBe('digest')
    locked = true
    cache.clear() // the reload that locked it (onMemoryChanged)
    await expect(primer('/srv/repo')).rejects.toMatchObject({ noMemory: 'locked' })
    expect(cache.size()).toBe(0)
  })

  it('with the cache: an ask waiting on a build that read the store before it locked says locked, never the old digest (WPA2 I2)', async () => {
    let locked = false
    const gates: Array<(v: string) => void> = []
    const cache = createPrimerCache({ build: lockAwareBuild(() => new Promise<string>((r) => gates.push(r)), async () => locked) })
    const primer = createAskPrimer({ cache, limit: () => 12, hostDown: () => false, isLocked: async () => locked })
    const asked = primer('/srv/repo', new AbortController().signal)
    await new Promise((r) => setImmediate(r))
    locked = true
    cache.clear() // the reload that locked it (onMemoryChanged)
    gates[0]('digest read before the lock')
    await new Promise((r) => setImmediate(r))
    expect(gates).toHaveLength(2) // built again, against the locked store
    gates[1]('digest read through the lock')
    await expect(asked).rejects.toMatchObject({ noMemory: 'locked' })
    expect(cache.size()).toBe(0)
  })
})

describe('createAskPrimerWarm and trackWrittenProjects', () => {
  it('warms under the long name at the primer size, passing force, and never rejects', async () => {
    const warm = vi.fn(async () => {})
    const w = createAskPrimerWarm({ cache: { warm }, limit: () => 12, expand: async (r) => r.toUpperCase() })
    await w('/a', { force: true })
    expect(warm).toHaveBeenCalledWith('/A', 12, { force: true })
    await w('/b')
    expect(warm).toHaveBeenLastCalledWith('/B', 12, {})
    const plain = createAskPrimerWarm({ cache: { warm }, limit: () => 3 })
    await plain('/c')
    expect(warm).toHaveBeenLastCalledWith('/c', 3, {})
    const bad = createAskPrimerWarm({ cache: { warm: async () => { throw new Error('x') } }, limit: () => 3 })
    await expect(bad('/d')).resolves.toBeUndefined()
  })

  it('remembers each folder a write stored notes for, once, and hands them over once', async () => {
    const t = trackWrittenProjects(async (i: { project?: unknown; ok?: boolean }) => (i.ok === false ? null : { id: 'n' }))
    await t.write({ project: '/a' })
    await t.write({ project: '/b' })
    await t.write({ project: '/a' })
    await t.write({ project: '/c', ok: false }) // not stored
    await t.write({ project: '' })
    await t.write({})
    expect(t.take()).toEqual(['/a', '/b'])
    expect(t.take()).toEqual([])
  })
})
