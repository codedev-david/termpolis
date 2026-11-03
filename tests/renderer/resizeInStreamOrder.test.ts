import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { resizeInStreamOrder, RESIZE_DRAIN_CAP_MS, type StreamOrderDeps } from '../../src/renderer/src/lib/resizeInStreamOrder'
import { createOutputThrottle } from '../../src/renderer/src/lib/outputThrottle'
import { readXtermPending } from '../../src/renderer/src/lib/xtermPending'

// Resizing in stream order (1.54.5, plan package P3).
//
// THE BUG: doFit ran fitAddon.fit() (xterm resizes at once) and then told the pty. Whatever sat in the
// output throttle, the selection hold or xterm's own write queue had been drawn for the OLD size, and
// was parsed at the NEW one. On ConPTY the viewport heals when conhost repaints (it does so on every
// resize, even to the same size); the scrollback does not, and a TUI that moves the cursor by relative
// steps keeps the ghost rows. THE FIX: flush the hold, wait for the throttle to hand everything on,
// queue an empty write behind xterm's queue and resize in ITS callback.
//
// Every claim below is a COUNTER measured on a real xterm (@xterm/headless 5.5.0, the same parser and
// WriteBuffer the renderer runs): frames parsed at the wrong geometry, rows that differ from what the
// stream means. Each is paired with a NEGATIVE CONTROL that resizes first, the 1.54.4 order, and must
// show the damage, or the test would prove nothing.

const WINDOWS_PTY = { backend: 'conpty' as const, buildNumber: 26200 }

type Term = InstanceType<typeof Terminal>

function makeTerm(o: { cols: number; rows: number; windowsPty?: typeof WINDOWS_PTY | null }): Term {
  const { cols, rows, windowsPty = WINDOWS_PTY } = o
  return new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true, ...(windowsPty ? { windowsPty } : {}) })
}
/** term.write, resolved once xterm has PARSED the data. */
const write = (t: Term, data: string): Promise<void> => new Promise((resolve) => t.write(data, resolve))
const settle = (t: Term): Promise<void> => write(t, '')

function viewport(t: Term): string[] {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '')
  return out
}
function wholeBuffer(t: Term): string[] {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
  return out
}
function diffRows(a: string[], b: string[]): number[] {
  const bad: number[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? '') !== (b[i] ?? '')) bad.push(i)
  return bad
}

// ---- TUI models (from the lens harness, harness-resize/lib.mjs) ---------------------------------

/** ink / log-update style: erase the previous frame with RELATIVE moves, then print the new one. */
class InkLikeTui {
  prevLineCount = 0
  static eraseLines(n: number): string {
    let s = ''
    for (let i = 0; i < n; i++) s += '\x1b[2K' + (i < n - 1 ? '\x1b[1A' : '')
    return s + '\x1b[G'
  }
  paint(lines: string[]): string {
    const out = (this.prevLineCount ? InkLikeTui.eraseLines(this.prevLineCount) : '') + lines.join('\r\n') + '\r\n'
    this.prevLineCount = lines.length + 1
    return out
  }
}
function agentFrame(cols: number, step: number, transcriptRows = 6): string[] {
  const w = Math.max(10, cols - 1)
  const fill = (s: string): string => (s + ' ' + '.'.repeat(w)).slice(0, w)
  const n = String(step).padStart(3, '0')
  const lines: string[] = []
  for (let i = 0; i < transcriptRows; i++) lines.push(fill(`step${n} transcript row ${i}`))
  lines.push('-'.repeat(w), fill(`> prompt step${n}`), '-'.repeat(w), fill(`footer step${n} cols=${cols}`))
  return lines
}
function absoluteRepaint(cols: number, rows: number, step: number): string {
  const w = Math.max(10, cols - 1)
  const n = String(step).padStart(3, '0')
  let s = '\x1b[H'
  for (let r = 1; r <= rows; r++) {
    const text = r === rows ? `footer step${n} ${cols}x${rows}` : `row ${String(r).padStart(2, '0')} step${n} `.padEnd(w, '#')
    s += `\x1b[${r};1H\x1b[2K${text.slice(0, w)}`
  }
  return s
}
function history(lines: number, cols: number): string {
  let s = ''
  for (let i = 0; i < lines; i++) s += `history line ${String(i).padStart(4, '0')} `.padEnd(Math.max(10, cols - 1), '=') + '\r\n'
  return s
}
/** conhost's repaint after a resize: home, every viewport row as text + EL + CRLF, the cursor put back absolutely. */
function conhostRepaint(model: Term): string {
  const b = model.buffer.active
  let s = '\x1b[?25l\x1b[H'
  for (let y = 0; y < model.rows; y++) s += (b.getLine(b.baseY + y)?.translateToString(true) ?? '') + '\x1b[K' + (y < model.rows - 1 ? '\r\n' : '')
  return s + `\x1b[${b.cursorY + 1};${b.cursorX + 1}H\x1b[?25h`
}

