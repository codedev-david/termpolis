// hostLane.ts: the memory host's interactive fast lane (WPA, Lumopolis 2.0).
//
// The memory host is one thread serving every memory call. Calls a person is waiting on (the Ask primer, an agent's
// memory_search) are INTERACTIVE; everything else (ingest writes, the Weave, sync reloads, label searches) is
// BACKGROUND. The lane works at the call boundary, never by blocking the thread:
//   - an interactive call starts at once, and while any is waiting or running the host runs at normal priority
//     (onInteractive(true) on the first, onInteractive(false) when the last ends);
//   - a background call that arrives while an interactive one is in the lane waits (an await, so the thread stays free)
//     until the lane is empty, then starts in arrival order, but never longer than BACKGROUND_MAX_WAIT_MS: a stream of
//     interactive calls (agents searching back to back) must not starve background work for good (WPA fix I4);
//   - long background loops call idle() between items, so a running Weave lets an interactive call through (bounded the same way);
//   - a waiting background call whose caller cancels is dropped before it starts (only reads are cancellable: the
//     host decides which calls get a signal).
// A call that already started is never paused: the single thread interleaves calls at their existing await points.
//
// The linger (memory host: LANE_LINGER_MS). A host lowered below normal is starved by a busy machine the moment it drops back,
// and Windows lifts a starved thread only every few seconds: an Ask primer is two reads in a row (search, then the recent
// listing), and lowering between them held the second one up for seconds (measured). So the host stays at normal until the
// lane has been empty for the whole linger; a call inside it keeps it there. Background calls do not wait for the linger.

export type HostLaneName = 'interactive' | 'background'

export interface HostLane {
  /** Enter the lane. Resolves with the release to call when the call ends; rejects with an AbortError when `signal`
   *  aborts while a background call is still waiting. A background call waits at most the max wait. */
  enter(lane: HostLaneName, signal?: AbortSignal): Promise<() => void>
  /** Resolves at once when no interactive call is in the lane, otherwise when the lane empties, at most after the max wait. */
  idle(): Promise<void>
  /** Interactive calls waiting or running. */
  interactive(): number
  /** Background calls waiting for the lane to empty. */
  waiting(): number
}

export function abortError(): Error {
  const e = new Error('memory call cancelled')
  e.name = 'AbortError'
  return e
}

/** The code a memory call's timeout carries, so a caller can tell "it took too long" from any other failure (WPA fix I2). */
export const MEMORY_TIMEOUT_CODE = 'MEMORY_TIMEOUT'

/** The error a memory call that ran out of time rejects with. The message is the one it always had. */
export function memoryTimeoutError(fn: string, limitMs: number): Error & { code: string } {
  const e = new Error(`memory host timed out after ${limitMs}ms (fn "${fn}")`) as Error & { code: string }
  e.code = MEMORY_TIMEOUT_CODE
  return e
}

/** Whether `e` is a memory call that ran out of time (memoryTimeoutError). */
export function isMemoryTimeout(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === MEMORY_TIMEOUT_CODE
}

/** How long the memory host stays at normal after its last interactive call leaves (see the linger above). */
export const LANE_LINGER_MS = 2_000

/** The longest a background call (or an idle() between a loop's items) waits on the interactive lane before it goes anyway.
 *  Long enough for an Ask primer's two reads (well under a second, measured), short enough that no background call starves. */
export const BACKGROUND_MAX_WAIT_MS = 1_000

export interface HostLaneOptions {
  /** Stay raised this long after the lane empties. 0 (the default) lowers at once. */
  lingerMs?: number
  /** The most a background call waits on the interactive lane (default BACKGROUND_MAX_WAIT_MS). */
  maxWaitMs?: number
}

export function createHostLane(onInteractive: (on: boolean) => void = () => {}, opts: HostLaneOptions = {}): HostLane {
  const lingerMs = opts.lingerMs ?? 0
  const maxWaitMs = opts.maxWaitMs ?? BACKGROUND_MAX_WAIT_MS
  let active = 0
  let raised = false
  let lowerTimer: ReturnType<typeof setTimeout> | null = null
  const waiters: Array<() => void> = []

  const lower = (): void => {
    lowerTimer = null
    raised = false
    onInteractive(false)
  }

  const flush = (): void => {
    // Arrival order; a waiter that enters the interactive lane meanwhile is not possible (enter is the only way in).
    for (const w of waiters.splice(0)) w()
  }

  const release = (): (() => void) => {
    let done = false
    return () => {
      if (done) return
      done = true
      active--
      if (active === 0) {
        if (lingerMs > 0) {
          lowerTimer = setTimeout(lower, lingerMs)
          lowerTimer.unref?.()
        } else lower()
        flush()
      }
    }
  }

  /** Wait until the lane empties, `ms` runs out, or `signal` fires (rejects AbortError), whichever is first. */
  const waitFor = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    const off = (): void => {
      clearTimeout(timer)
      const i = waiters.indexOf(go)
      if (i >= 0) waiters.splice(i, 1) // still waiting (flush() takes a waiter out only to call it)
      signal?.removeEventListener('abort', drop)
    }
    const go = (): void => { off(); resolve() }
    const drop = (): void => { off(); reject(abortError()) }
    const timer = setTimeout(go, ms)
    timer.unref?.()
    waiters.push(go)
    signal?.addEventListener('abort', drop, { once: true })
  })

  const idle = (): Promise<void> => (active === 0 ? Promise.resolve() : waitFor(maxWaitMs))

  return {
    async enter(lane, signal) {
      if (lane === 'interactive') {
        active++
        if (lowerTimer) { clearTimeout(lowerTimer); lowerTimer = null }
        if (!raised) { raised = true; onInteractive(true) }
        return release()
      }
      if (signal?.aborted) throw abortError()
      // One wait: until the lane empties or the max wait runs out. An interactive call that comes in after that runs beside
      // it (the single thread interleaves them at their await points), as one that came in after it started always did.
      if (active > 0) await waitFor(maxWaitMs, signal)
      return () => {}
    },
    idle,
    interactive: () => active,
    waiting: () => waiters.length,
  }
}
