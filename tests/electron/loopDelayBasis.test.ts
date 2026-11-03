// 1.54.5 merge seam (lane G's governor x lane B's typing trace): two event-loop histograms, one basis.
//
// Both lanes read Node's event-loop-delay histogram, on purpose each its own: the governor's resolution is
// 20 ms and it is read and reset every 2 s; the typing trace's is 10 ms, read and reset every 5 s. Sharing one
// histogram would let each reset corrupt the other's window, so nothing here shares one (test 2).
//
// What does have to agree is what the NUMBERS mean. On Windows the timer tick is 15.6 ms, so an idle loop reads
// 31.25 ms in the governor's histogram and 15.6 ms in the trace's, and a reader who sees `governor.lastP99Ms` of
// 43 next to `typing.loopDelay.last.p99` of 6 must be able to tell which is which. The governor judges
// DELAY = raw p99 minus the platform's idle floor (`lastDelayMs`); the trace reports raw minus its 10 ms PERIOD
// (`loopDelay.last`) and, since the merge, the same net-of-idle-floor basis as the governor under `loopDelay.net`,
// with the floor it subtracted recorded next to it. Test 1 pins the shared basis counter by counter: the same
// stall of L ms reads L on both nets, on every platform, and an idle loop reads 0 on both.
//
// Nothing here starts a real timer or histogram: every clock, histogram and timer is injected.

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '9.9.9') },
}))

import { startLoopGovernor, createShedRegistry, idleFloorMs, DEFAULT_GOVERNOR_CONFIG, __resetLoopGovernorForTests } from '../../src/main/loopGovernor'
import { createTypingTrace, openLoopDelay } from '../../src/main/typingTrace'

const NS = 1e6
const PLATFORMS: NodeJS.Platform[] = ['win32', 'linux', 'darwin']

/** One governor sample of an event loop whose p99 reads `rawMs`; returns the governor's snapshot. */
function governorReads(rawMs: number, platform: NodeJS.Platform) {
  let tick: () => void = () => {}
  let now = 0
  const handle = startLoopGovernor({
    env: {},
    platform,
    registry: createShedRegistry(),
    log: () => {},
    createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => rawMs * NS }),
    setInterval: ((fn: () => void) => { tick = fn; return {} }) as never,
    clearInterval: () => {},
    now: () => now,
    freemem: () => 0,
  })
  now += DEFAULT_GOVERNOR_CONFIG.sampleMs
  tick()
  const snap = handle.snapshot()
  handle.stop()
  return snap
}

/** One 5 s window of the typing trace on a loop whose histogram reads `rawMs` (p50, p99 and max alike). */
function traceReads(rawMs: number, platform: NodeJS.Platform) {
  let tick: () => void = () => {}
  const resolutions: number[] = []
  const hist = {
    count: 100,
    max: rawMs * NS,
    enable: () => true,
    disable: () => true,
    reset: () => {},
    percentile: () => rawMs * NS,
  }
  const trace = createTypingTrace({
    env: {},
    platform,
    now: () => 0,
    wallNow: () => 0,
    setInterval: ((fn: () => void) => { tick = fn; return 1 }) as never,
    clearInterval: () => {},
    openLoopDelay: () => openLoopDelay({ monitorEventLoopDelay: (o: { resolution: number }) => { resolutions.push(o.resolution); return hist } } as never),
    readElu: () => null,
    observeGc: () => null,
    freemem: () => 0,
    rss: () => 0,
    heap: () => ({ used: 0, total: 0, limit: 0 }),
    log: () => {},
  })
  trace.start()
  tick()
  const snap = trace.snapshot()
  trace.stop()
  return { snap, resolutions }
}

