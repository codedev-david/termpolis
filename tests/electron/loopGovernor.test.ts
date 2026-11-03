/**
 * The event-loop governor (1.54.5 hotfix, lane G, plan package P13 reduced).
 *
 * WHY: node-pty runs inside Electron's main process, so every keystroke and every echo crosses the main
 * event loop. When something else holds that loop for 100 ms to 1.5 s (a sync open under Defender, a
 * process creation, a whole-file parse), typing lags. The governor watches the loop and, while it is
 * struggling, lets the background timers that live in files nobody else edits stand down. It never acts
 * on the typing path, and nothing it does may feed what it measures (the v1.25.16 lesson: a freeze
 * detector that was the freeze).
 *
 * PROOF STYLE: counters, never wall-clock ratios. Every behaviour has a negative control in this file
 * ("control:" tests) that shows the assertion would notice the opposite behaviour. The histogram, the
 * timers, the clock, the logger and the registry are all injected, so no test waits for real time.
 *
 * MEASURED FACTS (this laptop, Node 24, own processes only) the numbers below rest on:
 *   - idle monitorEventLoopDelay({ resolution: 20 }) on Windows reports p50 31.5 ms / p99 42-44 ms (the 15.6 ms
 *     timer tick), so the governor compares DELAY = rawP99 - idleFloor, never the raw number;
 *   - histogram.reset() clears its previous-tick marker, so a stall that starts right after a reset is
 *     dropped by the histogram; the sampler's own lateness still sees it, so the sensor uses both;
 *   - an empty histogram answers percentile(99) = 511 (ns), not 0.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'
import { readAppLog, clearAppLog } from '../../src/main/appLog'
import {
  createShedRegistry,
  createShedGate,
  shedRegistry,
  registerShed,
  isShed,
  onShedChange,
  startLoopGovernor,
  installLoopGovernor,
  getGovernorSnapshot,
  idleFloorMs,
  DEFAULT_GOVERNOR_CONFIG,
  __resetLoopGovernorForTests,
  type GovernorConfig,
  type GovernorDeps,
} from '../../src/main/loopGovernor'

afterEach(() => {
  __resetLoopGovernorForTests()
  vi.useRealTimers()
})

// ── fakes ────────────────────────────────────────────────

interface Rig {
  handle: ReturnType<typeof startLoopGovernor>
  registry: ReturnType<typeof createShedRegistry>
  hist: { value: number; enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; percentile: ReturnType<typeof vi.fn> }
  histReads: string[]
  logs: string[]
  freememAt: number[]
  setIntervalFn: ReturnType<typeof vi.fn>
  clearIntervalFn: ReturnType<typeof vi.fn>
  createHistogram: ReturnType<typeof vi.fn>
  /** One sampler tick: the clock moves `dtMs` (default: exactly the sample period), the histogram answers `p99Ms`. */
  sample: (p99Ms: number, dtMs?: number) => void
  /** The sampler callback as it was first registered, callable even after stop() cleared the interval. */
  staleTick: () => void
  elapsed: () => number
}

function rig(opts: { config?: Partial<GovernorConfig>; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; freememBytes?: number; pairs?: Array<[string, { pause: () => void; resume: () => void }]> } = {}): Rig {
  let now = 1_000_000
  const t0 = now
  let tick: (() => void) | undefined
  const histReads: string[] = []
  const hist = {
    value: 0,
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn((_p: number) => hist.value * 1e6),
  }
  // Every property the governor touches is recorded, so "1 histogram read per sample" is a counter, not a hope.
  const proxied = new Proxy(hist, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop !== 'value') histReads.push(prop)
      return Reflect.get(target, prop, receiver)
    },
  })
  let firstTick: (() => void) | undefined
  const setIntervalFn = vi.fn((fn: () => void) => { tick = fn; firstTick = fn; return { unref: () => {} } })
  const clearIntervalFn = vi.fn(() => { tick = undefined })
  const createHistogram = vi.fn(() => proxied)
  const logs: string[] = []
  const freememAt: number[] = []
  const registry = createShedRegistry()
  for (const [name, hooks] of opts.pairs ?? []) registry.register(name, hooks)
  const deps: GovernorDeps = {
    env: opts.env ?? {},
    platform: opts.platform ?? 'linux',
    createHistogram,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    now: () => now,
    freemem: () => { freememAt.push(now); return opts.freememBytes ?? 6 * 1024 ** 3 },
    log: (line) => logs.push(line),
    registry,
    // idleFloorMs 0 maps the fake histogram's numbers 1:1 onto the brief's thresholds.
    config: { idleFloorMs: 0, ...opts.config },
  }
  const handle = startLoopGovernor(deps)
  return {
    handle, registry, hist, histReads, logs, freememAt, setIntervalFn, clearIntervalFn, createHistogram,
    sample: (p99Ms, dtMs = DEFAULT_GOVERNOR_CONFIG.sampleMs) => { now += dtMs; hist.value = p99Ms; tick!() },
    elapsed: () => now - t0,
    staleTick: () => firstTick?.(),
  }
}

const SLOW = 150 // ms, above the 100 ms enter threshold
const CALM = 10 // ms, below the 40 ms leave threshold
const hooks = () => ({ pause: vi.fn(), resume: vi.fn() })

// ── 1. the registry ────────────────────────────────────────────────

