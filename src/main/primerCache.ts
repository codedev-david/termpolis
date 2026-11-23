// primerCache.ts — the finished memory primer, cached per project in main (WPA, Lumopolis 2.0).
//
// An Ask, `termpolis exec` and a linked job all start with the same digest for the same folder, and building it reads the
// memory host (one search and one listing). A busy machine made that take seconds, sometimes far more, so the digest is kept
// here, stale-while-revalidate:
//   - an ask with a cached digest gets it at once; one older than PRIMER_FRESH_MS also starts ONE background rebuild, and the
//     next ask gets the rebuilt one;
//   - an ask with none builds it, with its own cancel signal: a cancelled build is never cached, and neither is a null one
//     (no digest, or a memory that could not answer), so the next ask tries again;
//   - an ask that finds a build already running (a warm-up) waits for it, and only stops waiting when it is cancelled: the
//     warm-up is someone else's and keeps going.
// It is warmed when a world opens and when memory ingest finishes (warm, force), and dropped on memory lock, clear, delete or
// correction (invalidate, clear): a digest built before such a change says what memory no longer says. A build that was
// running when its entry was dropped is not stored when it lands.
//
// Memory only, never on disk: the digest is memory content, and memory content at rest is encrypted by the store, not here.
// Keyed by the canonical project root (projectKey.ts), so every spelling of one folder shares an entry. PURE: no electron.
import { canonicalProjectPath, projectKeyOf } from './projectKey'

/** How long a cached digest is served without a rebuild. Past it, it is still served, and rebuilt behind the ask. */
export const PRIMER_FRESH_MS = 60_000
/** The most projects held at once (least recently used dropped first). */
export const PRIMER_CACHE_MAX = 16

export type PrimerBuild = (root: string, limit: number, signal?: AbortSignal) => Promise<string | null>

export interface PrimerCacheDeps {
  build: PrimerBuild
  /** Injectable clock, for tests. Default Date.now. */
  now?: () => number
}

export interface PrimerCache {
  /** The digest for `root` at `limit`: cached, or built now. Null when there is none or the ask was cancelled. */
  get(root: string, limit: number, opts?: { signal?: AbortSignal }): Promise<string | null>
  /** Builds ahead of an ask, unless a fresh digest is already held (`force` rebuilds it anyway). Never throws. */
  warm(root: string, limit: number, opts?: { force?: boolean }): Promise<void>
  /** Drops every cached digest of the project with this key. */
  invalidate(projectKey: string): void
  /** Drops everything. */
  clear(): void
  has(root: string, limit: number): boolean
  size(): number
}

interface Entry { text: string; at: number; projectKey: string }
interface Flight { promise: Promise<string | null>; generation: number }

export function createPrimerCache(deps: PrimerCacheDeps): PrimerCache {
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>() // insertion order = recency (oldest first)
  const flights = new Map<string, Flight>()
  // Bumped per project on every drop: a build started before the drop must not store what it read.
  const generations = new Map<string, number>()
  const generationOf = (projectKey: string): number => generations.get(projectKey) ?? 0

  // `root` is the spelling this ask came with, and the build gets it as is: the canonical spelling is lowercased, which is
  // a key, not a path a case-sensitive file system can open.
  const keyOf = (root: string, limit: number): { slot: string; projectKey: string; root: string } | null => {
    const projectKey = root ? projectKeyOf(root) : undefined
    if (!projectKey) return null
    return { slot: `${canonicalProjectPath(root)}\u0000${limit}`, projectKey, root }
  }

  const store = (slot: string, projectKey: string, text: string): void => {
    entries.delete(slot)
    entries.set(slot, { text, at: now(), projectKey })
    while (entries.size > PRIMER_CACHE_MAX) entries.delete(entries.keys().next().value as string)
  }

  /** One build for `slot`, stored when it lands with text, unless the project was dropped (or the build cancelled) meanwhile. */
  const fly = (k: { slot: string; projectKey: string; root: string }, limit: number, signal?: AbortSignal): Flight => {
    const generation = generationOf(k.projectKey)
    const promise = deps.build(k.root, limit, signal).then((text) => {
      if (signal?.aborted) return null
      if (typeof text === 'string' && generationOf(k.projectKey) === generation) store(k.slot, k.projectKey, text)
      return text
    })
    const flight = { promise, generation }
    flights.set(k.slot, flight)
    const done = (): void => { if (flights.get(k.slot) === flight) flights.delete(k.slot) }
    promise.then(done, done)
    return flight
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
      const text = await deps.build(root, limit, signal)
      return signal?.aborted ? null : text
    }
    const hit = entries.get(k.slot)
    if (hit) {
      entries.delete(k.slot)
      entries.set(k.slot, hit) // most recently used
      if (now() - hit.at > PRIMER_FRESH_MS && !flights.has(k.slot)) {
        // A refresh is nobody's to cancel, and one that fails keeps the stale digest.
        fly(k, limit).promise.catch(() => { /* kept stale */ })
      }
      return hit.text
    }
    const running = flights.get(k.slot)
    if (running) return waitOrCancel(running.promise, signal)
    return fly(k, limit, signal).promise
  }

  const warm: PrimerCache['warm'] = async (root, limit, opts = {}) => {
    const k = keyOf(root, limit)
    if (!k) return
    const hit = entries.get(k.slot)
    if (!opts.force && hit && now() - hit.at <= PRIMER_FRESH_MS) return
    const running = flights.get(k.slot)
    try { await (running && running.generation === generationOf(k.projectKey) ? running : fly(k, limit)).promise } catch { /* the next ask tries again */ }
  }

  const invalidate = (projectKey: string): void => {
    generations.set(projectKey, generationOf(projectKey) + 1)
    for (const [slot, e] of entries) if (e.projectKey === projectKey) entries.delete(slot)
  }

  const clear = (): void => {
    for (const e of entries.values()) generations.set(e.projectKey, generationOf(e.projectKey) + 1)
    entries.clear()
    // A build still running for a project with nothing stored yet must not store either.
    for (const slot of flights.keys()) {
      const projectKey = projectKeyOf(slot.split('\u0000')[0]) as string
      generations.set(projectKey, generationOf(projectKey) + 1)
    }
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
