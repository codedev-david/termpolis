// echoTrace.ts -- the renderer half of the echo trace (1.54.5, plan package P0).
//
// WHY: when typing lags, the main process cannot see the queue that matters most. A keystroke's echo
// has to get through the output throttle and then xterm's own write buffer, and any output queued
// ahead of it (an agent streaming, a build) delays it by exactly that much. Neither queue is visible
// from main. This module reads both, for 1 printable key in 10, together with the long tasks and frame
// gaps that say whether the renderer's own thread was the one stuck.
//
// WHAT IT RECORDS (numbers only: no key, no terminal id, no path; it stays in this process and the app
// log; nothing is sent anywhere):
//   * echoAhead: xterm's pending chars + the throttle's + whatever a held selection is sitting on,
//     read inside the key handler for 1 printable key in 10 (the 10th, 20th, ...). Over 64 KB is the
//     amplifier that turns a short stall into a multi-second lag;
//   * echoRtt: that key's time to the next output for its pane (a lower bound: output already in
//     flight answers it early; an echo that never comes, a password prompt, is dropped after 5 s);
//   * charsQueuedAtResize: the same queue, read when a fit is about to reflow the pane. Bytes drawn for
//     the old size are parsed at the new one, which is how a resize garbles the bottom of the screen;
//   * per pane, every 5 s: xterm's pending chars, the throttle's, chars received, handed to xterm and
//     parsed in the window;
//   * long tasks (count, total, max), frame gaps over 100 ms, and the JS heap.
// The one stamp that leaves this module is the sampled key's wall-clock time, as an optional third
// argument of writeToTerminal. Main turns it into T1 (key handler to main). Every other write reaches
// the preload with exactly the two arguments it always had.
//
// WHAT IT MUST NEVER BE: expensive, or a reason typing is slower. Every per-event hook is a few
// additions and one Map-free field read; the only timer is ONE 5 s interval, alive only while a pane
// is mounted; the frame probe is NOT a standing requestAnimationFrame loop (that would wake an idle
// renderer 60 times a second): it runs for 2 s after a sampled key and ends by itself. Nothing reacts
// to what it reads. A throwing probe reads as 0, a throwing hook leaves the write exactly as it was.
//
// KILL SWITCH: localStorage 'termpolis.echoTrace' = '0'. Switched off, attach() returns a pane whose
// write() is the plain two-argument call, whose tap() returns the function it was given, and which
// owns no timer and no observer: today's behaviour. (Main's half has its own: TERMPOLIS_TYPING_TRACE.)

export const SAMPLE_EVERY_KEYS = 10

const WINDOW_MS = 5_000
const MINUTE_TICKS = 12
const RING_WINDOWS = 12
const FRAME_GAP_MS = 100
/** A gap this long is a window coming back from hidden, not a slow frame. */
const FRAME_GAP_CAP_MS = 5_000
const FRAME_PROBE_MS = 2_000
const RTT_EXPIRE_MS = 5_000
/** A minute with a queue this deep is worth a line even when nobody typed. */
const QUEUE_LOG_CHARS = 4_096
const OVER_64K = 65_536
const SWITCH_KEY = 'termpolis.echoTrace'

/** A typed character: one code point, not a control, not part of an escape sequence, not a paste. */
export function isPrintableKey(data: string): boolean {
  const n = data.length
  if (n === 0 || n > 2) return false
  const c = data.charCodeAt(0)
  if (n === 2) {
    const d = data.charCodeAt(1)
    return c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff // one astral character (an emoji)
  }
  return c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f) && !(c >= 0xd800 && c <= 0xdfff) // a lone surrogate is half of something
}

/**
 * Chars sitting in xterm's own write buffer, ahead of whatever is written next. xterm keeps the count
 * in a private field: no public API says how far behind the parser is. Anything that does not look
 * like the real thing reads as null, never as 0: unknown is not an empty queue. The test suite parses
 * a write with the installed xterm and reads this back, so an upgrade that moves it fails loudly.
 */