describe('governor and typing trace: one basis for "how late is the loop"', () => {
  for (const platform of PLATFORMS) {
    for (const lag of [0, 8, 300, 1500]) {
      it(`${platform}: a loop ${lag} ms late reads ${lag} on the governor's lastDelayMs and on the trace's net p99 and max`, () => {
        const g = governorReads(idleFloorMs(DEFAULT_GOVERNOR_CONFIG.resolutionMs, platform) + lag, platform)
        const { snap: t, resolutions } = traceReads(idleFloorMs(10, platform) + lag, platform)
        expect(resolutions).toEqual([10]) // the trace's own histogram, at its own resolution
        expect(g.lastDelayMs).toBeCloseTo(lag, 1)
        expect(t.loopDelay.net.last).not.toBeNull()
        expect(t.loopDelay.net.last!.p99).toBeCloseTo(lag, 1)
        expect(t.loopDelay.net.last!.max).toBeCloseTo(lag, 1)
        expect(t.loopDelay.net.last!.p50).toBeCloseTo(lag, 1)
        // The floor each one subtracted is in its own record, so raw = net + floor can be read back.
        expect(g.idleFloorMs).toBe(idleFloorMs(DEFAULT_GOVERNOR_CONFIG.resolutionMs, platform))
        expect(t.loopDelay.idleFloorMs).toBeCloseTo(idleFloorMs(10, platform), 1)
        // lastP99Ms is rounded to one decimal (31.25 reads 31.3), so raw minus floor is the lag to within 0.1
        expect(Math.abs(g.lastP99Ms! - g.idleFloorMs! - lag)).toBeLessThan(0.1)
      })
    }
  }

  it('NEGATIVE CONTROL: the trace\'s plain `last` is raw minus the 10 ms PERIOD, so an idle Windows loop reads 5.6 there and 0 on the net basis', () => {
    const { snap } = traceReads(idleFloorMs(10, 'win32'), 'win32')
    expect(snap.loopDelay.last!.p99).toBeCloseTo(5.6, 1)
    expect(snap.loopDelay.net.last!.p99).toBe(0)
    const linux = traceReads(idleFloorMs(10, 'linux'), 'linux').snap
    expect(linux.loopDelay.last!.p99).toBe(0) // no 15.6 ms tick off Windows: the two bases agree there
    expect(linux.loopDelay.net.last!.p99).toBe(0)
  })

  it('the net numbers never go below zero, and the minute block is on the same basis as the last window', () => {
    const { snap } = traceReads(2, 'win32') // a timer that fired early: raw below the floor
    expect(snap.loopDelay.net.last).toEqual({ p50: 0, p99: 0, max: 0 })
    const busy = traceReads(idleFloorMs(10, 'win32') + 40, 'win32').snap
    expect(busy.loopDelay.net.minute).toEqual({ p50Median: 40, p99Max: 40, max: 40 })
    expect(busy.loopDelay.minute!.p99Max).toBeCloseTo(45.6, 1) // the raw number still carries the resting 5.6 ms
  })
})

describe('governor and typing trace: two histograms, never one', () => {
  const SRC = path.join(__dirname, '..', '..', 'src', 'main')

  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) sources(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  const withoutComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('exactly two files in src/main create an event-loop histogram: the governor and the typing trace', () => {
    const makers = sources(SRC)
      .filter((f) => /\bmonitorEventLoopDelay\s*\(/.test(withoutComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
      .sort()
    expect(makers).toEqual(['loopGovernor.ts', 'typingTrace.ts'])
  })

  it('each creates it once, and neither reaches into the other\'s histogram', () => {
    const count = (f: string): number => (withoutComments(fs.readFileSync(path.join(SRC, f), 'utf8')).match(/\bmonitorEventLoopDelay\s*\(/g) ?? []).length
    expect(count('loopGovernor.ts')).toBe(1)
    expect(count('typingTrace.ts')).toBe(1)
    const trace = withoutComments(fs.readFileSync(path.join(SRC, 'typingTrace.ts'), 'utf8'))
    const gov = withoutComments(fs.readFileSync(path.join(SRC, 'loopGovernor.ts'), 'utf8'))
    // The trace takes the governor's pure floor helper and nothing else; the governor knows nothing of the trace.
    const fromGovernor = [...trace.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/loopGovernor'/g)].map((m) => m[1].trim())
    expect(fromGovernor).toEqual(['idleFloorMs'])
    expect(gov).not.toMatch(/from\s*'\.\/typingTrace'/)
  })

  it('their windows differ on purpose: the governor reads every 2 s at 20 ms, the trace every 5 s at 10 ms', () => {
    expect(DEFAULT_GOVERNOR_CONFIG.sampleMs).toBe(2000)
    expect(DEFAULT_GOVERNOR_CONFIG.resolutionMs).toBe(20)
    expect(traceReads(15.6, 'win32').resolutions).toEqual([10])
  })
})

describe('diagnostics:collect labels both blocks', () => {
  it('carries the floor next to the governor\'s net numbers and next to the trace\'s, each from its own resolution', async () => {
    __resetLoopGovernorForTests()
    const { collectDiagnostics } = await import('../../src/main/diagnostics')
    const idle = collectDiagnostics()
    expect(idle.governor!.idleFloorMs).toBeNull() // no governor running in the unit suite (tests/setup.ts)
    expect(idle.typing!.loopDelay.idleFloorMs).toBeCloseTo(idleFloorMs(10, process.platform), 1)
    expect(JSON.stringify(idle.typing!.loopDelay)).not.toMatch(/null.*undefined|NaN/)
  })
})