describe('shed registry: register / isShed / onShedChange', () => {
  it('entering SHED calls every registered pause exactly once, leaving calls every resume exactly once', () => {
    const reg = createShedRegistry()
    const a = hooks(), b = hooks(), c = hooks()
    reg.register('a', a); reg.register('b', b); reg.register('c', c)
    expect(a.pause).not.toHaveBeenCalled() // control: registering while calm touches nothing
    expect(reg.setShed(true)).toBe(true)
    for (const h of [a, b, c]) { expect(h.pause).toHaveBeenCalledTimes(1); expect(h.resume).not.toHaveBeenCalled() }
    expect(reg.isShed()).toBe(true)
    expect(reg.setShed(false)).toBe(true)
    for (const h of [a, b, c]) { expect(h.pause).toHaveBeenCalledTimes(1); expect(h.resume).toHaveBeenCalledTimes(1) }
    expect(reg.isShed()).toBe(false)
  })

  it('control: setting the state it already has calls nothing again', () => {
    const reg = createShedRegistry()
    const a = hooks()
    reg.register('a', a)
    expect(reg.setShed(false)).toBe(false)
    reg.setShed(true)
    expect(reg.setShed(true)).toBe(false)
    expect(a.pause).toHaveBeenCalledTimes(1)
    reg.setShed(false)
    expect(reg.setShed(false)).toBe(false)
    expect(a.resume).toHaveBeenCalledTimes(1)
  })

  it('a registration made while shed is paused immediately (once) and resumed once when SHED ends', () => {
    const reg = createShedRegistry()
    reg.setShed(true)
    const late = hooks()
    reg.register('late', late)
    expect(late.pause).toHaveBeenCalledTimes(1)
    reg.setShed(false)
    expect(late.resume).toHaveBeenCalledTimes(1)
    expect(late.pause).toHaveBeenCalledTimes(1)
  })

  it('control: a registration made while calm is NOT paused', () => {
    const reg = createShedRegistry()
    const calm = hooks()
    reg.register('calm', calm)
    expect(calm.pause).not.toHaveBeenCalled()
  })

  it('registering one name twice replaces the old one: the old is never called again and its unregister cannot remove the new', () => {
    const reg = createShedRegistry()
    const oldH = hooks(), newH = hooks()
    const unregisterOld = reg.register('x', oldH)
    reg.register('x', newH)
    expect(reg.names()).toEqual(['x'])
    reg.setShed(true)
    expect(oldH.pause).not.toHaveBeenCalled()
    expect(newH.pause).toHaveBeenCalledTimes(1)
    unregisterOld() // a stale unregister must be a no-op
    expect(reg.names()).toEqual(['x'])
    reg.setShed(false)
    expect(oldH.resume).not.toHaveBeenCalled()
    expect(newH.resume).toHaveBeenCalledTimes(1)
  })

  it('a replacement made while shed is paused once, and the old one gets no callback', () => {
    const reg = createShedRegistry()
    const oldH = hooks(), newH = hooks()
    reg.register('x', oldH)
    reg.setShed(true)
    reg.register('x', newH)
    expect(oldH.pause).toHaveBeenCalledTimes(1)
    expect(oldH.resume).not.toHaveBeenCalled()
    expect(newH.pause).toHaveBeenCalledTimes(1)
    reg.setShed(false)
    expect(newH.resume).toHaveBeenCalledTimes(1)
    expect(oldH.resume).not.toHaveBeenCalled()
  })

  it('a throwing pause (and a throwing resume) never stops the others, and the thrower still gets its resume', () => {
    const reg = createShedRegistry()
    const first = hooks()
    const bad = { pause: vi.fn(() => { throw new Error('pause boom') }), resume: vi.fn(() => { throw new Error('resume boom') }) }
    const last = hooks()
    reg.register('first', first); reg.register('bad', bad); reg.register('last', last)
    expect(() => reg.setShed(true)).not.toThrow()
    expect(first.pause).toHaveBeenCalledTimes(1)
    expect(last.pause).toHaveBeenCalledTimes(1)
    expect(() => reg.setShed(false)).not.toThrow()
    expect(first.resume).toHaveBeenCalledTimes(1)
    expect(last.resume).toHaveBeenCalledTimes(1)
    expect(bad.pause).toHaveBeenCalledTimes(1)
    expect(bad.resume).toHaveBeenCalledTimes(1)
  })

  it('unregister removes the entry, calls nothing (not even resume) and is idempotent', () => {
    const reg = createShedRegistry()
    const a = hooks()
    const unregister = reg.register('a', a)
    reg.setShed(true)
    unregister()
    unregister()
    expect(reg.names()).toEqual([])
    reg.setShed(false)
    expect(a.resume).not.toHaveBeenCalled()
    expect(a.pause).toHaveBeenCalledTimes(1)
  })

  it('onShedChange hears each transition once, in order, after the hooks; unsubscribe stops it; a throwing listener breaks nobody', () => {
    const reg = createShedRegistry()
    const order: string[] = []
    reg.register('h', { pause: () => order.push('pause'), resume: () => order.push('resume') })
    const heard: boolean[] = []
    const unsubscribe = reg.onShedChange((s) => { order.push(`listener:${s}`); heard.push(s) })
    reg.onShedChange(() => { throw new Error('listener boom') })
    const other: boolean[] = []
    reg.onShedChange((s) => other.push(s))
    reg.setShed(true)
    reg.setShed(false)
    expect(heard).toEqual([true, false])
    expect(other).toEqual([true, false])
    expect(order).toEqual(['pause', 'listener:true', 'resume', 'listener:false'])
    unsubscribe()
    reg.setShed(true)
    expect(heard).toEqual([true, false]) // control: no longer called
    expect(other).toEqual([true, false, true])
  })

  it('re-entrancy: a hook that registers during the pause pass is paused exactly once, and one that unregisters a later entry spares it', () => {
    const reg = createShedRegistry()
    const added = hooks()
    const victim = hooks()
    let unregisterVictim: () => void = () => {}
    reg.register('adder', { pause: () => { reg.register('added', added) }, resume: () => {} })
    reg.register('remover', { pause: () => unregisterVictim(), resume: () => {} })
    unregisterVictim = reg.register('victim', victim)
    reg.setShed(true)
    expect(added.pause).toHaveBeenCalledTimes(1)
    expect(victim.pause).not.toHaveBeenCalled()
    reg.setShed(false)
    expect(added.resume).toHaveBeenCalledTimes(1)
    expect(victim.resume).not.toHaveBeenCalled()
  })

  it('re-entrancy: a hook that flips the state back mid-pass ends the outer pass instead of resuming and pausing twice', () => {
    const reg = createShedRegistry()
    const a = { pause: vi.fn(() => { reg.setShed(false) }), resume: vi.fn() }
    const b = hooks()
    reg.register('a', a); reg.register('b', b)
    reg.setShed(true)
    expect(reg.isShed()).toBe(false)
    expect(b.pause.mock.calls.length).toBeLessThanOrEqual(1)
    expect(b.pause.mock.calls.length - b.resume.mock.calls.length).toBe(0) // balanced
  })
})

