import { createChunkQueue, createStringQueue } from './chunkQueue'
import { createOutputThrottle, type OutputThrottle } from './outputThrottle'
import { switchEnabled, SWITCH_WRITE_SCHEDULER } from './paneSwitches'
import { getWriteScheduler, type PaneClass, type WriteScheduler } from './writeScheduler'

/**
 * How one pane's output reaches its xterm (1.54.5): through the renderer's write scheduler, or through its own
 * output throttle when the scheduler's kill switch is off. TerminalPane makes this ONE call and gets back what
 * it used to get from createOutputThrottle: a function to write live output with, `pending()` and
 * `whenDrained()` for the echo trace and the resize barrier, plus `typed()` (a key went into this terminal) and
 * `detach()` (the pane is going away), which the throttle path makes no-ops.
 *
 * The scheduler is used unless localStorage 'termpolis.writeScheduler' = '0' (read when a pane mounts), or
 * 'termpolis.outputChunks' = '0': that switch brings back the WHOLE 1.54.4 output path, string buffer and
 * all, and the scheduler is not part of 1.54.4.
 */

export interface PaneOutputOptions {
  id: string
  /** The pane's xterm: only `write` is used. */
  term: { write: (data: string, cb?: () => void) => void }
  /** The echo trace's tap around "hand a chunk to xterm" (counts the chars). Default: no trace. */
  tap?: (fn: (data: string) => void) => (data: string) => void
  /** Is the pane on screen? Read whenever the scheduler decides, so it needs no notification when it changes. */
  isVisible: () => boolean
  /** Is it the terminal the user is working in (the store's active terminal)? */
  isActive: () => boolean
  /** The output-chunks switch of this mount: chunk lists and retries (true) or the 1.54.4 string buffer (false). */
  chunked: boolean
  /** Tests: a scheduler of their own. Default: the renderer's. */
  scheduler?: WriteScheduler
}

export type PaneOutput = OutputThrottle & {
  /** `data` was typed into this terminal (a no-op without the scheduler). */
  typed: (data?: string) => void
  /** The pane is going away (a no-op without the scheduler). */
  detach: () => void
  /** True when the write scheduler carries this pane's output. */
  readonly scheduled: boolean
}

const noop = (): void => undefined

export function classifyPane(visible: boolean, active: boolean): PaneClass {
  return !visible ? 'hidden' : active ? 'focused' : 'visible'
}

/** Debug and e2e: the scheduler's counters (numbers only), as window.__termpolis_write_scheduler(). */
function exposeCounters(scheduler: WriteScheduler): void {
  try {
    ;(window as unknown as { __termpolis_write_scheduler?: () => unknown }).__termpolis_write_scheduler = () => scheduler.stats()
  } catch {
    // no window to hang it on: the counters are still in the scheduler
  }
}

export function createPaneOutput(o: PaneOutputOptions): PaneOutput {
  const tap = o.tap ?? ((fn: (data: string) => void) => fn)
  if (!o.chunked || !switchEnabled(SWITCH_WRITE_SCHEDULER)) {
    // With the output switch off the whole 1.54.4 output path is back: the string buffer, the flush that loses
    // a refused chunk. Otherwise this is the 1.54.5 throttle: a chunk list that keeps what xterm refuses.
    const throttle = createOutputThrottle(tap((data) => o.term.write(data)), {
      queue: o.chunked ? createChunkQueue() : createStringQueue(),
      retryRefused: o.chunked,
    })
    return Object.assign(throttle, { typed: noop, detach: noop, scheduled: false })
  }
  const scheduler = o.scheduler ?? getWriteScheduler()
  // The tap counts what is handed to xterm; the scheduler needs the callback of the same write, which is
  // what tells it xterm has parsed the chunk.
  const count = tap(() => undefined)
  const writer = scheduler.attach(o.id, {
    write: (data, ack) => {
      count(data)
      o.term.write(data, ack)
    },
    classify: () => classifyPane(o.isVisible(), o.isActive()),
  })
  exposeCounters(scheduler)
  return Object.assign(writer, { scheduled: true })
}