/** Frames and timers on the real clock, fast: the throttle's rAF becomes a 0 ms timer. */
function useFastFrames(): void {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
}

// =============================================================================================
// 1. The helper itself: the order of calls, exactly once, never stuck, never throwing into xterm
// =============================================================================================

describe('resizeInStreamOrder: the order of calls', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  type Rig = {
    calls: string[]
    deps: StreamOrderDeps
    drain: { cb?: () => void; max?: number; cancelled: boolean }
    xterm: { cb?: () => void; writes: string[] }
    state: { throttlePending: number; xtermPending: number | null }
  }
  function rig(over: Partial<StreamOrderDeps> = {}): Rig {
    const calls: string[] = []
    const drain: Rig['drain'] = { cancelled: false }
    const xterm: Rig['xterm'] = { writes: [] }
    const state: Rig['state'] = { throttlePending: 0, xtermPending: 0 }
    const deps: StreamOrderDeps = {
      flushHold: () => { calls.push('flushHold') },
      throttle: {
        pending: () => state.throttlePending,
        whenDrained: (cb, max) => {
          calls.push('whenDrained')
          drain.cb = cb
          drain.max = max
          return () => { drain.cancelled = true }
        },
      },
      term: { write: (data, cb) => { calls.push('term.write'); xterm.writes.push(data); xterm.cb = cb } },
      xtermPending: () => state.xtermPending,
      apply: () => { calls.push('apply') },
      onError: () => { calls.push('onError') },
      ...over,
    }
    return { calls, deps, drain, xterm, state }
  }

  it('idle: nothing is queued anywhere, so it resizes at once: no wait, no timer, no write (today\'s timing)', () => {
    const r = rig()
    const h = resizeInStreamOrder(r.deps)
    expect(r.calls).toEqual(['flushHold', 'apply'])
    expect(vi.getTimerCount()).toBe(0)
    expect(h.settled).toBe(true)
  })

  it('a backlog in the throttle: flush the hold FIRST, then wait on the throttle, then apply', () => {
    const r = rig()
    r.state.throttlePending = 200_000
    resizeInStreamOrder(r.deps)
    expect(r.calls).toEqual(['flushHold', 'whenDrained'])
    expect(r.drain.max).toBe(RESIZE_DRAIN_CAP_MS)
    r.drain.cb!() // the throttle has handed everything on; xterm has nothing pending
    expect(r.calls).toEqual(['flushHold', 'whenDrained', 'apply'])
  })

  it('output in xterm\'s own queue: an empty write goes in behind it and the resize runs in ITS callback', () => {
    const r = rig()
    r.state.xtermPending = 5_000
    resizeInStreamOrder(r.deps)
    expect(r.calls).toEqual(['flushHold', 'term.write'])
    expect(r.xterm.writes).toEqual(['']) // an empty write: it draws nothing, it only marks a place in the queue
    r.xterm.cb!()
    expect(r.calls).toEqual(['flushHold', 'term.write', 'apply'])
  })

  it('both: throttle first, then xterm, then apply', () => {
    const r = rig()
    r.state.throttlePending = 100_000
    r.state.xtermPending = 60_000
    resizeInStreamOrder(r.deps)
    r.drain.cb!()
    expect(r.calls).toEqual(['flushHold', 'whenDrained', 'term.write'])
    r.xterm.cb!()
    expect(r.calls).toEqual(['flushHold', 'whenDrained', 'term.write', 'apply'])
  })

  it('looks at xterm\'s queue only after the throttle has drained (the throttle feeds it)', () => {
    const r = rig()
    r.state.throttlePending = 100_000
    r.state.xtermPending = 0
    resizeInStreamOrder(r.deps)
    r.state.xtermPending = 64_000 // the throttle's last flushes landed in xterm's queue while we waited
    r.drain.cb!()
    expect(r.calls).toContain('term.write')
    expect(r.calls).not.toContain('apply')
  })

  it('does not know how deep xterm\'s queue is (null): it does not wait on a queue it cannot see', () => {
    const r = rig()
    r.state.xtermPending = null
    resizeInStreamOrder(r.deps)
    expect(r.calls).toEqual(['flushHold', 'apply'])
  })

  it('a throttle with no drain hook (a test double, an older throttle) is not waited on', () => {
    const r = rig({ throttle: { pending: () => 500_000 } })
    resizeInStreamOrder(r.deps)
    expect(r.calls).toEqual(['flushHold', 'apply'])
    const bare = rig({ throttle: undefined })
    resizeInStreamOrder(bare.deps)
    expect(bare.calls).toEqual(['flushHold', 'apply'])
  })

  it('a throttle that does not say what it holds counts as empty', () => {
    const r = rig({ throttle: { whenDrained: () => () => undefined } })
    resizeInStreamOrder(r.deps)
    expect(r.calls).toEqual(['flushHold', 'apply'])
  })

  it('reads the queue with the installed reader when none is injected', () => {
    const calls: string[] = []
    const fake = { _core: { _writeBuffer: { _pendingData: 10 } }, write: (_d: string, cb?: () => void) => { calls.push('write'); cb?.() } }
    resizeInStreamOrder({ flushHold: () => undefined, term: fake, apply: () => { calls.push('apply') } })
    expect(calls).toEqual(['write', 'apply'])
    const idle = { _core: { _writeBuffer: { _pendingData: 0 } }, write: () => { calls.push('never') } }
    resizeInStreamOrder({ flushHold: () => undefined, term: idle, apply: () => { calls.push('apply2') } })
    expect(calls).toEqual(['write', 'apply', 'apply2'])
  })
})

