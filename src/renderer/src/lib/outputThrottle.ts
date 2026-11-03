import { createChunkQueue, type ChunkQueue } from './chunkQueue'
import { reportFailure } from './reportFailure'

const MAX_FLUSH_SIZE = 65536 // 64KB per frame — prevents memory spikes from extreme output

// Writes at or below this size, when the throttle is otherwise idle, are flushed
// synchronously instead of waiting for the next animation frame. This is the
// keystroke-echo path: the PTY echoes each typed character straight back, and
// deferring it by a frame is felt as input lag — worst on the first keystroke in
// a freshly-opened terminal, when an animation frame can be starved for hundreds
// of ms by mount work. A bare 1-byte echo is the simplest case, but PowerShell's
// PSReadLine repaints the whole input line (often with a prediction suggestion)
// on every keystroke — a few KB, not one byte — so the limit is generous enough
// to keep those on the instant path too. Genuinely large chunks, and any write
// that arrives while a burst is already in flight, still coalesce through rAF so
// a flood can't spike memory or thrash the renderer.
const SMALL_WRITE_BYPASS = 8192

/**
 * How long the buffer may sit unwritten before the timer watchdog flushes it regardless of frames.
 *
 * Chromium stops firing requestAnimationFrame entirely when a page is hidden or OCCLUDED — and on
 * Windows a Termpolis window with anything sitting on top of it is occluded, not merely unfocused.
 * With rAF as the only clock the pending flush never ran, `scheduled` stayed true forever (which
 * also routes the small-write bypass into the buffer, so even keystroke echo went dark), and the
 * buffer grew unbounded until the window came back. The terminal was dead for as long as something
 * covered the window.
 *
 * rAF stays the fast path: while frames are being produced it always wins this race, so visible
 * terminals keep painting at frame cadence with no added latency. The watchdog only ever fires when
 * frames have stopped, and 100 ms (10 Hz) keeps a hidden terminal live and draining without busying
 * a backgrounded renderer. Paired with `backgroundThrottling: false` on the BrowserWindow, which is
 * what keeps this timer running at its real interval while the window is hidden.
 */
const WATCHDOG_MS = 100

/**
 * How many times in a row the writer may refuse one chunk before the chunk is dropped.
 *
 * term.write throws when xterm's own queue is past its 50,000,000-char watermark ("write data
 * discarded, use flow control to avoid losing data") or when the terminal is being torn down. The
 * 1.54.4 flush had already taken the chunk out of its buffer by then, so the throw lost it, in the
 * middle of an escape sequence if that is where the 64 KB boundary fell, and the screen stayed
 * wrong. Now the chunk stays at the head of the queue and is offered again: on the next tick, then
 * with a doubling delay (200, 400, 800, 1600 ms, then every 2 s), about 13 s in all. A refusal that
 * lasts that long is a terminal that is gone, and the chunk is dropped so the queue cannot grow for
 * ever behind it.
 */
export const MAX_WRITE_RETRIES = 10
const RETRY_BACKOFF_CAP_MS = 2000

/** What the throttle tells `onError` about a refused chunk. */
export interface ThrottleErrorInfo {
  /** Consecutive refusals of this chunk so far, this one included. */
  attempt: number
  /** True when this was the last: the chunk is gone. */
  dropped: boolean
  /** Size of the chunk that was refused. */
  chars: number
}

export interface OutputThrottleOptions {
  /** The queue the backlog lives in. Default: the chunk list. The kill switch passes the 1.54.4 string queue. */
  queue?: ChunkQueue
  /**
   * Told about a refused chunk: the FIRST refusal of an episode, and the drop. Never about every retry
   * (a stuck terminal would otherwise report ten times). Default: window.reportError, which is what an
   * uncaught throw in the timer used to reach (so crash reporting still sees it), else the console.
   */
  onError?: (error: unknown, info: ThrottleErrorInfo) => void
}

/** The throttle's write function.
 *  `pending()` is how many chars are buffered and not yet handed to the writer: the echo trace reads it
 *  to tell how much output sits ahead of a typed key.
 *  `whenDrained(cb, maxWaitMs)` calls `cb` once every char queued BEFORE the call has been handed to the
 *  writer (chars that arrive later do not hold it back), or after `maxWaitMs`, whichever comes first,
 *  exactly once; at once when nothing is queued. It returns a function that cancels the wait. A resize
 *  waits on it, so the grid never changes under output that was drawn for the old one. */
export type OutputThrottle = ((data: string) => void) & {
  pending: () => number
  whenDrained: (cb: () => void, maxWaitMs: number) => () => void
}

interface Waiter {
  target: number
  cb: () => void
  timer: ReturnType<typeof setTimeout> | undefined
}

