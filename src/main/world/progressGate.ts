// progressGate.ts
//
// A compile reports its progress far faster than a bar can show it: its reads alone post up to 700 reports a pass
// (compile.ts readPct), so a project read in under a second sends the window about one IPC message a millisecond.
// Each is a task on the renderer's one thread, whether or not a Lumopolis pane is open to show it. On the 3-core
// macOS runner, a key typed during such a compile was echoed 30 to 70 ms late in about 1 in 10 presses, and only
// while that stream ran (e2e/world-view.spec.ts test 5).
//
// So the window hears at most one report every PROGRESS_MIN_MS a project, and always the latest: the first report
// and each new stage go at once, a report that comes sooner is held (a later one replaces it) and sent when the
// interval is up, and a project's `updated` drops what is held, since it ends the run the report belonged to (the
// pane clears its bar on it, and a report sent after it would put the bar back). The values the bar shows still only
// rise: nothing is reordered, only skipped.

import type { WorldProgressEvent } from '../../shared/world/types'

/** The shortest time between two reports of one project's progress that the window is sent. */
export const PROGRESS_MIN_MS = 50

export interface ProgressGateDeps {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export interface ProgressGate {
  /** A report from the host: sent now, or held until the interval is up. */
  push(e: WorldProgressEvent): void
  /** The project's run ended (its `updated`): what is held for it is dropped. */
  end(projectKey: string): void
  /** Drops everything held (the handlers are going). */
  dispose(): void
}

interface Lane { at: number; stage: string; held?: WorldProgressEvent; timer?: unknown }

export function progressGate(send: (e: WorldProgressEvent) => void, deps: ProgressGateDeps = {}): ProgressGate {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const lanes = new Map<string, Lane>()
  const drop = (lane: Lane): void => {
    if (lane.timer !== undefined) clearTimer(lane.timer)
    lane.timer = undefined
    lane.held = undefined
  }
  const out = (lane: Lane, e: WorldProgressEvent): void => {
    lane.at = now()
    lane.stage = e.stage
    send(e)
  }
  return {
    push(e) {
      const lane = lanes.get(e.projectKey)
      if (lane === undefined) {
        const fresh: Lane = { at: 0, stage: e.stage }
        lanes.set(e.projectKey, fresh)
        out(fresh, e)
        return
      }
      const wait = lane.at + PROGRESS_MIN_MS - now()
      if (wait <= 0 || e.stage !== lane.stage) {
        drop(lane)
        out(lane, e)
        return
      }
      lane.held = e
      lane.timer ??= setTimer(() => {
        lane.timer = undefined
        const held = lane.held
        lane.held = undefined
        if (held !== undefined) out(lane, held)
      }, wait)
    },
    end(projectKey) {
      const lane = lanes.get(projectKey)
      if (lane === undefined) return
      drop(lane)
      lanes.delete(projectKey)
    },
    dispose() {
      for (const lane of lanes.values()) drop(lane)
      lanes.clear()
    },
  }
}
