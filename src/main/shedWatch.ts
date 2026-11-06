// shedWatch.ts — a watch that stops listening when it is being shouted at.
//
// WHY. watchGuard's run gate stops RUNNING a handler during a flood, but by then every event has already
// been delivered to JavaScript, and on this platform that delivery is the cost: measured on David's laptop
// (Windows 11, Defender on, Node 24, synthetic files in a temp dir) each delivered event cost the
// receiving thread about 1.5 ms of its own CPU, whatever the listener did with it. A handler that is
// paused for a minute still pays that for every event of the minute: 500 events a second is three
// quarters of a thread, on the thread that echoes keystrokes. The only way to stop paying is to stop
// receiving.
//
// WHAT. A wrapper over one OS watch. It counts the events the OS delivers, in one-second windows. More
// than `eventsPerSecond` (200: the same number the run gate calls a flood) in one window and the watch is
// CLOSED (the event that tipped it is dropped, and so is anything already queued); it is reopened after 4 s,
// then 8, 16, 32 and 60 s if it keeps tripping, and the schedule starts again after 30 s of calm. When it
// is reopened `onResume` runs, which is where the owner says "something changed here, look again": one
// synthetic `overflow` event, which every consumer already knows how to take (repaint; re-sweep; run once).
// So a storm costs at most `eventsPerSecond` events per attempt (about a third of a second of CPU) instead
// of one per file, and nothing is silently lost: what was not heard is made up for by looking.
//
// Never used for a watch whose events are the whole point (there is none such here: every consumer has a
// slower safety net, the git rail's 15 s poll, the transcript tail's 1.5 s poll, the code graph's 15 min sweep).
//
// The first open throws as fs.watch does. A REopen that is refused (the directory went away) is tried again
// on the next step of the schedule. Error listeners are kept and attached to every handle it opens.

export interface ShedFsWatcher {
  close(): void
  on?(event: 'error', listener: (err: unknown) => void): unknown
}

/** fs.watch, as far as the watch wrappers need it. */
export type ShedFsWatchFn = (
  path: string,
  opts: { recursive?: boolean; persistent?: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => ShedFsWatcher

/** Events the OS may deliver in one second before the watch is closed. Matches the run gate's flood number. */
export const SHED_EVENTS_PER_SECOND = 200
export const SHED_BACKOFF_BASE_MS = 4000
export const SHED_BACKOFF_MAX_MS = 60_000
/** A watch that ran this long without tripping starts its schedule again. */
export const SHED_CALM_MS = 30_000

/** Kill switch for the 1.54.5 watcher changes (lane M), read each time a watch is opened. 0, off, false or no (any
 *  case) brings back the 1.54.4 subscriptions: a plain fs.watch here (no storm shedding), and in scopedWatch.ts one
 *  recursive watch of the root instead of the scoped set. The run gates in watchGuard.ts are not affected. */
export const SCOPED_WATCH_ENV = 'TERMPOLIS_SCOPED_WATCH'

export function scopedWatchDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env[SCOPED_WATCH_ENV] ?? '').trim().toLowerCase()
  return v === '0' || v === 'off' || v === 'false' || v === 'no'
}