describe('resizeInStreamOrder: exactly once, and never stuck', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function waiting(over: Partial<StreamOrderDeps> = {}) {
    const apply = vi.fn()
    const onError = vi.fn()
    let drainCb: (() => void) | undefined
    const cancelDrain = vi.fn()
    let xtermCb: (() => void) | undefined
    const deps: StreamOrderDeps = {
      flushHold: () => undefined,
      throttle: { pending: () => 1000, whenDrained: (cb) => { drainCb = cb; return cancelDrain } },
      term: { write: (_d, cb) => { xtermCb = cb } },
      xtermPending: () => 1000,
      apply,
      onError,
      ...over,
    }
    return { deps, apply, onError, cancelDrain, drain: () => drainCb?.(), parsed: () => xtermCb?.() }
  }

  it('apply runs once however many times the callbacks fire, and the cap timer is gone once it has', () => {
    const w = waiting()
    resizeInStreamOrder(w.deps)
    w.drain()
    w.parsed()
    w.parsed()
    w.drain()
    vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS * 2)
    expect(w.apply).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    // (the throttle's own callback fired, so there is no wait left to cancel; the cap test below covers the cancel)
  })

  it('the throttle never drains: the resize goes ahead at the cap (today\'s behaviour, a little late)', () => {
    const w = waiting()
    resizeInStreamOrder(w.deps)
    vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS - 1)
    expect(w.apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(w.apply).toHaveBeenCalledTimes(1)
    expect(w.cancelDrain).toHaveBeenCalled()
    w.drain()
    expect(w.apply).toHaveBeenCalledTimes(1)
  })

  it('xterm never calls back (a terminal torn down under it): the resize still goes ahead at the cap', () => {
    const w = waiting({ throttle: undefined })
    resizeInStreamOrder(w.deps)
    expect(w.apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS)
    expect(w.apply).toHaveBeenCalledTimes(1)
  })

  it('the cap is measured from the start, not restarted by the second wait', () => {
    const w = waiting()
    resizeInStreamOrder(w.deps)
    vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS - 500)
    w.drain() // the throttle drains late; xterm's wait starts now
    vi.advanceTimersByTime(499)
    expect(w.apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(w.apply).toHaveBeenCalledTimes(1)
  })

  it('honours a cap the caller sets', () => {
    const w = waiting({ capMs: 250 })
    resizeInStreamOrder(w.deps)
    vi.advanceTimersByTime(249)
    expect(w.apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(w.apply).toHaveBeenCalledTimes(1)
  })

  it('cancel stops everything: no apply from the throttle, from xterm or from the cap', () => {
    const w = waiting()
    const h = resizeInStreamOrder(w.deps)
    h.cancel()
    expect(w.cancelDrain).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    w.drain()
    w.parsed()
    vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS * 2)
    expect(w.apply).not.toHaveBeenCalled()
    expect(h.settled).toBe(true)
  })

  it('cancel after the resize has run is harmless', () => {
    const w = waiting({ throttle: undefined, xtermPending: () => 0 })
    const h = resizeInStreamOrder(w.deps)
    expect(w.apply).toHaveBeenCalledTimes(1)
    expect(() => h.cancel()).not.toThrow()
    expect(w.apply).toHaveBeenCalledTimes(1)
  })

  it('xterm refuses the empty write (over its watermark, torn down): apply runs now rather than never', () => {
    const w = waiting({ throttle: undefined, term: { write: () => { throw new Error('write data discarded, use flow control to avoid losing data') } } })
    resizeInStreamOrder(w.deps)
    expect(w.apply).toHaveBeenCalledTimes(1)
    expect(w.onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the throttle refuses the wait: the resize does not hang on it', () => {
    const w = waiting({
      throttle: { pending: () => 10, whenDrained: () => { throw new Error('nope') } },
      xtermPending: () => 0,
    })
    expect(() => resizeInStreamOrder(w.deps)).not.toThrow()
    expect(w.apply).toHaveBeenCalledTimes(1)
  })
})

