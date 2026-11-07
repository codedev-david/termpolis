import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPaneFitter,
  DEGENERATE_COLS,
  DEGENERATE_ROWS,
  UNMEASURED_RETRY_FRAMES,
  SELECTION_DEFER_CAP_MS,
  SELECTION_RETRY_MS,
  type PaneFitter,
  type PaneFitterDeps,
} from '../../src/renderer/src/lib/paneFitter'
import { RESIZE_DRAIN_CAP_MS } from '../../src/renderer/src/lib/resizeInStreamOrder'

// The pane's doFit (1.54.5, plan package P3): when a pane may fit, and what it does.
//
//   - not while the mount's replay is being parsed at the pty's size (the replay's release asks again)
//   - not while the pane is hidden: every mounted pane used to refit on every window resize, hidden ones
//     too, 5 to 69 ms of reflow each plus a conhost repaint and an agent redraw (needsFit remembers it;
//     the visibility effect fits on show)
//   - not while a selection is active, for at most SELECTION_DEFER_CAP_MS (it used to be for ever)
//   - never to a degenerate grid (a 0 px container: FitAddon answers 2 x 1), but to any real one, small or not
//   - a pane whose pty was never told a size is fitted once even while hidden (RZ-2)
//   - an unmeasurable proposal keeps the fit owed and is retried on the next frames (RZ-3)
//   - in stream order (resizeInStreamOrder), and `try { fit() } finally { tell the pty }`
//   - never dropping a same-size resize: conhost repaints the viewport on every resize, even to the
//     same size, and that repaint is the only thing that heals a replayed pane

