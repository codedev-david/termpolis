import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  createWriteScheduler, getWriteScheduler, resetWriteScheduler, isUserInput, DEFAULT_LIMITS,
  type PaneClass, type PaneWriter, type SchedulerLimits, type WriteScheduler,
} from '../../src/renderer/src/lib/writeScheduler'
import { createChunkQueue, type ChunkQueue } from '../../src/renderer/src/lib/chunkQueue'
import { createOutputThrottle } from '../../src/renderer/src/lib/outputThrottle'
import { MAX_WRITE_RETRIES, type ThrottleErrorInfo } from '../../src/renderer/src/lib/writeRetry'
import { makeManualClock, makeFakeTerm, prng, type FakeTerm, type ManualClock, type WriteEvent } from './helpers/schedulerHarness'
import { runLagModel, T } from './helpers/lagModel'

// The renderer's write scheduler (1.54.5, plan package P8).
//
// WHAT IS PROVEN HERE, by counters (chars in flight, writes made, passes run), never by how long anything took:
//   1. one terminal's bytes reach xterm unchanged, in order, exactly once (fuzzed over 10 terminals, and through
//      the REAL @xterm/headless parser with every escape sequence split at every offset);
//   2. chars in flight to xterm never pass a terminal's cap (plus the one small echo write): focusedInFlight <= HI + chunk;
//   3. in every pass the focused terminal is served before the visible panes, and those before the hidden ones;
//   4. while a key is going in the slices shrink, the others are rationed by the pool and the frame's budget, and a
//      terminal that waits is still handed a slice at least every 500 ms;
//   5. the virtual-time model of the lag (harness s1 of the analysis): chars ahead of a typed echo stay within
//      HI + chunk at 0.5x, 2x and 4x load, where the throttle every pane had before (no bound, no priority) does not at 2x.
//
// Every claim has a NEGATIVE CONTROL in this file: the same scenario without the mechanism, or the old throttle,
// has to show what the mechanism removes, so a test that cannot fail does not stay green by accident.

// ---------------------------------------------------------------------------------------------------------
// A rig: a scheduler on a manual clock, and panes whose class the test can change.
// ---------------------------------------------------------------------------------------------------------
interface Pane {
  w: PaneWriter
  t: FakeTerm
  errors: Array<{ error: unknown; info: ThrottleErrorInfo }>
  setClass(c: PaneClass): void
}

interface Rig {
  clock: ManualClock
  sch: WriteScheduler
  events: WriteEvent[]
  internal: unknown[]
  add(id: string, cls?: PaneClass, opts?: { queue?: ChunkQueue }): Pane
}

function makeRig(limits: Partial<SchedulerLimits> = {}): Rig {
  const clock = makeManualClock()
  const events: WriteEvent[] = []
  const internal: unknown[] = []
  const sch = createWriteScheduler({ clock, limits, onInternalError: (e) => internal.push(e) })
  return {
    clock, sch, events, internal,
    add(id, cls = 'visible', opts = {}) {
      const t = makeFakeTerm(id, events)
      const state = { cls }
      const errors: Pane['errors'] = []
      const w = sch.attach(id, {
        write: t.write,
        classify: () => state.cls,
        onError: (error, info) => errors.push({ error, info }),
        queue: opts.queue,
      })
      return { w, t, errors, setClass: (c) => { state.cls = c } }
    },
  }
}

/** Deterministic text that never repeats, so a reordered or duplicated slice shows. */
function text(n: number, seed = 0): string {
  let s = ''
  let i = seed
  while (s.length < n) s += `${(i++).toString(36)} `
  return s.slice(0, n)
}

const D = DEFAULT_LIMITS
const lens = (t: FakeTerm): number[] => t.writes.map((d) => d.length)

/** Frames and acks until the pane has nothing queued and nothing in flight. */
function drainAll(r: Rig, ...panes: Pane[]): void {
  for (let i = 0; i < 5000; i++) {
    for (const p of panes) p.t.ack()
    if (panes.every((p) => p.w.pending() === 0 && p.t.unacked.length === 0)) return
    r.clock.frame(50)
  }
  throw new Error('the scheduler did not drain')
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetWriteScheduler()
})