describe('shed registry: re-entrancy, round two, and the process-wide default', () => {
  it('a hook that flips the state off and on again mid-pass leaves every entry paused exactly once (balanced)', () => {
    const reg = createShedRegistry()
    let flipped = false
    const a = {
      pause: vi.fn(() => { if (flipped) return; flipped = true; reg.setShed(false); reg.setShed(true) }),
      resume: vi.fn(),
    }
    const b = hooks()
    reg.register('a', a); reg.register('b', b)
    reg.setShed(true)
    expect(reg.isShed()).toBe(true)
    expect(b.pause).toHaveBeenCalledTimes(1) // the outer pass must not pause it a second time
    expect(b.resume).not.toHaveBeenCalled()
    expect(a.pause.mock.calls.length - a.resume.mock.calls.length).toBe(1) // paused now, and balanced
    reg.setShed(false)
    expect(b.resume).toHaveBeenCalledTimes(1)
    expect(a.pause.mock.calls.length).toBe(a.resume.mock.calls.length)
  })

  it('registerShed / isShed / onShedChange are the process-wide registry', () => {
    const h = hooks()
    const heard: boolean[] = []
    const unregister = registerShed('lane-g-test', h)
    const unsubscribe = onShedChange((s) => heard.push(s))
    try {
      expect(isShed()).toBe(false)
      expect(shedRegistry.names()).toContain('lane-g-test')
      shedRegistry.setShed(true)
      expect(isShed()).toBe(true)
      expect(h.pause).toHaveBeenCalledTimes(1)
      shedRegistry.setShed(false)
      expect(h.resume).toHaveBeenCalledTimes(1)
      expect(heard).toEqual([true, false])
    } finally {
      unregister()
      unsubscribe()
      shedRegistry.setShed(false)
    }
    expect(shedRegistry.names()).not.toContain('lane-g-test')
  })
})

// ── 2. the gate helper ────────────────────────────────────────────────