const reportThrottleFailure = (error: unknown): void => reportFailure(error, 'output throttle')

export function createOutputThrottle(writeFn: (data: string) => void, opts: OutputThrottleOptions = {}): OutputThrottle {
  const queue = opts.queue ?? createChunkQueue()
  const onError = opts.onError ?? reportThrottleFailure
  let scheduled = false
  let rafId: number | null = null
  let timerId: ReturnType<typeof setTimeout> | undefined
  /** Consecutive refusals of the chunk at the head of the queue. */
  let failures = 0
  /** Chars ever accepted / ever handed on (or dropped): a wait's target is a point on this line. */
  let pushed = 0
  let handed = 0
  const waiters: Waiter[] = []

  /** Arm both clocks; whichever fires first cancels the other. A retry arms the timer alone, after `delayMs`. */
  function schedule(delayMs?: number) {
    scheduled = true
    if (delayMs === undefined) {
      rafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(onTick) : null
      timerId = setTimeout(onTick, WATCHDOG_MS)
    } else {
      rafId = null
      timerId = setTimeout(onTick, delayMs)
    }
  }

  function disarm() {
    // rafId is null exactly when the environment had no requestAnimationFrame to arm — the only
    // case where there is nothing to cancel. clearTimeout takes undefined as a no-op, so the timer
    // needs no guard of its own.
    if (rafId !== null) cancelAnimationFrame(rafId)
    clearTimeout(timerId)
    rafId = null
    timerId = undefined
    scheduled = false
  }

  function onTick() {
    disarm()
    flush()
  }

  /** Tell onError, which is not allowed to break the flush. */
  function notify(error: unknown, info: ThrottleErrorInfo) {
    try {
      onError(error, info)
    } catch {
      // a reporter that throws must not take the throttle down with it
    }
  }

  /** Arm the retry after a refusal: the next ordinary tick first, then a doubling delay. */
  function retry() {
    schedule(failures <= 1 ? undefined : Math.min(WATCHDOG_MS * 2 ** (failures - 1), RETRY_BACKOFF_CAP_MS))
  }

  function runWaiter(w: Waiter) {
    const i = waiters.indexOf(w)
    if (i < 0) return // already served, or cancelled
    waiters.splice(i, 1)
    clearTimeout(w.timer)
    try {
      w.cb()
    } catch (error) {
      reportThrottleFailure(error)
    }
  }

  /** Serve every wait whose target has been handed to the writer. */
  function settle() {
    if (waiters.length === 0) return
    for (const w of waiters.slice()) if (w.target <= handed) runWaiter(w)
  }

  function flush() {
    // Write up to 64KB, defer the rest — re-armed on BOTH clocks so a large backlog keeps
    // draining even with no frames, instead of stalling after the first chunk.
    const out = queue.take(MAX_FLUSH_SIZE)
    try {
      writeFn(out)
      failures = 0
      handed += out.length
    } catch (error) {
      failures++
      const dropped = failures > MAX_WRITE_RETRIES
      if (failures === 1 || dropped) notify(error, { attempt: failures, dropped, chars: out.length })
      if (!dropped) {
        queue.restore(out) // the chunk stays at the head, in front of anything that arrived since
        retry()
        return
      }
      failures = 0
      handed += out.length // gone, and a resize waiting on it must not wait for ever
    }
    if (queue.length > 0) schedule()
    settle()
  }

  const write = (data: string): void => {
    pushed += data.length
    // Fast path: a small write while fully idle is almost always a typed character being echoed
    // back — write it now so it appears instantly. The `!scheduled && queue empty` guard
    // preserves ordering: once a burst is in flight, small writes fall through to the queue and
    // flush in order behind it.
    if (!scheduled && queue.length === 0 && data.length <= SMALL_WRITE_BYPASS) {
      try {
        writeFn(data)
        handed += data.length
        return
      } catch (error) {
        // The writer refused a typed echo. Keep it, as a flush would: the caller is the IPC data
        // handler and has nothing to do with it.
        failures = 1
        notify(error, { attempt: 1, dropped: false, chars: data.length })
        queue.push(data)
        retry()
        return
      }
    }
    queue.push(data)
    if (!scheduled) schedule()
  }

  const whenDrained = (cb: () => void, maxWaitMs: number): (() => void) => {
    const target = pushed
    if (handed >= target) {
      cb()
      return () => undefined
    }
    const w: Waiter = { target, cb, timer: undefined }
    w.timer = setTimeout(() => runWaiter(w), Math.max(0, maxWaitMs || 0))
    waiters.push(w)
    return () => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      clearTimeout(w.timer)
    }
  }

  return Object.assign(write, { pending: (): number => queue.length, whenDrained })
}