// =============================================================================================================
// What is typing
// =============================================================================================================
describe('isUserInput', () => {
  it.each([
    ['a printable key', 'a'],
    ['Enter', '\r'],
    ['Backspace', '\x7f'],
    ['Escape', '\x1b'],
    ['Ctrl+C', '\x03'],
    ['an arrow key', '\x1b[A'],
    ['an arrow key with a modifier', '\x1b[1;5C'],
    ['a function key', '\x1b[15~'],
    ['application cursor keys', '\x1bOA'],
    ['Alt+x', '\x1bx'],
    ['Alt+] (ESC ]: it does not end like an OSC reply)', '\x1b]'],
    ['Alt+P (ESC P: it does not end like a DCS reply)', '\x1bP'],
    ['a bracketed paste', '\x1b[200~hello\x1b[201~'],
    ['a mouse report (the user asked for a repaint)', '\x1b[<0;10;5M'],
    ['a multi-char paste', 'echo hi'],
  ])('%s is typing', (_name, data) => {
    expect(isUserInput(data)).toBe(true)
  })

  it.each([
    ['nothing', ''],
    ['a focus-in report', '\x1b[I'],
    ['a focus-out report', '\x1b[O'],
    ['a primary device attributes reply', '\x1b[?1;2c'],
    ['a secondary device attributes reply', '\x1b[>0;276;0c'],
    ['a mode report', '\x1b[?2004;2$y'],
    ['a cursor position report', '\x1b[24;80R'],
    ['a device status reply', '\x1b[0n'],
    ['an OSC reply ended by BEL', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['an OSC reply ended by ST', '\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['a DCS reply', '\x1bP1$r0m\x1b\\'],
  ])('%s is the terminal talking, not the user', (_name, data) => {
    expect(isUserInput(data)).toBe(false)
  })
})

// =============================================================================================================
// One terminal: order, the echo fast path, slices
// =============================================================================================================
describe('one terminal', () => {
  it('hands the bytes over unchanged and in order, in slices no bigger than its class allows', () => {
    const r = makeRig()
    const a = r.add('a', 'visible')
    const input = text(300_000)
    let off = 0
    for (const n of [1, 50_000, 7, 120_000, 30_000, 99_992]) {
      a.w(input.slice(off, off + n))
      off += n
    }
    expect(off).toBe(input.length)
    drainAll(r, a)
    expect(a.t.joined()).toBe(input)
    expect(Math.max(...lens(a.t))).toBeLessThanOrEqual(D.slice.visible)
    expect(a.w.pending()).toBe(0)
    expect(a.w.inflight()).toBe(0)
  })

  it('ignores an empty write', () => {
    const r = makeRig()
    const a = r.add('a', 'focused')
    a.w('')
    expect(a.t.writes).toEqual([])
    expect(r.clock.pendingFrames()).toBe(0)
    expect(a.w.pending()).toBe(0)
  })

  describe('the keystroke echo path', () => {
    it('a small write to the idle focused terminal reaches xterm before the next frame, with an ack to call', () => {
      const r = makeRig()
      const a = r.add('a', 'focused')
      a.w('x')
      expect(a.t.writes).toEqual(['x'])
      expect(a.t.unacked).toHaveLength(1)
      expect(r.sch.stats().fastPath).toBe(1)
      expect(r.clock.pendingFrames()).toBe(0) // no frame was needed
    })

    it('a write over the small limit waits for the frame', () => {
      const r = makeRig()
      const a = r.add('a', 'focused')
      a.w('y'.repeat(D.smallWrite + 1))
      expect(a.t.writes).toEqual([])
      r.clock.frame()
      expect(a.t.writes).toHaveLength(1)
      expect(r.sch.stats().fastPath).toBe(0)
    })

    it('never jumps a queue: output already waiting goes first', () => {
      const r = makeRig()
      const a = r.add('a', 'focused')
      const big = text(20_000)
      a.w(big)
      a.w('x') // small, but something is waiting ahead of it
      expect(a.t.writes).toEqual([])
      r.clock.frame()
      expect(a.t.joined()).toBe(big + 'x')
    })

    it('any pane has it while nobody is typing, as the output throttle gave every pane', () => {
      const r = makeRig()
      const v = r.add('v', 'visible')
      const h = r.add('h', 'hidden')
      v.w('a')
      h.w('b')
      expect(v.t.writes).toEqual(['a'])
      expect(h.t.writes).toEqual(['b'])
      expect(r.sch.stats().fastPath).toBe(2)
    })

    it('while a key is going in only the terminal it went into has it: the others are coalesced into the pass, where the budget is', () => {
      const r = makeRig()
      const f = r.add('f', 'focused')
      const v = r.add('v', 'visible')
      const h = r.add('h', 'hidden')
      f.w.typed('k')
      f.w('x')
      v.w('a')
      v.w('b')
      h.w('c')
      expect(f.t.writes).toEqual(['x'])
      expect(v.t.writes).toEqual([])
      expect(h.t.writes).toEqual([])
      r.clock.frame()
      expect(v.t.writes).toEqual(['ab']) // two pushes, one write
      expect(h.t.writes).toEqual(['c'])
    })

    it('NEGATIVE CONTROL: without the typing rule a visible pane takes the fast path while a key is going in', () => {
      const r = makeRig()
      const f = r.add('f', 'focused')
      const v = r.add('v', 'visible')
      f.w.typed('k')
      f.w('x')
      v.w('a') // the rule says: not now
      expect(v.t.writes).toEqual([])
      const written: string[] = []
      const throttle = createOutputThrottle((d) => { written.push(d) }) // the old throttle has no such rule
      throttle('a')
      expect(written).toEqual(['a'])
    })

    it('is bounded: an xterm that never acks is not fed small writes for ever', () => {
      const r = makeRig()
      const a = r.add('a', 'focused')
      for (let i = 0; i < 5000; i++) a.w('y'.repeat(100))
      expect(a.w.inflight()).toBeLessThanOrEqual(D.inflight.focused + D.smallWrite)
      expect(a.w.inflight()).toBeGreaterThan(D.inflight.focused - 200) // it did fill the room
      expect(a.w.pending() + a.w.inflight()).toBe(500_000)
    })

    it('NEGATIVE CONTROL: the same stalled xterm behind the old throttle is handed all of it', () => {
      let handed = 0
      const throttle = createOutputThrottle((d) => { handed += d.length })
      for (let i = 0; i < 5000; i++) throttle('y'.repeat(100))
      expect(handed).toBe(500_000)
      expect(handed).toBeGreaterThan(D.inflight.focused + D.smallWrite)
    })
  })

  describe('chars in flight', () => {
    it('are capped, and an ack makes room: the focused terminal refills at once, the others at the next pass', () => {
      const r = makeRig()
      const f = r.add('f', 'focused')
      f.w(text(1_000_000))
      r.clock.frame()
      expect(lens(f.t)).toEqual([65_536, 65_536])
      expect(f.w.inflight()).toBe(D.inflight.focused)
      f.t.ack(1) // xterm parsed the first slice: refill inside xterm's own loop, no frame needed
      expect(f.t.writes).toHaveLength(3)
      expect(f.w.inflight()).toBe(D.inflight.focused)

      const r2 = makeRig()
      const v = r2.add('v', 'visible')
      v.w(text(1_000_000))
      r2.clock.frame()
      expect(v.w.inflight()).toBe(D.inflight.visible)
      const before = v.t.writes.length
      v.t.ack(1)
      expect(v.t.writes).toHaveLength(before) // the visible pane waits for the pass that orders it
      r2.clock.frame()
      expect(v.t.writes.length).toBeGreaterThan(before)
    })

    it('stay at or under the cap through any run of acks and frames', () => {
      const r = makeRig()
      const rand = prng(5)
      const panes = [r.add('f', 'focused'), r.add('v', 'visible'), r.add('h', 'hidden')]
      const caps = [D.inflight.focused, D.inflight.visible, D.inflight.hidden]
      panes.forEach((p) => p.w(text(2_000_000)))
      for (let i = 0; i < 300; i++) {
        panes[Math.floor(rand() * 3)].t.ack(1 + Math.floor(rand() * 3))
        if (rand() < 0.5) r.clock.frame()
        panes.forEach((p, k) => expect(p.w.inflight()).toBeLessThanOrEqual(caps[k]))
      }
    })

    it('are counted before xterm is called, so an ack inside write() (xterm parses a user-input write at once) is safe', () => {
      const r = makeRig()
      const f = r.add('f', 'focused')
      f.t.mode = 'sync'
      const input = text(300_000)
      f.w(input)
      r.clock.frame()
      expect(f.t.joined()).toBe(input)
      expect(f.w.inflight()).toBe(0)
      expect(f.w.pending()).toBe(0)
    })

    it('ignore an ack that comes twice', () => {
      const r = makeRig()
      const f = r.add('f', 'focused')
      f.w(text(100_000))
      r.clock.frame()
      expect(lens(f.t)).toEqual([65_536, 34_464])
      const first = f.t.unacked[0].ack
      first()
      first()
      expect(f.w.inflight()).toBe(34_464)
    })

    it('are given back when xterm never acks (a torn-down terminal): after 2 s the credit returns, and the late acks are stale', () => {
      const r = makeRig()
      const v = r.add('v', 'visible')
      v.w(text(300_000))
      r.clock.frame()
      expect(v.w.inflight()).toBe(D.inflight.visible)
      const stale = v.t.unacked[0].ack
      r.clock.advance(1_900)
      expect(r.sch.stats().ackTimeouts).toBe(0)
      expect(v.t.writes).toHaveLength(1) // still waiting for the ack
      r.clock.advance(300)
      expect(r.sch.stats().ackTimeouts).toBe(1)
      expect(v.t.writes.length).toBeGreaterThan(1) // data flows again
      const inflightNow = v.w.inflight()
      expect(inflightNow).toBeGreaterThan(0)
      stale() // the first write was parsed after all: it must not be counted twice
      expect(v.w.inflight()).toBe(inflightNow)
    })

    it('NEGATIVE CONTROL: with no ack timeout a terminal that never acks stays stalled', () => {
      const r = makeRig({ ackTimeoutMs: Number.POSITIVE_INFINITY })
      const v = r.add('v', 'visible')
      v.w(text(300_000))
      r.clock.frame()
      r.clock.advance(10_000)
      expect(v.t.writes).toHaveLength(1)
      expect(r.sch.stats().ackTimeouts).toBe(0)
    })
  })
})

// =============================================================================================================
// Priority: focused first, then visible, then hidden
// =============================================================================================================
describe('priority', () => {
  it('serves the focused terminal before the visible panes and those before the hidden ones, whatever the order they registered in', () => {
    const r = makeRig()
    const h = r.add('h', 'hidden')
    const v = r.add('v', 'visible')
    const f = r.add('f', 'focused')
    for (const p of [h, v, f]) p.w(text(20_000))
    r.clock.frame()
    expect(r.events.map((e) => e.id)).toEqual(['f', 'v', 'h'])
  })

  it('picks a change of class up at the next pass, with no notification', () => {
    const r = makeRig()
    const p = r.add('p', 'hidden')
    p.w(text(200_000))
    r.clock.frame()
    expect(lens(p.t)).toEqual([D.slice.hidden]) // hidden: one 32 KB slice
    p.t.ack()
    p.setClass('focused')
    r.clock.frame()
    expect(lens(p.t).slice(1)).toEqual([D.slice.focused, D.slice.focused]) // focused: 64 KB slices, two in flight
  })

  it('a saturated focused terminal leaves the others nothing but their starvation slices', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    const v = r.add('v', 'visible')
    const h = r.add('h', 'hidden')
    f.w(text(500_000))
    v.w(text(100_000))
    h.w(text(100_000))
    r.clock.frame()
    // everything the focused terminal may have in flight IS in flight, and the pool is its cap: nothing is left
    expect(f.w.inflight()).toBe(D.inflight.focused)
    expect(v.w.inflight()).toBe(0)
    expect(h.w.inflight()).toBe(0)
    expect(r.sch.stats().rationedPasses).toBe(1)
    for (let i = 0; i < 35; i++) r.clock.frame(16) // 560 ms of frames, as a visible window gets them
    expect(v.w.inflight()).toBe(D.starveSlice)
    expect(h.w.inflight()).toBe(D.starveSlice)
    expect(r.sch.stats().starveServes).toBe(2)
  })

  it('a focused terminal with little in flight leaves the others their caps, as far as the pool goes', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    const v = r.add('v', 'visible')
    const h = r.add('h', 'hidden')
    f.w(text(20_000))
    v.w(text(100_000))
    h.w(text(100_000))
    r.clock.frame()
    expect(f.w.inflight()).toBe(20_000)
    expect(v.w.inflight()).toBe(D.inflight.visible) // 128 KB pool - 20 KB leaves 108 KB: a visible pane's cap fits
    expect(h.w.inflight()).toBe(D.inflight.hidden) // and what is left of it, 42 KB, holds a hidden pane's
    expect(r.sch.stats().rationedPasses).toBe(0)
  })

  it('...and when the pool is what binds, the visible pane takes what is left of it, the hidden pane nothing', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    const v = r.add('v', 'visible')
    const h = r.add('h', 'hidden')
    f.w(text(100_000))
    v.w(text(100_000))
    h.w(text(100_000))
    r.clock.frame()
    expect(f.w.inflight()).toBe(100_000)
    expect(v.w.inflight()).toBe(D.pool - 100_000)
    expect(h.w.inflight()).toBe(0)
    expect(r.sch.stats().rationedPasses).toBe(1)
  })

  it('a focused terminal that was acked empty but has more queued refills first, and takes the pool for itself', () => {
    const r = makeRig({ ackTimeoutMs: Number.POSITIVE_INFINITY })
    const f = r.add('f', 'focused')
    const v = r.add('v', 'visible')
    f.w(text(500_000))
    r.clock.frame()
    f.t.ack() // xterm parsed all of it: it is idle, with 300 KB of output still queued behind what it had
    expect(f.w.pending()).toBeGreaterThan(0)
    v.w(text(100_000))
    r.clock.frame()
    expect(v.w.inflight()).toBe(0)
  })

  it('a focused terminal that only waits out a refusal does not ration the others: a stuck terminal must not punish them', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    const v = r.add('v', 'visible')
    f.t.refuse = () => true // xterm refuses everything: the terminal is going away
    f.w(text(500_000))
    r.clock.frame() // refused: back-off
    expect(f.w.pending()).toBe(500_000)
    expect(f.w.inflight()).toBe(0)
    v.w(text(100_000))
    r.clock.frame()
    expect(v.w.inflight()).toBe(D.inflight.visible) // handed its full cap, not rationed to nothing behind the stuck terminal
    expect(r.sch.stats().rationedPasses).toBe(0)
  })

  it('NEGATIVE CONTROL: without the pool the same pass hands the others their full caps', () => {
    const r = makeRig({ pool: Number.POSITIVE_INFINITY })
    const f = r.add('f', 'focused')
    const v = r.add('v', 'visible')
    const h = r.add('h', 'hidden')
    f.w(text(500_000))
    v.w(text(100_000))
    h.w(text(100_000))
    r.clock.frame()
    expect(v.w.inflight()).toBe(D.inflight.visible)
    expect(h.w.inflight()).toBe(D.inflight.hidden)
    expect(r.sch.stats().rationedPasses).toBe(0)
  })

  it('the others share one frame budget, the focused terminal comes off it, and the pane served longest ago goes first', () => {
    const r = makeRig({ frameBudget: D.slice.hidden, pool: Number.POSITIVE_INFINITY })
    const panes = [r.add('h1', 'hidden'), r.add('h2', 'hidden'), r.add('h3', 'hidden')]
    panes.forEach((p) => p.w(text(200_000)))
    const served: string[] = []
    for (let i = 0; i < 6; i++) {
      const before = r.events.length
      r.clock.frame()
      for (const e of r.events.slice(before)) served.push(e.id)
      panes.forEach((p) => p.t.ack())
    }
    // one slice of budget per frame, handed round the three panes
    expect(served).toEqual(['h1', 'h2', 'h3', 'h1', 'h2', 'h3'])
  })

  describe('when no frames come (a covered or minimised window)', () => {
    /** Advance whole watchdog periods only: the animation-frame callbacks never run, as in a hidden page. */
    function watchdogPass(r: Rig, panes: Pane[]): void {
      r.clock.advance(D.watchdogMs)
      panes.forEach((p) => p.t.ack())
    }

    it('the timer drains the panes without a frame, and what the others may be handed per pass is scaled to the longer interval', () => {
      const r = makeRig()
      const panes = Array.from({ length: 8 }, (_, i) => r.add(`h${i}`, 'hidden'))
      panes.forEach((p) => p.w(text(1_000_000)))
      expect(r.clock.pendingFrames()).toBeGreaterThan(0)
      watchdogPass(r, panes)
      expect(r.sch.stats().timerTicks).toBe(1)
      // pool 128 KB x 6 = 768 KB: more than eight hidden panes' caps (8 x 32 KB) add up to, so all are filled
      panes.forEach((p) => expect(p.t.writes.length).toBeGreaterThan(0))
      const handed = panes.reduce((n, p) => n + p.t.joined().length, 0)
      expect(handed).toBe(8 * D.inflight.hidden)
    })

    it('NEGATIVE CONTROL: the same panes on a frame get one pool (128 KB) per pass, not the six it would take to keep up with 100 ms', () => {
      const r = makeRig()
      const panes = Array.from({ length: 8 }, (_, i) => r.add(`h${i}`, 'hidden'))
      panes.forEach((p) => p.w(text(1_000_000)))
      r.clock.frame()
      expect(r.sch.stats().timerTicks).toBe(0)
      const handed = panes.reduce((n, p) => n + p.t.joined().length, 0)
      expect(handed).toBe(D.pool)
    })

    it('while a key is going in a frame clock exists, so the scale is not applied: the typing frame budget (32 KB) binds, not six passes\' worth', () => {
      const r = makeRig()
      const f = r.add('f', 'focused')
      const hidden = Array.from({ length: 12 }, (_, i) => r.add(`h${i}`, 'hidden'))
      hidden.forEach((h) => h.w(text(200_000)))
      f.w.typed('k')
      r.clock.advance(D.watchdogMs) // only the timer ran, but a key is 100 ms old
      expect(r.sch.stats().timerTicks).toBeGreaterThan(0)
      const handed = hidden.reduce((n, h) => n + h.t.joined().length, 0)
      expect(handed).toBe(D.frameBudgetTyping) // 4 hidden panes' typing slices (8 KB each) use up the 32 KB budget; scaled by 6 it would be all twelve
    })

    it('NEGATIVE CONTROL: the same twelve panes with nobody typing get the scaled pool on a timer pass: all of them, to their caps', () => {
      const r = makeRig()
      const hidden = Array.from({ length: 12 }, (_, i) => r.add(`h${i}`, 'hidden'))
      hidden.forEach((h) => h.w(text(200_000)))
      r.clock.advance(D.watchdogMs)
      const handed = hidden.reduce((n, h) => n + h.t.joined().length, 0)
      expect(handed).toBe(12 * D.inflight.hidden) // 12 x 32 KB = 384 KB, under the scaled pool (768 KB)
    })
  })

  it('the singleton is one scheduler per renderer', () => {
    const a = getWriteScheduler()
    expect(getWriteScheduler()).toBe(a)
    resetWriteScheduler()
    expect(getWriteScheduler()).not.toBe(a)
  })
})

