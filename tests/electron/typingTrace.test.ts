// P0 of the 1.54.5 typing-lag hotfix: the main-process half of the echo trace.
//
// Nothing in Termpolis could tell the app, the agent CLI and the machine apart when typing lagged:
// no loop delay, no echo latency, no handler timings. src/main/typingTrace.ts adds them, and these
// tests pin the three promises that make it safe to ship on a monitored, already-overloaded box:
//
//   1. COUNTERS, not wall-clock ratios. Every assertion below counts calls, windows, lines or
//      timers against a fake clock that models a libuv event loop (an overdue timer fires once, late).
//   2. The instrument never becomes the disease (the v1.25.16 lesson, project_freeze_diagnosis.md):
//      its cost is one histogram read per 5 s window, whatever the loop is doing, and it holds no
//      timer that reacts to a stall. The feedback-loop check injects 100 two-second stalls and shows
//      the next window's baseline is untouched. Its NEGATIVE CONTROL is a model of the profiler that
//      shipped in v1.25.15, run through the same harness: it keeps stalling the loop by itself after
//      the external storm ends, so the harness must flag it.
//   3. Numbers only. No key content ever reaches a record, and nothing leaves the machine.
//
// Every test file in this lane carries a control: a deliberately wrong implementation (or input) that
// the same assertion must reject, so a green run cannot be a vacuous one.

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  KILL_SWITCH_ENV,
  createTypingTrace,
  openLoopDelay,
  openEluReader,
  observeGc,
  startTypingTrace,
  stopTypingTrace,
  traceTerminalWrite,
  noteTerminalOutput,
  timedIpc,
  traceMcpTool,
  registerTypingTraceSource,
  getTypingTraceSnapshot,
  type GcKind,
  type LoopDelayReading,
  type LoopDelaySource,
  type TypingTraceDeps,
} from '../../src/main/typingTrace'

// ---------------------------------------------------------------------------------------------
// A fake event loop. `advance` lets time pass with the thread idle; `block` makes the thread busy,
// so every timer that came due while it was busy fires ONCE, LATE, on the next advance -- which is
// exactly what libuv does, and what the real loop-delay histogram records.
// ---------------------------------------------------------------------------------------------

class FakeClock {
  t = 0
  idle = 0
  active = 0
  private seq = 0
  private timers = new Map<number, { due: number; every: number; fn: () => void }>()

  now = (): number => this.t
  wall = (): number => 1_700_000_000_000 + this.t

  setInterval = (fn: () => void, ms: number): number => {
    const id = ++this.seq
    this.timers.set(id, { due: this.t + ms, every: ms, fn })
    return id
  }
  clearInterval = (handle: unknown): void => { this.timers.delete(handle as number) }
  get timerCount(): number { return this.timers.size }

  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: { due: number; every: number; fn: () => void } | null = null
      for (const timer of this.timers.values()) if (timer.due <= end && (next === null || timer.due < next.due)) next = timer
      if (next === null) break
      const at = Math.max(this.t, next.due)
      this.idle += at - this.t
      this.t = at
      next.fn()
      next.due = this.t + next.every
    }
    this.idle += end - this.t
    this.t = end
  }

  block(ms: number): void {
    this.t += ms
    this.active += ms
  }
}

/** A loop-delay histogram on the fake loop: one 10 ms timer, like the real one. */
class FakeLoop implements LoopDelaySource {
  reads = 0
  resets = 0
  stops = 0
  private values: number[] = []
  private last: number
  constructor(private readonly clock: FakeClock, private readonly resolution = 10) {
    this.last = clock.t
    clock.setInterval(() => {
      this.values.push(clock.t - this.last)
      this.last = clock.t
    }, resolution)
  }
  readAndReset(): LoopDelayReading {
    this.reads++
    const v = this.values.slice().sort((a, b) => a - b)
    this.values = []
    this.resets++
    if (v.length === 0) return { count: 0, p50: 0, p99: 0, max: 0 }
    const q = (p: number): number => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]
    const d = (x: number): number => Math.max(0, x - this.resolution)
    return { count: v.length, p50: d(q(50)), p99: d(q(99)), max: d(v[v.length - 1]) }
  }
  stop(): void { this.stops++ }
}

interface Rig {
  clock: FakeClock
  loop: FakeLoop
  lines: string[]
  calls: { elu: number; freemem: number; rss: number; heap: number }
  emitGc: (kind: GcKind, ms: number) => void
  gcStops: { n: number }
  trace: ReturnType<typeof createTypingTrace>
}

