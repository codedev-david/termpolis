// primerCache.ts — the finished memory primer of a Lumopolis Ask, cached per project in main (WPA, Lumopolis 2.0).
//
// Building the digest reads the memory host (one search and one listing), and a busy machine made that take seconds, sometimes
// far more, so the Ask's digest is kept here, stale-while-revalidate. Only the Ask's: `termpolis exec` and a linked job build
// their own primer every time (WPA Ruling 7), so nothing they start with comes from here.
//   - an ask with a cached digest gets it at once; one older than PRIMER_FRESH_MS also starts ONE background rebuild, and the
//     next ask gets the rebuilt one. A rebuild that fails or finds nothing DROPS the entry (WPA fix I1): the next ask builds
//     again and says why it has none, instead of being served the old digest for good. One older than PRIMER_MAX_AGE_MS is
//     never served: the ask builds afresh, as with none;
//   - an ask with none builds it on the interactive lane. Every build runs on the cache's own cancel signal, and the cache
//     counts who waits on it (WPA2 I4): an ask that cancels stops waiting at once, and the build's reads stop only when no one
//     else waits (another ask, a warm-up, a refresh). A stopped build is never cached or joined, and neither is a null one
//     (no digest, or a memory that could not answer) cached, so the next ask tries again;
//   - an ask that finds an ask's build running for the memory as it is now waits for it. One that finds a warm-up running
//     (background lane) does not wait behind it: it starts its own build on the interactive lane and the warm-up's reads stop
//     (WPA2 I4), since reads already sent cannot change lane.
// Warm-ups and rebuilds read on the background lane (nobody is waiting on them). It is warmed when a world opens and when
// memory ingest finishes (warm, force: always a new build, since the running one may have read the memory before the ingest),
// and dropped whenever the memory changes under it (main wires memoryClient onMemoryChanged to clear: every delete, archive,
// supersession, sync reload, encryption or key change, and the store restarting).
//
// What a build read before a drop is never used (WPA2 I2): a clear bumps a cache-wide epoch, an invalidate the project's
// generation, and both stop the builds running. A build is stored, and handed to anyone waiting on it, only when neither moved
// since it started. An ask waiting on a build that read the old memory builds again, at most PRIMER_MAX_BUILDS times in all,
// then fails (askPrimer turns that into a reason the answer had no memory). Because the epoch belongs to the cache, not to a
// tracked build, an older build that outlived a newer one can never refill the cache after a clear.
//
// The store locked: an entry never outlives an unlocked store. The store can only lock by reloading (a sync reload, an
// encryption or key change, a host restart), and each of those clears this cache through onMemoryChanged, so a build that read
// the store before it locked is neither stored nor handed out; a build that finishes while the store is locked rejects
// (askPrimer lockAwareBuild). So a locked store is never served a digest.
//
// Memory only, never on disk: the digest is memory content, and memory content at rest is encrypted by the store, not here.
// Keyed by the canonical project root (projectKey.ts), so every spelling of one folder shares an entry. PURE: no electron.
import { canonicalProjectPath, projectKeyOf } from './projectKey'
import type { HostLaneName } from './hostLane'

/** How long a cached digest is served without a rebuild. Past it, it is still served, and rebuilt behind the ask. */
export const PRIMER_FRESH_MS = 60_000
/** The oldest a cached digest may be and still be served (stale or not): past it, the ask builds afresh. */
export const PRIMER_MAX_AGE_MS = 10 * 60_000
/** The most projects held at once (least recently used dropped first). */
export const PRIMER_CACHE_MAX = 16
/** How many builds an ask waits through while the memory keeps changing under them, before it gives up with an error. */
export const PRIMER_MAX_BUILDS = 3

/** Builds the digest: `signal` (the cache's own) stops its reads, `lane` is the memory lane they ride. */
export type PrimerBuild = (root: string, limit: number, signal?: AbortSignal, lane?: HostLaneName) => Promise<string | null>

export interface PrimerCacheDeps {
  build: PrimerBuild
  /** Injectable clock, for tests. Default Date.now. */
  now?: () => number
}

export interface PrimerCache {
  /** The digest for `root` at `limit`: cached, or built now. Null when there is none or the ask was cancelled. */
  get(root: string, limit: number, opts?: { signal?: AbortSignal }): Promise<string | null>
  /** Builds ahead of an ask, unless a fresh digest is already held (`force` always starts a new build). Never throws. */
  warm(root: string, limit: number, opts?: { force?: boolean }): Promise<void>
  /** Drops every cached digest of the project with this key. */
  invalidate(projectKey: string): void
  /** Drops everything. */
  clear(): void
  has(root: string, limit: number): boolean
  size(): number
}