// =============================================================================================================
// Typing
// =============================================================================================================
describe('typing', () => {
  it('shrinks the focused slices to 16 KB and its cap to 64 KB, and its output no longer waits for the frame', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    f.w.typed('a')
    f.w(text(1_000_000)) // a key is going in: handed over at once, not at the next frame
    expect(lens(f.t)).toEqual([16_384, 16_384, 16_384, 16_384])
    expect(f.w.inflight()).toBe(D.inflightTyping.focused)
  })

  it('NEGATIVE CONTROL: with nobody typing the same terminal waits for the frame and takes 64 KB slices', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    f.w(text(1_000_000))
    expect(f.t.writes).toEqual([])
    r.clock.frame()
    expect(lens(f.t)).toEqual([65_536, 65_536])
  })

  it('rations the others to what is left of the frame: 32 KB between them, not 128 KB', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    const v1 = r.add('v1', 'visible')
    const v2 = r.add('v2', 'visible')
    v1.w(text(100_000))
    v2.w(text(100_000))
    f.w.typed('a')
    r.clock.frame()
    expect(lens(v1.t)).toEqual([8_192, 8_192])
    expect(lens(v2.t)).toEqual([8_192, 8_192])
    expect(r.sch.stats().rationedPasses).toBe(0) // all of them were served from the budget
  })

  it('NEGATIVE CONTROL: with nobody typing the same two panes take 64 KB each', () => {
    const r = makeRig()
    r.add('f', 'focused')
    const v1 = r.add('v1', 'visible')
    const v2 = r.add('v2', 'visible')
    v1.w(text(100_000))
    v2.w(text(100_000))
    r.clock.frame()
    expect(lens(v1.t)).toEqual([65_536])
    expect(lens(v2.t)).toEqual([65_536])
  })

  it('lasts 300 ms from the last key', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w.typed('a')
    v.w.typed('b') // the typed pane counts as focused while typing; take the key from another terminal
    const other = r.add('other', 'visible')
    other.w(text(100_000))
    r.clock.advance(284)
    r.clock.frame(0)
    expect(lens(other.t)).toEqual([8_192, 8_192]) // still typing: the visible typing slice
    other.t.ack()
    r.clock.advance(16) // 300 ms since the last key
    r.clock.frame(0)
    expect(lens(other.t).slice(2)).toEqual([65_536]) // typing is over
  })

  it('a clock that goes backwards does not leave typing on', () => {
    const clock = makeManualClock()
    let offset = 0
    const realNow = clock.now
    clock.now = () => realNow() + offset // the scheduler copies the clock when it is made: set this first
    const sch = createWriteScheduler({ clock })
    const t = makeFakeTerm('v')
    const v = sch.attach('v', { write: t.write, classify: () => 'visible' })
    sch.noteKey('v', 'k')
    offset = -10_000 // the clock restarted: "now" is before the last key
    v(text(100_000))
    clock.frame()
    expect(lens(t)).toEqual([D.slice.visible]) // not the typing slice: nobody is typing
  })

  it('NEGATIVE CONTROL: with the clock going forward as usual the same terminal is still in the typing window', () => {
    const clock = makeManualClock()
    const sch = createWriteScheduler({ clock })
    const t = makeFakeTerm('v')
    const v = sch.attach('v', { write: t.write, classify: () => 'visible' })
    sch.noteKey('v', 'k')
    clock.advance(100)
    v(text(100_000))
    clock.frame(0)
    expect(lens(t)[0]).toBe(D.sliceTyping.focused) // the terminal a key went into is treated as focused, with the typing slice
  })

  it('does not start for what the terminal itself sends back', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    for (const report of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[24;80R', '\x1b]11;rgb:0/0/0\x07']) f.w.typed(report)
    expect(r.sch.stats().keys).toBe(0)
    f.w.typed('a')
    expect(r.sch.stats().keys).toBe(1)
  })

  it('treats the terminal a key went into as the focused one, whatever the store has caught up with', () => {
    const r = makeRig()
    const p = r.add('p', 'visible')
    p.w.typed('a')
    p.w(text(100_000))
    expect(lens(p.t)).toEqual([16_384, 16_384, 16_384, 16_384]) // the focused typing slice (a visible pane would take 8 KB)
  })

  /** Types a key whenever the last one is 100 ms old, through `ms` of frames. Returns the times a hidden pane was handed something. */
  function typeWhileFrames(r: Rig, f: Pane, h: Pane, ms: number): number[] {
    const at: number[] = []
    let seen = 0
    let lastKey = Number.NEGATIVE_INFINITY
    const end = r.clock.now() + ms
    while (r.clock.now() < end) {
      if (r.clock.now() - lastKey >= 100) {
        f.w.typed('a')
        lastKey = r.clock.now()
      }
      r.clock.frame()
      h.t.ack()
      if (h.t.writes.length > seen) {
        seen = h.t.writes.length
        at.push(r.clock.now())
      }
    }
    return at
  }

  it('a terminal that waits is still handed a slice every 500 ms, however long the typing goes on', () => {
    const r = makeRig({ poolTyping: 0, frameBudgetTyping: 0 }) // nothing for the others but the guarantee
    const f = r.add('f', 'focused')
    const h = r.add('h', 'hidden')
    h.w(text(10_000_000))
    const at = typeWhileFrames(r, f, h, 6_000)
    expect(at.length).toBeGreaterThanOrEqual(10)
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(D.starvationMs)
      expect(at[i] - at[i - 1]).toBeLessThanOrEqual(D.starvationMs + 32) // 500 ms and the frame it lands in
    }
    for (const d of h.t.writes) expect(d.length).toBeLessThanOrEqual(D.starveSlice)
    expect(r.sch.stats().starveServes).toBe(h.t.writes.length)
  })

  it('NEGATIVE CONTROL: without the guarantee the same terminal is not served at all while typing goes on', () => {
    const r = makeRig({ poolTyping: 0, frameBudgetTyping: 0, starvationMs: Number.POSITIVE_INFINITY })
    const f = r.add('f', 'focused')
    const h = r.add('h', 'hidden')
    h.w(text(10_000_000))
    typeWhileFrames(r, f, h, 6_000)
    expect(h.t.writes.length).toBe(0)
  })

  it('does not ration a terminal a resize is waiting on, nor one whose backlog is too big to keep in strings', () => {
    const r = makeRig({ poolTyping: 0, holdCapChars: 50_000 })
    const f = r.add('f', 'focused')
    const waited = r.add('waited', 'visible')
    const plain = r.add('plain', 'visible')
    const big = r.add('big', 'visible')
    waited.w(text(40_000))
    plain.w(text(40_000))
    big.w(text(100_000)) // over holdCapChars
    waited.w.whenDrained(() => undefined, 60_000)
    f.w.typed('a')
    r.clock.frame()
    expect(waited.w.inflight()).toBeGreaterThan(0)
    expect(plain.w.inflight()).toBe(0) // rationed: the pool is 0
    expect(big.w.inflight()).toBeGreaterThan(0)
  })

  it('NEGATIVE CONTROL: the same panes without a wait or a big backlog are all rationed', () => {
    const r = makeRig({ poolTyping: 0, holdCapChars: 50_000 })
    const f = r.add('f', 'focused')
    const panes = [r.add('a', 'visible'), r.add('b', 'visible'), r.add('c', 'visible')]
    panes.forEach((p) => p.w(text(40_000)))
    f.w.typed('a')
    r.clock.frame()
    panes.forEach((p) => expect(p.w.inflight()).toBe(0))
  })
})