describe('createShedGate: skip while shed, make the run up once after calm returns', () => {
  it('skip() is false while calm and arms nothing (control: no timers, nothing owed)', () => {
    vi.useFakeTimers()
    const reg = createShedRegistry()
    const makeUp = vi.fn()
    const gate = createShedGate('g', { registry: reg, makeUp, makeUpDelayMs: 1000 })
    expect(gate.skip()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    reg.setShed(true)
    reg.setShed(false)
    vi.advanceTimersByTime(60_000)
    expect(makeUp).not.toHaveBeenCalled() // nothing was skipped, nothing is owed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a skipped run is made up exactly once, only after the delay, only when calm', () => {
    vi.useFakeTimers()
    const reg = createShedRegistry()
    const makeUp = vi.fn()
    const gate = createShedGate('g', { registry: reg, makeUp, makeUpDelayMs: 1000 })
    reg.setShed(true)
    expect(gate.skip()).toBe(true)
    expect(gate.skip()).toBe(true) // skipping twice still owes ONE run
    vi.advanceTimersByTime(5000)
    expect(makeUp).not.toHaveBeenCalled() // still shed: nothing runs
    reg.setShed(false)
    vi.advanceTimersByTime(999)
    expect(makeUp).not.toHaveBeenCalled() // staggered, not instant (no burst on resume)
    vi.advanceTimersByTime(1)
    expect(makeUp).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(makeUp).toHaveBeenCalledTimes(1)
  })

  it('SHED returning before the make-up fires cancels it; the next calm schedules it again', () => {
    vi.useFakeTimers()
    const reg = createShedRegistry()
    const makeUp = vi.fn()
    const gate = createShedGate('g', { registry: reg, makeUp, makeUpDelayMs: 1000 })
    reg.setShed(true); gate.skip(); reg.setShed(false)
    vi.advanceTimersByTime(500)
    reg.setShed(true) // loop struggles again
    vi.advanceTimersByTime(5000)
    expect(makeUp).not.toHaveBeenCalled()
    reg.setShed(false)
    vi.advanceTimersByTime(1000)
    expect(makeUp).toHaveBeenCalledTimes(1)
  })

  it('a gate without a make-up never schedules anything, and a throwing make-up is swallowed', () => {
    vi.useFakeTimers()
    const reg = createShedRegistry()
    const plain = createShedGate('plain', { registry: reg })
    reg.setShed(true); plain.skip(); reg.setShed(false)
    expect(vi.getTimerCount()).toBe(0)
    const boom = vi.fn(() => { throw new Error('boom') })
    const loud = createShedGate('loud', { registry: reg, makeUp: boom, makeUpDelayMs: 10 })
    reg.setShed(true); loud.skip(); reg.setShed(false)
    expect(() => vi.advanceTimersByTime(10)).not.toThrow()
    expect(boom).toHaveBeenCalledTimes(1)
  })

  it('dispose() unregisters the gate and clears its timer', () => {
    vi.useFakeTimers()
    const reg = createShedRegistry()
    const makeUp = vi.fn()
    const gate = createShedGate('g', { registry: reg, makeUp, makeUpDelayMs: 1000 })
    expect(reg.names()).toEqual(['g'])
    reg.setShed(true); gate.skip(); reg.setShed(false)
    gate.dispose()
    expect(reg.names()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(makeUp).not.toHaveBeenCalled()
  })
})

// ── 3. the watchdog state machine ───────────────────────────────────────

describe('watchdog: entering SHED', () => {
  it('3 slow samples in a row enter SHED and call every pause once', () => {
    const h = hooks()
    const r = rig({ pairs: [['bg', h]] })
    r.sample(SLOW); r.sample(SLOW)
    expect(r.registry.isShed()).toBe(false)
    expect(h.pause).not.toHaveBeenCalled()
    r.sample(SLOW)
    expect(r.registry.isShed()).toBe(true)
    expect(h.pause).toHaveBeenCalledTimes(1)
    r.sample(SLOW); r.sample(SLOW)
    expect(h.pause).toHaveBeenCalledTimes(1) // control: staying shed calls nothing again
  })

  it('control: 2 slow samples do not enter, and a calm sample resets the streak (2 + calm + 2 never enters)', () => {
    const r = rig()
    r.sample(SLOW); r.sample(SLOW); r.sample(CALM)
    r.sample(SLOW); r.sample(SLOW)
    expect(r.registry.isShed()).toBe(false)
    expect(r.handle.snapshot().transitions).toBe(0)
  })

  it('the enter threshold is strictly "above 100 ms": 100 is not slow, 100.1 is', () => {
    const r = rig()
    r.sample(100); r.sample(100); r.sample(100); r.sample(100)
    expect(r.registry.isShed()).toBe(false)
    r.sample(100.1); r.sample(100.1); r.sample(100.1)
    expect(r.registry.isShed()).toBe(true)
  })

  it('the dead band between 40 and 100 ms neither enters nor builds a streak', () => {
    const r = rig()
    for (let i = 0; i < 50; i++) r.sample(70)
    expect(r.registry.isShed()).toBe(false)
    r.sample(SLOW); r.sample(SLOW); r.sample(70); r.sample(SLOW)
    expect(r.registry.isShed()).toBe(false)
  })
})

describe('watchdog: leaving SHED (hysteresis)', () => {
  function shedRig() {
    const h = hooks()
    const r = rig({ pairs: [['bg', h]] })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    expect(r.registry.isShed()).toBe(true)
    return { r, h }
  }

  it('leaving needs 10 s under 40 ms: 4 calm samples (8 s) stay shed, the 5th (10 s) leaves, resume is called once', () => {
    const { r, h } = shedRig()
    for (let i = 0; i < 4; i++) r.sample(CALM)
    expect(r.registry.isShed()).toBe(true)
    expect(h.resume).not.toHaveBeenCalled()
    r.sample(CALM)
    expect(r.registry.isShed()).toBe(false)
    expect(h.resume).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) r.sample(CALM)
    expect(h.resume).toHaveBeenCalledTimes(1) // control: calm after leaving calls nothing
  })

  it('a 40-100 ms sample in the middle of the calm run restarts the 10 s clock', () => {
    const { r } = shedRig()
    r.sample(CALM); r.sample(CALM); r.sample(CALM)
    r.sample(60) // not slow enough to matter, not calm enough to count
    for (let i = 0; i < 4; i++) r.sample(CALM)
    expect(r.registry.isShed()).toBe(true) // only 8 s since the 60
    r.sample(CALM)
    expect(r.registry.isShed()).toBe(false)
  })

  it('the leave threshold is strictly "under 40 ms": 40 is not calm, 39.9 is', () => {
    const { r } = shedRig()
    for (let i = 0; i < 20; i++) r.sample(40)
    expect(r.registry.isShed()).toBe(true)
    for (let i = 0; i < 5; i++) r.sample(39.9)
    expect(r.registry.isShed()).toBe(false)
  })

  it('a slow sample while shed does not re-enter or re-pause (it only restarts the calm clock)', () => {
    const { r, h } = shedRig()
    r.sample(CALM); r.sample(CALM); r.sample(SLOW)
    for (let i = 0; i < 4; i++) r.sample(CALM)
    expect(r.registry.isShed()).toBe(true)
    r.sample(CALM)
    expect(r.registry.isShed()).toBe(false)
    expect(h.pause).toHaveBeenCalledTimes(1)
    expect(h.resume).toHaveBeenCalledTimes(1)
  })
})

describe('watchdog: no flapping', () => {
  it('1,000 strictly alternating slow/calm samples make ZERO transitions', () => {
    const r = rig()
    for (let i = 0; i < 1000; i++) r.sample(i % 2 === 0 ? SLOW : CALM)
    expect(r.handle.snapshot().transitions).toBe(0)
  })

  it('1,000 samples of 2 slow + 1 calm repeating make ZERO transitions', () => {
    const r = rig()
    for (let i = 0; i < 1000; i++) r.sample(i % 3 === 2 ? CALM : SLOW)
    expect(r.handle.snapshot().transitions).toBe(0)
  })

  it('3 slow + 4 calm repeating (calm never lasts 10 s) enters ONCE and is only released by the max-dwell valve: exactly 2 transitions in 1,000 samples', () => {
    const r = rig()
    const pattern = [SLOW, SLOW, SLOW, CALM, CALM, CALM, CALM]
    for (let i = 0; i < 1000; i++) r.sample(pattern[i % pattern.length])
    const s = r.handle.snapshot()
    expect(s.enters).toBe(1)
    expect(s.forcedLeaves).toBe(1)
    expect(s.transitions).toBe(2)
  })

  it('1,000 seeded pseudo-random samples stay within a small bound of transitions', () => {
    let seed = 12345
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const r = rig()
    for (let i = 0; i < 1000; i++) r.sample(rand() * 200)
    expect(r.handle.snapshot().transitions).toBeLessThanOrEqual(8)
  })

  it('control: the same alternating input WOULD flap with no hysteresis (enter after 1, leave at once), so the zero above is real', () => {
    const r = rig({ config: { enterSamples: 1, leaveHoldMs: 0 } })
    for (let i = 0; i < 100; i++) r.sample(i % 2 === 0 ? SLOW : CALM)
    expect(r.handle.snapshot().transitions).toBe(100)
  })
})

describe('watchdog: the max-dwell valve (fail open: a stuck SHED must not starve background work)', () => {
  it('leaves after maxShedMs of continuous slowness, stays open for forcedOpenMs, then may enter again', () => {
    const h = hooks()
    const r = rig({ pairs: [['bg', h]], config: { maxShedMs: 60_000, forcedOpenMs: 20_000 } })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW) // entered at t = 6 s
    expect(r.registry.isShed()).toBe(true)
    while (r.elapsed() < 64_000) r.sample(SLOW)
    expect(r.registry.isShed()).toBe(true) // 58 s in: still shed
    r.sample(SLOW) // t = 66 s: 60 s of shed
    expect(r.registry.isShed()).toBe(false)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(r.handle.snapshot().forcedLeaves).toBe(1)
    expect(r.logs.some((l) => /max/i.test(l))).toBe(true)
    while (r.elapsed() < 84_000) r.sample(SLOW) // forced-open window: slow samples do not re-enter
    expect(r.registry.isShed()).toBe(false)
    expect(h.pause).toHaveBeenCalledTimes(1)
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW) // window over: 3 slow samples enter again
    expect(r.registry.isShed()).toBe(true)
    expect(h.pause).toHaveBeenCalledTimes(2)
  })

  it('control: calm samples leave through the normal path, not the valve', () => {
    const r = rig({ config: { maxShedMs: 60_000 } })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    for (let i = 0; i < 5; i++) r.sample(CALM)
    expect(r.registry.isShed()).toBe(false)
    expect(r.handle.snapshot().forcedLeaves).toBe(0)
  })
})