function rig(over: Partial<TypingTraceDeps> = {}): Rig {
  const clock = new FakeClock()
  const loop = new FakeLoop(clock)
  const lines: string[] = []
  const calls = { elu: 0, freemem: 0, rss: 0, heap: 0 }
  const gcStops = { n: 0 }
  let gcCb: ((kind: GcKind, ms: number) => void) | null = null
  const trace = createTypingTrace({
    env: {},
    now: clock.now,
    wallNow: clock.wall,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    openLoopDelay: () => loop,
    readElu: () => { calls.elu++; return { idle: clock.idle, active: clock.active } },
    observeGc: (cb) => { gcCb = cb; return () => { gcStops.n++ } },
    freemem: () => { calls.freemem++; return 3 * 1024 * 1024 * 1024 },
    rss: () => { calls.rss++; return 900 * 1024 * 1024 },
    heap: () => { calls.heap++; return { used: 200 * 1024 * 1024, total: 300 * 1024 * 1024, limit: 4096 * 1024 * 1024 } },
    log: (line) => lines.push(line),
    ...over,
  })
  return { clock, loop, lines, calls, emitGc: (k, ms) => gcCb?.(k, ms), gcStops, trace }
}

const MAIN_SRC = path.join(__dirname, '..', '..', 'src', 'main', 'typingTrace.ts')

afterEach(() => { stopTypingTrace() })

