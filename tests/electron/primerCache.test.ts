// WPA item 1: the finished primer, cached per project in main, stale-while-revalidate, in memory only.
import { describe, it, expect, vi } from 'vitest'
import { createPrimerCache, PRIMER_FRESH_MS, PRIMER_CACHE_MAX } from '../../src/main/primerCache'
import { projectKeyOf } from '../../src/main/projectKey'

const ROOT = '/srv/work/termpolis'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function harness(build?: (root: string, limit: number, signal?: AbortSignal) => Promise<string | null>) {
  let clock = 1_000
  const calls: Array<{ root: string; limit: number; signal?: AbortSignal }> = []
  let n = 0
  const b = build ?? (async (root: string, limit: number) => `primer ${++n} for ${root} at ${limit}`)
  const cache = createPrimerCache({
    build: (root, limit, signal) => { calls.push({ root, limit, signal }); return b(root, limit, signal) },
    now: () => clock,
  })
  return { cache, calls, advance: (ms: number) => { clock += ms } }
}

describe('primerCache', () => {
  it('builds once; a second ask is served from memory without a build', async () => {
    const { cache, calls } = harness()
    expect(await cache.get(ROOT, 10)).toBe(`primer 1 for ${ROOT} at 10`)
    expect(await cache.get(ROOT, 10)).toBe(`primer 1 for ${ROOT} at 10`)
    expect(calls).toHaveLength(1)
  })

  it('keys by the canonical root: a trailing slash or doubled separator is the same project; a limit is its own entry', async () => {
    const { cache, calls } = harness()
    await cache.get(ROOT, 10)
    await cache.get(ROOT + '/', 10)
    await cache.get('/srv/work//termpolis', 10)
    expect(calls).toHaveLength(1)
    await cache.get(ROOT, 12)
    expect(calls).toHaveLength(2)
  })

  it('builds with the spelling the ask came with, not the lowercased key (a case-sensitive file system needs the real path)', async () => {
    const { cache, calls } = harness()
    await cache.get('/srv/Work/Termpolis/', 10)
    expect(calls[0].root).toBe('/srv/Work/Termpolis/')
    expect(cache.has('/srv/work/termpolis', 10)).toBe(true)
  })

  it('serves stale past the fresh window and refreshes once in the background; the next ask gets the new one', async () => {
    const { cache, calls, advance } = harness()
    await cache.get(ROOT, 10)
    advance(PRIMER_FRESH_MS + 1)
    const first = cache.get(ROOT, 10) // stale, at once
    const second = cache.get(ROOT, 10) // the refresh is still running: no second one
    expect(await first).toBe(`primer 1 for ${ROOT} at 10`)
    expect(await second).toBe(`primer 1 for ${ROOT} at 10`)
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1].signal).toBeUndefined() // a background refresh is nobody's to cancel
    expect(await cache.get(ROOT, 10)).toBe(`primer 2 for ${ROOT} at 10`)
  })

  it('a refresh that fails or finds nothing keeps the stale primer', async () => {
    let fail = false
    let n = 0
    const { cache, advance } = harness(async () => { if (fail) throw new Error('host down'); return `p${++n}` })
    await cache.get(ROOT, 10)
    fail = true
    advance(PRIMER_FRESH_MS + 1)
    expect(await cache.get(ROOT, 10)).toBe('p1')
    await tick()
    expect(await cache.get(ROOT, 10)).toBe('p1')
  })

  it('a null build is never cached: the next ask builds again', async () => {
    const { cache, calls } = harness(async () => null)
    expect(await cache.get(ROOT, 10)).toBeNull()
    expect(await cache.get(ROOT, 10)).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('a build that throws rejects that ask and caches nothing', async () => {
    let n = 0
    const { cache } = harness(async () => { if (++n === 1) throw new Error('boom'); return 'ok' })
    await expect(cache.get(ROOT, 10)).rejects.toThrow('boom')
    expect(await cache.get(ROOT, 10)).toBe('ok')
  })

  it('the first uncached ask builds with its own signal; a cancelled build is never cached', async () => {
    const d = deferred<string | null>()
    const { cache, calls } = harness(() => d.promise)
    const ctl = new AbortController()
    const p = cache.get(ROOT, 10, { signal: ctl.signal })
    expect(calls[0].signal).toBe(ctl.signal)
    ctl.abort()
    d.resolve('built after the cancel')
    expect(await p).toBeNull()
    expect(cache.size()).toBe(0)
  })

  it('an ask that joins a build another started waits for it, and leaves it running when it gives up', async () => {
    const d = deferred<string | null>()
    const { cache, calls } = harness(() => d.promise)
    void cache.warm(ROOT, 10)
    const ctl = new AbortController()
    const p = cache.get(ROOT, 10, { signal: ctl.signal })
    expect(calls).toHaveLength(1)
    ctl.abort()
    expect(await p).toBeNull()
    d.resolve('warm one')
    await tick()
    expect(await cache.get(ROOT, 10)).toBe('warm one')
    expect(calls).toHaveLength(1)
  })

  it('an ask that joins a build waits for its result when nobody cancels', async () => {
    const d = deferred<string | null>()
    const { cache } = harness(() => d.promise)
    const a = cache.get(ROOT, 10)
    const b = cache.get(ROOT, 10, { signal: new AbortController().signal })
    d.resolve('shared')
    expect(await a).toBe('shared')
    expect(await b).toBe('shared')
  })

  it('an already-cancelled ask builds nothing and returns null, even with a cached primer it is not owed', async () => {
    const { cache, calls } = harness()
    const ctl = new AbortController()
    ctl.abort()
    expect(await cache.get(ROOT, 10, { signal: ctl.signal })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('a joined build that throws: the joiner gets the rejection', async () => {
    const d = deferred<string | null>()
    const { cache } = harness(() => d.promise)
    const a = cache.get(ROOT, 10)
    const b = cache.get(ROOT, 10, { signal: new AbortController().signal })
    d.reject(new Error('fails'))
    await expect(a).rejects.toThrow('fails')
    await expect(b).rejects.toThrow('fails')
  })

  it('warm builds ahead of an ask and never throws; warming a cached fresh primer does nothing; a stale one is rebuilt', async () => {
    let n = 0
    const { cache, calls, advance } = harness(async () => { if (++n === 1) throw new Error('cold'); return `w${n}` })
    await expect(cache.warm(ROOT, 10)).resolves.toBeUndefined()
    await cache.warm(ROOT, 10)
    expect(await cache.get(ROOT, 10)).toBe('w2')
    await cache.warm(ROOT, 10)
    expect(calls).toHaveLength(2)
    advance(PRIMER_FRESH_MS + 1)
    await cache.warm(ROOT, 10)
    expect(await cache.get(ROOT, 10)).toBe('w3')
  })

  it('warm with force rebuilds a fresh entry (memory ingest finished), keeping the old one until the new one lands', async () => {
    const { cache } = harness()
    await cache.get(ROOT, 10)
    const w = cache.warm(ROOT, 10, { force: true })
    expect(await cache.get(ROOT, 10)).toBe(`primer 1 for ${ROOT} at 10`)
    await w
    expect(await cache.get(ROOT, 10)).toBe(`primer 2 for ${ROOT} at 10`)
  })

  it('invalidate(projectKey) drops that project at every limit and no other; clear drops all', async () => {
    const { cache, calls } = harness()
    await cache.get(ROOT, 10)
    await cache.get(ROOT, 12)
    await cache.get('/srv/other', 10)
    cache.invalidate(projectKeyOf(ROOT) as string)
    expect(cache.size()).toBe(1)
    await cache.get('/srv/other', 10)
    expect(calls).toHaveLength(3)
    cache.clear()
    expect(cache.size()).toBe(0)
  })

  it('a build that lands after an invalidate is not cached (it read the memory as it was before)', async () => {
    const d = deferred<string | null>()
    const { cache } = harness(() => d.promise)
    const p = cache.get(ROOT, 10)
    cache.clear()
    d.resolve('read before the clear')
    expect(await p).toBe('read before the clear') // that ask still gets its answer
    expect(cache.size()).toBe(0)
  })

  it('an invalidate during a background refresh drops the stale entry and the refresh result too', async () => {
    let gate: ReturnType<typeof deferred<string | null>> | null = null
    let n = 0
    const { cache, advance } = harness(async () => { n++; if (gate) return gate.promise; return `v${n}` })
    await cache.get(ROOT, 10)
    gate = deferred<string | null>()
    advance(PRIMER_FRESH_MS + 1)
    await cache.get(ROOT, 10)
    cache.invalidate(projectKeyOf(ROOT) as string)
    gate.resolve('late')
    await tick()
    expect(cache.size()).toBe(0)
  })

  it('a bare name or empty root is not cached (no key to drop it by): it builds every time', async () => {
    const { cache, calls } = harness()
    await cache.get('', 10)
    await cache.get('', 10)
    await cache.get('termpolis', 10)
    expect(calls).toHaveLength(3)
    expect(cache.size()).toBe(0)
    await cache.warm('', 10)
    expect(calls).toHaveLength(3)
  })

  it('holds at most PRIMER_CACHE_MAX entries, dropping the least recently used', async () => {
    const { cache } = harness()
    for (let i = 0; i < PRIMER_CACHE_MAX; i++) await cache.get(`/srv/p${i}`, 10)
    await cache.get('/srv/p0', 10) // touched: now the newest
    await cache.get('/srv/extra', 10)
    expect(cache.size()).toBe(PRIMER_CACHE_MAX)
    expect(cache.has('/srv/p0', 10)).toBe(true)
    expect(cache.has('/srv/p1', 10)).toBe(false)
  })

  it('warm joins a build already running; after a drop it starts a new one, and the old one landing leaves the new one alone', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const asked = cache.get(ROOT, 10)
    const joined = cache.warm(ROOT, 10)
    expect(calls).toHaveLength(1) // joined, not a second build
    const plain = cache.get(ROOT, 10) // a joiner with no signal just waits
    cache.clear()
    const fresh = cache.warm(ROOT, 10)
    expect(calls).toHaveLength(2) // the running build read the memory before the clear: a new one starts
    gates[0].resolve('old')
    expect(await asked).toBe('old')
    expect(await plain).toBe('old')
    gates[1].resolve('new')
    await joined
    await fresh
    expect(await cache.get(ROOT, 10)).toBe('new')
    expect(calls).toHaveLength(2)
  })

  it('a bare name built with a signal that fires is null', async () => {
    const ctl = new AbortController()
    const { cache } = harness(async () => { ctl.abort(); return 'late' })
    expect(await cache.get('termpolis', 10, { signal: ctl.signal })).toBeNull()
  })

  it('defaults to the real clock', async () => {
    const build = vi.fn(async () => 'x')
    const cache = createPrimerCache({ build })
    expect(await cache.get(ROOT, 10)).toBe('x')
    expect(await cache.get(ROOT, 10)).toBe('x')
    expect(build).toHaveBeenCalledTimes(1)
  })
})
