// P0 of the 1.54.5 typing-lag hotfix: the renderer half of the echo trace.
//
// The main process cannot see how much output is queued ahead of the key someone just typed: that
// queue lives in the renderer (the output throttle, then xterm's own write buffer). src/renderer/src/
// lib/echoTrace.ts reads it for 1 printable key in 10, along with long tasks, frame gaps and the
// numbers that tell a lagging pane from a lagging machine.
//
// Promises pinned here, each with a NEGATIVE CONTROL beside it (a deliberately wrong input or model
// that the same assertion must reject, so a green run cannot be a vacuous one):
//   * echoAhead is exactly xterm's pending chars plus the throttle's, read inside the key handler;
//   * exactly 1 printable key in 10 is sampled, and nothing else is;
//   * a sampled key is the ONLY write that carries a third argument: every other write reaches the
//     preload exactly as before, so no existing caller or test sees a difference;
//   * no record or log line holds key content, a terminal id or a path -- numbers only;
//   * the whole thing is O(1) per event, owns no timer without a pane, and switches off.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import {
  SAMPLE_EVERY_KEYS,
  createEchoTrace,
  echoTraceAttach,
  getEchoTraceSnapshot,
  isPrintableKey,
  readXtermPending,
  type EchoTraceDeps,
} from '../../src/renderer/src/lib/echoTrace'

// ---------------------------------------------------------------------------------------------
// A fake renderer thread: timers, one-shot frames (a frame due while the thread is blocked fires
// late, once) and a PerformanceObserver that tests can feed.
// ---------------------------------------------------------------------------------------------

type Timer = { due: number; every: number; fn: () => void }

class FakeClock {
  t = 0
  private seq = 0
  private timers = new Map<number, Timer>()
  now = (): number => this.t
  wall = (): number => 1_700_000_000_000 + this.t
  setInterval = (fn: () => void, ms: number): number => {
    const id = ++this.seq
    this.timers.set(id, { due: this.t + ms, every: ms, fn })
    return id
  }
  clearInterval = (h: unknown): void => { this.timers.delete(h as number) }
  /** requestAnimationFrame: one shot, 16 ms out. */
  raf = (fn: () => void): number => {
    const id = ++this.seq
    this.timers.set(id, { due: this.t + 16, every: 0, fn })
    return id
  }
  get timerCount(): number { return this.timers.size }
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let nextId = -1
      let next: Timer | null = null
      for (const [id, timer] of this.timers) if (timer.due <= end && (next === null || timer.due < next.due)) { next = timer; nextId = id }
      if (next === null) break
      this.t = Math.max(this.t, next.due)
      if (next.every === 0) this.timers.delete(nextId)
      else next.due = this.t + next.every
      next.fn()
    }
    this.t = end
  }
  block(ms: number): void { this.t += ms }
}

class FakeObserver {
  static all: FakeObserver[] = []
  observed: Array<{ entryTypes?: string[] }> = []
  disconnected = false
  constructor(private readonly cb: (list: { getEntries: () => Array<{ duration: number }> }) => void) { FakeObserver.all.push(this) }
  observe(o: { entryTypes?: string[] }): void { this.observed.push(o) }
  disconnect(): void { this.disconnected = true }
  emit(durations: number[]): void { this.cb({ getEntries: () => durations.map((duration) => ({ duration })) }) }
}

interface FakeTerm { _core: { _writeBuffer: { _pendingData: number } } }
const fakeTerm = (pending = 0): FakeTerm => ({ _core: { _writeBuffer: { _pendingData: pending } } })

type WriteArgs = unknown[]