export function readXtermPending(term: unknown): number | null {
  try {
    const n = (term as { _core?: { _writeBuffer?: { _pendingData?: unknown } } } | null | undefined)?._core?._writeBuffer?._pendingData
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export interface EchoPaneProbes {
  /** Chars buffered in the output throttle, not yet handed to xterm. */
  throttle?: () => number
  /** Chars held back while a selection is active: the echo waits behind them. */
  held?: () => number
}

export interface EchoPane {
  /** The keystroke path. Forwards the write; 1 printable key in 10 carries the wall-clock stamp. */
  write(data: string): void
  /** Wraps the function that hands a flushed chunk to xterm, counting the chars it hands over. */
  tap(fn: (data: string) => void): (data: string) => void
  /** A terminal:data message for this pane arrived. */
  received(chars: number): void
  /** A fit is about to reflow this pane: read what is still queued. */
  resize(): void
  detach(): void
}

interface ObserverLike {
  observe(o: { entryTypes?: string[] }): void
  disconnect(): void
}
type ObserverCtor = new (cb: (list: { getEntries: () => Array<{ duration: number }> }) => void) => ObserverLike

export interface EchoTraceDeps {
  enabled?: () => boolean
  /** Monotonic ms. */
  now?: () => number
  /** Epoch ms: what a stamp carries. */
  wallNow?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  raf?: (fn: () => void) => unknown
  PerformanceObserverCtor?: ObserverCtor | undefined
  heapUsed?: () => number | null
  writeToTerminal?: (id: string, data: string, t?: number) => void
  log?: (line: string) => void
}

export interface EchoTerminalRow {
  xtermPending: number | null
  throttle: number
  held: number
  received: number
  handed: number
  parsed: number | null
}

export interface EchoWindow {
  longTasks: { count: number; totalMs: number; maxMs: number }
  frameGaps: { count: number; maxMs: number }
  heapUsedMB: number | null
  keys: number
  sampled: number
  echoAhead: { n: number; max: number; avg: number; over64k: number }
  echoRtt: { n: number; avg: number; max: number }
  resizes: { n: number; maxQueued: number; lastQueued: number }
  terminals: EchoTerminalRow[]
}

export interface EchoMinute {
  windows: number
  keys: number
  sampled: number
  longTasks: number
  longTaskMs: number
  maxLongTaskMs: number
  frameGaps: number
  maxFrameGapMs: number
  maxQueued: number
  received: number
  parsed: number
  echoAheadMax: number
  echoAheadOver64k: number
  rttMax: number
  resizes: number
  maxQueuedAtResize: number
  /** JS heap of the newest window, or null when the browser does not say. */
  heapUsedMB: number | null
}

export interface EchoTraceSnapshot {
  enabled: boolean
  panes: number
  last: EchoWindow | null
  minute: EchoMinute | null
}

export interface EchoTrace {
  attach(id: string, term: unknown, probes?: EchoPaneProbes): EchoPane
  snapshot(): EchoTraceSnapshot
}

interface PaneState {
  term: unknown
  probes: EchoPaneProbes
  received: number
  receivedPrev: number
  handed: number
  handedPrev: number
  pendingPrev: number
  /** Monotonic time of the sampled key still waiting for its echo. */
  pendingEcho: number | null
  /** Printable keys typed into this pane: every 10th is sampled. Per pane, so a fresh pane (or a
   *  test that types four characters) never sees a stamp. */
  keys: number
}

interface Acc { n: number; sum: number; max: number }
const newAcc = (): Acc => ({ n: 0, sum: 0, max: 0 })
const addAcc = (a: Acc, v: number): void => { a.n++; a.sum += v; if (v > a.max) a.max = v }
const round1 = (x: number): number => Math.round(x * 10) / 10
const toMB = (bytes: number): number => Math.round(bytes / 1_048_576)

function probeValue(read: (() => number) | undefined): number {
  if (read === undefined) return 0
  try {
    const v = read()
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

// The real timers are taken once, at load, so a test that installs fake timers later cannot turn this
// module's interval into a runaway. Tests inject their own through EchoTraceDeps.
const nativeSetInterval = globalThis.setInterval.bind(globalThis)
const nativeClearInterval = globalThis.clearInterval.bind(globalThis)

function defaultEnabled(): boolean {
  try { return window.localStorage.getItem(SWITCH_KEY) !== '0' } catch { return true }
}

function defaultHeapUsed(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize?: unknown } }).memory
  return m !== undefined && typeof m.usedJSHeapSize === 'number' ? m.usedJSHeapSize : null
}

export function createEchoTrace(deps: EchoTraceDeps = {}): EchoTrace {
  const isEnabled = deps.enabled ?? defaultEnabled
  const now = deps.now ?? ((): number => performance.now())
  const wallNow = deps.wallNow ?? ((): number => Date.now())
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number): unknown => nativeSetInterval(fn, ms))
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown): void => nativeClearInterval(h as ReturnType<typeof setInterval>))
  const rafFn = deps.raf ?? ((fn: () => void): unknown => window.requestAnimationFrame(fn))
  const heapUsed = deps.heapUsed ?? defaultHeapUsed
  const writeTo = deps.writeToTerminal ?? ((id: string, data: string, t?: number): void => {
    if (t === undefined) window.termpolis.writeToTerminal(id, data)
    else window.termpolis.writeToTerminal(id, data, t)
  })
  const log = deps.log ?? ((line: string): void => { console.info(line) })

  const panes = new Set<PaneState>()
  const ring: EchoWindow[] = []
  let last: EchoWindow | null = null
  let timer: unknown = null
  let observer: ObserverLike | null = null
  let tick = 0

  let frameRunning = false
  let frameUntil = 0
  let frameLast = 0

  // The window being filled.
  let win = newWindow()
  function newWindow() {
    return { longCount: 0, longTotal: 0, longMax: 0, gapCount: 0, gapMax: 0, keys: 0, sampled: 0, ahead: newAcc(), ahead64: 0, rtt: newAcc(), resizeN: 0, resizeMax: 0, resizeLast: 0 }
  }

  /** Chars queued ahead of the next write for this pane. */
  function queuedChars(pane: PaneState): number {
    return (readXtermPending(pane.term) ?? 0) + probeValue(pane.probes.throttle) + probeValue(pane.probes.held)
  }

  function armFrameProbe(): void {
    const t = now()
    frameUntil = t + FRAME_PROBE_MS
    if (frameRunning) return
    frameRunning = true
    frameLast = t
    const step = (): void => {
      try {
        const at = now()
        const gap = at - frameLast
        frameLast = at
        if (gap > FRAME_GAP_MS && gap < FRAME_GAP_CAP_MS) {
          win.gapCount++
          if (gap > win.gapMax) win.gapMax = gap
        }
        if (at < frameUntil) { rafFn(step); return }
      } catch { /* the probe ends here */ }
      frameRunning = false
    }
    try { rafFn(step) } catch { frameRunning = false }
  }

  /** The stamp for this key, or undefined when it is not the one in ten. */
  function sampleKey(pane: PaneState, data: string): number | undefined {
    if (!isPrintableKey(data)) return undefined
    win.keys++
    pane.keys++
    if (pane.keys % SAMPLE_EVERY_KEYS !== 0) return undefined
    win.sampled++
    const queued = queuedChars(pane)
    addAcc(win.ahead, queued)
    if (queued > OVER_64K) win.ahead64++
    pane.pendingEcho = now()
    const stamp = wallNow()
    try { armFrameProbe() } catch { /* the stamp matters more than the frame probe */ }
    return stamp
  }

  function terminalRow(pane: PaneState): EchoTerminalRow {
    const xtermPending = readXtermPending(pane.term)
    const received = pane.received - pane.receivedPrev
    const handed = pane.handed - pane.handedPrev
    pane.receivedPrev = pane.received
    pane.handedPrev = pane.handed
    let parsed: number | null = null
    if (xtermPending !== null) {
      parsed = Math.max(0, handed - (xtermPending - pane.pendingPrev))
      pane.pendingPrev = xtermPending
    }
    return { xtermPending, throttle: probeValue(pane.probes.throttle), held: probeValue(pane.probes.held), received, handed, parsed }
  }

  function closeWindow(): void {
    const terminals: EchoTerminalRow[] = []
    for (const pane of panes) {
      try { terminals.push(terminalRow(pane)) } catch { /* one pane's probe never costs the others */ }
    }
    let heapUsedMB: number | null = null
    try {
      const bytes = heapUsed()
      heapUsedMB = bytes === null ? null : toMB(bytes)
    } catch { heapUsedMB = null }
    const w = win
    const done: EchoWindow = {
      longTasks: { count: w.longCount, totalMs: round1(w.longTotal), maxMs: round1(w.longMax) },
      frameGaps: { count: w.gapCount, maxMs: round1(w.gapMax) },
      heapUsedMB,
      keys: w.keys,
      sampled: w.sampled,
      echoAhead: { n: w.ahead.n, max: w.ahead.max, avg: w.ahead.n === 0 ? 0 : Math.round(w.ahead.sum / w.ahead.n), over64k: w.ahead64 },
      echoRtt: { n: w.rtt.n, avg: w.rtt.n === 0 ? 0 : round1(w.rtt.sum / w.rtt.n), max: round1(w.rtt.max) },
      resizes: { n: w.resizeN, maxQueued: w.resizeMax, lastQueued: w.resizeLast },
      terminals,
    }
    ring.push(done)
    if (ring.length > RING_WINDOWS) ring.shift()
    last = done
    win = newWindow()
  }

  /** The ring folded into one record. An empty ring folds to zeros. */
  function aggregate(): EchoMinute {
    const m: EchoMinute = {
      windows: ring.length, keys: 0, sampled: 0, longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0, frameGaps: 0, maxFrameGapMs: 0,
      maxQueued: 0, received: 0, parsed: 0, echoAheadMax: 0, echoAheadOver64k: 0, rttMax: 0, resizes: 0, maxQueuedAtResize: 0,
      heapUsedMB: null,
    }
    for (const w of ring) {
      m.heapUsedMB = w.heapUsedMB // the newest window wins
      m.keys += w.keys
      m.sampled += w.sampled
      m.longTasks += w.longTasks.count
      m.longTaskMs += w.longTasks.totalMs
      m.maxLongTaskMs = Math.max(m.maxLongTaskMs, w.longTasks.maxMs)
      m.frameGaps += w.frameGaps.count
      m.maxFrameGapMs = Math.max(m.maxFrameGapMs, w.frameGaps.maxMs)
      m.echoAheadMax = Math.max(m.echoAheadMax, w.echoAhead.max)
      m.echoAheadOver64k += w.echoAhead.over64k
      m.rttMax = Math.max(m.rttMax, w.echoRtt.max)
      m.resizes += w.resizes.n
      m.maxQueuedAtResize = Math.max(m.maxQueuedAtResize, w.resizes.maxQueued)
      for (const t of w.terminals) {
        m.received += t.received
        m.parsed += t.parsed ?? 0
        m.maxQueued = Math.max(m.maxQueued, (t.xtermPending ?? 0) + t.throttle + t.held)
      }
    }
    m.longTaskMs = round1(m.longTaskMs)
    return m
  }

  function minute(): EchoMinute | null {
    return ring.length === 0 ? null : aggregate()
  }

  function logMinute(): void {
    const m = aggregate()
    const active = m.keys > 0 || m.longTasks > 0 || m.resizes > 0 || m.frameGaps > 0 || m.maxQueued >= QUEUE_LOG_CHARS
    if (!active) return // an idle minute stays out of the app log
    const heap = m.heapUsedMB !== null ? ` | heap=${m.heapUsedMB}MB` : ''
    log(
      `[echo-trace] 60s keys=${m.keys} sampled=${m.sampled}` +
      ` | ahead max=${m.echoAheadMax} over64k=${m.echoAheadOver64k}` +
      ` | rtt max=${m.rttMax}ms` +
      ` | resize n=${m.resizes} queued=${m.maxQueuedAtResize}` +
      ` | longtask n=${m.longTasks} ms=${m.longTaskMs} max=${m.maxLongTaskMs}ms` +
      ` | frame gaps=${m.frameGaps} max=${m.maxFrameGapMs}ms` +
      ` | panes=${panes.size} queue max=${m.maxQueued} recv=${m.received} parsed=${m.parsed}` +
      heap,
    )
  }

  function onTick(): void {
    tick++
    try { closeWindow() } catch { /* the window is lost; the next one starts clean */ win = newWindow() }
    if (tick % MINUTE_TICKS === 0) { try { logMinute() } catch { /* the log sink is not ours to fix */ } }
  }

  function startObserver(): void {
    const Ctor = 'PerformanceObserverCtor' in deps
      ? deps.PerformanceObserverCtor
      : (typeof PerformanceObserver === 'undefined' ? undefined : (PerformanceObserver as unknown as ObserverCtor))
    if (Ctor === undefined) return
    try {
      const o = new Ctor((list) => {
        for (const e of list.getEntries()) {
          win.longCount++
          win.longTotal += e.duration
          if (e.duration > win.longMax) win.longMax = e.duration
        }
      })
      observer = o
      o.observe({ entryTypes: ['longtask'] })
    } catch { /* long tasks are not observable here; the rest still works */ }
  }

  function ensureRunning(): void {
    if (timer !== null) return
    tick = 0
    timer = setIntervalFn(onTick, WINDOW_MS)
    startObserver()
  }

  function stopRunning(): void {
    if (timer !== null) { try { clearIntervalFn(timer) } catch { /* already gone */ } timer = null }
    try { observer?.disconnect() } catch { /* already disconnected */ }
    observer = null
  }

  function attach(id: string, term: unknown, probes: EchoPaneProbes = {}): EchoPane {
    if (!isEnabled()) {
      return {
        write: (data) => { writeTo(id, data) },
        tap: (fn) => fn,
        received: () => undefined,
        resize: () => undefined,
        detach: () => undefined,
      }
    }
    const pane: PaneState = { term, probes, received: 0, receivedPrev: 0, handed: 0, handedPrev: 0, pendingPrev: readXtermPending(term) ?? 0, pendingEcho: null, keys: 0 }
    panes.add(pane)
    ensureRunning()
    return {
      write: (data) => {
        let stamp: number | undefined
        try { stamp = sampleKey(pane, data) } catch { stamp = undefined }
        if (stamp === undefined) writeTo(id, data)
        else writeTo(id, data, stamp)
      },
      tap: (fn) => (data) => {
        pane.handed += data.length
        fn(data)
      },
      received: (chars) => {
        try {
          pane.received += chars
          if (pane.pendingEcho !== null) {
            const d = now() - pane.pendingEcho
            pane.pendingEcho = null
            if (d <= RTT_EXPIRE_MS) addAcc(win.rtt, d)
          }
        } catch { /* a counter is never worth an exception in the data path */ }
      },
      resize: () => {
        try {
          const q = queuedChars(pane)
          win.resizeN++
          win.resizeLast = q
          if (q > win.resizeMax) win.resizeMax = q
        } catch { /* the fit goes ahead regardless */ }
      },
      detach: () => {
        if (!panes.delete(pane)) return
        if (panes.size === 0) stopRunning()
      },
    }
  }

  return {
    attach,
    snapshot: (): EchoTraceSnapshot => ({ enabled: isEnabled(), panes: panes.size, last, minute: minute() }),
  }
}

// The shared instance TerminalPane calls.
const shared = createEchoTrace()

export const echoTraceAttach = (id: string, term: unknown, probes?: EchoPaneProbes): EchoPane => shared.attach(id, term, probes)
export const getEchoTraceSnapshot = (): EchoTraceSnapshot => shared.snapshot()