// =============================================================================================================
// A chunk xterm refuses is kept and offered again (the policy of the output throttle)
// =============================================================================================================
describe('refused chunks', () => {
  it('stay at the head and are offered again, then with a growing delay: every byte arrives once, in order', () => {
    const r = makeRig()
    const p = r.add('p', 'visible')
    p.t.refuse = (_d, attempt) => attempt < 3
    const input = text(5_000)
    p.w(input)
    for (let i = 0; i < 100 && p.t.writes.length === 0; i++) r.clock.frame(100)
    expect(p.t.writes).toEqual([input])
    expect(r.sch.stats().refusals).toBe(3)
    expect(p.errors).toHaveLength(1) // the first refusal is reported, not every retry
    expect(p.errors[0].info).toEqual({ attempt: 1, dropped: false, chars: input.length })
  })

  it('wait for the delay: not before 200 ms after the second refusal', () => {
    const r = makeRig()
    const p = r.add('p', 'visible')
    let attempts = 0
    p.t.refuse = () => { attempts++; return true }
    p.w('data') // a small write to an idle pane is tried at once: refusal 1
    expect(attempts).toBe(1)
    r.clock.frame() // the next pass retries at once: refusal 2, and then 200 ms
    expect(attempts).toBe(2)
    for (let i = 0; i < 5; i++) r.clock.frame() // 80 ms later: still waiting
    expect(attempts).toBe(2)
    r.clock.advance(150)
    r.clock.frame(0)
    expect(attempts).toBe(3)
  })

  it('are dropped after MAX_WRITE_RETRIES refusals in a row, which is reported, and what came next goes through', () => {
    const r = makeRig()
    const p = r.add('p', 'visible')
    p.t.refuse = () => true
    p.w('AAAA')
    for (let i = 0; i < MAX_WRITE_RETRIES + 5; i++) {
      r.clock.advance(2_500)
      r.clock.frame(0)
    }
    expect(r.sch.stats().drops).toBe(1)
    expect(r.sch.stats().refusals).toBe(MAX_WRITE_RETRIES + 1)
    expect(p.errors.map((e) => e.info)).toEqual([
      { attempt: 1, dropped: false, chars: 4 },
      { attempt: MAX_WRITE_RETRIES + 1, dropped: true, chars: 4 },
    ])
    p.t.refuse = null
    p.w('BBBB')
    r.clock.frame()
    expect(p.t.writes).toEqual(['BBBB'])
  })

  it('a refused echo is kept as well: it is offered again at the next pass', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    f.t.refuse = (_d, attempt) => attempt < 1
    f.w('echo')
    expect(f.t.writes).toEqual([])
    expect(f.w.pending()).toBe(4)
    expect(f.errors).toHaveLength(1)
    r.clock.frame()
    expect(f.t.writes).toEqual(['echo'])
  })

  it('a drop lets a resize that waited on the chunk go ahead', () => {
    const r = makeRig()
    const p = r.add('p', 'visible')
    p.t.refuse = () => true
    p.w('AAAA')
    const cb = vi.fn()
    p.w.whenDrained(cb, 600_000)
    for (let i = 0; i < MAX_WRITE_RETRIES + 5; i++) {
      r.clock.advance(2_500)
      r.clock.frame(0)
    }
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a reporter that throws does not stop the scheduler', () => {
    const r = makeRig()
    const t = makeFakeTerm('p', r.events)
    t.refuse = (_d, attempt) => attempt < 1
    const w = r.sch.attach('p', { write: t.write, classify: () => 'visible', onError: () => { throw new Error('reporter') } })
    w('data')
    r.clock.frame()
    r.clock.frame()
    expect(t.writes).toEqual(['data'])
    expect(r.internal).toEqual([])
  })
})

