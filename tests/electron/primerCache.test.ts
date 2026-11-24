// WPA item 1: the finished primer, cached per project in main, stale-while-revalidate, in memory only.
import { describe, it, expect, vi } from 'vitest'
import { createPrimerCache, PRIMER_FRESH_MS, PRIMER_CACHE_MAX, PRIMER_MAX_AGE_MS, PRIMER_MAX_BUILDS } from '../../src/main/primerCache'
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
  const calls: Array<{ root: string; limit: number; signal?: AbortSignal; lane?: string }> = []
  let n = 0
  const b = build ?? (async (root: string, limit: number) => `primer ${++n} for ${root} at ${limit}`)
  const cache = createPrimerCache({
    build: (root, limit, signal, lane) => { calls.push({ root, limit, signal, lane }); return b(root, limit, signal) },
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
    expect(calls[1].signal?.aborted).toBe(false) // a refresh is no ask's to cancel: its signal is the cache's own
    expect(calls.map((c) => c.lane)).toEqual(['interactive', 'background']) // an ask's build is interactive; the refresh is not
    expect(await cache.get(ROOT, 10)).toBe(`primer 2 for ${ROOT} at 10`)
  })

  it('a refresh that fails drops the stale primer: the next ask builds again and gets the failure (WPA fix I1)', async () => {
    let fail = false
    let n = 0
    const { cache, calls, advance } = harness(async () => { if (fail) throw new Error('host down'); return `p${++n}` })
    await cache.get(ROOT, 10)
    fail = true
    advance(PRIMER_FRESH_MS + 1)
    expect(await cache.get(ROOT, 10)).toBe('p1') // this ask still gets it at once
    await tick()
    expect(cache.size()).toBe(0)
    await expect(cache.get(ROOT, 10)).rejects.toThrow('host down')
    expect(calls).toHaveLength(3)
  })

  it('a refresh that finds nothing drops the stale primer too: the next ask is told there is none', async () => {
    let none = false
    const { cache, advance } = harness(async () => (none ? null : 'p'))
    await cache.get(ROOT, 10)
    none = true
    advance(PRIMER_FRESH_MS + 1)
    expect(await cache.get(ROOT, 10)).toBe('p')
    await tick()
    expect(cache.has(ROOT, 10)).toBe(false)
    expect(await cache.get(ROOT, 10)).toBeNull()
  })

  it('a refresh that lands after a newer build stored leaves the newer one alone', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    let first = true
    const { cache, advance } = harness(() => {
      if (first) { first = false; return Promise.resolve('p1') }
      const d = deferred<string | null>(); gates.push(d); return d.promise
    })
    await cache.get(ROOT, 10)
    advance(PRIMER_FRESH_MS + 1)
    await cache.get(ROOT, 10) // starts the refresh (gates[0])
    const forced = cache.warm(ROOT, 10, { force: true }) // a newer build (gates[1])
    gates[1].resolve('newer')
    await forced
    gates[0].reject(new Error('old refresh failed'))
    await tick()
    expect(await cache.get(ROOT, 10)).toBe('newer')
  })

  it('a primer older than PRIMER_MAX_AGE_MS is never served: the ask builds afresh and waits for it', async () => {
    const { cache, calls, advance } = harness()
    await cache.get(ROOT, 10)
    advance(PRIMER_MAX_AGE_MS + 1)
    expect(await cache.get(ROOT, 10)).toBe(`primer 2 for ${ROOT} at 10`)
    expect(calls.map((c) => c.lane)).toEqual(['interactive', 'interactive'])
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

  it('the first uncached ask builds on the interactive lane; its cancel stops the build when nobody else waits; never cached', async () => {
    const d = deferred<string | null>()
    const { cache, calls } = harness(() => d.promise)
    const ctl = new AbortController()
    const p = cache.get(ROOT, 10, { signal: ctl.signal })
    expect(calls[0].lane).toBe('interactive')
    expect(calls[0].signal?.aborted).toBe(false)
    ctl.abort()
    expect(calls[0].signal?.aborted).toBe(true) // the memory reads stop with the only ask waiting on them
    d.resolve('built after the cancel')
    expect(await p).toBeNull()
    expect(cache.size()).toBe(0)
  })

  it('an ask that finds a warm-up running takes over on the interactive lane, and the background build stops (WPA2 I4)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const warmed = cache.warm(ROOT, 10)
    const p = cache.get(ROOT, 10, { signal: new AbortController().signal })
    expect(calls.map((c) => c.lane)).toEqual(['background', 'interactive'])
    expect(calls[0].signal?.aborted).toBe(true) // the warm-up's reads stop: the ask's build replaces them
    await warmed // a warm-up that was taken over is done, and never throws
    gates[0].resolve('the warm-up, too late')
    gates[1].resolve('the ask build')
    expect(await p).toBe('the ask build')
    await tick()
    expect(await cache.get(ROOT, 10)).toBe('the ask build')
    expect(calls).toHaveLength(2)
  })

  it('an ask whose build a warm-up joined leaves it running when it cancels, and the warm-up stores it', async () => {
    const d = deferred<string | null>()
    const { cache, calls } = harness(() => d.promise)
    const ctl = new AbortController()
    const p = cache.get(ROOT, 10, { signal: ctl.signal })
    const warmed = cache.warm(ROOT, 10)
    ctl.abort()
    expect(await p).toBeNull()
    expect(calls[0].signal?.aborted).toBe(false) // the warm-up still wants it
    d.resolve('kept')
    await warmed
    expect(await cache.get(ROOT, 10)).toBe('kept')
    expect(calls).toHaveLength(1)
  })

  it('an ask that joined another ask build is not cancelled by that ask cancelling (WPA2 I4)', async () => {
    const d = deferred<string | null>()
    const { cache, calls } = harness(() => d.promise)
    const first = new AbortController()
    const a = cache.get(ROOT, 10, { signal: first.signal })
    const b = cache.get(ROOT, 10, { signal: new AbortController().signal })
    expect(calls).toHaveLength(1)
    first.abort()
    expect(await a).toBeNull()
    expect(calls[0].signal?.aborted).toBe(false) // b still waits on it
    d.resolve('shared')
    expect(await b).toBe('shared')
  })

  it('when every ask waiting on a build cancels, the build stops, and the next ask never joins it (WPA2 I4)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const one = new AbortController()
    const two = new AbortController()
    const a = cache.get(ROOT, 10, { signal: one.signal })
    const b = cache.get(ROOT, 10, { signal: two.signal })
    one.abort()
    expect(calls[0].signal?.aborted).toBe(false)
    two.abort()
    expect(calls[0].signal?.aborted).toBe(true)
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    const c = cache.get(ROOT, 10, { signal: new AbortController().signal }) // a re-ask: the old one was cancelled for it
    expect(calls).toHaveLength(2)
    expect(calls[1].lane).toBe('interactive')
    gates[0].resolve(null) // the stopped build ends empty; that is not the re-ask's answer
    gates[1].resolve('fresh')
    expect(await c).toBe('fresh')
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

  it('warm reads on the background lane; warm with force always starts a new build, even with one running (WPA fix M4, M5)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const a = cache.warm(ROOT, 10)
    const b = cache.warm(ROOT, 10, { force: true })
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.lane)).toEqual(['background', 'background'])
    gates[1].resolve('after the ingest')
    await b
    gates[0].resolve('before the ingest')
    await a
    expect(await cache.get(ROOT, 10)).toBe('after the ingest') // the older build never overwrites the newer one
  })

  it('an ask never joins a build started before a drop: it builds anew', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    void cache.warm(ROOT, 10)
    cache.clear()
    const p = cache.get(ROOT, 10)
    expect(calls).toHaveLength(2)
    gates[0].resolve('read before the clear')
    gates[1].resolve('read after')
    expect(await p).toBe('read after')
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

  it('an ask waiting when the cache is cleared never gets the text read before the clear: it gets a build made after (WPA2 I2)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const p = cache.get(ROOT, 10, { signal: new AbortController().signal })
    const plain = cache.get(ROOT, 10) // a waiter that cannot cancel is held to the same rule
    cache.clear()
    expect(calls[0].signal?.aborted).toBe(true) // the reads that can no longer be used stop
    gates[0].resolve('read before the clear')
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1].lane).toBe('interactive')
    gates[1].resolve('read after the clear')
    expect(await p).toBe('read after the clear')
    expect(await plain).toBe('read after the clear')
    expect(await cache.get(ROOT, 10)).toBe('read after the clear')
    expect(calls).toHaveLength(2)
  })

  it('the same holds after an invalidate of that project, and for a pre-invalidate build that failed (WPA2 I2)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const p = cache.get(ROOT, 10, { signal: new AbortController().signal })
    const other = cache.get('/srv/other', 10)
    cache.invalidate(projectKeyOf(ROOT) as string)
    expect(calls[1].signal?.aborted).toBe(false) // another project's build is left alone
    gates[0].reject(new Error('the store reloaded under it'))
    await tick()
    expect(calls).toHaveLength(3)
    gates[2].resolve('after')
    expect(await p).toBe('after')
    gates[1].resolve('other')
    expect(await other).toBe('other')
  })

  it('a build that lands just before a clear is not handed out after it (WPA2 I2)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const p = cache.get(ROOT, 10)
    gates[0].resolve('read before the clear')
    queueMicrotask(() => cache.clear()) // lands between the build settling and the waiter reading it
    await tick()
    expect(calls).toHaveLength(2)
    gates[1].resolve('read after the clear')
    expect(await p).toBe('read after the clear')
  })

  it('a forced warm that ends empty cannot let an older build refill the cache after a clear (WPA2 I2)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const older = cache.warm(ROOT, 10)
    const forced = cache.warm(ROOT, 10, { force: true })
    expect(calls).toHaveLength(2)
    gates[1].resolve(null) // the forced one ends empty: no entry, and it was the tracked build
    await forced
    cache.clear()
    gates[0].resolve('read before the clear')
    await older
    await tick()
    expect(cache.size()).toBe(0)
    expect(cache.has(ROOT, 10)).toBe(false)
  })

  it('memory that keeps changing under every build is an error after PRIMER_MAX_BUILDS tries, never pre-clear text (WPA2 I2)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const p = cache.get(ROOT, 10, { signal: new AbortController().signal })
    for (let i = 0; i < PRIMER_MAX_BUILDS; i++) {
      await tick()
      expect(calls).toHaveLength(i + 1)
      cache.clear()
      gates[i].resolve(`read before clear ${i + 1}`)
    }
    await expect(p).rejects.toThrow('the memory kept changing while the primer was read')
    expect(calls).toHaveLength(PRIMER_MAX_BUILDS)
  })

  it('a bare name built across a clear is built again too, whether the old build answered or failed (WPA2 I2)', async () => {
    const gates: Array<ReturnType<typeof deferred<string | null>>> = []
    const { cache, calls } = harness(() => { const d = deferred<string | null>(); gates.push(d); return d.promise })
    const p = cache.get('termpolis', 10)
    cache.clear()
    gates[0].reject(new Error('read across the clear'))
    await tick()
    expect(calls).toHaveLength(2)
    gates[1].resolve('after')
    expect(await p).toBe('after')
    const q = cache.get('termpolis', 10)
    for (let i = 2; i < 2 + PRIMER_MAX_BUILDS; i++) { await tick(); cache.clear(); gates[i].resolve('before') }
    await expect(q).rejects.toThrow('the memory kept changing while the primer was read')
    expect(calls).toHaveLength(2 + PRIMER_MAX_BUILDS)
    const r = cache.get('termpolis', 10)
    gates[2 + PRIMER_MAX_BUILDS].reject(new Error('plain failure'))
    await expect(r).rejects.toThrow('plain failure') // a failure with no clear behind it is the caller's to see
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
    await tick()
    // The asks that waited on the pre-clear build never get 'old' (WPA2 I2): they take over from the fresh warm-up on the
    // interactive lane (WPA2 I4), whose background reads stop.
    expect(calls).toHaveLength(3)
    expect(calls[2].lane).toBe('interactive')
    expect(calls[1].signal?.aborted).toBe(true)
    gates[2].resolve('new')
    expect(await asked).toBe('new')
    expect(await plain).toBe('new')
    await joined
    await fresh
    expect(await cache.get(ROOT, 10)).toBe('new')
    expect(calls).toHaveLength(3)
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