describe('watchdog: the sensor', () => {
  it('reads the histogram ONCE per sample (percentile 99) and resets it ONCE per sample, touching nothing else', () => {
    const r = rig()
    for (let i = 0; i < 25; i++) r.sample(i % 7 === 0 ? SLOW : CALM)
    expect(r.hist.percentile).toHaveBeenCalledTimes(25)
    for (const call of r.hist.percentile.mock.calls) expect(call).toEqual([99])
    expect(r.hist.reset).toHaveBeenCalledTimes(25)
    expect(r.hist.enable).toHaveBeenCalledTimes(1)
    const touched = new Set(r.histReads)
    expect([...touched].sort()).toEqual(['enable', 'percentile', 'reset'])
  })

  it('the clock is the only other input: one createHistogram, one interval, never a second timer, over 1,000 samples with many transitions', () => {
    const r = rig({ config: { enterSamples: 1, leaveHoldMs: 0 } })
    for (let i = 0; i < 1000; i++) r.sample(i % 2 === 0 ? SLOW : CALM)
    expect(r.createHistogram).toHaveBeenCalledTimes(1)
    expect(r.createHistogram).toHaveBeenCalledWith(DEFAULT_GOVERNOR_CONFIG.resolutionMs)
    expect(r.setIntervalFn).toHaveBeenCalledTimes(1)
    expect(r.setIntervalFn.mock.calls[0][1]).toBe(DEFAULT_GOVERNOR_CONFIG.sampleMs)
  })

  it('os.freemem is read at most once per 10 s: 6 reads in a 60 s run, never two within 10 s', () => {
    const r = rig()
    for (let i = 0; i < 30; i++) r.sample(CALM)
    expect(r.freememAt.length).toBe(6)
    for (let i = 1; i < r.freememAt.length; i++) expect(r.freememAt[i] - r.freememAt[i - 1]).toBeGreaterThanOrEqual(10_000)
  })

  it('freemem is a diagnostic only: a starved machine (50 MB free) with a calm loop never causes SHED', () => {
    const r = rig({ freememBytes: 50 * 1024 * 1024 })
    for (let i = 0; i < 100; i++) r.sample(CALM)
    expect(r.registry.isShed()).toBe(false)
    expect(r.handle.snapshot().freeMB).toBe(50)
  })

  it('a sample that arrives late (the loop was blocked) is slow even when the histogram dropped the stall: lateness backstop', () => {
    const r = rig()
    r.sample(CALM, 2000 + 500); r.sample(CALM, 2000 + 500); r.sample(CALM, 2000 + 500)
    expect(r.registry.isShed()).toBe(true)
    expect(r.handle.snapshot().lastDelayMs).toBe(500)
  })

  it('control: the same calm histogram with on-time samples never enters', () => {
    const r = rig()
    for (let i = 0; i < 50; i++) r.sample(CALM)
    expect(r.registry.isShed()).toBe(false)
  })

  it('an empty histogram (percentile(99) = 511 ns) is "no data", not a slow reading and not an exception', () => {
    const r = rig()
    r.hist.percentile.mockImplementation(() => 511)
    for (let i = 0; i < 10; i++) r.sample(0)
    expect(r.registry.isShed()).toBe(false)
    expect(r.handle.snapshot().lastDelayMs).toBe(0)
  })
})