describe('paneFitter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  type Rig = {
    log: string[]
    deps: PaneFitterDeps
    s: {
      disposed: boolean
      held: boolean
      visible: boolean
      selecting: boolean
      proposal: { cols: number; rows: number } | undefined | 'absent'
      fitThrows: Error | null
      cols: number
      rows: number
      throttlePending: number
      xtermPending: number | null
      drain?: () => void
      xtermCb?: () => void
    }
    sent: Array<[number, number]>
    errors: unknown[]
  }

  function rig(over: Partial<PaneFitterDeps> = {}): Rig {
    const log: string[] = []
    const sent: Array<[number, number]> = []
    const errors: unknown[] = []
    const s: Rig['s'] = {
      disposed: false, held: false, visible: true, selecting: false, proposal: { cols: 100, rows: 30 }, fitThrows: null,
      cols: 80, rows: 24, throttlePending: 0, xtermPending: 0,
    }
    const term = {
      get cols() { return s.cols },
      get rows() { return s.rows },
      write: (_d: string, cb?: () => void) => { log.push('term.write'); s.xtermCb = cb },
    }
    // Behaves like FitAddon: it fits to what it proposes, and an unreadable proposal (undefined, NaN) changes nothing.
    const addon: PaneFitterDeps['addon'] = {
      fit: () => {
        log.push('fit')
        if (s.fitThrows) throw s.fitThrows
        const p = s.proposal === 'absent' ? { cols: 100, rows: 30 } : s.proposal
        if (!p || Number.isNaN(p.cols) || Number.isNaN(p.rows)) return
        s.cols = p.cols
        s.rows = p.rows
      },
    }
    Object.defineProperty(addon, 'proposeDimensions', { get: () => (s.proposal === 'absent' ? undefined : () => s.proposal as { cols: number; rows: number } | undefined) })
    const deps: PaneFitterDeps = {
      isDisposed: () => s.disposed,
      isHeld: () => s.held,
      isVisible: () => s.visible,
      isSelectionActive: () => s.selecting,
      onFit: () => { log.push('onFit') },
      flushHold: () => { log.push('flushHold') },
      throttle: {
        pending: () => s.throttlePending,
        whenDrained: (cb) => { log.push('whenDrained'); s.drain = cb; return () => { log.push('cancelDrain') } },
      },
      term,
      addon,
      send: (c, r) => { log.push('send'); sent.push([c, r]) },
      xtermPending: () => s.xtermPending,
      onError: (e) => { errors.push(e) },
      ...over,
    }
    return { log, deps, s, sent, errors }
  }

  describe('a visible, idle pane', () => {
    it('reads the queue, flushes the hold, fits, THEN tells the pty what the grid became', () => {
      const r = rig()
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.log).toEqual(['onFit', 'flushHold', 'fit', 'send'])
      expect(r.sent).toEqual([[100, 30]]) // term.cols/rows as they are AFTER the fit
      expect(vi.getTimerCount()).toBe(0)
      expect(f.needsFit).toBe(false)
    })

    it('does nothing at all once disposed', () => {
      const r = rig()
      r.s.disposed = true
      createPaneFitter(r.deps).request()
      expect(r.log).toEqual([])
    })
  })

  describe('while the mount\'s replay is held', () => {
    it('does not fit, does not tell the pty, and does not mark the pane as owing a fit', () => {
      const r = rig()
      r.s.held = true
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.log).toEqual([])
      expect(f.needsFit).toBe(false) // the release of the hold asks again; nothing is owed by the pane itself
      r.s.held = false
      f.request()
      expect(r.log).toContain('fit')
    })
  })

  // A pane that has told its pty a size once (the usual case: it was visible at some point).
  function sizedThenHidden(r: Rig): PaneFitter {
    const f = createPaneFitter(r.deps)
    f.request()
    expect(r.sent).toEqual([[100, 30]])
    r.log.length = 0
    r.sent.length = 0
    r.s.visible = false
    return f
  }

  describe('a hidden pane', () => {
    it('is not fitted (no reflow, no pty resize, no repaint), and remembers it owes a fit', () => {
      const r = rig()
      const f = sizedThenHidden(r)
      f.request()
      f.request()
      f.request()
      expect(r.log).toEqual([])
      expect(r.sent).toEqual([])
      expect(f.needsFit).toBe(true)
    })

    it('fits when asked again once it is shown, and then owes nothing', () => {
      const r = rig()
      const f = sizedThenHidden(r)
      r.s.proposal = { cols: 90, rows: 20 }
      f.request()
      r.s.visible = true
      f.request()
      expect(r.sent).toEqual([[90, 20]])
      expect(f.needsFit).toBe(false)
    })

    it('RZ-2: a pane hidden from mount (its pty never told a size) is fitted ONCE while hidden, then waits for the show', () => {
      const r = rig()
      r.s.visible = false
      const f = createPaneFitter(r.deps)
      for (let i = 0; i < 5; i++) f.request() // the mount fit, then window resizes while the tab stays in the background
      expect(r.sent).toEqual([[100, 30]]) // the agent draws at the real width, not the spawn size of 80 x 24
      expect(r.log.filter((x) => x === 'fit').length).toBe(1)
      expect(f.needsFit).toBe(true) // the later requests are owed for the show
    })

    it('RZ-2: a hidden-from-mount pane that cannot be measured is left owing the fit, with no frame loop', () => {
      const r = rig()
      const frames: Array<() => void> = []
      r.deps.nextFrame = (cb) => { frames.push(cb); return () => {} }
      r.s.visible = false
      r.s.proposal = undefined
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.sent).toEqual([])
      expect(frames.length).toBe(0) // the show asks again; a hidden pane does not spin
      expect(f.needsFit).toBe(true)
      r.s.visible = true
      r.s.proposal = { cols: 100, rows: 30 }
      f.request()
      expect(r.sent).toEqual([[100, 30]])
    })

    it('NEGATIVE CONTROL: the same pane, visible, fits on every request', () => {
      const r = rig()
      const f = createPaneFitter(r.deps)
      f.request()
      f.request()
      f.request()
      expect(r.sent.length).toBe(3)
    })

    it('hidden while the resize waited in line: the fit is skipped when it comes up, and owed', () => {
      const r = rig({ tellFirst: false })
      const f = sizedThenHidden(r)
      r.s.visible = true
      r.s.throttlePending = 100_000
      f.request()
      r.s.visible = false
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([])
      expect(f.needsFit).toBe(true)
    })
  })

  describe('while a selection is active', () => {
    it('waits, asking again every 150 ms, and fits on the first try after the selection is gone', () => {
      const r = rig()
      r.s.selecting = true
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.log).toEqual([])
      vi.advanceTimersByTime(SELECTION_RETRY_MS * 2 + 1) // two retries, still selecting
      expect(r.log).toEqual([])
      r.s.selecting = false
      vi.advanceTimersByTime(SELECTION_RETRY_MS)
      expect(r.sent).toEqual([[100, 30]])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('stops waiting after SELECTION_DEFER_CAP_MS: one fit, with the selection still active (it used to wait for ever)', () => {
      const r = rig()
      r.s.selecting = true
      const f = createPaneFitter(r.deps)
      f.request()
      vi.advanceTimersByTime(SELECTION_DEFER_CAP_MS - 1)
      expect(r.sent).toEqual([])
      vi.advanceTimersByTime(SELECTION_RETRY_MS) // the first retry past the cap
      expect(r.sent).toEqual([[100, 30]])
      vi.advanceTimersByTime(60_000)
      expect(r.sent.length).toBe(1) // not again
      expect(vi.getTimerCount()).toBe(0)
    })

    it('the cap runs from the FIRST request: requests while waiting do not extend it', () => {
      const r = rig()
      r.s.selecting = true
      const f = createPaneFitter(r.deps)
      f.request()
      for (let t = 0; t < 8; t++) {
        vi.advanceTimersByTime(100)
        f.request() // the observer fires again and again while the window is dragged
      }
      vi.advanceTimersByTime(SELECTION_RETRY_MS * 2)
      expect(r.sent.length).toBe(1)
    })

    it('a later selection gets the whole allowance again', () => {
      const r = rig()
      r.s.selecting = true
      const f = createPaneFitter(r.deps)
      f.request()
      vi.advanceTimersByTime(SELECTION_DEFER_CAP_MS + SELECTION_RETRY_MS)
      expect(r.sent.length).toBe(1)
      r.sent.length = 0
      f.request() // the selection is STILL there, but that episode is over: this request starts a new one
      vi.advanceTimersByTime(SELECTION_DEFER_CAP_MS - 1)
      expect(r.sent.length).toBe(0) // a fresh allowance
      vi.advanceTimersByTime(SELECTION_RETRY_MS)
      expect(r.sent.length).toBe(1)
    })

    it('is not stuck behind a pane that is disposed while it waits', () => {
      const r = rig()
      r.s.selecting = true
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.disposed = true
      vi.advanceTimersByTime(SELECTION_DEFER_CAP_MS * 2)
      expect(r.log).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('floor: a 0 px container never reaches the pty, a small pane does', () => {
    it('keeps the last good size when FitAddon proposes 2 x 1 (a zero-size container)', () => {
      const r = rig()
      r.s.proposal = { cols: 2, rows: 1 }
      createPaneFitter(r.deps).request()
      expect(r.log).toEqual(['onFit', 'flushHold']) // it was asked, and declined
      expect(r.sent).toEqual([])
    })

    it.each([
      [DEGENERATE_COLS, 30, false],
      [120, DEGENERATE_ROWS, false],
      [DEGENERATE_COLS + 1, DEGENERATE_ROWS + 1, true],
      [120, 4, true], // RZ-1: a pane shrunk to 4 visible rows gets a 4-row grid, so its input box is not clipped
      [19, 30, true],
      [10, 34, true], // a 10% split pane of a 1200 px window is a real layout
    ])('a proposal of %i x %i fits: %s', (cols, rows, fits) => {
      const r = rig()
      r.s.proposal = { cols, rows }
      createPaneFitter(r.deps).request()
      expect(r.sent.length).toBe(fits ? 1 : 0)
      if (fits) expect(r.sent[0]).toEqual([cols, rows])
    })

    it('the termpolis.fitFloor switch (floor: false) declines nothing, as 1.54.4', () => {
      const r = rig({ floor: false })
      r.s.proposal = { cols: 2, rows: 1 }
      createPaneFitter(r.deps).request()
      expect(r.sent).toEqual([[2, 1]])
    })
  })

  describe('RZ-3: a proposal xterm cannot measure yet (undefined, just after a content-visibility show)', () => {
    function framed(r: Rig): { frames: Array<() => void>; cancelled: () => number } {
      const frames: Array<() => void> = []
      let cancelled = 0
      r.deps.nextFrame = (cb) => {
        frames.push(cb)
        return () => { cancelled++ }
      }
      return { frames, cancelled: () => cancelled }
    }

    it('keeps the fit owed, does not tell the pty the stale size, and fits on the next frame once measurable', () => {
      const r = rig()
      const { frames } = framed(r)
      r.s.proposal = undefined
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.sent).toEqual([]) // it used to send [80, 24] and clear needsFit
      expect(f.needsFit).toBe(true)
      expect(frames.length).toBe(1)
      r.s.proposal = { cols: 100, rows: 30 }
      frames.shift()!()
      expect(r.sent).toEqual([[100, 30]])
      expect(f.needsFit).toBe(false)
      expect(frames.length).toBe(0)
    })

    it('retries for at most UNMEASURED_RETRY_FRAMES frames, then waits for the next request', () => {
      const r = rig()
      const { frames } = framed(r)
      r.s.proposal = undefined
      const f = createPaneFitter(r.deps)
      f.request()
      let ran = 0
      while (frames.length > 0 && ran < 100) { frames.shift()!(); ran++ }
      expect(ran).toBe(UNMEASURED_RETRY_FRAMES)
      expect(r.sent).toEqual([])
      expect(f.needsFit).toBe(true)
      f.request() // the next resize or show gets the whole allowance again
      expect(frames.length).toBe(1)
    })

    it('cancel() drops a pending frame', () => {
      const r = rig()
      const { cancelled } = framed(r)
      r.s.proposal = undefined
      const f = createPaneFitter(r.deps)
      f.request()
      f.cancel()
      expect(cancelled()).toBe(1)
    })

    it('with no nextFrame given it uses requestAnimationFrame, or a timer where there is none', () => {
      const r = rig()
      r.s.proposal = undefined
      createPaneFitter(r.deps).request()
      r.s.proposal = { cols: 100, rows: 30 }
      vi.advanceTimersByTime(50)
      expect(r.sent).toEqual([[100, 30]])
    })

    it.each([true, false])('the default frame can be cancelled (requestAnimationFrame present: %s)', (hasRaf) => {
      if (!hasRaf) {
        vi.stubGlobal('requestAnimationFrame', undefined)
        vi.stubGlobal('cancelAnimationFrame', undefined)
      }
      try {
        const r = rig()
        r.s.proposal = undefined
        const f = createPaneFitter(r.deps)
        f.request()
        f.cancel()
        r.s.proposal = { cols: 100, rows: 30 }
        vi.advanceTimersByTime(50)
        expect(r.sent).toEqual([]) // the cancelled frame never ran
        if (!hasRaf) {
          f.request()
          vi.advanceTimersByTime(20)
          expect(r.sent).toEqual([[100, 30]]) // the timer fallback runs it
        }
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('a FitAddon double with no proposeDimensions at all goes ahead as before', () => {
      const r = rig()
      r.s.proposal = 'absent'
      createPaneFitter(r.deps).request()
      expect(r.sent).toEqual([[100, 30]])
    })

    it('NaN is not a floor: fit() has its own guard for it, and the pty is told the (unchanged) size as before', () => {
      const r = rig()
      r.s.proposal = { cols: Number.NaN, rows: Number.NaN }
      createPaneFitter(r.deps).request()
      expect(r.sent.length).toBe(1)
    })
  })

  describe('try { fit() } finally { tell the pty }', () => {
    it('a fit that throws still tells the pty the size xterm has, and the error is reported, not thrown', () => {
      const r = rig()
      const boom = new Error('renderer lost its context mid-fit')
      r.s.fitThrows = boom
      expect(() => createPaneFitter(r.deps).request()).not.toThrow()
      expect(r.sent).toEqual([[80, 24]]) // term.cols/rows as xterm has them
      expect(r.errors).toEqual([boom])
    })

    it('...also when it runs behind a backlog, in xterm\'s write callback (where a throw would wedge xterm)', () => {
      const r = rig()
      r.s.xtermPending = 9_000
      r.s.fitThrows = new Error('boom')
      createPaneFitter(r.deps).request()
      expect(r.log).toContain('term.write')
      expect(() => r.s.xtermCb!()).not.toThrow()
      expect(r.sent).toEqual([[100, 30], [80, 24]]) // told the proposal first (RZ2-1), then put back to what xterm has
      expect(r.errors.length).toBe(1)
    })
  })

  describe('a same-size resize is still sent (conhost repaints the viewport on every resize)', () => {
    it('fit() changes nothing, and the pty is told anyway', () => {
      const r = rig()
      r.s.cols = 100
      r.s.rows = 30 // already the size the container asks for
      const f = createPaneFitter(r.deps)
      f.request()
      f.request()
      expect(r.sent).toEqual([[100, 30], [100, 30]])
    })
  })

  describe('in stream order (termpolis.resizeTellFirst off: the pty waits with xterm, as the first 1.54.5 builds)', () => {
    it('behind a backlog the fit waits for the throttle, and the hold is flushed before the wait', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 150_000
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.log).toEqual(['onFit', 'flushHold', 'whenDrained'])
      expect(r.sent).toEqual([])
      expect(f.waiting).toBe(true)
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.log).toEqual(['onFit', 'flushHold', 'whenDrained', 'fit', 'send'])
      expect(f.waiting).toBe(false)
    })

    it('behind xterm\'s queue it writes the empty marker and fits in its callback', () => {
      const r = rig({ tellFirst: false })
      r.s.xtermPending = 40_000
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.log).toEqual(['onFit', 'flushHold', 'term.write'])
      expect(f.waiting).toBe(true)
      r.s.xtermCb!()
      expect(r.log).toEqual(['onFit', 'flushHold', 'term.write', 'fit', 'send'])
    })

    it('a request while one waits in line is folded into it: one wait, one fit, measured when it runs', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      f.request()
      f.request()
      expect(r.log.filter((l) => l === 'whenDrained').length).toBe(1)
      expect(r.log.filter((l) => l === 'flushHold').length).toBe(1)
      r.s.proposal = { cols: 77, rows: 22 } // the container moved again while the resize waited: the fit sees the latest
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([[77, 22]])
    })

    it('a request that arrives once the resize has run starts a new one', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.throttlePending = 0
      r.s.drain!()
      f.request() // nothing queued now: at once
      expect(r.sent.length).toBe(2)
    })

    it('the wait is capped: a throttle that never drains cannot hold the resize back for ever', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS)
      expect(r.sent).toEqual([[100, 30]])
      expect(f.waiting).toBe(false)
    })

    it('a stream of requests (a window dragged while a backlog drains) cannot postpone the resize past the cap', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS / 6)
        f.request()
      }
      vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS / 6 + 1)
      expect(r.sent.length).toBe(1)
    })

    it('a selection that begins while the resize waits in line defers it, instead of reflowing the selection away', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.selecting = true // the user starts selecting while the backlog drains
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([]) // not now
      expect(r.log).not.toContain('fit')
      r.s.selecting = false
      vi.advanceTimersByTime(SELECTION_RETRY_MS)
      expect(r.sent).toEqual([[100, 30]])
    })

    it('...but only for the allowance: past the cap it fits once, selection or not (and does not loop)', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.selecting = true
      r.s.throttlePending = 0
      r.s.drain!()
      vi.advanceTimersByTime(SELECTION_DEFER_CAP_MS + SELECTION_RETRY_MS * 2)
      expect(r.sent.length).toBe(1)
      vi.advanceTimersByTime(60_000)
      expect(r.sent.length).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cancel drops the wait and the retry: nothing runs afterwards', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      f.cancel()
      r.s.drain!()
      vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS * 2)
      expect(r.sent).toEqual([])
      const sel = rig({ tellFirst: false })
      sel.s.selecting = true
      const g = createPaneFitter(sel.deps)
      g.request()
      g.cancel()
      vi.advanceTimersByTime(SELECTION_DEFER_CAP_MS * 2)
      expect(sel.log).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a pane disposed, or held again, while the resize waited does not resize on its way out', () => {
      const r = rig({ tellFirst: false })
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.held = true // a new replay took the hold
      r.s.drain!()
      expect(r.sent).toEqual([])
      const d = rig({ tellFirst: false })
      d.s.throttlePending = 100_000
      const g = createPaneFitter(d.deps)
      g.request()
      d.s.disposed = true
      d.s.drain!()
      expect(d.sent).toEqual([])
    })
  })

  // RZ2-1: a resize behind a backlog used to leave the pty at the old size for the whole wait (up to the 3 s cap), so
  // everything it drew meanwhile was parsed at the new size. The pty is told when the resize is asked for; only
  // xterm's resize waits in line.
  describe('RZ2-1: the pty is told first, xterm resizes in stream order', () => {
    const count = (r: Rig, what: string): number => r.log.filter((l) => l === what).length

    it('behind a backlog the pty is told the proposed size at once, and the fit does not tell it again', () => {
      const r = rig()
      r.s.throttlePending = 150_000
      const f = createPaneFitter(r.deps)
      f.request()
      expect(r.log).toEqual(['onFit', 'flushHold', 'whenDrained', 'send'])
      expect(r.sent).toEqual([[100, 30]]) // while the resize still waits
      expect(f.waiting).toBe(true)
      expect([r.s.cols, r.s.rows]).toEqual([80, 24]) // xterm has not moved: the backlog is parsed at the size it was drawn for
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.log).toEqual(['onFit', 'flushHold', 'whenDrained', 'send', 'fit'])
      expect(r.sent).toEqual([[100, 30]])
      expect([r.s.cols, r.s.rows]).toEqual([100, 30])
    })

    it('...also behind xterm\'s own queue', () => {
      const r = rig()
      r.s.xtermPending = 40_000
      createPaneFitter(r.deps).request()
      expect(r.log).toEqual(['onFit', 'flushHold', 'term.write', 'send'])
      r.s.xtermCb!()
      expect(r.sent).toEqual([[100, 30]])
    })

    it('nothing queued: fit, then tell, as before (no early tell, no timer)', () => {
      const r = rig()
      createPaneFitter(r.deps).request()
      expect(r.log).toEqual(['onFit', 'flushHold', 'fit', 'send'])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a request while the resize waits tells the pty a moved container at once, and the same size only once', () => {
      const r = rig()
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.proposal = { cols: 77, rows: 22 }
      f.request()
      f.request()
      expect(r.sent).toEqual([[100, 30], [77, 22]])
      expect(count(r, 'whenDrained')).toBe(1) // still one wait
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([[100, 30], [77, 22]])
      expect([r.s.cols, r.s.rows]).toEqual([77, 22])
    })

    it('a container that moved with no request since: the fit tells the pty the size the grid came out at', () => {
      const r = rig()
      r.s.throttlePending = 100_000
      createPaneFitter(r.deps).request()
      r.s.proposal = { cols: 90, rows: 20 }
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([[100, 30], [90, 20]])
    })

    it.each([
      ['a 0 px container', { cols: 2, rows: 1 }],
      ['an unmeasurable one', undefined],
      ['NaN', { cols: Number.NaN, rows: Number.NaN }],
    ])('%s is never told early', (_name, proposal) => {
      const r = rig()
      r.deps.nextFrame = () => () => {}
      r.s.proposal = proposal
      r.s.throttlePending = 100_000
      createPaneFitter(r.deps).request()
      expect(r.sent).toEqual([])
    })

    it('with no proposeDimensions there is nothing to tell early: the fit tells the pty, as before', () => {
      const r = rig()
      r.s.proposal = 'absent'
      r.s.throttlePending = 100_000
      createPaneFitter(r.deps).request()
      expect(r.sent).toEqual([])
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([[100, 30]])
    })

    it('the termpolis.fitFloor switch (floor: false): a 2 x 1 proposal is told early too, as the fit would take it', () => {
      const r = rig({ floor: false })
      r.s.proposal = { cols: 2, rows: 1 }
      r.s.throttlePending = 100_000
      createPaneFitter(r.deps).request()
      expect(r.sent).toEqual([[2, 1]])
    })

    it('a proposeDimensions that throws is reported, not thrown, and the resize still runs', () => {
      const r = rig()
      const boom = new Error('no core')
      let calls = 0
      const fit = r.deps.addon.fit
      r.deps.addon = { fit, proposeDimensions: () => { if (calls++ === 0) throw boom; return { cols: 100, rows: 30 } } }
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      expect(() => f.request()).not.toThrow()
      expect(r.errors).toEqual([boom])
      expect(r.sent).toEqual([])
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.sent).toEqual([[100, 30]])
    })

    it('a pane hidden while the resize waited: no fit, and the pty is put back to the size xterm has', () => {
      const r = rig()
      const f = sizedThenHidden(r) // xterm 100 x 30
      r.s.visible = true
      r.s.proposal = { cols: 90, rows: 20 }
      r.s.throttlePending = 100_000
      f.request()
      expect(r.sent).toEqual([[90, 20]])
      r.s.visible = false
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.log).not.toContain('fit')
      expect(r.sent).toEqual([[90, 20], [100, 30]])
      expect(f.needsFit).toBe(true)
    })

    it('held again, or a 0 px container by the time the resize comes up: the pty is put back too', () => {
      const held = rig()
      held.s.throttlePending = 100_000
      createPaneFitter(held.deps).request()
      held.s.held = true
      held.s.drain!()
      expect(held.sent).toEqual([[100, 30], [80, 24]])
      const zero = rig()
      zero.s.throttlePending = 100_000
      createPaneFitter(zero.deps).request()
      zero.s.proposal = { cols: 2, rows: 1 }
      zero.s.drain!()
      expect(zero.log).not.toContain('fit')
      expect(zero.sent).toEqual([[100, 30], [80, 24]])
    })

    it('NEGATIVE CONTROL: nothing to put back when the early size is what xterm already has, or the pane is gone', () => {
      const same = rig()
      same.s.cols = 100
      same.s.rows = 30
      same.s.throttlePending = 100_000
      createPaneFitter(same.deps).request()
      same.s.held = true
      same.s.drain!()
      expect(same.sent).toEqual([[100, 30]])
      const gone = rig()
      gone.s.throttlePending = 100_000
      createPaneFitter(gone.deps).request()
      gone.s.disposed = true
      gone.s.drain!()
      expect(gone.sent).toEqual([[100, 30]])
    })

    it('RZ-2 still holds: a pane hidden from mount is fitted once behind a backlog, told once', () => {
      const r = rig()
      r.s.visible = false
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.throttlePending = 0
      r.s.drain!()
      expect(count(r, 'fit')).toBe(1)
      expect(r.sent).toEqual([[100, 30]])
      f.request()
      expect(r.sent).toEqual([[100, 30]]) // sized now: hidden, it waits for the show
    })

    it('requests while the resize waits tell nothing while the pane may not fit (hidden, held, selecting, disposed)', () => {
      for (const flip of ['visible', 'held', 'selecting', 'disposed'] as const) {
        const r = rig()
        const f = sizedThenHidden(r)
        r.s.visible = true
        r.s.throttlePending = 100_000
        f.request()
        expect(r.sent).toEqual([[100, 30]])
        r.s.proposal = { cols: 70, rows: 20 }
        if (flip === 'visible') r.s.visible = false
        else r.s[flip] = true
        f.request()
        expect(r.sent).toEqual([[100, 30]])
      }
    })

    it('a selection that begins while the resize waits: the fit is deferred, and tells the pty when it runs', () => {
      const r = rig()
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      r.s.selecting = true
      r.s.throttlePending = 0
      r.s.drain!()
      expect(r.log).not.toContain('fit')
      r.s.selecting = false
      vi.advanceTimersByTime(SELECTION_RETRY_MS)
      expect(r.sent).toEqual([[100, 30], [100, 30]]) // early, then the deferred fit's own (a same-size resize is still sent)
    })

    it('cancel forgets the early size: the next fit tells the pty again', () => {
      const r = rig()
      r.s.throttlePending = 100_000
      const f = createPaneFitter(r.deps)
      f.request()
      f.cancel()
      r.s.throttlePending = 0
      f.request()
      expect(r.sent).toEqual([[100, 30], [100, 30]])
    })

    it('the cap still bounds xterm\'s resize; the pty had the size from the start', () => {
      const r = rig()
      r.s.throttlePending = 100_000
      createPaneFitter(r.deps).request()
      expect(r.sent).toEqual([[100, 30]])
      vi.advanceTimersByTime(RESIZE_DRAIN_CAP_MS)
      expect([r.s.cols, r.s.rows]).toEqual([100, 30])
      expect(r.sent).toEqual([[100, 30]])
    })
  })

  it('uses Date.now for the selection clock unless told otherwise', () => {
    const r = rig()
    r.s.selecting = true
    const f = createPaneFitter(r.deps)
    f.request()
    vi.setSystemTime(Date.now() + SELECTION_DEFER_CAP_MS + 1)
    vi.advanceTimersByTime(SELECTION_RETRY_MS)
    expect(r.sent.length).toBe(1)
  })

  it('works with no onFit and no throttle (a plain pane)', () => {
    const r = rig({ onFit: undefined, throttle: undefined })
    createPaneFitter(r.deps).request()
    expect(r.log).toEqual(['flushHold', 'fit', 'send'])
  })
})