function rig(over: Partial<EchoTraceDeps> = {}) {
  FakeObserver.all = []
  const clock = new FakeClock()
  const writes: WriteArgs[] = []
  const lines: string[] = []
  const trace = createEchoTrace({
    enabled: () => true,
    now: clock.now,
    wallNow: clock.wall,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    raf: clock.raf,
    PerformanceObserverCtor: FakeObserver as never,
    heapUsed: () => 50 * 1024 * 1024,
    writeToTerminal: ((...args: WriteArgs) => { writes.push(args) }) as never,
    log: (l: string) => { lines.push(l) },
    ...over,
  })
  return { clock, writes, lines, trace, observer: (): FakeObserver => FakeObserver.all[FakeObserver.all.length - 1] }
}

const stamped = (writes: WriteArgs[]): WriteArgs[] => writes.filter((w) => w.length === 3)

afterEach(() => { vi.restoreAllMocks(); try { window.localStorage.removeItem('termpolis.echoTrace') } catch { /* no storage */ } })

// ---------------------------------------------------------------------------------------------
describe('echoTrace: what counts as a typed key', () => {
  it('a printable character is a key; controls, escape sequences, empties and pastes are not', () => {
    for (const k of ['a', 'Z', ' ', '~', '5', 'é', '€', '日', '\u{1F600}']) expect(isPrintableKey(k), JSON.stringify(k)).toBe(true)
    for (const k of ['', '\r', '\n', '\t', '\x7f', '\x1b', '\x1b[A', '\x1b[200~', '\u0003', '\u0085', 'ab', 'hello world, a paste', '\ud83d']) expect(isPrintableKey(k), JSON.stringify(k)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: exactly 1 printable key in 10 is sampled', () => {
  /** How many of `keys` a sampler stamps: the harness both the real pane and the control go through. */
  function stampsOf(keys: string[], write: (k: string) => number | undefined): number {
    return keys.filter((k) => write(k) !== undefined).length
  }

  it('stamps the 10th, 20th ... printable key and no other', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    const keys = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26)))
    keys.forEach((k) => pane.write(k))
    expect(r.writes.length).toBe(100)
    const hits = stamped(r.writes)
    expect(hits.length).toBe(100 / SAMPLE_EVERY_KEYS)
    expect(r.writes.map((w, i) => (w.length === 3 ? i + 1 : 0)).filter(Boolean)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    r.clock.advance(5_000)
    const last = r.trace.snapshot().last!
    expect(last.keys).toBe(100)
    expect(last.sampled).toBe(10)
    expect(SAMPLE_EVERY_KEYS).toBe(10)
  })

  it('control keys, escape sequences and pastes neither count toward the ten nor get stamped', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < 40; i++) for (const k of ['\r', '\x7f', '\x1b[A', 'pasted text', '']) pane.write(k)
    expect(stamped(r.writes).length).toBe(0)
    for (let i = 0; i < 9; i++) pane.write('x')
    expect(stamped(r.writes).length).toBe(0)
    pane.write('x') // the tenth printable key, however many other writes came between
    expect(stamped(r.writes).length).toBe(1)
  })

  it('NEGATIVE CONTROL: the counting harness does see every key when everything is sampled', () => {
    const keys = Array.from({ length: 100 }, () => 'a')
    expect(stampsOf(keys, () => 1)).toBe(100) // a sample-everything model scores 100, not 10
    expect(stampsOf(keys, () => undefined)).toBe(0)
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    expect(stampsOf(keys, (k) => { pane.write(k); const w = r.writes[r.writes.length - 1]; return w.length === 3 ? 1 : undefined })).toBe(10)
  })

  it('the stamp is the wall clock in ms, and an unstamped write has exactly two arguments', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < 9; i++) pane.write('a')
    r.clock.advance(250)
    pane.write('a')
    expect(r.writes[0]).toEqual(['t1', 'a']) // exactly as the preload has always been called
    expect(r.writes[9]).toEqual(['t1', 'a', r.clock.wall()])
    expect(typeof r.writes[9][2]).toBe('number')
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: echoAhead, read inside the key handler', () => {
  function sampleOne(r: ReturnType<typeof rig>, term: FakeTerm, probes?: { throttle?: () => number; held?: () => number }) {
    const pane = r.trace.attach('t1', term, probes)
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(5_000)
    return r.trace.snapshot().last!.echoAhead
  }

  it('equals xterm pending chars plus the throttle length', () => {
    const r = rig()
    expect(sampleOne(r, fakeTerm(1_234), { throttle: () => 4_321 })).toEqual({ n: 1, max: 5_555, avg: 5_555, over64k: 0 })
  })

  it('also counts what a held selection is sitting on, because the echo waits behind it', () => {
    const r = rig()
    expect(sampleOne(r, fakeTerm(10), { throttle: () => 20, held: () => 100 }).max).toBe(130)
  })

  it('counts a queue past 64 KB, the amplifier a 5 second lag needs', () => {
    const r = rig()
    const a = sampleOne(r, fakeTerm(70_000), { throttle: () => 10_000 })
    expect(a.over64k).toBe(1)
    expect(a.max).toBe(80_000)
  })

  it('NEGATIVE CONTROL: empty queues read 0, and only the sampled key is read at all', () => {
    const r = rig()
    const probe = vi.fn(() => 0)
    const pane = r.trace.attach('t1', fakeTerm(0), { throttle: probe })
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    expect(probe).toHaveBeenCalledTimes(1) // ten keys typed, the queue read once, before any sampler tick
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.echoAhead).toEqual({ n: 1, max: 0, avg: 0, over64k: 0 })
  })

  it('a probe that throws reads as 0 and never stops the write', () => {
    const r = rig()
    const a = sampleOne(r, fakeTerm(7), { throttle: () => { throw new Error('gone') }, held: () => { throw new Error('gone') } })
    expect(a.max).toBe(7)
    expect(r.writes.length).toBe(SAMPLE_EVERY_KEYS)
  })

  it('reads a terminal without the private counter as 0 pending, not as a failure', () => {
    const r = rig()
    const pane = r.trace.attach('t1', {} as never, { throttle: () => 5 })
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.echoAhead.max).toBe(5)
    expect(r.trace.snapshot().last!.terminals[0].xtermPending).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: chars queued when a resize reflows the pane', () => {
  it('reads the queue at the moment of the fit', () => {
    const r = rig()
    const term = fakeTerm(900)
    const pane = r.trace.attach('t1', term, { throttle: () => 100, held: () => 5 })
    pane.resize()
    term._core._writeBuffer._pendingData = 40
    pane.resize()
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.resizes).toEqual({ n: 2, maxQueued: 1_005, lastQueued: 145 })
  })

  it('NEGATIVE CONTROL: a pane with nothing queued reports 0, and a quiet window reports no resizes', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm(0))
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.resizes).toEqual({ n: 0, maxQueued: 0, lastQueued: 0 })
    pane.resize()
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.resizes).toEqual({ n: 1, maxQueued: 0, lastQueued: 0 })
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: the echo round trip as the renderer sees it', () => {
  it('measures a sampled key to the next output for that pane', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(30)
    pane.received(1)
    pane.received(1) // a second chunk is not the echo
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.echoRtt).toEqual({ n: 1, avg: 30, max: 30 })
  })

  it('drops an echo that never came, and records nothing for output with no key behind it', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    pane.received(100) // output with no sampled key pending: NEGATIVE CONTROL, rtt stays empty
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(20_000) // a password prompt: nothing echoed for 20 s
    pane.received(1)
    expect(r.trace.snapshot().last!.echoRtt).toEqual({ n: 0, avg: 0, max: 0 })
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: per-pane throughput', () => {
  it('reports chars received, handed to xterm and parsed in the window, and what is still queued', () => {
    const r = rig()
    const term = fakeTerm(0)
    let throttle = 0
    const pane = r.trace.attach('t1', term, { throttle: () => throttle })
    const toXterm = vi.fn()
    const tapped = pane.tap(toXterm)
    pane.received(300)
    throttle = 100
    tapped('x'.repeat(200)) // 200 of the 300 reached xterm; 100 still sit in the throttle
    term._core._writeBuffer._pendingData = 80 // the parser has chewed through 120 of them
    r.clock.advance(5_000)
    const row = r.trace.snapshot().last!.terminals[0]
    expect(row).toEqual({ xtermPending: 80, throttle: 100, held: 0, received: 300, handed: 200, parsed: 120 })
    expect(toXterm).toHaveBeenCalledWith('x'.repeat(200)) // the tap forwards exactly what it was given

    // Next window: nothing new arrives, xterm finishes the 80 it had.
    term._core._writeBuffer._pendingData = 0
    throttle = 0
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.terminals[0]).toEqual({ xtermPending: 0, throttle: 0, held: 0, received: 0, handed: 0, parsed: 80 })
  })

  it('NEGATIVE CONTROL: a terminal that hides its queue yields null parsed, not a made-up number', () => {
    const r = rig()
    const pane = r.trace.attach('t1', {} as never)
    pane.tap(() => undefined)('abc')
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.terminals[0]).toEqual({ xtermPending: null, throttle: 0, held: 0, received: 0, handed: 3, parsed: null })
  })

  it('lists one row per live pane and none for a detached one', () => {
    const r = rig()
    const a = r.trace.attach('a', fakeTerm())
    r.trace.attach('b', fakeTerm())
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.terminals.length).toBe(2)
    a.detach()
    a.detach() // idempotent
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.terminals.length).toBe(1)
    expect(r.trace.snapshot().panes).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: long tasks, frame gaps and the heap', () => {
  it('counts long tasks from the observer', () => {
    const r = rig()
    r.trace.attach('t1', fakeTerm())
    expect(r.observer().observed).toEqual([{ entryTypes: ['longtask'] }])
    r.observer().emit([80, 120])
    r.observer().emit([55])
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.longTasks).toEqual({ count: 3, totalMs: 255, maxMs: 120 })
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.longTasks).toEqual({ count: 0, totalMs: 0, maxMs: 0 }) // a window, not a lifetime
  })

  it('records a frame gap over 100 ms during the 2 s after a sampled key', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(160) // ten smooth 16 ms frames
    r.clock.block(450) // the renderer thread is stuck: the next frame is 466 ms after the last
    r.clock.advance(4_500)
    const gaps = r.trace.snapshot().last!.frameGaps
    expect(gaps.count).toBe(1)
    expect(gaps.maxMs).toBeGreaterThanOrEqual(440)
  })

  it('NEGATIVE CONTROL: smooth frames record no gap, and the frame loop ends by itself', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    const idle = r.clock.timerCount // the sampling interval, and nothing else
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    expect(r.clock.timerCount).toBe(idle + 1) // one frame request in flight
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.frameGaps).toEqual({ count: 0, maxMs: 0 })
    expect(r.clock.timerCount).toBe(idle) // 2 s later the chain stopped: no standing rAF loop
  })

  it('ignores a gap that is really a hidden window coming back', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.block(30_000) // the window was hidden: no frames, and the overdue sampler fires on return
    r.clock.advance(100)
    expect(r.trace.snapshot().last!.frameGaps).toEqual({ count: 0, maxMs: 0 })
  })

  it('arms the frame probe once while one is running, and extends it on a later sampled key', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    const idle = r.clock.timerCount
    for (let i = 0; i < SAMPLE_EVERY_KEYS * 3; i++) pane.write('a') // three sampled keys back to back
    expect(r.clock.timerCount).toBe(idle + 1)
    r.clock.advance(1_000)
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(1_500)
    expect(r.clock.timerCount).toBe(idle + 1) // the later key kept it going past the first 2 s
    r.clock.advance(5_000)
    expect(r.clock.timerCount).toBe(idle)
  })

  it('reports the JS heap in whole MB, or null when the browser will not say', () => {
    const r = rig()
    r.trace.attach('t1', fakeTerm())
    r.clock.advance(5_000)
    expect(r.trace.snapshot().last!.heapUsedMB).toBe(50)
    const q = rig({ heapUsed: () => null })
    q.trace.attach('t1', fakeTerm())
    q.clock.advance(5_000)
    expect(q.trace.snapshot().last!.heapUsedMB).toBeNull()
    const t = rig({ heapUsed: () => { throw new Error('no memory API') } })
    t.trace.attach('t1', fakeTerm())
    expect(() => t.clock.advance(5_000)).not.toThrow()
    expect(t.trace.snapshot().last!.heapUsedMB).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: the one line a minute', () => {
  const ALLOWED = /^[A-Za-z0-9 _.:=,;()<>/%+\-[\]|]+$/

  it('writes exactly one line for an active minute, and none for an idle one', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    r.clock.advance(5 * 60_000)
    expect(r.lines).toEqual([]) // idle: silent
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(60_000)
    expect(r.lines.length).toBe(1)
    expect(r.lines[0].startsWith('[echo-trace]')).toBe(true)
    expect(r.lines[0]).toContain('keys=10 sampled=1')
    r.clock.advance(60_000)
    expect(r.lines.length).toBe(1) // the next minute was quiet again
  })

  it('speaks for a minute with a long task, a deep queue or a resize even if nobody typed', () => {
    for (const trigger of ['longtask', 'queue', 'resize']) {
      const r = rig()
      const term = fakeTerm(trigger === 'queue' ? 70_000 : 0)
      const pane = r.trace.attach('t1', term)
      if (trigger === 'longtask') r.observer().emit([300])
      if (trigger === 'resize') pane.resize()
      r.clock.advance(60_000)
      expect(r.lines.length, trigger).toBe(1)
    }
  })

  it('holds only numbers and fixed labels: no key content, no terminal id, no path', () => {
    const r = rig()
    const pane = r.trace.attach('C:\\Users\\someone\\secret-terminal', fakeTerm(3), { throttle: () => 2 })
    for (const ch of 'hunter2 P@ssw0rd€日') pane.write(ch)
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('q')
    r.clock.advance(60_000)
    expect(r.lines.length).toBe(1)
    expect(r.lines[0]).toMatch(ALLOWED)
    for (const leak of ['hunter2', 'P@ssw0rd', '€', '日', 'secret-terminal', 'someone', 'Users']) expect(r.lines[0]).not.toContain(leak)
  })

  it('NEGATIVE CONTROL: the allow-list rejects a line that carries content', () => {
    expect(ALLOWED.test('[echo-trace] 60s keys=10 sampled=1 ahead n=1 max=0')).toBe(true)
    expect(ALLOWED.test('[echo-trace] typed hunter2!')).toBe(false)
    expect(ALLOWED.test('[echo-trace] C:\\Users\\x')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: numbers only', () => {
  function leaves(v: unknown, out: unknown[] = []): unknown[] {
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out)
    else out.push(v)
    return out
  }
  const numbersOnly = (v: unknown): boolean => leaves(v).every((x) => x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))

  it('no record carries key content, whatever is typed', () => {
    const r = rig()
    const pane = r.trace.attach('terminal-abc-123', fakeTerm(5), { throttle: () => 9 })
    for (const ch of ['é', '€', '日', 'Q', '\r', '\x1b[A', 'rm -rf /', 'password=hunter2']) pane.write(ch)
    for (let i = 0; i < 25; i++) pane.write('z')
    pane.received(10)
    pane.resize()
    r.clock.advance(60_000)
    const snap = r.trace.snapshot()
    expect(numbersOnly(snap)).toBe(true)
    const json = JSON.stringify(snap)
    for (const leak of ['hunter2', 'rm -rf', 'terminal-abc-123', '€', '日']) expect(json).not.toContain(leak)
  })

  it('NEGATIVE CONTROL: the walker does flag a record with a string or a NaN in it', () => {
    expect(numbersOnly({ a: 1, b: { c: null, d: true } })).toBe(true)
    expect(numbersOnly({ a: 1, b: { c: 'typed text' } })).toBe(false)
    expect(numbersOnly({ a: Number.NaN })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: owns nothing without a pane, and switches off', () => {
  it('starts its interval and observer with the first pane and drops them with the last', () => {
    const r = rig()
    expect(r.clock.timerCount).toBe(0)
    expect(FakeObserver.all.length).toBe(0)
    const a = r.trace.attach('a', fakeTerm())
    const b = r.trace.attach('b', fakeTerm())
    expect(r.clock.timerCount).toBe(1) // one interval for every pane
    expect(FakeObserver.all.length).toBe(1)
    a.detach()
    expect(r.clock.timerCount).toBe(1)
    b.detach()
    expect(r.clock.timerCount).toBe(0)
    expect(r.observer().disconnected).toBe(true)
  })

  it('with the switch off it changes nothing: same write, same tap, no timer, no observer, no sample', () => {
    const r = rig({ enabled: () => false })
    const pane = r.trace.attach('t1', fakeTerm(1_000), { throttle: () => 1_000 })
    const fn = (): void => undefined
    expect(pane.tap(fn)).toBe(fn) // the very same function: zero added cost per chunk
    for (let i = 0; i < 100; i++) pane.write('a')
    pane.received(10)
    pane.resize()
    pane.detach()
    expect(r.writes.length).toBe(100)
    expect(r.writes.every((w) => w.length === 2)).toBe(true)
    expect(r.clock.timerCount).toBe(0)
    expect(FakeObserver.all.length).toBe(0)
    expect(r.trace.snapshot().enabled).toBe(false)
    expect(r.trace.snapshot().last).toBeNull()
  })

  it('NEGATIVE CONTROL: switched on, the tap is a wrapper and the writes do get stamped', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    const fn = (): void => undefined
    expect(pane.tap(fn)).not.toBe(fn)
    for (let i = 0; i < 10; i++) pane.write('a')
    expect(stamped(r.writes).length).toBe(1)
  })

  it('survives a missing PerformanceObserver, an observer that refuses, and a log that throws', () => {
    const none = rig({ PerformanceObserverCtor: undefined })
    none.trace.attach('t1', fakeTerm())
    none.clock.advance(5_000)
    expect(none.trace.snapshot().last!.longTasks.count).toBe(0)

    class Refuses { constructor() { /* ok */ } observe(): void { throw new Error('longtask unsupported') } disconnect(): void { throw new Error('x') } }
    const refuse = rig({ PerformanceObserverCtor: Refuses as never, log: () => { throw new Error('log sink') } })
    const pane = refuse.trace.attach('t1', fakeTerm(70_000))
    expect(() => { for (let i = 0; i < 20; i++) pane.write('a'); refuse.clock.advance(120_000); pane.detach() }).not.toThrow()
  })

  it('still forwards the write when the sampling code throws', () => {
    const r = rig({ wallNow: () => { throw new Error('clock') } })
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    expect(r.writes.length).toBe(SAMPLE_EVERY_KEYS)
    expect(r.writes.every((w) => w.length === 2)).toBe(true)
  })

  it('answers a snapshot for a trace that never saw a pane', () => {
    const r = rig()
    expect(r.trace.snapshot()).toEqual({ enabled: true, panes: 0, last: null, minute: null })
  })

  it('summarises the last minute across windows', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm(300), { throttle: () => 200 })
    for (let i = 0; i < SAMPLE_EVERY_KEYS * 2; i++) pane.write('a')
    r.observer().emit([60])
    pane.received(1_000)
    r.clock.advance(60_000)
    const minute = r.trace.snapshot().minute!
    expect(minute.windows).toBe(12)
    expect(minute.keys).toBe(20)
    expect(minute.sampled).toBe(2)
    expect(minute.longTasks).toBe(1)
    expect(minute.maxQueued).toBe(500)
    expect(minute.echoAheadMax).toBe(500)
    expect(minute.received).toBe(1_000)
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: the real xterm still has the counter this reads', () => {
  it('@xterm/headless: pending chars rise on write and fall once parsed', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true })
    expect(readXtermPending(term)).toBe(0)
    const done = new Promise<void>((resolve) => term.write('x'.repeat(1_000), resolve))
    expect(readXtermPending(term)).toBe(1_000) // queued, not yet parsed
    await done
    expect(readXtermPending(term)).toBe(0)
    term.dispose()
  })

  it('NEGATIVE CONTROL: anything without that exact counter reads as null, not as 0', () => {
    for (const t of [null, undefined, 42, {}, { _core: {} }, { _core: { _writeBuffer: {} } }, { _core: { _writeBuffer: { _pendingData: '5' } } }, { _core: { _writeBuffer: { _pendingData: Number.NaN } } }, { _core: { _writeBuffer: { _pendingData: -1 } } }]) {
      expect(readXtermPending(t), JSON.stringify(t)).toBeNull()
    }
    expect(readXtermPending(fakeTerm(0))).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: the shared instance TerminalPane calls', () => {
  it('forwards through window.termpolis, stamps 1 in 10, and honours the localStorage switch', () => {
    const writeToTerminal = vi.fn()
    ;(window as unknown as { termpolis: unknown }).termpolis = { writeToTerminal }
    const pane = echoTraceAttach('shared-1', fakeTerm(11), { throttle: () => 22 })
    for (let i = 0; i < 20; i++) pane.write('a')
    expect(writeToTerminal).toHaveBeenCalledTimes(20)
    expect(writeToTerminal.mock.calls.filter((c) => c.length === 3).length).toBe(2)
    expect(writeToTerminal.mock.calls[0]).toEqual(['shared-1', 'a']) // two arguments, as always
    expect(getEchoTraceSnapshot().enabled).toBe(true)
    expect(getEchoTraceSnapshot().panes).toBe(1)
    pane.detach()

    window.localStorage.setItem('termpolis.echoTrace', '0')
    const off = echoTraceAttach('shared-2', fakeTerm())
    const fn = (): void => undefined
    expect(off.tap(fn)).toBe(fn)
    off.write('b')
    expect(writeToTerminal).toHaveBeenLastCalledWith('shared-2', 'b')
    off.detach()
    window.localStorage.removeItem('termpolis.echoTrace')

    const on = echoTraceAttach('shared-3', fakeTerm())
    expect(on.tap(fn)).not.toBe(fn)
    on.detach()
  })

  it('treats unreadable storage as "on"', () => {
    const writeToTerminal = vi.fn()
    ;(window as unknown as { termpolis: unknown }).termpolis = { writeToTerminal }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const pane = echoTraceAttach('shared-4', fakeTerm())
    const fn = (): void => undefined
    expect(pane.tap(fn)).not.toBe(fn)
    pane.detach()
  })
})

// ---------------------------------------------------------------------------------------------
describe('echoTrace: the defaults and the edges', () => {
  const quiet = (clock: FakeClock) => ({ enabled: () => true, now: clock.now, wallNow: clock.wall, setInterval: clock.setInterval, clearInterval: clock.clearInterval, raf: clock.raf })

  it('reads the real heap counter when the browser has one, and null when it does not', () => {
    const had = Object.getOwnPropertyDescriptor(performance, 'memory')
    try {
      Object.defineProperty(performance, 'memory', { value: { usedJSHeapSize: 5 * 1024 * 1024 }, configurable: true })
      const a = new FakeClock()
      const withHeap = createEchoTrace({ ...quiet(a), PerformanceObserverCtor: undefined })
      withHeap.attach('t1', fakeTerm())
      a.advance(5_000)
      expect(withHeap.snapshot().last!.heapUsedMB).toBe(5)

      Object.defineProperty(performance, 'memory', { value: undefined, configurable: true })
      const b = new FakeClock()
      const without = createEchoTrace({ ...quiet(b), PerformanceObserverCtor: undefined })
      without.attach('t1', fakeTerm())
      b.advance(5_000)
      expect(without.snapshot().last!.heapUsedMB).toBeNull()
    } finally {
      if (had) Object.defineProperty(performance, 'memory', had)
      else delete (performance as unknown as Record<string, unknown>).memory
    }
  })

  it('logs through console.info by default, and leaves the heap out of the line when unknown', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const clock = new FakeClock()
      const trace = createEchoTrace({ ...quiet(clock), PerformanceObserverCtor: undefined, heapUsed: () => null })
      const pane = trace.attach('t1', fakeTerm())
      for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
      clock.advance(60_000)
      expect(info).toHaveBeenCalledTimes(1)
      const line = String(info.mock.calls[0][0])
      expect(line.startsWith('[echo-trace]')).toBe(true)
      expect(line).not.toContain('heap=')
    } finally { info.mockRestore() }
  })

  it('NEGATIVE CONTROL: with a heap reading the line carries it', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(60_000)
    expect(r.lines[0]).toContain('heap=50MB')
  })

  it('uses a PerformanceObserver global when none is injected, and copes when there is none', () => {
    const clock = new FakeClock()
    const seen: unknown[] = []
    class Seen { constructor() { seen.push(this) } observe(): void { /* ok */ } disconnect(): void { /* ok */ } }
    vi.stubGlobal('PerformanceObserver', Seen)
    try {
      const withGlobal = createEchoTrace(quiet(clock))
      withGlobal.attach('t1', fakeTerm()).detach()
      expect(seen.length).toBe(1)
      vi.stubGlobal('PerformanceObserver', undefined)
      const without = createEchoTrace(quiet(clock))
      const pane = without.attach('t1', fakeTerm())
      clock.advance(5_000)
      expect(without.snapshot().last!.longTasks.count).toBe(0)
      pane.detach()
    } finally { vi.unstubAllGlobals() }
  })

  it('a second, shorter frame gap does not lower the longest', () => {
    const r = rig()
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS; i++) pane.write('a')
    r.clock.advance(32)
    r.clock.block(450)
    r.clock.advance(48)
    r.clock.block(200)
    r.clock.advance(5_000)
    const gaps = r.trace.snapshot().last!.frameGaps
    expect(gaps.count).toBe(2)
    expect(gaps.maxMs).toBeGreaterThanOrEqual(440)
    expect(gaps.maxMs).toBeLessThan(500)
  })

  it('detach survives a clearInterval that throws, and an observer that throws on disconnect', () => {
    class Throws { observe(): void { /* ok */ } disconnect(): void { throw new Error('x') } }
    const clock = new FakeClock()
    const trace = createEchoTrace({ ...quiet(clock), clearInterval: () => { throw new Error('gone') }, PerformanceObserverCtor: Throws as never })
    const pane = trace.attach('t1', fakeTerm())
    expect(() => pane.detach()).not.toThrow()
    expect(trace.snapshot().panes).toBe(0)
  })

  it('a terminal whose private field throws reads as unknown, not as a crash', () => {
    const hostile = { get _core(): never { throw new Error('no') } }
    expect(readXtermPending(hostile)).toBeNull()
  })

  it('a frame probe that cannot get a frame ends instead of leaking its running flag', () => {
    let calls = 0
    const r = rig({ raf: () => { if (calls++ === 0) throw new Error('rAF unavailable'); return 1 } })
    const pane = r.trace.attach('t1', fakeTerm())
    for (let i = 0; i < SAMPLE_EVERY_KEYS * 2; i++) pane.write('a') // two sampled keys: the second may arm again
    expect(calls).toBe(2)
    expect(r.writes.length).toBe(SAMPLE_EVERY_KEYS * 2)
  })
})