describe('watchdog: the idle floor (Windows reports 31.25 ms for an idle loop at resolution 20)', () => {
  it('idleFloorMs: the resolution rounded up to the 15.625 ms timer tick on win32, the resolution elsewhere', () => {
    expect(idleFloorMs(20, 'win32')).toBe(31.25)
    expect(idleFloorMs(10, 'win32')).toBe(15.625)
    expect(idleFloorMs(20, 'linux')).toBe(20)
    expect(idleFloorMs(20, 'darwin')).toBe(20)
  })

  it('on win32 the measured IDLE p99 (43.8 ms raw) is calm, so SHED can be left; 131.5 raw (100.25 over the floor) enters', () => {
    const quiet = rig({ platform: 'win32', config: { idleFloorMs: undefined } })
    for (let i = 0; i < 40; i++) quiet.sample(43.8)
    expect(quiet.registry.isShed()).toBe(false)
    expect(quiet.handle.snapshot().lastDelayMs).toBeCloseTo(12.55, 2)
    const busy = rig({ platform: 'win32', config: { idleFloorMs: undefined } })
    busy.sample(131.5); busy.sample(131.5); busy.sample(131.5)
    expect(busy.registry.isShed()).toBe(true)
    for (let i = 0; i < 5; i++) busy.sample(43.8)
    expect(busy.registry.isShed()).toBe(false) // the literal "raw p99 < 40" rule could never get here on Windows
  })

  it('control: 130 raw on win32 (98.75 over the floor) is not slow', () => {
    const r = rig({ platform: 'win32', config: { idleFloorMs: undefined } })
    for (let i = 0; i < 10; i++) r.sample(130)
    expect(r.registry.isShed()).toBe(false)
  })

  it('on linux the floor is the resolution: 120.5 raw enters, 119 raw does not', () => {
    const slow = rig({ platform: 'linux', config: { idleFloorMs: undefined } })
    slow.sample(120.5); slow.sample(120.5); slow.sample(120.5)
    expect(slow.registry.isShed()).toBe(true)
    const fine = rig({ platform: 'linux', config: { idleFloorMs: undefined } })
    for (let i = 0; i < 10; i++) fine.sample(119)
    expect(fine.registry.isShed()).toBe(false)
  })
})

describe('watchdog: with every default (real histogram, real timers, real clock, real app log)', () => {
  it('starts, samples, enters and leaves SHED, writes both transitions to the app log, reads free memory, and stops', () => {
    vi.useFakeTimers()
    clearAppLog()
    const registry = createShedRegistry()
    // enterDelayMs -1 makes the real histogram's "no data" reading (nothing real elapsed under fake timers) count as slow
    const handle = startLoopGovernor({
      env: {}, registry, config: { enterDelayMs: -1, enterSamples: 1, leaveDelayMs: 1000, leaveHoldMs: 0 },
    })
    expect(handle.enabled).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(registry.isShed()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(registry.isShed()).toBe(false)
    const lines = readAppLog().map((e) => e.msg)
    expect(lines.some((l) => /loop governor: SHED on/.test(l))).toBe(true)
    expect(lines.some((l) => /loop governor: SHED off/.test(l))).toBe(true)
    expect(typeof handle.snapshot().freeMB).toBe('number')
    expect(handle.snapshot().samples).toBe(2)
    handle.stop()
    expect(vi.getTimerCount()).toBe(0) // the one interval it ever created is gone
    clearAppLog()
  })

  it('control: the same defaults with a calm real histogram and the shipped thresholds never enter', () => {
    vi.useFakeTimers()
    const registry = createShedRegistry()
    const handle = startLoopGovernor({ env: {}, registry })
    vi.advanceTimersByTime(60_000)
    expect(registry.isShed()).toBe(false)
    expect(handle.snapshot().transitions).toBe(0)
    handle.stop()
  })
})

describe('watchdog: logging', () => {
  it('a single suppressed transition is reported in the singular on the next line that is allowed', () => {
    const r = rig({ config: { enterSamples: 1, leaveHoldMs: 2000, logMaxPerWindow: 2, logWindowMs: 10_000 } })
    r.sample(SLOW) // t=2 s  enter  (logged)
    r.sample(CALM) // t=4 s  leave  (logged)
    r.sample(SLOW) // t=6 s  enter  (over the limit: suppressed)
    r.sample(SLOW); r.sample(SLOW) // t=8, 10 s: still shed, each slow sample restarts the 2 s calm clock
    expect(r.logs).toHaveLength(2)
    r.sample(CALM) // t=12 s leave: the t=2 s line has aged out of the window
    expect(r.logs).toHaveLength(3)
    expect(r.logs[2]).toMatch(/\(1 earlier transition not logged\)/)
  })

  it('each transition is logged exactly once, in plain words', () => {
    const r = rig()
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0]).toMatch(/SHED/)
    expect(r.logs[0]).toMatch(/\bon\b/i)
    for (let i = 0; i < 5; i++) r.sample(CALM)
    expect(r.logs).toHaveLength(2)
    expect(r.logs[1]).toMatch(/\boff\b/i)
  })

  it('flapping thresholds cannot flood the log: at most 6 lines a minute, and the suppressed count is reported', () => {
    const r = rig({ config: { enterSamples: 1, leaveHoldMs: 0 } })
    for (let i = 0; i < 100; i++) r.sample(i % 2 === 0 ? SLOW : CALM) // 100 transitions in 200 s
    expect(r.handle.snapshot().transitions).toBe(100)
    expect(r.logs.length).toBeLessThanOrEqual(6 * Math.ceil(200 / 60) + 3)
    expect(r.logs.length).toBeLessThan(40)
    expect(r.logs.some((l) => /not logged|suppressed/i.test(l))).toBe(true)
  })

  it('control: with calm input nothing is logged at all', () => {
    const r = rig()
    for (let i = 0; i < 200; i++) r.sample(CALM)
    expect(r.logs).toEqual([])
  })
})

