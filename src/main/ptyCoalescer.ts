// ptyCoalescer.ts
//
// Batches PTY output before it crosses into the renderer.
//
// WHY: node-pty delivers output in whatever pieces the OS hands it — during a build or
// an agent's TUI redraw that is thousands of small chunks per second, and each one used
// to become its own `webContents.send`. Every crossing pays a structured clone and a
// process hop, and — worse — every crossing runs the renderer's whole per-chunk handler
// again: a rolling-buffer slice, a diff regex and two global ANSI strips over a 4 KB
// window (~7 us of pure recomputation, measured). Both costs scale with the number of
// MESSAGES, not the number of bytes, so the cheapest fix is to send fewer messages.
//
// WHY LEADING-EDGE: a plain interval would add latency to the one case where latency is
// the whole product — the echo of a keystroke. So the first chunk after an idle period
// is emitted SYNCHRONOUSLY and starts the window; only chunks that arrive while output
// is already flowing are batched. Typing stays instant; a firehose collapses to one
// message per window.
//
// PURE by construction: timers are injected, so the whole thing is unit-tested with fake
// clocks and no PTY, no Electron and no real waiting.

/** One frame at 60 Hz is 16.7 ms. Half a frame means a coalesced batch still lands in
 *  the frame the renderer would have painted anyway — invisible, but it divides the
 *  message count by however many chunks the OS produced in those 8 ms. */
export const DEFAULT_WINDOW_MS = 8

/** Hard bound on how much is held back. A single 64 KB message is already far past the
 *  point where per-message overhead matters, and holding more just delays output and
 *  grows a string nobody is reading yet. */
export const DEFAULT_MAX_PENDING_CHARS = 65_536

export interface CoalescerOptions {
  windowMs?: number
  maxPendingChars?: number
  /** Injected for tests. Defaults to the global timer functions. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface OutputCoalescer {
  /** Feed one PTY chunk. May emit synchronously (idle) or buffer it (flowing). */
  push: (data: string) => void
  /** Emit anything held back right now. Safe to call when nothing is pending. */
  flush: () => void
  /** Flush and stop the window. Call on exit/kill so trailing output is not lost. */
  dispose: () => void
}

export function createOutputCoalescer(
  emit: (data: string) => void,
  options: CoalescerOptions = {},
): OutputCoalescer {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxPendingChars = options.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))

  const pending: string[] = []
  let pendingChars = 0
  let timer: unknown = null
  let disposed = false

  /** Emit what is held back, if anything. Does NOT touch the timer — the two callers
   *  want opposite things from it. */
  function drain(): void {
    if (pendingChars === 0) return
    const batch = pending.length === 1 ? pending[0] : pending.join('')
    pending.length = 0
    pendingChars = 0
    emit(batch)
  }

  /** The window closed. If output kept arriving, emit it and open another window —
   *  a sustained stream therefore emits once per window rather than once per chunk.
   *  If nothing arrived, go idle so the NEXT chunk is emitted with no delay at all. */
  function onWindowEnd(): void {
    timer = null
    if (pendingChars === 0) return
    drain()
    timer = setTimer(onWindowEnd, windowMs)
  }

  function flush(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    drain()
  }

  function push(data: string): void {
    if (data === '' || disposed) return
    if (timer === null) {
      // Idle: nothing is waiting on a timer, so this chunk goes straight out. This is
      // the keystroke-echo path and it must not be delayed by even one window.
      emit(data)
      timer = setTimer(onWindowEnd, windowMs)
      return
    }
    pending.push(data)
    pendingChars += data.length
    // A burst big enough to matter should not sit waiting for a window that exists to
    // amortise per-message overhead it has already amortised.
    if (pendingChars >= maxPendingChars) flush()
  }

  function dispose(): void {
    flush()
    disposed = true
  }

  return { push, flush, dispose }
}