describe('resizeInStreamOrder: nothing it calls may throw into the caller, or into xterm', () => {
  // xterm's WriteBuffer runs a write callback BEFORE it advances past that chunk. A callback that
  // throws leaves the chunk at the head of the queue and the write loop stopped: the terminal stops
  // painting for good. apply() runs in such a callback, so it must never escape it.
  it('an apply that throws is handed to onError, on every path', () => {
    vi.useFakeTimers()
    try {
      const boom = new Error('fit exploded')
      const paths: Array<[string, (onError: (e: unknown) => void) => void]> = [
        ['at once', (onError) => { resizeInStreamOrder({ flushHold: () => undefined, term: { write: () => undefined }, xtermPending: () => 0, apply: () => { throw boom }, onError }) }],
        ['in xterm\'s callback', (onError) => {
          let cb: (() => void) | undefined
          resizeInStreamOrder({ flushHold: () => undefined, term: { write: (_d, c) => { cb = c } }, xtermPending: () => 9, apply: () => { throw boom }, onError })
          expect(() => cb!()).not.toThrow()
        }],
        ['at the cap', (onError) => {
          resizeInStreamOrder({ flushHold: () => undefined, term: { write: () => undefined }, xtermPending: () => 9, apply: () => { throw boom }, onError })
          expect(() => vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS)).not.toThrow()
        }],
      ]
      for (const [name, run] of paths) {
        const onError = vi.fn()
        expect(() => run(onError), name).not.toThrow()
        expect(onError, name).toHaveBeenCalledWith(boom)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('a flushHold that throws does not stop the resize', () => {
    const onError = vi.fn()
    const apply = vi.fn()
    const boom = new Error('hold release failed')
    resizeInStreamOrder({ flushHold: () => { throw boom }, term: { write: () => undefined }, xtermPending: () => 0, apply, onError })
    expect(onError).toHaveBeenCalledWith(boom)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('with no onError it reports to the console instead of throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      resizeInStreamOrder({ flushHold: () => undefined, term: { write: () => undefined }, xtermPending: () => 0, apply: () => { throw new Error('x') } })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('an onError that throws is swallowed too', () => {
    expect(() => resizeInStreamOrder({
      flushHold: () => undefined, term: { write: () => undefined }, xtermPending: () => 0,
      apply: () => { throw new Error('a') }, onError: () => { throw new Error('b') },
    })).not.toThrow()
  })
})

describe('readXtermPending sees the queue of the installed xterm (the barrier depends on it)', () => {
  // The same private field the echo trace reads. If an xterm upgrade moves it this fails, loudly, here,
  // instead of the barrier silently never waiting.
  it('counts what was written and has not been parsed yet, and is 0 once it has', async () => {
    const t = makeTerm({ cols: 80, rows: 24 })
    expect(readXtermPending(t)).toBe(0)
    t.write('x'.repeat(5000))
    expect(readXtermPending(t)).toBe(5000)
    await settle(t)
    expect(readXtermPending(t)).toBe(0)
    t.dispose()
  })
})

// =============================================================================================
// 2. On a real xterm: bytes drawn for the old size are parsed at the old size
// =============================================================================================

describe('resize in stream order, on a real xterm', () => {
  beforeEach(() => { useFastFrames() })
  afterEach(() => { vi.unstubAllGlobals() })

  const A = { cols: 120, rows: 30 }
  const B = { cols: 90, rows: 30 }

  /** The renderer's path: output goes through the real throttle into term.write. */
  function rendererPath(term: Term) {
    const throttle = createOutputThrottle((d) => term.write(d))
    return throttle
  }

  /** What the pty meant: everything before the resize is parsed first, THEN the grid changes. */
  async function inStreamOrder(model: { before: string[]; to: { cols: number; rows: number }; after: string; windowsPty?: typeof WINDOWS_PTY | null }) {
    const term = makeTerm({ ...A, windowsPty: model.windowsPty })
    for (const b of model.before) await write(term, b)
    term.resize(model.to.cols, model.to.rows)
    await write(term, model.after)
    const out = { vp: viewport(term), all: wholeBuffer(term) }
    term.dispose()
    return out
  }

  /** 1.54.4: queue the output, then fit() at once. */
  async function resizeFirst(model: { before: string[]; to: { cols: number; rows: number }; after: string; windowsPty?: typeof WINDOWS_PTY | null }) {
    const term = makeTerm({ ...A, windowsPty: model.windowsPty })
    const throttle = rendererPath(term)
    for (const b of model.before) throttle(b)
    const queued = (readXtermPending(term) ?? 0) + throttle.pending()
    term.resize(model.to.cols, model.to.rows)
    throttle(model.after)
    while (throttle.pending() > 0) await new Promise((r) => setTimeout(r, 2))
    await settle(term)
    const out = { vp: viewport(term), all: wholeBuffer(term), queued }
    term.dispose()
    return out
  }

  /** 1.54.5: the same, through the barrier. */
  async function inOrder(model: { before: string[]; to: { cols: number; rows: number }; after: string; windowsPty?: typeof WINDOWS_PTY | null }) {
    const term = makeTerm({ ...A, windowsPty: model.windowsPty })
    const throttle = rendererPath(term)
    for (const b of model.before) throttle(b)
    const queued = (readXtermPending(term) ?? 0) + throttle.pending()
    let applied = 0
    await new Promise<void>((resolve) => {
      resizeInStreamOrder({
        flushHold: () => undefined,
        throttle,
        term,
        apply: () => { applied++; term.resize(model.to.cols, model.to.rows); resolve() },
      })
    })
    // The pty has the new size now: what it draws next is drawn for it.
    throttle(model.after)
    while (throttle.pending() > 0) await new Promise((r) => setTimeout(r, 2))
    await settle(term)
    const out = { vp: viewport(term), all: wholeBuffer(term), queued, applied }
    term.dispose()
    return out
  }

  // The harness itself: pushing the bytes through the throttle, or straight into xterm, must make no
  // difference to the screen. If it did, the damage the negative controls below show could be blamed on
  // the harness, not on the order of the resize.
  it('CONTROL: with no change of size, resizing first, in order and in stream order are identical', async () => {
    const tui = new InkLikeTui()
    const S1 = history(80, A.cols) + tui.paint(agentFrame(A.cols, 1))
    const S2 = history(400, A.cols) + tui.paint(agentFrame(A.cols, 2))
    const model = { before: [S1, S2], to: A, after: tui.paint(agentFrame(A.cols, 3)), windowsPty: null }
    const meant = await inStreamOrder(model)
    const old = await resizeFirst(model)
    const fixed = await inOrder(model)
    expect(old.queued).toBeGreaterThan(40_000)
    expect(diffRows(old.vp, meant.vp)).toEqual([])
    expect(diffRows(old.all, meant.all)).toEqual([])
    expect(diffRows(fixed.vp, meant.vp)).toEqual([])
    expect(diffRows(fixed.all, meant.all)).toEqual([])
  })

  // ---- R1a: no pty repaint (Linux/macOS, or an agent that redraws itself), a relative-move TUI, 120 -> 90 ----
  it('R1a: a relative-move TUI narrowed under a backlog ends exactly as the stream meant', async () => {
    const tui = new InkLikeTui()
    const S1 = history(80, A.cols) + tui.paint(agentFrame(A.cols, 1))
    // The backlog the renderer holds when the resize arrives: a big burst (it goes through the throttle) ending in a frame.
    const S2 = history(400, A.cols) + tui.paint(agentFrame(A.cols, 2))
    const redrawAtB = tui.paint(agentFrame(B.cols, 3)) // the app's own redraw after the resize event
    const model = { before: [S1, S2], to: B, after: redrawAtB, windowsPty: null }

    const meant = await inStreamOrder(model)
    const old = await resizeFirst(model)
    const fixed = await inOrder(model)

    expect(old.queued).toBeGreaterThan(40_000) // there really was a backlog when fit() ran
    // NEGATIVE CONTROL: resizing first leaves rows that differ from what the stream meant, in the viewport and the whole buffer
    expect(diffRows(old.vp, meant.vp).length).toBeGreaterThan(0)
    expect(diffRows(old.all, meant.all).length).toBeGreaterThan(0)
    // THE FIX
    expect(fixed.applied).toBe(1)
    expect(diffRows(fixed.vp, meant.vp)).toEqual([])
    expect(diffRows(fixed.all, meant.all)).toEqual([])
  })

  // ---- R1b: ConPTY repaints the viewport after the resize, then the TUI redraws ----
  it('R1b: on ConPTY the viewport heals either way, but only the barrier keeps the SCROLLBACK from being polluted', async () => {
    const tui = new InkLikeTui()
    const S1 = history(80, A.cols) + tui.paint(agentFrame(A.cols, 1))
    const S2 = history(400, A.cols) + tui.paint(agentFrame(A.cols, 2))
    const redrawAtB = tui.paint(agentFrame(B.cols, 3))
    // conhost's own view: it parsed the bytes at the right geometry, then reflowed at the resize.
    const conhost = makeTerm(A)
    await write(conhost, S1 + S2)
    conhost.resize(B.cols, B.rows)
    const after = conhostRepaint(conhost) + redrawAtB
    conhost.dispose()
    const model = { before: [S1, S2], to: B, after }

    const meant = await inStreamOrder(model)
    const old = await resizeFirst(model)
    const fixed = await inOrder(model)

    expect(diffRows(old.vp, meant.vp)).toEqual([]) // the conhost repaint put the viewport right (the lens's finding)
    expect(diffRows(old.all, meant.all).length).toBeGreaterThan(0) // ...the scrollback stayed wrong
    expect(diffRows(fixed.vp, meant.vp)).toEqual([])
    expect(diffRows(fixed.all, meant.all)).toEqual([])
  })

  // ---- R1c: shrinking the height under a queued absolute-addressing frame (Codex / Gemini style) ----
  it('R1c: shrinking the height under a queued full-screen frame does not displace it', async () => {
    const H1 = { cols: 120, rows: 20 }
    const S1 = absoluteRepaint(A.cols, A.rows, 1)
    const S2 = history(300, A.cols) + absoluteRepaint(A.cols, A.rows, 2) // queued when fit() shrinks the grid
    const model = { before: [S1, S2], to: H1, after: '' }
    const meant = await inStreamOrder(model)
    const old = await resizeFirst(model)
    const fixed = await inOrder(model)
    expect(diffRows(old.vp, meant.vp).length).toBeGreaterThan(0) // NEGATIVE CONTROL
    expect(diffRows(fixed.vp, meant.vp)).toEqual([])
    expect(diffRows(fixed.all, meant.all)).toEqual([])
  })

  // ---- the counter from key s8: frames parsed at the wrong geometry ----
  it('counts frames parsed at the wrong geometry: 0 with the barrier, many without (key s8)', async () => {
    const FRAMES = 30
    const frameFor = (id: number, cols: number, rows: number): string => `\x1b]9999;${id}\x07` + history(Math.min(30, rows - 5), cols) + 'x'.repeat(9000 - 40) + '\r\n'
    async function run(barrier: boolean): Promise<{ wrong: number; queued: number }> {
      const t = makeTerm({ cols: 120, rows: 40 })
      const drawnFor = new Map<number, [number, number]>()
      const parsedAt = new Map<number, [number, number]>()
      t.parser.registerOscHandler(9999, (payload) => { parsedAt.set(Number(payload), [t.cols, t.rows]); return true })
      const throttle = rendererPath(t)
      // 30 frames the child drew for 120x40 are in flight (each over the 8 KB bypass, so they queue) when the pane is resized.
      for (let i = 0; i < FRAMES; i++) { drawnFor.set(i, [120, 40]); throttle(frameFor(i, 120, 40)) }
      const queued = (readXtermPending(t) ?? 0) + throttle.pending()
      if (barrier) {
        await new Promise<void>((resolve) => {
          resizeInStreamOrder({ flushHold: () => undefined, throttle, term: t, apply: () => { t.resize(100, 30); resolve() } })
        })
      } else {
        t.resize(100, 30) // what fit() did, synchronously
      }
      // the child sees the resize and repaints for 100x30
      for (let i = FRAMES; i < FRAMES + 5; i++) { drawnFor.set(i, [100, 30]); throttle(frameFor(i, 100, 30)) }
      while (throttle.pending() > 0) await new Promise((r) => setTimeout(r, 2))
      await settle(t)
      let wrong = 0
      for (const [id, want] of drawnFor) {
        const got = parsedAt.get(id)
        if (!got || got[0] !== want[0] || got[1] !== want[1]) wrong++
      }
      t.dispose()
      return { wrong, queued }
    }
    const shipped = await run(false)
    const fixed = await run(true)
    expect(shipped.queued).toBeGreaterThan(200_000)
    expect(shipped.wrong).toBeGreaterThan(0) // NEGATIVE CONTROL: the 1.54.4 order parses queued frames at the new size
    expect(fixed.wrong).toBe(0)
  })

  it('a same-size resize still goes out: the barrier orders it, it does not drop it (conhost\'s repaint heals the viewport)', async () => {
    const term = makeTerm(A)
    const throttle = rendererPath(term)
    throttle(history(300, A.cols))
    const sent: Array<[number, number]> = []
    await new Promise<void>((resolve) => {
      resizeInStreamOrder({ flushHold: () => undefined, throttle, term, apply: () => { term.resize(A.cols, A.rows); sent.push([term.cols, term.rows]); resolve() } })
    })
    expect(sent).toEqual([[A.cols, A.rows]])
    term.dispose()
  })
})

// =============================================================================================
// 3. A remounted pane: the replay is parsed at the pty's size, the fit comes after, conhost repaints at the new size
// =============================================================================================
//
// tests/fixtures/conpty-10.0.26200.json is REAL conhost output (a cmd.exe on Windows build 26200 holding 22 long lines),
// recorded at every pty.resize call (the capture machine's working directory was replaced by a neutral
// path of the same length: offsets and wrapping are unchanged). W is main's retained window, P the repaint
// conhost sends after the pane is widened from 90 to 120 columns.

interface Capture {
  chunks: string[]
  marks: Array<{ label: string; offset: number; cols?: number; rows?: number }>
}

describe('a remounted pane: replay at the pty size, fit afterwards', () => {
  const cap = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'conpty-10.0.26200.json'), 'utf8')) as Capture
  const all = cap.chunks.join('')
  const at = (label: string): number => cap.marks.find((m) => m.label === label)!.offset
  const OLD = { cols: 90, rows: 30 }
  const NEW = { cols: 120, rows: 30 }
  const W = all.slice(0, at('settled: narrow 120x30 -> 90x30')) // main's retained window (the whole stream is under 32 KB)
  const P = all.slice(at('BEFORE widen 90x30 -> 120x30'), at('settled: widen 90x30 -> 120x30'))
  const P2 = all.slice(at('BEFORE SAME SIZE 120x30 -> 120x30'), at('settled: SAME SIZE 120x30 -> 120x30'))

  beforeEach(() => { useFastFrames() })
  afterEach(() => { vi.unstubAllGlobals() })

  /** What the pty meant: the window parsed as it really happened (80x24, 120x30, 90x30), then fit to 120x30, then P. */
  async function truth(): Promise<Term> {
    const t = makeTerm({ cols: 80, rows: 24 })
    let fed = 0
    for (const m of cap.marks.filter((x) => x.cols && (x.label.startsWith('resize call returned') || x.label === 'resize 120x30'))) {
      if (m.offset > at('settled: narrow 120x30 -> 90x30')) break
      await write(t, all.slice(fed, m.offset))
      fed = m.offset
      t.resize(m.cols!, m.rows!)
    }
    await write(t, all.slice(fed, at('settled: narrow 120x30 -> 90x30')))
    t.resize(NEW.cols, NEW.rows)
    await write(t, P)
    return t
  }

  /** 1.54.4: the mount-time font effect fits (and tells the pty) BEFORE the reply lands; the replay is then parsed at the old size. */
  async function mountedTheOldWay(o: { earlyLive: boolean; heal: boolean }): Promise<Term> {
    const t = makeTerm({ cols: 80, rows: 24 })
    t.resize(NEW.cols, NEW.rows) // the font effect's fit(), before the reply
    t.resize(OLD.cols, OLD.rows) // landReplay: the replay is parsed at the size the pty had when main answered
    if (o.earlyLive) await write(t, '\x1bc' + W + P) // the new-size repaint beat the reply and is laid in behind a reset
    else { await write(t, W); await write(t, P) } // ...or arrived while the hold was up, still at the old size
    t.resize(NEW.cols, NEW.rows) // releaseSizeHold -> doFit -> fit()
    if (o.heal) await write(t, P2) // doFit's resizeTerminal -> conhost repaints again
    return t
  }

  /** 1.54.5: the pane holds its fits from mount; the replay is parsed at the pty's size; the fit comes in stream order; conhost's repaint follows it. */
  async function mountedInOrder(): Promise<{ term: Term; fitsBeforeReplay: number }> {
    const t = makeTerm({ cols: 80, rows: 24 })
    const throttle = createOutputThrottle((d) => t.write(d))
    const fitsBeforeReplay = 0 // the hold: the font effect and the first fit are skipped, so the pty is not told anything yet
    t.resize(OLD.cols, OLD.rows) // landReplay
    t.write(W) // writeHistory: the replay is queued, not yet parsed
    await new Promise<void>((resolve) => {
      resizeInStreamOrder({ flushHold: () => undefined, throttle, term: t, apply: () => { t.resize(NEW.cols, NEW.rows); resolve() } })
    })
    await write(t, P) // the pty learned the new size; conhost's repaint is drawn for it
    return { term: t, fitsBeforeReplay }
  }

  const damage = (t: Term, ref: Term) => ({
    viewport: diffRows(viewport(t), viewport(ref)).length,
    buffer: diffRows(wholeBuffer(t), wholeBuffer(ref)).length,
    scroll: t.buffer.active.baseY !== ref.buffer.active.baseY,
    cursor: t.buffer.active.cursorX !== ref.buffer.active.cursorX || t.buffer.active.cursorY !== ref.buffer.active.cursorY,
  })

  it('NEGATIVE CONTROL: mounted the 1.54.4 way, the pane is left wrong, whichever way the repaint races the reply', async () => {
    const ref = await truth()
    for (const variant of [{ earlyLive: true, heal: false }, { earlyLive: false, heal: false }]) {
      const t = await mountedTheOldWay(variant)
      const d = damage(t, ref)
      expect(d.viewport + d.buffer, JSON.stringify(variant)).toBeGreaterThan(0)
      t.dispose()
    }
    ref.dispose()
  })

  it('NEGATIVE CONTROL: the unconditional same-size resize heals the viewport but the scrollback and scroll position keep the damage', async () => {
    const ref = await truth()
    const t = await mountedTheOldWay({ earlyLive: false, heal: true })
    const d = damage(t, ref)
    expect(d.viewport).toBe(0) // conhost's second repaint
    expect(d.buffer > 0 || d.scroll || d.cursor).toBe(true) // ...but not the rest
    t.dispose()
    ref.dispose()
  })

  it('mounted in stream order, the pane equals what the pty meant in every column: viewport, whole buffer, scroll position, cursor', async () => {
    const ref = await truth()
    const { term } = await mountedInOrder()
    expect(damage(term, ref)).toEqual({ viewport: 0, buffer: 0, scroll: false, cursor: false })
    term.dispose()
    ref.dispose()
  })
})