describe('watchdog: lifecycle, kill switch and failing open', () => {
  it('TERMPOLIS_NO_GOVERNOR=1: no histogram, no timer, no clock, no freemem, never shed (behaviour identical to today)', () => {
    const r = rig({ env: { TERMPOLIS_NO_GOVERNOR: '1' }, pairs: [['bg', hooks()]] })
    expect(r.handle.enabled).toBe(false)
    expect(r.createHistogram).not.toHaveBeenCalled()
    expect(r.setIntervalFn).not.toHaveBeenCalled()
    expect(r.freememAt).toEqual([])
    expect(r.registry.isShed()).toBe(false)
    expect(r.handle.snapshot().enabled).toBe(false)
    r.handle.stop() // harmless
  })

  it('reads the real environment when none is injected: the unit suite runs with the kill switch on, so it stays inert', () => {
    expect(process.env.TERMPOLIS_NO_GOVERNOR).toBe('1')
    const createHistogram = vi.fn()
    const handle = startLoopGovernor({ createHistogram: createHistogram as never })
    expect(handle.enabled).toBe(false)
    expect(createHistogram).not.toHaveBeenCalled()
  })

  it('control: "true" also switches it off; "0" and an unset variable leave it running', () => {
    expect(rig({ env: { TERMPOLIS_NO_GOVERNOR: 'true' } }).handle.enabled).toBe(false)
    expect(rig({ env: { TERMPOLIS_NO_GOVERNOR: '0' } }).handle.enabled).toBe(true)
    expect(rig({ env: {} }).handle.enabled).toBe(true)
  })

  it('stop() clears the interval, disables the histogram, and RESUMES everything if it was shed (fail open)', () => {
    const h = hooks()
    const r = rig({ pairs: [['bg', h]] })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    expect(r.registry.isShed()).toBe(true)
    r.handle.stop()
    expect(r.clearIntervalFn).toHaveBeenCalledTimes(1)
    expect(r.hist.disable).toHaveBeenCalledTimes(1)
    expect(r.registry.isShed()).toBe(false)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(r.handle.snapshot().enabled).toBe(false)
    r.handle.stop()
    expect(r.clearIntervalFn).toHaveBeenCalledTimes(1) // idempotent
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  it('a histogram that cannot be created leaves an inert governor and a log line, never an exception', () => {
    const logs: string[] = []
    const handle = startLoopGovernor({
      env: {}, registry: createShedRegistry(), log: (l) => logs.push(l),
      createHistogram: () => { throw new Error('perf_hooks unavailable') },
      setInterval: vi.fn() as never, clearInterval: vi.fn(),
    })
    expect(handle.enabled).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/unavailable|disabled/i)
  })

  it('a histogram that throws something that is not an Error is reported just as well', () => {
    const logs: string[] = []
    const handle = startLoopGovernor({
      env: {}, registry: createShedRegistry(), log: (l) => logs.push(l),
      createHistogram: () => { throw 'no perf hooks here' }, // eslint-disable-line no-throw-literal
      setInterval: vi.fn() as never, clearInterval: vi.fn(),
    })
    expect(handle.enabled).toBe(false)
    expect(logs[0]).toMatch(/no perf hooks here/)
  })

  it('a tick that arrives after stop() does nothing (control: counters do not move)', () => {
    const r = rig()
    r.sample(CALM)
    r.handle.stop()
    const reads = r.hist.percentile.mock.calls.length
    r.staleTick(); r.staleTick()
    expect(r.hist.percentile.mock.calls.length).toBe(reads)
    expect(r.handle.snapshot().samples).toBe(1)
  })

  it('three failing samples in a row stop the governor and release everything; one failure alone does not', () => {
    const h = hooks()
    const r = rig({ pairs: [['bg', h]] })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    expect(r.registry.isShed()).toBe(true)
    r.hist.percentile.mockImplementationOnce(() => { throw new Error('read failed') })
    r.sample(SLOW)
    expect(r.handle.enabled).toBe(true) // control: one failure is tolerated
    r.sample(SLOW) // a good read resets the failure count
    r.hist.percentile.mockImplementation(() => { throw new Error('read failed') })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    expect(r.handle.enabled).toBe(false)
    expect(r.registry.isShed()).toBe(false)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(r.handle.snapshot().errors).toBe(4) // the first lone failure plus the three in a row
  })

  it('starting again replaces the previous run (its interval is cleared once)', () => {
    const first = rig()
    const second = startLoopGovernor({
      env: {}, registry: createShedRegistry(), log: () => {}, platform: 'linux',
      createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0 }),
      setInterval: vi.fn(() => ({})) as never, clearInterval: vi.fn(), now: () => 0, freemem: () => 0,
    })
    expect(first.clearIntervalFn).toHaveBeenCalledTimes(1)
    expect(first.handle.enabled).toBe(false)
    expect(second.enabled).toBe(true)
  })
})

