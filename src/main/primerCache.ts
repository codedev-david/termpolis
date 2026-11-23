// primerCache.ts — the finished memory primer of a Lumopolis Ask, cached per project in main (WPA, Lumopolis 2.0).
//
// Building the digest reads the memory host (one search and one listing), and a busy machine made that take seconds, sometimes
// far more, so the Ask's digest is kept here, stale-while-revalidate. Only the Ask's: `termpolis exec` and a linked job build
// their own primer every time (WPA Ruling 7), so nothing they start with comes from here.
//   - an ask with a cached digest gets it at once; one older than PRIMER_FRESH_MS also starts ONE background rebuild, and the
//     next ask gets the rebuilt one. A rebuild that fails or finds nothing DROPS the entry (WPA fix I1): the next ask builds
//     again and says why it has none, instead of being served the old digest for good. One older than PRIMER_MAX_AGE_MS is
//     never served: the ask builds afresh, as with none;
//   - an ask with none builds it on the interactive lane, with its own cancel signal: a cancelled build is never cached, and
//     neither is a null one (no digest, or a memory that could not answer), so the next ask tries again;
//   - an ask that finds a build already running (a warm-up) for the memory as it is now waits for it, and only stops waiting
//     when it is cancelled: the warm-up is someone else's and keeps going. A build started before a drop is never joined.
// Warm-ups and rebuilds read on the background lane (nobody is waiting on them). It is warmed when a world opens and when
// memory ingest finishes (warm, force: always a new build, since the running one may have read the memory before the ingest),
// and dropped whenever the memory changes under it (main wires memoryClient onMemoryChanged to clear: every delete, archive,
// supersession, sync reload, encryption or key change, and the store restarting). A build that was running when its entry
// was dropped is not stored when it lands.
//
// The store locked: an entry never outlives an unlocked store. The store can only lock by reloading (a sync reload, an
// encryption or key change, a host restart), and each of those clears this cache through onMemoryChanged; a build that finishes
// while the store is locked rejects (askPrimer lockAwareBuild) and is never stored. So a locked store is never served a digest.
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

/** Builds the digest: `signal` cancels it (an ask's), `lane` is the memory lane its reads ride. */
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
interface Flight { promise: Promise<string | null>; generation: number; projectKey: string }
interface Key { slot: string; projectKey: string; root: string }

export function createPrimerCache(deps: PrimerCacheDeps): PrimerCache {
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>() // insertion order = recency (oldest first)
  const flights = new Map<string, Flight>()
  // Bumped per project on every drop: a build started before the drop must not store what it read.
  const generations = new Map<string, number>()
  const generationOf = (projectKey: string): number => generations.get(projectKey) ?? 0
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

  /** One build for `k`. It lands with text: stored. With none, or failing: the entry it would have replaced is dropped (WPA fix
   *  I1). Either only when it was not cancelled, the project was not dropped meanwhile, and no later build already stored. */
  const fly = (k: Key, limit: number, lane: HostLaneName, signal?: AbortSignal): Flight => {
    const generation = generationOf(k.projectKey)
    const seq = ++nextSeq
    const current = (): boolean => !signal?.aborted && generationOf(k.projectKey) === generation && (entries.get(k.slot)?.seq ?? 0) < seq
    const promise = deps.build(k.root, limit, signal, lane).then((text) => {
      if (signal?.aborted) return null
      if (current()) {
        if (typeof text === 'string') store(k.slot, k.projectKey, text, seq)
        else entries.delete(k.slot)
      }
      return text
    }, (e: unknown) => {
      if (current()) entries.delete(k.slot)
      throw e
    })
    const flight = { promise, generation, projectKey: k.projectKey }
    flights.set(k.slot, flight)
    const done = (): void => { if (flights.get(k.slot) === flight) flights.delete(k.slot) }
    promise.then(done, done)
    return flight
  }

  /** A build already running for this slot that read the memory as it is now, if any. */
  const joinable = (k: Key): Flight | undefined => {
    const running = flights.get(k.slot)
    return running && running.generation === generationOf(k.projectKey) ? running : undefined
  }

  /** Waits for `p`, or resolves null once `signal` fires, whichever is first. The work behind `p` keeps going. */
  const waitOrCancel = (p: Promise<string | null>, signal: AbortSignal | undefined): Promise<string | null> => {
    if (!signal) return p
    return new Promise<string | null>((resolve, reject) => {
      const onAbort = (): void => resolve(null)
      signal.addEventListener('abort', onAbort, { once: true })
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  const get: PrimerCache['get'] = async (root, limit, opts = {}) => {
    const { signal } = opts
    if (signal?.aborted) return null
    const k = keyOf(root, limit)
    if (!k) {
      const text = await deps.build(root, limit, signal, 'interactive')
      return signal?.aborted ? null : text
    }
    const hit = entries.get(k.slot)
    if (hit && now() - hit.at > PRIMER_MAX_AGE_MS) entries.delete(k.slot) // too old to serve at all: built afresh below
    else if (hit) {
      entries.delete(k.slot)
      entries.set(k.slot, hit) // most recently used
      if (now() - hit.at > PRIMER_FRESH_MS && !joinable(k)) {
        // A refresh is nobody's to cancel; one that fails or finds nothing drops the entry (fly), and the next ask builds.
        fly(k, limit, 'background').promise.catch(() => { /* the entry is dropped; the next ask says why */ })
      }
      return hit.text
    }
    const running = joinable(k)
    if (running) return waitOrCancel(running.promise, signal)
    return fly(k, limit, 'interactive', signal).promise
  }

  const warm: PrimerCache['warm'] = async (root, limit, opts = {}) => {
    const k = keyOf(root, limit)
    if (!k) return
    const hit = entries.get(k.slot)
    if (!opts.force && hit && now() - hit.at <= PRIMER_FRESH_MS) return
    // force: always a new build (the running one may have read the memory before what made the caller warm it).
    const running = opts.force ? undefined : joinable(k)
    try { await (running ?? fly(k, limit, 'background')).promise } catch { /* the next ask tries again */ }
  }

  const invalidate = (projectKey: string): void => {
    generations.set(projectKey, generationOf(projectKey) + 1)
    for (const [slot, e] of entries) if (e.projectKey === projectKey) entries.delete(slot)
  }

  const clear = (): void => {
    const keys = new Set<string>()
    for (const e of entries.values()) keys.add(e.projectKey)
    // A build still running for a project with nothing stored yet must not store either.
    for (const f of flights.values()) keys.add(f.projectKey)
    for (const key of keys) generations.set(key, generationOf(key) + 1)
    entries.clear()
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
