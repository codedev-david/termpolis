// trailingThrottle.ts
//
// At most one call per interval, and never a dropped LAST call.
//
// WHY: a leading-edge-only throttle — "run if 500 ms have passed, otherwise skip" — loses
// whatever arrives inside the window for good when nothing arrives after it. That is
// exactly how a shell prompt ends a burst of output: it is the last thing an idle shell
// prints. Under ConPTY, Enter's echo reaches the renderer alone first (the pty was idle,
// so main's coalescer sends it on its leading edge), the prompt follows ~30 ms later in
// the next message, and the parse that ran on the bare echo had already spent the window.
// So the prompt after every Enter was skipped, and the git mark never followed a `cd`.
//
// So a request inside the window is not dropped but deferred: exactly one run is
// scheduled for the moment the window ends, and it sees everything that arrived up to
// then. The first request after an idle interval still runs synchronously, so a lone
// prompt is handled with no delay at all.
//
// PURE by construction, like ptyCoalescer: the clock is injected, so the whole thing is
// unit-tested with a fake clock and no real waiting.

export interface ThrottleClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface TrailingThrottle {
  /** Run now if the interval has passed and nothing is pending; otherwise make sure exactly
   *  one run is scheduled for when the interval ends. */
  request: () => void
  /** Drop the scheduled run, if there is one. Call on unmount. */
  cancel: () => void
}

// The globals are looked up at CALL time, not captured here. A test that installs fake
// timers after this module was imported (vi.useFakeTimers in a beforeEach) must still be
// the clock this throttle runs on; a captured reference would escape it.
const globalClock: ThrottleClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createTrailingThrottle(
  fn: () => void,
  intervalMs: number,
  clock: ThrottleClock = globalClock,
): TrailingThrottle {
  let last = -Infinity
  let timer: unknown = null
  let scheduled = false

  function run(): void {
    // Bookkeeping first, so a throwing fn cannot leave the throttle believing a run is
    // still scheduled — it would then never run again.
    scheduled = false
    timer = null
    last = clock.now()
    fn()
  }

  function request(): void {
    if (scheduled) return
    const sinceLast = clock.now() - last
    if (sinceLast >= intervalMs) {
      run()
      return
    }
    scheduled = true
    timer = clock.setTimer(run, intervalMs - sinceLast)
  }

  function cancel(): void {
    if (!scheduled) return
    clock.clearTimer(timer)
    scheduled = false
    timer = null
  }

  return { request, cancel }
}