// ---------------------------------------------------------------------------------------------
describe('typingTrace: loop delay', () => {
  it('a blocked loop raises loopDelay.max in the window it landed in', () => {
    const r = rig()
    r.trace.start()
    r.clock.advance(2_000)
    r.clock.block(1_500) // the thread is busy for 1.5 s inside this 5 s window
    r.clock.advance(1_500)
    expect(r.loop.reads).toBe(1)
    const last = r.trace.snapshot().loopDelay.last
    expect(last).not.toBeNull()
    // The 10 ms timer is delayed by the whole block; the histogram reports the delay beyond its period.
    expect(last!.max).toBeGreaterThanOrEqual(1_400)
    // One stall among ~350 samples is invisible to a percentile: `max` is the stall detector, and the
    // minute aggregate counts the windows whose max crossed 250 ms and 1 s.
    expect(last!.p99).toBeLessThan(50)
    expect(r.trace.snapshot().loopDelay.minute!.over1000).toBe(1)
  })

  it('NEGATIVE CONTROL: a quiet window reports a near-zero max, so the metric does discriminate', () => {
    const r = rig()
    r.trace.start()
    r.clock.advance(5_000)
    const last = r.trace.snapshot().loopDelay.last!
    expect(last.max).toBeLessThan(50)
    expect(last.count).toBeGreaterThan(0)
    expect(r.trace.snapshot().loopDelay.minute!.over250).toBe(0)
  })

  it('the minute aggregate takes the worst window, not an average that hides it', () => {
    const r = rig()
    r.trace.start()
    for (let w = 0; w < 12; w++) {
      if (w === 7) r.clock.block(900)
      r.clock.advance(5_000)
    }
    const minute = r.trace.snapshot().loopDelay.minute!
    expect(minute.windows).toBe(12)
    expect(minute.max).toBeGreaterThanOrEqual(850)
    expect(minute.p50Median).toBeLessThan(50)
    expect(minute.over250).toBe(1)
  })

  it('reports ELU as the busy share of each window', () => {
    const r = rig()
    r.trace.start()
    r.clock.advance(2_500)
    r.clock.block(2_500) // half of the 5 s window is spent running
    r.clock.advance(1) // let the overdue sampler fire (late) at the end of the block
    expect(r.trace.snapshot().elu).toBeCloseTo(0.5, 1)
    r.clock.advance(5_000)
    expect(r.trace.snapshot().elu).toBeLessThan(0.1)
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: the sampler stays cheap', () => {
  it('reads the loop histogram once per 5 s window, and memory once per 10 s', () => {
    const r = rig()
    r.trace.start()
    const timers = r.clock.timerCount
    expect(r.calls.elu).toBe(1) // the baseline reading taken at start
    r.clock.advance(60_000)
    expect(r.loop.reads).toBe(12) // 1 histogram read per sample
    expect(r.loop.resets).toBe(12)
    expect(r.calls.elu).toBe(1 + 12) // one reading per window
    expect(r.calls.freemem).toBe(6) // once per 10 s
    expect(r.calls.rss).toBe(6)
    expect(r.calls.heap).toBe(6)
    expect(r.clock.timerCount).toBe(timers) // it never arms another timer
  })

  it('NEGATIVE CONTROL: the counters are wired, so a sampler that read every second would show', () => {
    // The same harness around a sampler that reads on a 1 s cadence counts 5x the reads per window.
    const clock = new FakeClock()
    const loop = new FakeLoop(clock)
    clock.setInterval(() => { loop.readAndReset() }, 1_000)
    clock.advance(60_000)
    expect(loop.reads).toBe(60)
    expect(loop.reads).toBeGreaterThan(12)
  })

  it('does no sensor work per event: 10,000 writes and outputs read nothing', () => {
    const r = rig()
    r.trace.start()
    const base = { ...r.calls } // start() takes one baseline ELU reading and nothing else
    expect(base).toEqual({ elu: 1, freemem: 0, rss: 0, heap: 0 })
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    for (let i = 0; i < 10_000; i++) {
      write({}, { id: 't1', data: 'a', t: r.clock.wall() - 2 })
      r.trace.noteTerminalOutput('t1')
    }
    expect(r.loop.reads).toBe(0)
    expect(r.calls).toEqual(base)
    r.trace.snapshot() // and neither does reading the snapshot
    expect(r.loop.reads).toBe(0)
    expect(r.calls).toEqual(base)
  })

  it('samples memory into the snapshot after 10 s, in whole MB', () => {
    const r = rig()
    r.trace.start()
    expect(r.trace.snapshot().memory).toBeNull()
    r.clock.advance(10_000)
    expect(r.trace.snapshot().memory).toEqual({ freeMB: 3072, rssMB: 900, heapUsedMB: 200, heapTotalMB: 300, heapLimitMB: 4096 })
  })

  it('imports no inspector and drives no profiler', () => {
    const src = fs.readFileSync(MAIN_SRC, 'utf8')
    expect(offendsInstrumentRule(src)).toEqual([])
  })

  it('NEGATIVE CONTROL: the inspector rule does flag an inspector import and a profiler call', () => {
    expect(offendsInstrumentRule(`import { Session } from 'node:inspector'`).length).toBeGreaterThan(0)
    expect(offendsInstrumentRule(`const x = require('inspector')`).length).toBeGreaterThan(0)
    expect(offendsInstrumentRule(`session.post('x'); Profiler.stop()`).length).toBeGreaterThan(0)
    expect(offendsInstrumentRule(`import { cpus } from 'os'`)).toEqual([])
  })
})

/** The same patterns tests/electron/noMainThreadInstruments.test.ts enforces, applied to one source. */
function offendsInstrumentRule(src: string): string[] {
  const out: string[] = []
  if (/from ['"](node:)?inspector['"]|require\(['"](node:)?inspector['"]\)/.test(src)) out.push('inspector import')
  if (/Profiler\.(start|stop|enable|setSamplingInterval)/.test(src)) out.push('profiler call')
  return out
}

// ---------------------------------------------------------------------------------------------
describe('typingTrace: the feedback-loop check (v1.25.16)', () => {
  /** The metric: after the external storm ends, how many quiet windows still show a stall on their own? */
  function selfSustainedStalls(r: Rig, quietWindows: number): number {
    let stalled = 0
    for (let w = 0; w < quietWindows; w++) {
      r.clock.advance(5_000)
      const last = r.trace.snapshot().loopDelay.last
      if (last !== null && last.max >= 250) stalled++
    }
    return stalled
  }

  it('a 2 s stall injected 100 times does not raise the next window baseline', () => {
    const r = rig()
    r.trace.start()
    r.clock.advance(5_000)
    const before = r.trace.snapshot().loopDelay.last!
    const readsBefore = r.loop.reads
    const timersBefore = r.clock.timerCount

    let stormWindows = 0
    for (let i = 0; i < 100; i++) {
      r.clock.block(2_000)
      r.clock.advance(3_000)
      if (r.trace.snapshot().loopDelay.last!.max >= 1_900) stormWindows++
    }
    expect(stormWindows).toBe(100) // each stall really was seen

    // Sampler cost is per window, whatever the loop did: still exactly one read per window.
    const windowsDuringStorm = r.loop.reads - readsBefore
    expect(windowsDuringStorm).toBeGreaterThanOrEqual(100)
    expect(r.loop.reads).toBe(r.loop.resets)
    expect(r.calls.elu).toBe(r.loop.reads + 1) // one reading per window, plus the baseline at start
    expect(r.clock.timerCount).toBe(timersBefore)

    // The storm is over: the next window's baseline is the one from before it, and nothing keeps
    // stalling. Twelve quiet windows also flush the minute's ring of every storm window.
    expect(selfSustainedStalls(r, 12)).toBe(0)
    const after = r.trace.snapshot().loopDelay.last!
    expect(after.p50).toBe(before.p50)
    expect(after.max).toBeLessThan(50)
    expect(r.trace.snapshot().loopDelay.minute!.over250).toBe(0)
  })

  it('writes the same one line a minute however many stalls there were', () => {
    const calm = rig()
    const stormy = rig()
    calm.trace.start()
    stormy.trace.start()
    // Five minutes of fake time each, one sampler tick per iteration. The calm app is typed into; the
    // stormy one is blocked for 2 s of every 5 s window: sixty stalls. Both minutes count as "active".
    const write = calm.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    for (let i = 0; i < 60; i++) {
      if (i % 12 === 0) write({}, { id: 't1', data: 'a' })
      calm.clock.advance(5_000)
      stormy.clock.block(2_000)
      stormy.clock.advance(3_000)
    }
    expect(calm.lines.length).toBe(5)
    expect(stormy.lines.length).toBe(5) // sixty stalls did not buy a single extra line
    expect(stormy.loop.reads).toBe(calm.loop.reads) // nor a single extra histogram read
  })

  it('NEGATIVE CONTROL: a profiler that harvests on every stall IS caught, by the same metric', () => {
    // A model of v1.25.15's stall watchdog: a 250 ms tick that, on seeing drift, runs a harvest that
    // itself blocks the thread for ~1 s (Profiler.stop in a 1.1 GB heap). Its own block delays its
    // next tick, which it reads as another stall: it feeds on itself and never lets go.
    const r = rig()
    let harvests = 0
    let last = r.clock.t
    r.clock.setInterval(() => {
      const drift = r.clock.t - last - 250
      last = r.clock.t
      if (drift > 150) { harvests++; r.clock.block(1_000) }
    }, 250)
    r.trace.start()
    r.clock.advance(5_000)
    r.clock.block(2_000) // ONE external stall is all it needs
    r.clock.advance(3_000)
    const stalledAfterStorm = selfSustainedStalls(r, 6)
    expect(harvests).toBeGreaterThan(10)
    expect(stalledAfterStorm).toBeGreaterThan(0) // the harness flags it: the real sampler scored 0 above
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: T1 (renderer to main) and T2 (pty write to first output)', () => {
  it('a stamped write records T1 on arrival and T2 when the first output follows', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => { r.clock.block(3) })
    write({}, { id: 't1', data: 'x', t: r.clock.wall() - 12 }) // the key was typed 12 ms ago
    r.clock.advance(7)
    r.trace.noteTerminalOutput('t1') // the echo leaves main 7 ms after the handler returned
    const s = r.trace.snapshot()
    expect(s.t1).toEqual({ n: 1, avg: 12, max: 12 })
    expect(s.t2.n).toBe(1)
    expect(s.t2.avg).toBe(7)
    expect(s.ipc['terminal:write']).toEqual({ count: 1, msSum: 3, msMax: 3 })
  })

  it('NEGATIVE CONTROL: an unstamped write records the handler only, never T1 or T2', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    write({}, { id: 't1', data: 'x' })
    r.trace.noteTerminalOutput('t1')
    const s = r.trace.snapshot()
    expect(s.t1.n).toBe(0)
    expect(s.t2.n).toBe(0)
    expect(s.ipc['terminal:write'].count).toBe(1)
  })

  it('records only 1 stamped write in 10 when the renderer stamps 1 in 10', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    for (let i = 1; i <= 100; i++) {
      write({}, i % 10 === 0 ? { id: 't1', data: 'k', t: r.clock.wall() } : { id: 't1', data: 'k' })
      r.clock.advance(1)
      r.trace.noteTerminalOutput('t1')
    }
    const s = r.trace.snapshot()
    expect(s.ipc['terminal:write'].count).toBe(100)
    expect(s.t1.n).toBe(10)
    expect(s.t2.n).toBe(10)
  })

  it('drops a stamp from a clock that disagrees, and a T2 whose echo never came', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    write({}, { id: 't1', data: 'x', t: r.clock.wall() + 5_000 }) // from the future
    write({}, { id: 't2', data: 'x', t: r.clock.wall() - 600_000 }) // ten minutes old
    write({}, { id: 't3', data: 'x', t: Number.NaN })
    write({}, { id: 't4', data: 'x', t: 'now' })
    expect(r.trace.snapshot().t1.n).toBe(0)

    write({}, { id: 't5', data: 'x', t: r.clock.wall() - 1 })
    r.clock.advance(30_000) // a password prompt: no echo for half a minute
    r.trace.noteTerminalOutput('t5')
    const s = r.trace.snapshot()
    expect(s.t2.n).toBe(0)
    expect(s.t2.expired).toBe(1)
  })

  it('keeps the unanswered-write table bounded and ignores output for a terminal it never timed', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    r.trace.noteTerminalOutput('nobody') // nothing pending: the hot path leaves at once
    for (let i = 0; i < 500; i++) write({}, { id: `term-${i}`, data: 'x', t: r.clock.wall() })
    r.trace.noteTerminalOutput('term-499')
    r.trace.noteTerminalOutput('term-499') // already answered
    r.trace.noteTerminalOutput('term-0') // evicted when the table was capped
    expect(r.trace.snapshot().t2.n).toBe(1)
  })

  it('tolerates a payload that is not an object, and passes the handler result and errors through', () => {
    const r = rig()
    r.trace.start()
    const boom = new Error('pty gone')
    const handler = vi.fn((_e: unknown, p: unknown) => { if (p === 'throw') throw boom; return 7 })
    const write = r.trace.traceTerminalWrite(handler as (e: unknown, p: unknown) => number)
    expect(write({}, null)).toBe(7)
    expect(write({}, 'text')).toBe(7)
    expect(write({}, { id: 5, data: 'x', t: 1 })).toBe(7)
    expect(() => write({}, 'throw')).toThrow(boom)
    expect(handler).toHaveBeenCalledTimes(4)
    expect(r.trace.snapshot().ipc['terminal:write'].count).toBe(4)
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: per-handler counters', () => {
  it('times a sync handler, an async handler and a failing one, and returns what they return', async () => {
    const r = rig()
    r.trace.start()
    const resize = r.trace.timedIpc('terminal:resize', (_e: unknown, n: number) => { r.clock.block(n); return n * 2 })
    expect(resize({}, 4)).toBe(8)
    expect(resize({}, 10)).toBe(20)

    const reflect = r.trace.timedIpc('memory:reflect-session', async (_e: unknown, ms: number) => { r.clock.block(ms); return 'done' })
    await expect(reflect({}, 40)).resolves.toBe('done')

    const failing = r.trace.timedIpc('agentWatcher:attach', async () => { r.clock.block(5); throw new Error('nope') })
    await expect(failing()).rejects.toThrow('nope')
    const sync = r.trace.timedIpc('terminal:kill', () => { r.clock.block(1); throw new Error('sync nope') })
    expect(() => sync()).toThrow('sync nope')

    const ipc = r.trace.snapshot().ipc
    expect(ipc['terminal:resize']).toEqual({ count: 2, msSum: 14, msMax: 10 })
    expect(ipc['memory:reflect-session']).toEqual({ count: 1, msSum: 40, msMax: 40 })
    expect(ipc['agentWatcher:attach']).toEqual({ count: 1, msSum: 5, msMax: 5 })
    expect(ipc['terminal:kill']).toEqual({ count: 1, msSum: 1, msMax: 1 })
  })

  it('times each MCP tool by name, refuses odd names, and caps how many it will track', async () => {
    const r = rig()
    r.trace.start()
    const run = (name: string, ms: number): Promise<string> =>
      r.trace.traceMcpTool(name, async () => { r.clock.block(ms); return name })
    await expect(run('create_terminal', 20)).resolves.toBe('create_terminal')
    await run('create_terminal', 5)
    await run('bad name with spaces', 1)
    await run('x'.repeat(200), 1)
    for (let i = 0; i < 100; i++) await run(`tool_${i}`, 1)
    await expect(r.trace.traceMcpTool('boom', async () => { throw new Error('tool failed') })).rejects.toThrow('tool failed')

    const ipc = r.trace.snapshot().ipc
    expect(ipc['mcp:create_terminal']).toEqual({ count: 2, msSum: 25, msMax: 20 })
    expect(ipc['mcp:other'].count).toBeGreaterThanOrEqual(2)
    expect(Object.keys(ipc).length).toBeLessThanOrEqual(65) // the cap, plus the shared overflow bucket
  })

  it('NEGATIVE CONTROL: with the kill switch thrown the wrappers are the original functions', () => {
    const r = rig({ env: { [KILL_SWITCH_ENV]: '0' } })
    const original = (): number => 1
    expect(r.trace.enabled).toBe(false)
    expect(r.trace.timedIpc('x', original)).toBe(original)
    expect(r.trace.traceTerminalWrite(original)).toBe(original)
    const p = Promise.resolve(3)
    expect(r.trace.traceMcpTool('tool', () => p)).toBe(p)
    r.trace.noteTerminalOutput('t1')
    r.trace.start()
    expect(r.clock.timerCount).toBe(1) // only the fake histogram's own timer, which the test created
    expect(r.trace.snapshot().enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: garbage collection', () => {
  it('counts major and incremental collections with their longest pause, and minors by count', () => {
    const r = rig()
    r.trace.start()
    r.emitGc('major', 40)
    r.emitGc('major', 95.5)
    r.emitGc('incremental', 6)
    r.emitGc('minor', 1)
    r.emitGc('minor', 2)
    r.emitGc('other', 500)
    expect(r.trace.snapshot().gc).toEqual({ majorCount: 2, majorMaxMs: 95.5, incrementalCount: 1, incrementalMaxMs: 6, minorCount: 2 })
  })

  it('stops the observer on stop()', () => {
    const r = rig()
    r.trace.start()
    r.trace.stop()
    expect(r.gcStops.n).toBe(1)
    expect(r.loop.stops).toBe(1)
    r.trace.stop() // idempotent
    expect(r.gcStops.n).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: the one log line a minute', () => {
  const ALLOWED = /^[A-Za-z0-9 _.:=,;()<>\/%+\-[\]|]+$/

  function typeFor(r: Rig, minutes: number, perMinute = 1): void {
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    for (let m = 0; m < minutes; m++) {
      for (let i = 0; i < perMinute; i++) write({}, { id: 't1', data: 'q', t: r.clock.wall() - 4 })
      r.trace.noteTerminalOutput('t1')
      r.clock.advance(60_000)
    }
  }

  it('writes exactly one line per active minute', () => {
    const r = rig()
    r.trace.start()
    typeFor(r, 3)
    expect(r.lines.length).toBe(3)
    expect(r.lines[0].startsWith('[typing-trace]')).toBe(true)
    expect(r.lines[0]).toContain('terminal:write n=1')
    expect(r.lines[0]).toContain('t1 n=1')
  })

  it('stays silent through an idle minute, so an idle app does not fill the app log', () => {
    const r = rig()
    r.trace.start()
    r.clock.advance(5 * 60_000)
    expect(r.lines).toEqual([])
  })

  it('speaks up for a minute with a stall even when nobody typed', () => {
    const r = rig()
    r.trace.start()
    r.clock.advance(30_000)
    r.clock.block(1_200)
    r.clock.advance(30_000)
    expect(r.lines.length).toBe(1)
    expect(r.lines[0]).toMatch(/max=1[12]\d\d(\.\d)?ms/)
  })

  it('speaks up for a major collection', () => {
    const r = rig()
    r.trace.start()
    r.emitGc('major', 80)
    r.clock.advance(60_000)
    expect(r.lines.length).toBe(1)
    expect(r.lines[0]).toContain('gc major=1/80ms')
  })

  it('contains only numbers and fixed labels: no content, no ids, no paths', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    write({}, { id: 'C:\\Users\\someone\\secret-terminal', data: 'hunter2 P@ssw0rd', t: r.clock.wall() - 3 })
    r.trace.noteTerminalOutput('C:\\Users\\someone\\secret-terminal')
    r.clock.advance(60_000)
    expect(r.lines.length).toBe(1)
    const line = r.lines[0]
    expect(line).toMatch(ALLOWED)
    for (const leak of ['hunter2', 'P@ssw0rd', 'secret-terminal', 'someone', 'Users']) expect(line).not.toContain(leak)
  })

  it('NEGATIVE CONTROL: the allow-list does reject a line that carries content', () => {
    expect(ALLOWED.test('[typing-trace] loop p50med=0ms terminal:write n=1')).toBe(true)
    expect(ALLOWED.test('[typing-trace] typed "hunter2"')).toBe(false)
    expect(ALLOWED.test('[typing-trace] C:\\Users\\x')).toBe(false)
  })

  it('names only the busiest handlers, so the line stays short', () => {
    const r = rig()
    r.trace.start()
    for (let i = 0; i < 30; i++) r.trace.timedIpc(`channel:${i}`, () => { r.clock.block(i + 1) })()
    r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)({}, { id: 't1', data: 'x' })
    r.clock.advance(60_000)
    expect(r.lines.length).toBe(1)
    const line = r.lines[0]
    expect(line.length).toBeLessThan(900)
    expect((line.match(/ n=\d+ sum=/g) ?? []).length).toBeLessThanOrEqual(6)
    expect(line).toContain('channel:29') // the busiest is named
    expect(line).not.toContain('channel:0 ') // the quietest is not
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: fails open and can be switched off', () => {
  it('does nothing at all when the kill switch is thrown', () => {
    for (const v of ['0', 'off', 'FALSE', 'no']) {
      const r = rig({ env: { [KILL_SWITCH_ENV]: v } })
      const timers = r.clock.timerCount
      r.trace.start()
      expect(r.clock.timerCount).toBe(timers)
      r.clock.advance(60_000)
      expect(r.loop.reads).toBe(0)
      expect(r.lines).toEqual([])
    }
  })

  it('NEGATIVE CONTROL: any other value leaves it on', () => {
    for (const v of [undefined, '', '1', 'on', 'yes']) {
      const r = rig({ env: { [KILL_SWITCH_ENV]: v } })
      expect(r.trace.enabled).toBe(true)
    }
  })

  it('starts once, and survives a histogram that cannot be opened', () => {
    const r = rig({ openLoopDelay: () => null })
    r.trace.start()
    r.trace.start()
    r.clock.advance(60_000)
    expect(r.trace.snapshot().loopDelay).toEqual({ last: null, minute: null }) // unknown is not 0 ms
    expect(r.calls.freemem).toBe(6)
  })

  it('survives every sensor throwing', () => {
    const boom = (): never => { throw new Error('sensor') }
    const r = rig({ openLoopDelay: boom, readElu: boom, observeGc: boom, freemem: boom, rss: boom, heap: boom, log: boom })
    expect(() => {
      r.trace.start()
      const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
      write({}, { id: 't1', data: 'x', t: r.clock.wall() })
      r.clock.advance(120_000)
    }).not.toThrow()
    const s = r.trace.snapshot()
    expect(s.memory).toBeNull()
    expect(s.elu).toBeNull()
  })

  it('survives a histogram that throws on read', () => {
    const bad: LoopDelaySource = { readAndReset: () => { throw new Error('read') }, stop: () => { throw new Error('stop') } }
    const r = rig({ openLoopDelay: () => bad })
    r.trace.start()
    expect(() => { r.clock.advance(60_000); r.trace.stop() }).not.toThrow()
  })

  it('reports an unstarted trace as such', () => {
    const r = rig()
    const s = r.trace.snapshot()
    expect(s.enabled).toBe(true)
    expect(s.started).toBe(false)
    expect(s.loopDelay).toEqual({ last: null, minute: null })
    expect(s.uptimeMs).toBe(0)
  })

  it('exposes registered sources under extra, and skips one that throws', () => {
    const r = rig()
    r.trace.registerSource('passes', () => ({ ingest: 4, reflect: 2 }))
    r.trace.registerSource('broken', () => { throw new Error('x') })
    r.trace.registerSource('late', () => ({ n: 1 }))
    r.trace.registerSource('late', () => ({ n: 2 })) // re-registering replaces
    expect(r.trace.snapshot().extra).toEqual({ passes: { ingest: 4, reflect: 2 }, late: { n: 2 } })
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: the record is numbers only', () => {
  function leaves(v: unknown, out: unknown[] = []): unknown[] {
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out)
    else out.push(v)
    return out
  }
  const numbersOnly = (v: unknown): boolean => leaves(v).every((x) => x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))

  it('holds no key content however much is typed', () => {
    const r = rig()
    r.trace.start()
    const write = r.trace.traceTerminalWrite((_e: unknown, _p: unknown) => undefined)
    for (const ch of ['é', '€', '日', 'Q', '\r', '\x1b[A', 'rm -rf /', 'password=hunter2']) {
      write({}, { id: 'abc-123', data: ch, t: r.clock.wall() - 1 })
      r.trace.noteTerminalOutput('abc-123')
    }
    r.clock.advance(60_000)
    const snap = r.trace.snapshot()
    expect(numbersOnly(snap)).toBe(true)
    const json = JSON.stringify(snap)
    for (const leak of ['hunter2', 'rm -rf', 'abc-123', '€', '日']) expect(json).not.toContain(leak)
  })

  it('NEGATIVE CONTROL: the walker does flag a record with a string in it', () => {
    expect(numbersOnly({ a: 1, b: { c: null, d: true } })).toBe(true)
    expect(numbersOnly({ a: 1, b: { c: 'typed text' } })).toBe(false)
    expect(numbersOnly({ a: Number.NaN })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: the real Node adapters', () => {
  const NS = 1e6

  function fakeHistogram(values: { count: number; p50: number; p99: number; max: number }) {
    const calls: string[] = []
    const h = {
      count: values.count,
      max: values.max * NS,
      enable: () => { calls.push('enable'); return true },
      disable: () => { calls.push('disable'); return true },
      reset: () => { calls.push('reset') },
      percentile: (p: number) => (values.count === 0 ? 511 : (p === 50 ? values.p50 : values.p99) * NS),
    }
    return { h, calls }
  }

  it('converts nanoseconds to the delay beyond the 10 ms period, in one read pass', () => {
    const { h, calls } = fakeHistogram({ count: 480, p50: 15.9, p99: 60, max: 153.9 })
    const mon = vi.fn(() => h)
    const src = openLoopDelay({ monitorEventLoopDelay: mon } as never)!
    expect(mon).toHaveBeenCalledWith({ resolution: 10 })
    expect(calls).toEqual(['enable'])
    const r = src.readAndReset()
    expect(r.count).toBe(480)
    expect(r.p50).toBeCloseTo(5.9, 5)
    expect(r.p99).toBeCloseTo(50, 5)
    expect(r.max).toBeCloseTo(143.9, 5)
    expect(calls).toEqual(['enable', 'reset'])
    src.stop()
    expect(calls).toEqual(['enable', 'reset', 'disable'])
  })

  it('NEGATIVE CONTROL: an empty histogram reads as zero, not the 511 ns floor Node reports for it', () => {
    const { h } = fakeHistogram({ count: 0, p50: 0, p99: 0, max: 0 })
    expect(h.percentile(50)).toBe(511) // the trap: an empty histogram does not say 0
    const src = openLoopDelay({ monitorEventLoopDelay: () => h } as never)!
    expect(src.readAndReset()).toEqual({ count: 0, p50: 0, p99: 0, max: 0 })
  })

  it('never reports a negative delay when the timer fires early', () => {
    const { h } = fakeHistogram({ count: 3, p50: 9, p99: 9.5, max: 9.9 })
    const src = openLoopDelay({ monitorEventLoopDelay: () => h } as never)!
    expect(src.readAndReset()).toEqual({ count: 3, p50: 0, p99: 0, max: 0 })
  })

  it('returns null when the histogram cannot be opened', () => {
    expect(openLoopDelay({ monitorEventLoopDelay: () => { throw new Error('no') } } as never)).toBeNull()
  })

  it('reads ELU as one absolute sample, or null when unavailable', () => {
    const ph = { performance: { eventLoopUtilization: vi.fn(() => ({ idle: 10, active: 5, utilization: 0.33 })) } }
    const read = openEluReader(ph as never)
    expect(read()).toEqual({ idle: 10, active: 5 })
    expect(ph.performance.eventLoopUtilization).toHaveBeenCalledTimes(1)
    const broken = openEluReader({ performance: {} } as never)
    expect(broken()).toBeNull()
  })

  it('maps GC kinds from entry.detail, falls back to the old entry.kind, and ignores unknown kinds', () => {
    const constants = { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP: 2, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 }
    let deliver: (list: { getEntries: () => unknown[] }) => void = () => undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    class FakeObserver {
      constructor(cb: typeof deliver) { deliver = cb }
      observe = observe
      disconnect = disconnect
    }
    const seen: Array<[GcKind, number]> = []
    const stop = observeGc((k, ms) => seen.push([k, ms]), { PerformanceObserver: FakeObserver, constants } as never)!
    expect(observe).toHaveBeenCalledWith({ entryTypes: ['gc'] })
    deliver({ getEntries: () => [
      { detail: { kind: 4 }, duration: 30 },
      { detail: { kind: 8 }, duration: 4 },
      { detail: { kind: 1 }, duration: 1 },
      { detail: { kind: 2 }, duration: 2 },
      { detail: { kind: 16 }, duration: 3 },
      { kind: 4, duration: 9 }, // an old runtime: no detail, the kind sits on the entry
      { detail: null, kind: 1, duration: 0.5 },
    ] })
    expect(seen).toEqual([['major', 30], ['incremental', 4], ['minor', 1], ['minor', 2], ['other', 3], ['major', 9], ['minor', 0.5]])
    stop()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('returns null when the GC observer cannot be started', () => {
    class Throws { constructor() { throw new Error('unsupported') } }
    expect(observeGc(() => undefined, { PerformanceObserver: Throws, constants: {} } as never)).toBeNull()
  })

  it('SMOKE: the real histogram sees a real 100 ms block, in milliseconds, and resets', async () => {
    const src = openLoopDelay()
    expect(src).not.toBeNull()
    await new Promise((r) => setTimeout(r, 40))
    const until = Date.now() + 100
    while (Date.now() < until) { /* hold the thread */ }
    await new Promise((r) => setTimeout(r, 40))
    const first = src!.readAndReset()
    expect(first.count).toBeGreaterThan(0)
    expect(first.max).toBeGreaterThanOrEqual(60) // a lower bound only: a timer cannot fire during the block
    expect(first.max).toBeLessThan(60_000) // and it is milliseconds, not nanoseconds
    // Nothing can run between these two synchronous reads, so the second sees only what reset left behind.
    expect(src!.readAndReset()).toEqual({ count: 0, p50: 0, p99: 0, max: 0 })
    src!.stop()
  })
})

// ---------------------------------------------------------------------------------------------
describe('typingTrace: the module-level entry points index.ts calls', () => {
  it('start, wrap, time, snapshot and stop work on the shared instance', async () => {
    startTypingTrace()
    startTypingTrace() // idempotent
    expect(getTypingTraceSnapshot().enabled).toBe(true)
    expect(getTypingTraceSnapshot().started).toBe(true)

    const write = traceTerminalWrite((_e: unknown, p: { id: string }) => p.id)
    expect(write({}, { id: 'shared-1' })).toBe('shared-1')
    noteTerminalOutput('shared-1')
    expect(timedIpc('shared:channel', (x: number) => x + 1)(1)).toBe(2)
    await expect(traceMcpTool('shared_tool', async () => 5)).resolves.toBe(5)
    registerTypingTraceSource('shared-source', () => ({ ok: 1 }))

    const s = getTypingTraceSnapshot()
    expect(s.ipc['terminal:write'].count).toBeGreaterThanOrEqual(1)
    expect(s.ipc['shared:channel'].count).toBe(1)
    expect(s.ipc['mcp:shared_tool'].count).toBe(1)
    expect(s.extra['shared-source']).toEqual({ ok: 1 })

    stopTypingTrace()
    expect(getTypingTraceSnapshot().started).toBe(false)
  })
})
