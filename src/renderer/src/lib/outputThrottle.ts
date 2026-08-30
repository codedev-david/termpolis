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

export function createOutputThrottle(writeFn: (data: string) => void) {
  let buffer = ''
  let scheduled = false
  let rafId: number | null = null
  let timerId: ReturnType<typeof setTimeout> | undefined

  /** Arm both clocks; whichever fires first cancels the other. */
  function schedule() {
    scheduled = true
    rafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(onTick) : null
    timerId = setTimeout(onTick, WATCHDOG_MS)
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

  function flush() {
    if (buffer.length <= MAX_FLUSH_SIZE) {
      const out = buffer
      buffer = ''
      writeFn(out)
    } else {
      // Write up to 64KB, defer the rest — re-armed on BOTH clocks so a large backlog keeps
      // draining even with no frames, instead of stalling after the first chunk.
      writeFn(buffer.slice(0, MAX_FLUSH_SIZE))
      buffer = buffer.slice(MAX_FLUSH_SIZE)
      schedule()
    }
  }

  return (data: string) => {
    // Fast path: a small write while fully idle is almost always a typed character being echoed
    // back — write it now so it appears instantly. The `!scheduled && buffer.length === 0` guard
    // preserves ordering: once a burst is in flight, small writes fall through to the buffer and
    // flush in order behind it.
    if (!scheduled && buffer.length === 0 && data.length <= SMALL_WRITE_BYPASS) {
      writeFn(data)
      return
    }
    buffer += data
    if (!scheduled) schedule()
  }
}
