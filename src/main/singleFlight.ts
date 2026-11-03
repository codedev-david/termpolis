// One run of an expensive async call per key at a time, and for a short time after: callers that ask while it runs,
// or within `ttlMs` of an answer worth keeping, share that answer instead of starting another.
//
// Used where two callers ask the same question at once and each question costs a process creation (shellAlone: a
// submit and an auto-primer ask for the same terminal together), which on the typing thread's own machine is
// 0.1-0.3 s of Defender-inspected process start. Only answers `keep` accepts are remembered for the TTL: a failure is
// never replayed, the next ask tries again.

export interface SingleFlight {
  run<T>(key: string, ttlMs: number, fn: () => Promise<T>, keep?: (value: T) => boolean): Promise<T>
  /** Entries held right now (running or inside their TTL): bounded by the keys in use. */
  size(): number
  /** Forget everything (tests; a call already running still settles for its own callers). */
  clear(): void
}

interface Entry {
  promise: Promise<unknown>
  /** null while the call is running; the time it settled with an answer worth keeping. */
  settledAt: number | null
  ttlMs: number
}

export function createSingleFlight(now: () => number = () => Date.now()): SingleFlight {
  const entries = new Map<string, Entry>()

  function sweep(): void {
    const t = now()
    for (const [key, e] of entries) {
      if (e.settledAt !== null && t - e.settledAt >= e.ttlMs) entries.delete(key)
    }
  }

  return {
    run<T>(key: string, ttlMs: number, fn: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
      sweep()
      const held = entries.get(key)
      if (held) return held.promise as Promise<T>
      const entry: Entry = { promise: undefined as unknown as Promise<unknown>, settledAt: null, ttlMs }
      entry.promise = fn().then(
        (value) => {
          if (keep(value) && ttlMs > 0) entry.settledAt = now()
          else if (entries.get(key) === entry) entries.delete(key)
          return value
        },
        (err) => {
          if (entries.get(key) === entry) entries.delete(key)
          throw err
        },
      )
      entries.set(key, entry)
      return entry.promise as Promise<T>
    },
    size: () => entries.size,
    clear: () => { entries.clear() },
  }
}