describe('diagnostics snapshot', () => {
  it('reports shed, transitions, the last p99 and the registered names, as plain numbers', () => {
    const r = rig({ pairs: [['alpha', hooks()], ['beta', hooks()]] })
    r.sample(SLOW); r.sample(SLOW); r.sample(SLOW)
    r.sample(42.34)
    const s = r.handle.snapshot()
    expect(s.enabled).toBe(true)
    expect(s.shed).toBe(true)
    expect(s.transitions).toBe(1)
    expect(s.enters).toBe(1)
    expect(s.samples).toBe(4)
    expect(s.lastP99Ms).toBe(42.3)
    expect(s.maxDelayMs).toBe(SLOW)
    expect(s.freeMB).toBe(6144)
    expect(s.registered).toEqual(['alpha', 'beta'])
    expect(s.shedForMs).toBe(2000)
    expect(JSON.stringify(s)).not.toMatch(/undefined|NaN/)
  })

  it('getGovernorSnapshot(): disabled and empty before anything starts, live once started (control for the wiring)', () => {
    expect(getGovernorSnapshot()).toMatchObject({ enabled: false, shed: false, transitions: 0, samples: 0, lastP99Ms: null })
    const r = rig()
    r.sample(CALM)
    expect(getGovernorSnapshot()).toMatchObject({ enabled: true, samples: 1 })
    r.handle.stop()
    expect(getGovernorSnapshot().enabled).toBe(false)
  })
})

describe('installLoopGovernor: ONE call from main', () => {
  it('starts the watchdog and stops it when the app emits will-quit', () => {
    const quit: Array<() => void> = []
    const app = { once: vi.fn((event: string, cb: () => void) => { if (event === 'will-quit') quit.push(cb) }) }
    const clear = vi.fn()
    const handle = installLoopGovernor(app, {
      env: {}, registry: createShedRegistry(), log: () => {}, platform: 'linux',
      createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0 }),
      setInterval: vi.fn(() => ({})) as never, clearInterval: clear, now: () => 0, freemem: () => 0,
    })
    expect(handle.enabled).toBe(true)
    expect(app.once).toHaveBeenCalledTimes(1)
    expect(app.once.mock.calls[0][0]).toBe('will-quit')
    expect(clear).not.toHaveBeenCalled()
    quit[0]()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(handle.enabled).toBe(false)
  })

  it('a governor that cannot even start (the clock throws) leaves an inert handle, never an exception', () => {
    const handle = installLoopGovernor({ once: vi.fn() }, {
      env: {}, registry: createShedRegistry(), log: () => {},
      createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0 }),
      setInterval: vi.fn(() => ({})) as never, clearInterval: vi.fn(),
      now: () => { throw new Error('clock unavailable') }, freemem: () => 0,
    })
    expect(handle.enabled).toBe(false)
    expect(handle.snapshot()).toMatchObject({ enabled: false, shed: false, samples: 0 })
    expect(() => handle.stop()).not.toThrow()
  })

  it('with the kill switch it does not even look at app, and it never throws on an app that has no once()', () => {
    const app = { once: vi.fn() }
    const off = installLoopGovernor(app, { env: { TERMPOLIS_NO_GOVERNOR: '1' }, log: () => {} })
    expect(off.enabled).toBe(false)
    expect(app.once).not.toHaveBeenCalled()
    expect(() => installLoopGovernor({} as never, { env: {}, registry: createShedRegistry(), log: () => {}, createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0 }), setInterval: (() => ({})) as never, clearInterval: () => {}, now: () => 0, freemem: () => 0 })).not.toThrow()
  })
})

// ── 4. the governor never measures with an instrument that could become the disease ───

const GOVERNOR_FILES = ['loopGovernor.ts', 'threadpoolEnv.ts', 'hostPriority.ts'].map((f) => join(__dirname, '..', '..', 'src', 'main', f))

const FORBIDDEN_IDENTIFIERS = [
  'inspector', 'Profiler', 'getAppMetrics', 'getProcessMemoryInfo', 'getHeapSnapshot', 'writeHeapSnapshot',
  'child_process', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync', 'fork', 'utilityProcess',
]
const FORBIDDEN_STRINGS = [
  /\bnode:inspector\b|^inspector$/, /child_process/, /\btasklist\b/i, /Get-Process\b/i, /Get-CimInstance|Win32_Process|\bwmic\b/i,
  /\bnetstat\b/i, /\bpgrep\b|\blsof\b/, /Profiler\./,
]

/** Identifiers, module specifiers and string literals of a source text (comments are ignored by the parser). */
function surface(source: string): { identifiers: string[]; strings: string[] } {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true)
  const identifiers: string[] = []
  const strings: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) identifiers.push(n.text)
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { identifiers, strings }
}

function offenders(source: string): string[] {
  const { identifiers, strings } = surface(source)
  return [
    ...identifiers.filter((i) => FORBIDDEN_IDENTIFIERS.includes(i)),
    ...strings.filter((s) => FORBIDDEN_STRINGS.some((re) => re.test(s))),
  ]
}

describe('the governor source carries no inspector, no profiler and no process-enumeration API', () => {
  it('control: the scanner does flag each forbidden construct (so an empty result below means something)', () => {
    expect(offenders("import inspector from 'node:inspector'")).not.toEqual([])
    expect(offenders('const m = app.getAppMetrics()')).toEqual(['getAppMetrics'])
    expect(offenders("import { execFile } from 'child_process'")).not.toEqual([])
    expect(offenders("run('tasklist /v')")).not.toEqual([])
    expect(offenders("run('Get-Process -Name x')")).not.toEqual([])
    expect(offenders('const ok = performance.now()')).toEqual([])
  })

  for (const file of GOVERNOR_FILES) {
    it(`${file.split(/[\\/]/).pop()} is clean`, () => {
      expect(offenders(readFileSync(file, 'utf8'))).toEqual([])
    })
  }
})
