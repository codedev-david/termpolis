// Paces a compile's progress on its way to the page (TYPEFLAKE).
//
// A compile's reads post progress in twentieths of a point, up to 700 a pass, so the bar keeps moving on a big
// folder read slowly. On a project read in half a second that is some 1,400 events a second, and each one was an
// IPC to the page and a render of the whole world pane, while a person types on a machine with nothing to spare
// (macOS CI: three cores, the compile on one, GPU drawing in software). The page shows one bar; ten moves a second
// is all it can use. So: a project's first event, a new stage and the end (100) go at once; within a stage, at most
// one event an interval, and the latest one at the interval's end, so the bar never stops short of where it got to.
import type { WorldProgressEvent } from '../../shared/world/types'

export const PROGRESS_PACE_MS = 100

interface Lane {
  stage: string
  at: number
  pending: WorldProgressEvent | null
  timer: ReturnType<typeof setTimeout> | null
}

export function paceProgress(send: (e: WorldProgressEvent) => void, ms = PROGRESS_PACE_MS): { push: (e: WorldProgressEvent) => void; stop: () => void } {
  const lanes = new Map<string, Lane>()
  const flush = (lane: Lane): void => {
    lane.timer = null
    // Only ever set with a pending event, and a newer lane clears it, so there is always one to send.
    const e = lane.pending as WorldProgressEvent
    lane.pending = null
    lane.at = Date.now()
    send(e)
  }
  return {
    push: (e) => {
      const now = Date.now()
      const lane = lanes.get(e.projectKey)
      if (!lane || lane.stage !== e.stage || e.pct >= 100 || now - lane.at >= ms) {
        if (lane?.timer) clearTimeout(lane.timer)
        lanes.set(e.projectKey, { stage: e.stage, at: now, pending: null, timer: null })
        send(e)
        return
      }
      lane.pending = e
      if (!lane.timer) lane.timer = setTimeout(() => flush(lane), ms - (now - lane.at))
    },
    stop: () => {
      for (const lane of lanes.values()) if (lane.timer) clearTimeout(lane.timer)
      lanes.clear()
    }
  }
}