// =============================================================================================================
// drained(id): what a resize waits on
// =============================================================================================================
describe('drained', () => {
  it('answers at once when nothing is queued, and for an id nobody registered', () => {
    const r = makeRig()
    const p = r.add('p', 'focused')
    const a = vi.fn()
    const b = vi.fn()
    p.w.whenDrained(a, 1_000)
    r.sch.drained('nobody', b, 1_000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('waits until every char pushed before the call has been HANDED to xterm, not parsed by it', () => {
    const r = makeRig()
    const f = r.add('f', 'focused')
    f.w(text(300_000))
    const cb = vi.fn()
    r.sch.drained('f', cb, 60_000)
    r.clock.frame() // 128 KB handed
    expect(cb).not.toHaveBeenCalled()
    f.t.ack(1) // refill: 192 KB handed
    expect(cb).not.toHaveBeenCalled()
    f.t.ack(1) // refill: 256 KB handed
    expect(cb).not.toHaveBeenCalled()
    f.t.ack(1) // the last 44 KB are handed
    expect(cb).toHaveBeenCalledTimes(1)
    expect(f.t.unackedChars()).toBeGreaterThan(0) // xterm has not parsed it all: the resize's own barrier covers that
  })

  it('chars that arrive after the call do not hold it back', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w(text(50_000))
    const cb = vi.fn()
    v.w.whenDrained(cb, 60_000)
    v.w(text(500_000)) // later output
    r.clock.frame()
    expect(cb).toHaveBeenCalledTimes(1) // the first 50 KB are out: that is all it waited for
  })

  it('gives up after maxWaitMs, once, and never again', () => {
    const r = makeRig({ ackTimeoutMs: Number.POSITIVE_INFINITY })
    const v = r.add('v', 'visible')
    v.w(text(500_000))
    r.clock.frame() // a cap's worth in flight, never acked: stuck
    const cb = vi.fn()
    v.w.whenDrained(cb, 1_000)
    r.clock.advance(999)
    expect(cb).not.toHaveBeenCalled()
    r.clock.advance(2)
    expect(cb).toHaveBeenCalledTimes(1)
    v.t.ack()
    drainAll(r, v)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('can be cancelled', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w(text(50_000))
    const cb = vi.fn()
    const cancel = v.w.whenDrained(cb, 60_000)
    cancel()
    r.clock.frame()
    r.clock.advance(120_000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('a wait on a pane that goes away is dropped silently: a resize must not reach a pty that is going', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w(text(50_000))
    const cb = vi.fn()
    v.w.whenDrained(cb, 5_000)
    v.w.detach()
    r.clock.advance(10_000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('a wait that another wait cancels while they are being served is not served: it is already gone', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w(text(50_000))
    const second = vi.fn()
    let cancelSecond: () => void = () => undefined
    v.w.whenDrained(() => cancelSecond(), 60_000) // served first, and cancels the second
    cancelSecond = v.w.whenDrained(second, 60_000)
    r.clock.frame()
    expect(second).not.toHaveBeenCalled()
    r.clock.advance(120_000)
    expect(second).not.toHaveBeenCalled()
  })

  it('a wait of 0 ms (or NaN) is answered at the next timer turn, not never', () => {
    const r = makeRig({ ackTimeoutMs: Number.POSITIVE_INFINITY })
    const v = r.add('v', 'visible')
    v.w(text(500_000))
    r.clock.frame() // a cap in flight, never acked: stuck
    const zero = vi.fn()
    const nan = vi.fn()
    v.w.whenDrained(zero, 0)
    v.w.whenDrained(nan, Number.NaN)
    r.clock.advance(0)
    expect(zero).toHaveBeenCalledTimes(1)
    expect(nan).toHaveBeenCalledTimes(1)
  })

  it('cancelling a wait that was already answered does nothing', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w(text(50_000))
    const cb = vi.fn()
    const cancel = v.w.whenDrained(cb, 60_000)
    r.clock.frame()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(() => cancel()).not.toThrow()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a callback that throws is reported, not thrown into the scheduler', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const r = makeRig()
      const v = r.add('v', 'visible')
      v.w(text(50_000))
      v.w.whenDrained(() => { throw new Error('resize failed') }, 5_000)
      expect(() => r.clock.frame()).not.toThrow()
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

// =============================================================================================================
// Panes come and go
// =============================================================================================================
describe('attach and detach', () => {
  it('a detached pane drops its queue, ignores later writes and stale acks, and no longer counts', () => {
    const r = makeRig()
    const v = r.add('v', 'visible')
    v.w(text(300_000))
    r.clock.frame()
    expect(r.sch.stats().panes).toBe(1)
    const ack = v.t.unacked[0].ack
    v.w.detach()
    expect(r.sch.stats().panes).toBe(0)
    expect(r.sch.stats().queuedChars).toBe(0)
    const writes = v.t.writes.length
    v.w('more')
    ack()
    r.clock.frame()
    expect(v.t.writes).toHaveLength(writes)
    expect(r.sch.pending('v')).toBe(0)
  })

  it('detaching twice is harmless, and a writer that is detached after its pane was replaced does not disturb the new one', () => {
    const r = makeRig()
    const old = r.add('same', 'visible')
    const fresh = r.add('same', 'visible')
    old.w.detach()
    old.w.detach()
    fresh.w(text(20_000))
    expect(r.sch.stats().panes).toBe(1)
    r.clock.frame()
    expect(fresh.t.joined()).toHaveLength(20_000)
    fresh.w.detach()
    fresh.w.detach()
    expect(r.sch.stats().panes).toBe(0)
  })

  it('a pane that mounts again under the same id takes over; the one it replaces goes quiet', () => {
    const r = makeRig()
    const old = r.add('same', 'visible')
    old.w(text(20_000))
    const fresh = r.add('same', 'visible')
    expect(r.sch.stats().panes).toBe(1)
    old.w('lost') // the old writer is gone
    fresh.w('kept')
    r.clock.frame()
    expect(old.t.writes).toEqual([])
    expect(fresh.t.writes).toEqual(['kept'])
  })

  it('the pane a new one replaces gives its queue up and its waits are dropped: a resize waiting on a dead pane never runs', () => {
    const r = makeRig()
    const old = r.add('same', 'visible')
    old.w(text(200_000))
    const waited = vi.fn()
    old.w.whenDrained(waited, 5_000)
    expect(old.w.pending()).toBeGreaterThan(0)
    r.add('same', 'visible') // the remount
    expect(old.w.pending()).toBe(0) // the old queue is gone, not kept alive in a closure
    r.clock.advance(60_000)
    expect(waited).not.toHaveBeenCalled()
  })

  it('dispose detaches everything and stops the clocks', () => {
    const r = makeRig()
    const a = r.add('a', 'visible')
    a.w(text(20_000))
    expect(r.clock.pendingFrames() + r.clock.pendingTimers()).toBeGreaterThan(0)
    r.sch.dispose()
    expect(r.sch.stats().panes).toBe(0)
    expect(r.clock.pendingFrames()).toBe(0)
    expect(r.clock.pendingTimers()).toBe(0)
  })
})

// =============================================================================================================
// FAILS OPEN: a bug in the scheduler must not stop the output
// =============================================================================================================
describe('failing open', () => {
  /** A queue that throws from take() once, the way a bug in the scheduler's own code would. */
  function flakyQueue(): { queue: ChunkQueue; arm(): void } {
    const q = createChunkQueue()
    let armed = false
    return {
      arm: () => { armed = true },
      queue: {
        get length() { return q.length },
        get chunks() { return q.chunks },
        get reads() { return q.reads },
        get work() { return q.work },
        push: (d) => q.push(d),
        take: (n) => {
          if (armed) { armed = false; throw new Error('bug in the scheduler') }
          return q.take(n)
        },
        restore: (t) => q.restore(t),
        takeAll: () => q.takeAll(),
        clear: () => q.clear(),
      },
    }
  }

  it('an exception in a pass switches to pass-through: what was queued goes out in order, later writes go straight through', () => {
    const r = makeRig()
    const f = flakyQueue()
    const p = r.add('p', 'visible', { queue: f.queue })
    const input = text(200_000)
    p.w(input.slice(0, 120_000))
    f.arm()
    r.clock.frame() // take() throws: the scheduler gives up scheduling
    expect(r.sch.stats().bypassed).toBe(true)
    expect(r.internal).toHaveLength(1)
    p.w(input.slice(120_000))
    expect(p.t.joined()).toBe(input) // all of it, in order, with no frame needed
    expect(p.w.pending()).toBe(0)
  })

  it('waits are answered at once once it has failed open', () => {
    const r = makeRig()
    const f = flakyQueue()
    const p = r.add('p', 'visible', { queue: f.queue })
    p.w(text(120_000))
    const cb = vi.fn()
    p.w.whenDrained(cb, 60_000)
    f.arm()
    r.clock.frame()
    expect(cb).toHaveBeenCalledTimes(1)
    const later = vi.fn()
    p.w.whenDrained(later, 60_000)
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('a write that breaks inside the pass does not lose the chunk that was being written (it is the data that matters)', () => {
    const r = makeRig()
    const f = flakyQueue()
    const p = r.add('p', 'focused', { queue: f.queue })
    f.arm()
    const big = text(20_000)
    p.w.typed('a') // typing: a focused write is handed at once, inside push()
    p.w(big) // take() throws inside push(): the chunk is queued first, then flushed by the fallback
    expect(r.sch.stats().bypassed).toBe(true)
    expect(p.t.joined()).toBe(big)
  })
})

/** A chunk queue that behaves, except that `take` (and optionally `length`) are the test's. */
function queueWith(take?: (n: number) => string, length?: () => number): ChunkQueue {
  const q = createChunkQueue()
  return {
    get length() { return length ? length() : q.length },
    get chunks() { return q.chunks },
    get reads() { return q.reads },
    get work() { return q.work },
    push: (d) => q.push(d),
    restore: (x) => q.restore(x),
    takeAll: () => q.takeAll(),
    clear: () => q.clear(),
    take: take ?? ((n) => q.take(n)),
  }
}

// =============================================================================================================
// The clocks and the classifier: the defaults a real renderer has, and what happens when they misbehave
// =============================================================================================================
describe('the real clocks', () => {
  afterEach(() => { vi.useRealTimers() })

  it('without requestAnimationFrame the timer alone drives the passes (a page with no frame clock)', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    vi.stubGlobal('cancelAnimationFrame', undefined)
    const sch = createWriteScheduler() // the default clock
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    w(text(20_000))
    expect(t.writes).toEqual([])
    vi.advanceTimersByTime(100)
    expect(t.joined()).toHaveLength(20_000)
    expect(sch.stats().timerTicks).toBe(1)
    sch.dispose()
  })

  it('with requestAnimationFrame the frame wins the race and cancels the timer', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16))
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
    const sch = createWriteScheduler()
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    w(text(20_000))
    vi.advanceTimersByTime(16)
    expect(t.joined()).toHaveLength(20_000)
    expect(sch.stats().timerTicks).toBe(0)
    expect(vi.getTimerCount()).toBe(0) // the watchdog was cancelled with the frame
    sch.dispose()
  })

  it('without performance.now the wall clock is read instead', () => {
    vi.useFakeTimers()
    vi.stubGlobal('performance', undefined)
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16))
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
    const sch = createWriteScheduler()
    const t = makeFakeTerm('v')
    const v = sch.attach('v', { write: t.write, classify: () => 'visible' })
    sch.noteKey('v', 'k')
    v(text(100_000))
    expect(t.writes.length).toBeGreaterThan(0) // typing is on (the typed pane is focused): handed at once, in typing slices
    vi.advanceTimersByTime(400)
    t.ack()
    v(text(100_000))
    vi.advanceTimersByTime(16)
    expect(lens(t).slice(-1)[0]).toBe(D.slice.visible) // 400 ms on the wall clock: typing is over
    sch.dispose()
    vi.unstubAllGlobals()
  })
})

describe('the classifier', () => {
  it('a classify that throws, or answers with something that is not a class, makes the pane a visible one', () => {
    const r = makeRig()
    const t1 = makeFakeTerm('throws')
    const t2 = makeFakeTerm('weird')
    const w1 = r.sch.attach('throws', { write: t1.write, classify: () => { throw new Error('store gone') } })
    const w2 = r.sch.attach('weird', { write: t2.write, classify: () => 'banana' as unknown as PaneClass })
    w1(text(200_000))
    w2(text(200_000))
    r.clock.frame()
    expect(lens(t1)).toEqual([D.slice.visible])
    expect(lens(t2)).toEqual([D.slice.visible])
  })
})

describe('a writer that calls back into the scheduler', () => {
  it('a write that pushes more output to its own pane (xterm answering a query) is queued behind, in order, once', () => {
    const r = makeRig()
    const seen: string[] = []
    let once = true
    let w!: PaneWriter
    w = r.sch.attach('p', {
      write: (d, ack) => {
        seen.push(d)
        if (once) { once = false; w('AFTER') } // re-entrant: while this very hand-over is running
        ack()
      },
      classify: () => 'focused',
    })
    w(text(20_000))
    r.clock.frame()
    r.clock.frame()
    expect(seen.join('')).toBe(text(20_000) + 'AFTER')
    expect(w.pending()).toBe(0)
    expect(w.inflight()).toBe(0)
  })

  it('a write that pushes to its own typed pane while the hand-over runs: queued behind it, and nothing is handed twice', () => {
    const r = makeRig()
    const seen: string[] = []
    let once = true
    let w!: PaneWriter
    w = r.sch.attach('p', {
      write: (d, ack) => {
        seen.push(d)
        if (once) { once = false; w('AFTER'.repeat(5_000)) } // re-entrant, and a key is going in: push() would serve the pane
        ack()
      },
      classify: () => 'focused',
    })
    w.typed('k')
    w(text(40_000))
    r.clock.frame()
    expect(seen.join('')).toBe(text(40_000) + 'AFTER'.repeat(5_000))
    expect(w.pending()).toBe(0)
  })

  it('a refusal that detaches the pane first leaves no negative in-flight behind', () => {
    const r = makeRig()
    let w!: PaneWriter
    w = r.sch.attach('p', {
      write: () => { w.detach(); throw new Error('torn down') },
      classify: () => 'visible',
      onError: () => undefined,
    })
    w(text(20_000))
    r.clock.frame()
    expect(w.inflight()).toBe(0)
    expect(r.sch.stats().panes).toBe(0)
  })
})

describe('failing open, the other ways', () => {
  function brokenClock(): { clock: ManualClock; breakNow: () => void; breakCancel: () => void } {
    const clock = makeManualClock()
    const realNow = clock.now
    const realCancel = clock.cancelFrame
    let nowBoom = false
    let cancelBoom = false
    clock.now = () => { if (nowBoom) { nowBoom = false; throw new Error('clock') } return realNow() }
    clock.cancelFrame = (h) => { if (cancelBoom) throw new Error('cancelFrame'); realCancel(h) }
    return { clock, breakNow: () => { nowBoom = true }, breakCancel: () => { cancelBoom = true } }
  }

  it('a clock that throws while a write arrives fails open and loses nothing: the chunk is queued first, then flushed', () => {
    const { clock, breakNow } = brokenClock()
    const internal: unknown[] = []
    const sch = createWriteScheduler({ clock, onInternalError: (e) => internal.push(e) })
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    breakNow()
    w('data that must survive')
    expect(sch.stats().bypassed).toBe(true)
    expect(internal).toHaveLength(1)
    expect(t.joined()).toBe('data that must survive')
  })

  it('an exception inside an ack (the refill of the focused terminal) fails open, and what was queued goes out in order', () => {
    const r = makeRig()
    const q = createChunkQueue()
    let armed = false
    const queue: ChunkQueue = {
      get length() { return q.length }, get chunks() { return q.chunks }, get reads() { return q.reads }, get work() { return q.work },
      push: (d) => q.push(d), restore: (x) => q.restore(x), takeAll: () => q.takeAll(), clear: () => q.clear(),
      take: (n) => { if (armed) { armed = false; throw new Error('bug in the refill') } return q.take(n) },
    }
    const p = r.add('p', 'focused', { queue })
    const input = text(400_000)
    p.w(input)
    r.clock.frame()
    armed = true
    p.t.ack(1) // xterm acks: the refill throws inside the ack wrapper
    expect(r.sch.stats().bypassed).toBe(true)
    p.w('')
    p.t.ack()
    expect(p.t.joined()).toBe(input) // everything, once, in order
  })

  it('a second failure after it has failed open (a clock that throws inside a late ack) is not reported or flushed again', () => {
    const { clock, breakNow } = brokenClock()
    const internal: unknown[] = []
    const sch = createWriteScheduler({ clock, onInternalError: (e) => internal.push(e) })
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    w(text(100_000))
    clock.frame() // handed to xterm, never acked
    expect(t.unacked.length).toBeGreaterThan(0)
    breakNow()
    w('x') // the clock throws inside push: fails open
    expect(sch.stats().bypassed).toBe(true)
    expect(internal).toHaveLength(1)
    const writes = t.writes.length
    breakNow()
    expect(() => t.ack()).not.toThrow() // a late ack: the clock throws again inside it
    expect(internal).toHaveLength(1) // not reported again
    expect(t.writes.length).toBe(writes) // and nothing flushed again
  })

  it('with no reporter given the failure goes to reportError (or the console), as an uncaught error would', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { clock, breakNow } = brokenClock()
    const sch = createWriteScheduler({ clock }) // no onInternalError
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    breakNow()
    w('x')
    expect(t.joined()).toBe('x')
    expect(spy.mock.calls.length + (typeof (globalThis as { reportError?: unknown }).reportError === 'function' ? 1 : 0)).toBeGreaterThan(0)
    spy.mockRestore()
  })

  it('a reporter that throws does not stop it failing open', () => {
    const { clock, breakNow } = brokenClock()
    const sch = createWriteScheduler({ clock, onInternalError: () => { throw new Error('reporter') } })
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    breakNow()
    expect(() => w('x')).not.toThrow()
    expect(t.joined()).toBe('x')
  })

  it('a cancelFrame that throws does not stop it failing open, and a frame that still fires afterwards does nothing', () => {
    const { clock, breakCancel } = brokenClock()
    const frames: Array<() => void> = []
    const realRequest = clock.requestFrame
    clock.requestFrame = (cb) => { frames.push(cb); return realRequest(cb) } // keep the callbacks: a real rAF could still deliver one
    const internal: unknown[] = []
    const sch = createWriteScheduler({ clock, onInternalError: (e) => internal.push(e) })
    const t = makeFakeTerm('p')
    const w = sch.attach('p', { write: t.write, classify: () => 'visible' })
    w(text(200_000)) // armed: a frame and a timer are pending
    const flaky = sch.attach('flaky', { write: t.write, classify: () => 'visible', queue: queueWith(() => { throw new Error('bug') }) })
    flaky('boom')
    breakCancel()
    expect(() => clock.frame()).not.toThrow() // the pass throws, and so does disarm: it fails open, and the frame callback does not throw
    expect(sch.stats().bypassed).toBe(true)
    expect(internal.length).toBeGreaterThan(0)
    const writes = t.writes.length
    expect(frames.length).toBeGreaterThan(0)
    for (const cb of frames) expect(() => cb()).not.toThrow() // frames that arrive late (the cancel failed)
    expect(t.writes.length).toBe(writes) // and do nothing: it has failed open
  })

  it('in pass-through a write that xterm refuses is kept, and offered again with the next write, in order', () => {
    const r = makeRig()
    const q = createChunkQueue()
    let boom = false
    const queue: ChunkQueue = {
      get length() { return q.length }, get chunks() { return q.chunks }, get reads() { return q.reads }, get work() { return q.work },
      push: (d) => q.push(d), restore: (x) => q.restore(x), takeAll: () => q.takeAll(), clear: () => q.clear(),
      take: (n) => { if (boom) { boom = false; throw new Error('bug') } return q.take(n) },
    }
    const p = r.add('p', 'visible', { queue })
    p.w(text(100_000))
    boom = true
    r.clock.frame() // fails open
    expect(r.sch.stats().bypassed).toBe(true)
    p.t.refuse = (_d, attempt) => attempt < 1 // xterm refuses the next write once
    p.w('first')
    expect(p.w.pending()).toBeGreaterThan(0) // kept
    p.t.refuse = null
    p.w('second')
    expect(p.t.joined()).toBe(text(100_000) + 'firstsecond')
    expect(p.w.pending()).toBe(0)
  })

  it('a flush that throws while failing open is reported, and the other panes are still flushed', () => {
    const r = makeRig()
    r.add('bad', 'visible', { queue: queueWith(() => { throw new Error('bug in take') }, () => 1) }) // always "has" a char, and cannot give it
    const good = r.add('good', 'visible')
    good.w(text(100_000)) // queued for the frame
    r.clock.frame() // the pass throws on `bad`: it fails open; flushing `bad` throws again
    expect(r.sch.stats().bypassed).toBe(true)
    expect(good.t.joined()).toBe(text(100_000))
    expect(r.internal.length).toBeGreaterThanOrEqual(2)
  })
})

// =============================================================================================================
// FUZZ: any interleaving of 10 terminals' arrivals, acks, frames, typing and focus changes
// =============================================================================================================
describe('fuzz: 10 terminals, any interleaving', () => {
  interface Outcome {
    mismatches: number
    unaccounted: number
    overBound: number
    focusedMax: number
    orderViolations: number
    framesChecked: number
    waitViolations: number
    waitsAnswered: number
    waitsMade: number
    stalled: boolean
    drops: number
  }

  const RANK: Record<PaneClass, number> = { focused: 0, visible: 1, hidden: 2 }

  const memo = new Map<string, Outcome>()
  function fuzz(seed: number, o: { refusals?: boolean; steps?: number } = {}): Outcome {
    const key = `${seed}:${o.refusals ? 'r' : ''}:${o.steps ?? ''}`
    const hit = memo.get(key)
    if (hit) return hit
    const out = fuzzRun(seed, o)
    memo.set(key, out)
    return out
  }

  function fuzzRun(seed: number, o: { refusals?: boolean; steps?: number } = {}): Outcome {
    const rand = prng(seed)
    const T = 10
    const r = makeRig({ ackTimeoutMs: Number.POSITIVE_INFINITY })
    const panes = Array.from({ length: T }, (_, i) => r.add(`t${i}`, i === 0 ? 'focused' : i < 3 ? 'visible' : 'hidden'))
    const classes: PaneClass[] = panes.map((_, i) => (i === 0 ? 'focused' : i < 3 ? 'visible' : 'hidden'))
    const sent: string[] = Array(T).fill('')
    let counter = 0
    let lastKey = Number.NEGATIVE_INFINITY
    let typedOn = -1
    const out: Outcome = {
      mismatches: 0, unaccounted: 0, overBound: 0, focusedMax: 0, orderViolations: 0, framesChecked: 0,
      waitViolations: 0, waitsAnswered: 0, waitsMade: 0, stalled: false, drops: 0,
    }
    const bound = D.inflight.focused + D.smallWrite
    if (o.refusals) panes.forEach((p) => { p.t.refuse = () => rand() < 0.15 })

    const waits: Array<{ reg: number; i: number; need: number; fired: boolean }> = []

    const check = (): void => {
      panes.forEach((p, i) => {
        if (p.w.inflight() !== p.t.unackedChars()) out.mismatches++
        if (p.w.inflight() > bound) out.overBound++
        if (i === 0) out.focusedMax = Math.max(out.focusedMax, p.w.inflight())
        // everything pushed is somewhere: queued here, in flight, or parsed
        const parsed = p.t.writtenChars - p.t.unackedChars()
        if (p.w.pending() + p.w.inflight() + parsed !== sent[i].length) out.unaccounted++
      })
    }

    for (let step = 0; step < (o.steps ?? 500); step++) {
      const roll = rand()
      if (roll < 0.4) {
        const i = Math.floor(rand() * T)
        const k = rand()
        const n = k < 0.3 ? 1 + Math.floor(rand() * 40) : k < 0.5 ? D.smallWrite - 1 + Math.floor(rand() * 3) : k < 0.85 ? 500 + Math.floor(rand() * 30_000) : 60_000 + Math.floor(rand() * 90_000)
        const chunk = text(n, counter++ * 977)
        sent[i] += chunk
        panes[i].w(chunk)
      } else if (roll < 0.6) {
        panes[Math.floor(rand() * T)].t.ack(1 + Math.floor(rand() * 4))
      } else if (roll < 0.75) {
        const quiet = r.clock.now() - lastKey > 400 // no typing at the pass, or at the watchdog before it
        const before = r.events.length
        r.clock.frame(Math.floor(rand() * 30))
        if (quiet && r.clock.now() - lastKey > 400) {
          const seen = r.events.slice(before).map((e) => RANK[classes[Number(e.id.slice(1))]])
          for (let k = 1; k < seen.length; k++) if (seen[k] < seen[k - 1]) out.orderViolations++
          out.framesChecked++
        }
      } else if (roll < 0.8) {
        r.clock.advance(Math.floor(rand() * 700))
      } else if (roll < 0.87) {
        const i = Math.floor(rand() * T)
        panes[i].w.typed('k')
        lastKey = r.clock.now()
        typedOn = i
      } else if (roll < 0.93) {
        const i = 1 + Math.floor(rand() * (T - 1)) // focus never leaves terminal 0 in this run: the others move between visible and hidden
        classes[i] = rand() < 0.5 ? 'visible' : 'hidden'
        panes[i].setClass(classes[i])
      } else {
        const i = Math.floor(rand() * T)
        const wait = { reg: r.clock.now(), i, need: sent[i].length, fired: false }
        waits.push(wait)
        out.waitsMade++
        panes[i].w.whenDrained(() => {
          wait.fired = true
          out.waitsAnswered++
          // answered before its cap: everything pushed before the call has been handed to xterm
          if (r.clock.now() - wait.reg < 5_000 && panes[i].t.writtenChars < wait.need) out.waitViolations++
        }, 5_000)
      }
      check()
    }
    void typedOn

    // Let it all drain: no more input, everything acked, time passing.
    for (let k = 0; k < 8000; k++) {
      panes.forEach((p) => p.t.ack())
      if (panes.every((p) => p.w.pending() === 0 && p.t.unacked.length === 0)) break
      r.clock.frame(50)
      if (k === 7999) out.stalled = true
    }
    if (o.refusals) panes.forEach((p) => { p.t.refuse = null })
    drainAll(r, ...panes)
    check()
    r.clock.advance(10_000)
    for (let i = 0; i < T; i++) if (!o.refusals && panes[i].t.joined() !== sent[i]) out.mismatches++
    out.drops = r.sch.stats().drops
    if (o.refusals && out.drops === 0) {
      for (let i = 0; i < T; i++) if (panes[i].t.joined() !== sent[i]) out.mismatches++
    }
    out.waitsAnswered = waits.filter((w) => w.fired).length
    return out
  }

  const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

  it.each(SEEDS)('seed %i: bytes out equal bytes in for every terminal, nothing over the cap, nothing stalled, focused first in every pass', (seed) => {
    const o = fuzz(seed)
    expect(o.mismatches).toBe(0)
    expect(o.unaccounted).toBe(0)
    expect(o.overBound).toBe(0)
    expect(o.orderViolations).toBe(0)
    expect(o.waitViolations).toBe(0)
    expect(o.waitsAnswered).toBe(o.waitsMade)
    expect(o.stalled).toBe(false)
  })

  it('the focused terminal reaches its cap in these schedules, so the bound is not vacuous: focusedInFlight <= HI + chunk, and HI is reached', () => {
    let best = 0
    let checked = 0
    for (const seed of SEEDS) {
      const o = fuzz(seed)
      best = Math.max(best, o.focusedMax)
      checked += o.framesChecked
    }
    expect(best).toBeGreaterThan(D.inflight.focused / 2)
    expect(best).toBeLessThanOrEqual(D.inflight.focused + D.smallWrite)
    expect(checked).toBeGreaterThan(100) // and the order of a pass was looked at in plenty of frames
  })

  it.each([4, 9, 16, 25])('seed %i with xterm refusing 15% of the writes: nothing is lost, nothing reordered', (seed) => {
    const o = fuzz(seed, { refusals: true, steps: 300 })
    expect(o.drops).toBe(0)
    expect(o.mismatches).toBe(0)
    expect(o.stalled).toBe(false)
  })

  it('NEGATIVE CONTROL: the order check can fail. A pass that served the hidden pane first would be counted', () => {
    // The same bookkeeping the fuzz uses, fed the order a broken scheduler would produce.
    const seen = [RANK.hidden, RANK.focused, RANK.visible]
    let violations = 0
    for (let k = 1; k < seen.length; k++) if (seen[k] < seen[k - 1]) violations++
    expect(violations).toBe(1)
  })
})

// =============================================================================================================
// The REAL xterm parser: any split of the stream, at any offset, ends in the same screen
// =============================================================================================================
describe('through the real @xterm/headless parser', () => {
  const ESC = '\x1b'
  // A stream with the sequences a TUI uses, so a split lands inside CSI, SGR, OSC, DCS, a two-byte escape,
  // a multi-byte character and a surrogate pair.
  const STREAM = [
    `${ESC}[?2004h${ESC}]0;title one\x07`,
    ...Array.from({ length: 20 }, (_, i) => `row ${String(i).padStart(2, '0')} of the part that scrolls away\r\n`),
    `${ESC}[1;31mred${ESC}[0m ${ESC}[38;5;208morange${ESC}[0m ${ESC}[38;2;10;200;30mgreen${ESC}[0m\r\n`,
    `plain éè 日本語 \u{1F600} end\r\n`,
    `${ESC}7${ESC}[3;10H${ESC}[4mcursor${ESC}[24m${ESC}8after\r\n`,
    `${ESC}[2;6r${ESC}[6;1Hscroll 1\r\nscroll 2\r\nscroll 3\r\nscroll 4\r\n${ESC}[r`,
    `${ESC}[?1049hALT SCREEN${ESC}[2;3Hinside${ESC}[?1049l`,
    `${ESC}[2K${ESC}[1Aerased${ESC}[K\r\n`,
    `${ESC}P1$r0m${ESC}\\${ESC}]0;title two\x07`,
    `${ESC}[3L${ESC}[2M${ESC}[2@${ESC}[2P${ESC}[?25l${ESC}[?25h`,
    `│ box ──┘ ${ESC}[7minverse${ESC}[27m\ttab\r\n`,
    'last line without newline',
  ].join('')

  function digest(term: Terminal, titles: string[]): string {
    const buf = term.buffer.active
    const rows: string[] = []
    const cell = buf.getNullCell()
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      if (!line) continue
      let attrs = ''
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x, cell)
        if (!c) continue
        if (c.getFgColorMode() || c.getBgColorMode() || c.isBold() || c.isInverse() || c.isUnderline()) {
          attrs += `${x}:${c.getFgColorMode()}/${c.getFgColor()}/${c.getBgColorMode()}/${c.getBgColor()}/${c.isBold()}${c.isInverse()}${c.isUnderline()};`
        }
      }
      rows.push(`${y}|${line.translateToString(false)}|${attrs}`)
    }
    return JSON.stringify({
      type: buf.type, cx: buf.cursorX, cy: buf.cursorY, base: buf.baseY, rows, titles,
      modes: { bp: term.modes.bracketedPasteMode, wrap: term.modes.wraparoundMode, ck: term.modes.applicationCursorKeysMode },
    })
  }

  function newTerm(): { term: Terminal; titles: string[] } {
    const term = new Terminal({ cols: 40, rows: 12, scrollback: 200, allowProposedApi: true, logLevel: 'off' })
    const titles: string[] = []
    term.onTitleChange((t) => titles.push(t))
    return { term, titles }
  }

  const settle = (term: Terminal): Promise<void> => new Promise((resolve) => term.write('', resolve))

  async function reference(): Promise<string> {
    const { term, titles } = newTerm()
    term.write(STREAM)
    await settle(term)
    const d = digest(term, titles)
    term.dispose()
    return d
  }

  /**
   * Push the stream as [0, k) and [k, end), and let the scheduler hand it over in slices of `slice` chars (the
   * echo fast path is off by default here, so that the data really is cut into slices; `fast` turns it on).
   */
  async function through(k: number, slice: number, cls: PaneClass, sink?: (write: (d: string, ack: () => void) => void) => (d: string, ack: () => void) => void, fast = false): Promise<string> {
    const limits: Partial<SchedulerLimits> = {
      slice: { focused: slice, visible: slice, hidden: slice },
      sliceTyping: { focused: slice, visible: slice, hidden: slice },
      ...(fast ? {} : { smallWrite: 0 }),
    }
    const r = makeRig(limits)
    const { term, titles } = newTerm()
    const real = (d: string, ack: () => void): void => term.write(d, ack)
    const p = r.sch.attach('p', { write: sink ? sink(real) : real, classify: () => cls })
    p(STREAM.slice(0, k))
    p(STREAM.slice(k))
    for (let i = 0; i < 4000 && (p.pending() > 0 || p.inflight() > 0); i++) {
      r.clock.frame()
      await settle(term)
    }
    expect(p.pending()).toBe(0)
    await settle(term)
    const d = digest(term, titles)
    term.dispose()
    return d
  }

  /**
   * The same as through(), parsed synchronously: xterm's own writeSync runs the same parser with no timers, so
   * an exhaustive sweep over every split offset costs milliseconds instead of a settle per offset. The result is
   * compared with the reference the ASYNCHRONOUS parser made, so the two are checked against each other too.
   */
  function throughSync(k: number, slice: number, cls: PaneClass, fast = false): string {
    const limits: Partial<SchedulerLimits> = {
      slice: { focused: slice, visible: slice, hidden: slice },
      sliceTyping: { focused: slice, visible: slice, hidden: slice },
      ...(fast ? {} : { smallWrite: 0 }),
    }
    const r = makeRig(limits)
    const { term, titles } = newTerm()
    const core = (term as unknown as { _core: { writeSync: (data: string) => void } })._core
    const p = r.sch.attach('p', { write: (d, ack) => { core.writeSync(d); ack() }, classify: () => cls })
    p(STREAM.slice(0, k))
    p(STREAM.slice(k))
    for (let i = 0; i < 4000 && (p.pending() > 0 || p.inflight() > 0); i++) r.clock.frame()
    if (p.pending() !== 0) throw new Error('the scheduler did not drain')
    const d = digest(term, titles)
    term.dispose()
    return d
  }

  it('the stream really does exercise the parser (so equality below means something)', async () => {
    const { term, titles } = newTerm()
    term.write(STREAM)
    await settle(term)
    expect(titles).toEqual(['title one', 'title two'])
    expect(term.buffer.active.length).toBeGreaterThan(term.rows) // it scrolled
    term.dispose()
  })

  it('a split at EVERY offset, cut into 24-char slices, ends in the screen the whole stream makes', async () => {
    const want = await reference()
    const bad: number[] = []
    for (let k = 0; k <= STREAM.length; k++) {
      if (throughSync(k, 24, 'visible') !== want) bad.push(k)
    }
    expect(bad).toEqual([])
  })

  it('...at every slice size from 1 to 40 chars, at every 7th offset', async () => {
    const want = await reference()
    const bad: string[] = []
    for (let slice = 1; slice <= 40; slice++) {
      for (let k = 0; k <= STREAM.length; k += 7) {
        if (throughSync(k, slice, 'hidden') !== want) bad.push(`${slice}@${k}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('a split at EVERY offset through the echo fast path (two whole writes) ends in the same screen', async () => {
    const want = await reference()
    const bad: number[] = []
    for (let k = 0; k <= STREAM.length; k++) {
      if (throughSync(k, D.slice.focused, 'focused', true) !== want) bad.push(k)
    }
    expect(bad).toEqual([])
  })

  it('NEGATIVE CONTROL: the synchronous sweep can fail too: a stream parsed without its last 5 chars differs', async () => {
    const want = await reference()
    const { term, titles } = newTerm()
    ;(term as unknown as { _core: { writeSync: (data: string) => void } })._core.writeSync(STREAM.slice(0, STREAM.length - 5))
    expect(digest(term, titles)).not.toBe(want)
    term.dispose()
  })

  it.each<[string, number, PaneClass]>([
    ['7-char slices, focused', 7, 'focused'],
    ['13-char slices, visible', 13, 'visible'],
    ['64-char slices, hidden', 64, 'hidden'],
  ])('slices of any size (%s) end in the same screen, at a spread of split offsets', async (_name, slice, cls) => {
    const want = await reference()
    const bad: number[] = []
    for (let k = 0; k <= STREAM.length; k += 11) {
      if ((await through(k, slice, cls)) !== want) bad.push(k)
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('NEGATIVE CONTROL: two slices handed over in the wrong order DO end in a different screen, so the comparison can fail', async () => {
    const want = await reference()
    let held: { d: string; ack: () => void } | null = null
    let n = 0
    const swap = (write: (d: string, ack: () => void) => void) => (d: string, ack: () => void): void => {
      n++
      if (n === 2) { held = { d, ack }; return } // hold the 2nd back...
      write(d, ack)
      if (n === 3 && held) { write(held.d, held.ack); held = null } // ...and hand it over after the 3rd
    }
    const got = await through(100, 24, 'visible', swap)
    expect(got).not.toBe(want)
  }, 60_000)
})

// =============================================================================================================
// The lag, as a model (harness s1 of the analysis, in virtual time)
// =============================================================================================================
describe('the model of the lag: chars ahead of a typed echo, at 0.5x, 2x and 4x load', () => {
  // See helpers/lagModel.ts for the model: 6 terminals on one thread, a key every 200 ms into terminal 0, its
  // echo 12 ms later. `ahead` is what an echo waits behind: chars terminal 0 was sent that its xterm has not
  // parsed yet, the queue the scheduler holds included.
  //
  // THE BOUND. The scheduler bounds what is in flight to xterm per terminal (HI). What it cannot bound is what
  // main sends: output keeps arriving whether or not anyone reads it (slowing the producer is credit flow
  // control, a separate package), and arrivals pile up while the renderer's thread is busy with one slice of
  // xterm's (12 ms, and a chunk) plus the other work's share of the frame. So the bound the scheduler can
  // keep is HI, the echo's own small write, and the arrivals of one such blocked stretch: BLOCKED_ARRIVALS
  // batches (26 ms at 8 ms per batch is 4, rounded up). It does not grow with the length of the overload; the
  // path every pane had before does, linearly.
  const BLOCKED_ARRIVALS = 4
  const bound = (batch: number): number => D.inflight.focused + D.smallWrite + BLOCKED_ARRIVALS * batch

  it.each([0.5, 2, 4])('at %ix load the scheduler keeps the chars ahead of the echo within HI + chunk, and every echo is on screen', (load) => {
    const s = runLagModel('scheduler', load)
    expect(s.echoes).toBeGreaterThanOrEqual(13)
    expect(s.aheadMax).toBeLessThanOrEqual(bound(s.batch))
    expect(s.visible).toBe(s.echoes) // every echo reached the screen before the run ended
    expect(s.focusedMaxInflight).toBeLessThanOrEqual(D.inflight.focused + D.smallWrite)
  })

  it.each([0.5, 2, 4])('at %ix load it holds for any phase of the keys against the frames, and a 4 ms timer clamp', (load) => {
    for (const minTimerMs of [1, 4]) {
      for (const phaseMs of [0, 3, 7, 11, 40, 97, 150]) {
        const s = runLagModel('scheduler', load, { minTimerMs, phaseMs })
        expect(s.aheadMax).toBeLessThanOrEqual(bound(s.batch))
        expect(s.visible).toBe(s.echoes)
      }
    }
  })

  it('NEGATIVE CONTROL: at 2x and 4x the throttle every pane had before (no bound, no priority) is far over it', () => {
    for (const load of [2, 4]) {
      const shipped = runLagModel('shipped', load)
      expect(shipped.aheadMax).toBeGreaterThan(bound(shipped.batch))
      expect(shipped.aheadMax).toBeGreaterThan(5 * bound(shipped.batch)) // not marginally: the queue is the lag
      expect(shipped.visible).toBeLessThan(shipped.echoes) // echoes still waiting when the run ended
    }
  })

  it('NEGATIVE CONTROL: below capacity (0.5x) the old path is within the bound as well, so the model does not just fail everything', () => {
    const shipped = runLagModel('shipped', 0.5)
    expect(shipped.aheadMax).toBeLessThanOrEqual(bound(shipped.batch))
  })

  it.each([2, 4])('at %ix the old path gets worse the longer the overload lasts, and the scheduler does not', (load) => {
    const longRun = runLagModel('scheduler', load, { runMs: 9_000 })
    expect(longRun.aheadMax).toBeLessThanOrEqual(bound(longRun.batch))
    const oldShort = runLagModel('shipped', load, { runMs: 3_000 })
    const oldLong = runLagModel('shipped', load, { runMs: 9_000 })
    expect(oldLong.aheadMax).toBeGreaterThan(2 * oldShort.aheadMax)
  })

  it.each([2, 4])('at %ix the echo is on screen sooner than before, in virtual ms', (load) => {
    const s = runLagModel('scheduler', load)
    const shipped = runLagModel('shipped', load)
    expect(s.latencyMax).toBeLessThan(shipped.latencyMax / 5)
    expect(s.visible).toBeGreaterThan(shipped.visible)
  })

  it.each([0.5, 2, 4])('at %ix nothing is lost and the others still make progress (the starvation guarantee)', (load) => {
    const s = runLagModel('scheduler', load)
    for (let i = 0; i < T; i++) expect(s.parsed[i] + s.queued[i]).toBe(s.offered[i]) // sent = parsed + still waiting, per terminal
    for (let i = 1; i < T; i++) expect(s.parsed[i]).toBeGreaterThan(0)
  })

  it('at 4x the thread goes to the focused terminal first: it parses what it is sent, which the old path, sharing the thread equally, could not', () => {
    const s = runLagModel('scheduler', 4)
    const shipped = runLagModel('shipped', 4)
    expect(s.offered[0] - s.parsed[0]).toBeLessThanOrEqual(bound(s.batch))
    expect(shipped.offered[0] - shipped.parsed[0]).toBeGreaterThan(10 * bound(s.batch))
    // the price is the other terminals: their backlog waits here, in strings, not in xterm's queues
    expect(Math.max(...s.held.slice(1))).toBeGreaterThan(0)
    expect(s.background).toBeLessThan(shipped.background)
  })
})
