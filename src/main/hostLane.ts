// hostLane.ts: the memory host's interactive fast lane (WPA, Lumopolis 2.0).
//
// The memory host is one thread serving every memory call. Calls a person is waiting on (the Ask primer, an agent's
// memory_search) are INTERACTIVE; everything else (ingest writes, the Weave, sync reloads, label searches) is
// BACKGROUND. The lane works at the call boundary, never by blocking the thread:
//   - an interactive call starts at once, and while any is waiting or running the host runs at normal priority
//     (onInteractive(true) on the first, onInteractive(false) when the last ends);
//   - a background call that arrives while an interactive one is in the lane waits (an await, so the thread stays free)
//     until the lane is empty, then starts in arrival order;
//   - long background loops call idle() between items, so a running Weave lets an interactive call through;
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
   *  aborts while a background call is still waiting. */
  enter(lane: HostLaneName, signal?: AbortSignal): Promise<() => void>
  /** Resolves at once when no interactive call is in the lane, otherwise when the lane empties. */
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

/** How long the memory host stays at normal after its last interactive call leaves (see the linger above). */
export const LANE_LINGER_MS = 2_000

export interface HostLaneOptions {
  /** Stay raised this long after the lane empties. 0 (the default) lowers at once. */
  lingerMs?: number
}

export function createHostLane(onInteractive: (on: boolean) => void = () => {}, opts: HostLaneOptions = {}): HostLane {
  const lingerMs = opts.lingerMs ?? 0
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

  const idle = (): Promise<void> => (active === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)))

  return {
    async enter(lane, signal) {
      if (lane === 'interactive') {
        active++
        if (lowerTimer) { clearTimeout(lowerTimer); lowerTimer = null }
        if (!raised) { raised = true; onInteractive(true) }
        return release()
      }
      if (signal?.aborted) throw abortError()
      while (active > 0) {
        await new Promise<void>((resolve, reject) => {
          const go = (): void => { signal?.removeEventListener('abort', drop); resolve() }
          const drop = (): void => {
            // Still waiting: flush() takes `go` out only to call it, and `go` takes this listener off before anything else.
            waiters.splice(waiters.indexOf(go), 1)
            reject(abortError())
          }
          waiters.push(go)
          signal?.addEventListener('abort', drop, { once: true })
        })
      }
      return () => {}
    },
    idle,
    interactive: () => active,
    waiting: () => waiters.length,
  }
}