interface Entry { text: string; at: number; projectKey: string; seq: number }
type Outcome = { ok: true; text: string | null } | { ok: false; error: unknown }
interface Flight {
  /** The build's outcome. Never rejects. */
  settled: Promise<Outcome>
  lane: HostLaneName
  /** The cache's own: the build's reads stop when it fires (every ask waiting gave up, an ask took over, or a drop). */
  ctl: AbortController
  epoch: number
  generation: number
  projectKey: string
  /** Asks waiting that can still cancel. */
  waiters: number
  /** Someone waits who never cancels (a warm-up, a refresh, an ask with no signal), so no ask's cancel stops the build. */
  pinned: boolean
}
interface Key { slot: string; projectKey: string; root: string }
type Wait = { kind: 'cancelled' } | { kind: 'stopped' } | { kind: 'done'; outcome: Outcome }

const KEPT_CHANGING = 'the memory kept changing while the primer was read'

export function createPrimerCache(deps: PrimerCacheDeps): PrimerCache {
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>() // insertion order = recency (oldest first)
  const flights = new Map<string, Flight>()
  // Bumped per project on an invalidate: a build started before it must not store or hand out what it read.
  const generations = new Map<string, number>()
  const generationOf = (projectKey: string): number => generations.get(projectKey) ?? 0
  // Bumped by every clear, for every project at once (WPA2 I2).
  let epoch = 0
  let nextSeq = 0 // every build's number: a build's outcome never touches an entry a later build stored

  // `root` is the spelling this ask came with, and the build gets it as is: the canonical spelling is lowercased, which is
  // a key, not a path a case-sensitive file system can open.
  const keyOf = (root: string, limit: number): Key | null => {
    const projectKey = root ? projectKeyOf(root) : undefined
    if (!projectKey) return null
    return { slot: `${canonicalProjectPath(root)}\u0000${limit}`, projectKey, root }
  }

  const store = (slot: string, projectKey: string, text: string, seq: number): void => {
    entries.delete(slot)
    entries.set(slot, { text, at: now(), projectKey, seq })
    while (entries.size > PRIMER_CACHE_MAX) entries.delete(entries.keys().next().value as string)
  }

  /** The memory has not changed since this build started: what it read may still be stored and handed out. */
  const unchanged = (f: Flight): boolean => f.epoch === epoch && f.generation === generationOf(f.projectKey)

  /** One build for `k`. It lands with text: stored. With none, or failing: the entry it would have replaced is dropped (WPA fix
   *  I1). Either only when it was not stopped, the memory did not change meanwhile, and no later build already stored. */
  const fly = (k: Key, limit: number, lane: HostLaneName): Flight => {
    const ctl = new AbortController()
    const seq = ++nextSeq
    const f = { lane, ctl, epoch, generation: generationOf(k.projectKey), projectKey: k.projectKey, waiters: 0, pinned: false } as Flight
    const mayStore = (): boolean => !ctl.signal.aborted && unchanged(f) && (entries.get(k.slot)?.seq ?? 0) < seq
    f.settled = deps.build(k.root, limit, ctl.signal, lane).then((text): Outcome => {
      if (mayStore()) {
        if (typeof text === 'string') store(k.slot, k.projectKey, text, seq)
        else entries.delete(k.slot)
      }
      return { ok: true, text }
    }, (error: unknown): Outcome => {
      if (mayStore()) entries.delete(k.slot)
      return { ok: false, error }
    })
    flights.set(k.slot, f)
    void f.settled.then(() => { if (flights.get(k.slot) === f) flights.delete(k.slot) })
    return f
  }

  /** A build running for this slot that is still going and read the memory as it is now, if any (never a stopped one). */
  const joinable = (k: Key): Flight | undefined => {
    const running = flights.get(k.slot)
    return running && !running.ctl.signal.aborted && unchanged(running) ? running : undefined
  }

  /** Waits on `f` until it lands, it is stopped, or `signal` fires. An ask with a signal is counted; when the last such ask gives
   *  up on a build nobody else needs, the build stops, and never on another ask's cancel while this one waits (WPA2 I4). */
  const waitOn = (f: Flight, signal?: AbortSignal): Promise<Wait> => new Promise<Wait>((resolve) => {
    if (signal) f.waiters++
    else f.pinned = true
    const leave = (): void => {
      signal?.removeEventListener('abort', onCancel)
      f.ctl.signal.removeEventListener('abort', onStop)
    }
    const onCancel = (): void => {
      leave()
      if (--f.waiters === 0 && !f.pinned) f.ctl.abort()
      resolve({ kind: 'cancelled' })
    }
    const onStop = (): void => { leave(); resolve({ kind: 'stopped' }) }
    signal?.addEventListener('abort', onCancel, { once: true })
    f.ctl.signal.addEventListener('abort', onStop, { once: true })
    void f.settled.then((outcome) => { leave(); resolve({ kind: 'done', outcome }) })
  })

  /** A bare name has no key to cache or join by: it builds every time, and again when the memory changed under the build. */
  const getUnkeyed = async (root: string, limit: number, signal?: AbortSignal): Promise<string | null> => {
    for (let changed = 0; ;) {
      const at = epoch
      let outcome: Outcome
      try {
        outcome = { ok: true, text: await deps.build(root, limit, signal, 'interactive') }
      } catch (error) {
        outcome = { ok: false, error }
      }
      if (signal?.aborted) return null
      if (epoch === at) {
        if (outcome.ok) return outcome.text
        throw outcome.error
      }
      if (++changed >= PRIMER_MAX_BUILDS) throw new Error(KEPT_CHANGING)
    }
  }

  const get: PrimerCache['get'] = async (root, limit, opts = {}) => {
    const { signal } = opts
    if (signal?.aborted) return null
    const k = keyOf(root, limit)
    if (!k) return getUnkeyed(root, limit, signal)
    for (let changed = 0; ;) {
      const hit = entries.get(k.slot)
      if (hit && now() - hit.at > PRIMER_MAX_AGE_MS) entries.delete(k.slot) // too old to serve at all: built afresh below
      else if (hit) {
        entries.delete(k.slot)
        entries.set(k.slot, hit) // most recently used
        if (now() - hit.at > PRIMER_FRESH_MS && !joinable(k)) {
          // A refresh is no ask's to cancel; one that fails or finds nothing drops the entry (fly), and the next ask builds.
          fly(k, limit, 'background').pinned = true
        }
        return hit.text
      }
      let running = joinable(k)
      // A warm-up's reads wait behind every interactive call on the background lane; an ask does not wait behind them. Its own
      // build replaces the warm-up's, whose reads stop (WPA2 I4): reads already sent cannot change lane.
      if (running && running.lane === 'background') {
        running.ctl.abort()
        running = undefined
      }
      const flight = running ?? fly(k, limit, 'interactive')
      const w = await waitOn(flight, signal)
      if (w.kind === 'cancelled') return null
      // Handed out only when the memory has not changed since the build started (WPA2 I2). A waiter on a build that read the
      // memory before a clear or an invalidate (a delete, a sync reload, a lock) builds again instead.
      if (w.kind === 'done' && unchanged(flight)) {
        if (w.outcome.ok) return w.outcome.text
        throw w.outcome.error
      }
      if (++changed >= PRIMER_MAX_BUILDS) throw new Error(KEPT_CHANGING)
    }
  }

  const warm: PrimerCache['warm'] = async (root, limit, opts = {}) => {
    const k = keyOf(root, limit)
    if (!k) return
    const hit = entries.get(k.slot)
    if (!opts.force && hit && now() - hit.at <= PRIMER_FRESH_MS) return
    // force: always a new build (the running one may have read the memory before what made the caller warm it).
    const running = opts.force ? undefined : joinable(k)
    await waitOn(running ?? fly(k, limit, 'background')) // never rejects: a failure is the next ask's to report
  }

  const invalidate = (projectKey: string): void => {
    generations.set(projectKey, generationOf(projectKey) + 1)
    for (const [slot, e] of entries) if (e.projectKey === projectKey) entries.delete(slot)
    for (const f of flights.values()) if (f.projectKey === projectKey) f.ctl.abort() // what they read can no longer be used
  }

  const clear = (): void => {
    epoch++
    entries.clear()
    for (const f of flights.values()) f.ctl.abort() // what they read can no longer be used
  }

  return {
    get,
    warm,
    invalidate,
    clear,
    has: (root, limit) => { const k = keyOf(root, limit); return k !== null && entries.has(k.slot) },
    size: () => entries.size,
  }
}