export interface SheddingWatchOptions {
  /** The environment the kill switch is read from. Default: process.env. Tests only. */
  env?: Record<string, string | undefined>
  /** Runs after a closed watch has been reopened: the owner's cue to look again (emit an `overflow`). */
  onResume?: () => void
  /** A line when a watch is first closed, and at most one a minute after that. */
  log?: (msg: string) => void
  label?: string
  eventsPerSecond?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  calmMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export interface SheddingWatch extends ShedFsWatcher {
  on(event: 'error', listener: (err: unknown) => void): SheddingWatch
  /** True while the OS watch is closed because of a storm. */
  readonly shed: boolean
  /** How many times it has been closed so far. */
  readonly sheds: number
}

export function openSheddingWatch(
  fsWatch: ShedFsWatchFn,
  path: string,
  opts: { recursive?: boolean; persistent?: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
  o: SheddingWatchOptions = {},
): SheddingWatch {
  if (scopedWatchDisabled(o.env)) return plainWatch(fsWatch(path, opts, listener))
  const limit = o.eventsPerSecond ?? SHED_EVENTS_PER_SECOND
  const base = o.backoffBaseMs ?? SHED_BACKOFF_BASE_MS
  const cap = o.backoffMaxMs ?? SHED_BACKOFF_MAX_MS
  const calmMs = o.calmMs ?? SHED_CALM_MS
  const now = o.now ?? Date.now
  const setT = o.setTimer ?? ((fn: () => void, ms: number): unknown => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.() // a watch that is waiting to reopen must not keep the process alive
    return t
  })
  const clearT = o.clearTimer ?? ((t: unknown): void => clearTimeout(t as ReturnType<typeof setTimeout>))
  const errorListeners: Array<(err: unknown) => void> = []

  let inner: ShedFsWatcher | null = null
  let closed = false
  let shed = false
  let sheds = 0
  let backoff = base
  let windowStart = 0
  let count = 0
  let openedAt = 0
  let lastLogAt = -Infinity
  let timer: unknown = null

  function open(): void {
    const h = fsWatch(path, opts, onEvent)
    inner = h
    openedAt = now()
    windowStart = openedAt
    count = 0
    for (const cb of errorListeners) {
      try { h.on?.('error', cb) } catch { /* a watcher without an event emitter */ }
    }
  }

  function onEvent(event: string, name: string | Buffer | null): void {
    if (closed || shed) return // already closed by us, or a queued event arriving after close()
    const t = now()
    if (t - windowStart >= 1000 || t < windowStart) {
      // A new second, or the clock was stepped BACK (NTP): without this the old window would count every event
      // until the clock caught up, and a calm stream would look like a storm.
      windowStart = t
      count = 0
    }
    if (++count > limit) {
      trip()
      return
    }
    listener(event, name)
  }

  function trip(): void {
    shed = true
    sheds++
    const h = inner
    inner = null
    try { h?.close() } catch { /* already closed */ }
    if (now() - openedAt > calmMs) backoff = base // it ran calm for a long while first: start the schedule again
    const wait = backoff
    backoff = Math.min(backoff * 2, cap)
    const t = now()
    if (t - lastLogAt >= 60_000) {
      lastLogAt = t
      try {
        o.log?.(`[watch] ${o.label ?? path}: more than ${limit} events in a second; not listening for ${Math.round(wait / 1000)} s, then looking once (every event costs the main thread, so a storm is not heard)`)
      } catch { /* a logger must not take the watch down */ }
    }
    timer = setT(resume, wait)
  }

  function resume(): void {
    timer = null
    if (closed) return
    try {
      open()
    } catch {
      // Refused (the directory is gone, or the platform is out of handles): next step of the schedule.
      const wait = backoff
      backoff = Math.min(backoff * 2, cap)
      timer = setT(resume, wait)
      return
    }
    shed = false
    try { o.onResume?.() } catch { /* the owner's problem, never the watch's */ }
  }

  open() // the first open throws, as fs.watch does

  const handle: SheddingWatch = {
    close() {
      if (closed) return
      closed = true
      if (timer !== null) clearT(timer)
      timer = null
      try { inner?.close() } catch { /* already closed */ }
      inner = null
    },
    on(event, cb) {
      errorListeners.push(cb)
      try { inner?.on?.(event, cb) } catch { /* a watcher without an event emitter */ }
      return handle
    },
    get shed(): boolean { return shed },
    get sheds(): number { return sheds },
  }
  return handle
}

/** The kill switch's watch: the OS watch itself, in the SheddingWatch shape (it never sheds). */
function plainWatch(inner: ShedFsWatcher): SheddingWatch {
  const handle: SheddingWatch = {
    close() { inner.close() },
    on(event, l) { inner.on?.(event, l); return handle },
    get shed(): boolean { return false },
    get sheds(): number { return 0 },
  }
  return handle
}
