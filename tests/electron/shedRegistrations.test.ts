/**
 * The Wire step of 1.54.5: what the event-loop governor (lane G) may pause in the files lanes M, B and C own.
 *
 * PROOF STYLE: counters. A fake histogram drives the REAL governor (startLoopGovernor) into SHED and out again; a
 * counting registry wraps every pause and resume that is registered, so "each ran exactly once" is a number. The kill
 * switch (TERMPOLIS_NO_GOVERNOR=1) is the negative control: the same slow histogram pauses nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createShedRegistry, startLoopGovernor, whenNotShed, SHED_WAIT_CAP_MS,
  type ShedRegistry, type ShedHooks, type GovernorDeps,
} from '../../src/main/loopGovernor'
import {
  registerShedTargets, SHED_REGISTRATION_NAMES, WATCH_RESUME_STAGGER_MS, SHED_RETRY_WAIT_MS, type ShedTargets,
} from '../../src/main/shedRegistrations'
import { startIndexer, _resetIndexerForTests } from '../../src/main/memoryIndexer'
import { createRunGate, setWatchGatesPaused } from '../../src/main/watchGuard'
import { attachClaudeSessionWatcher, setClaudeLocatePaused, type ClaudeSessionWatcherHandle } from '../../src/main/transcriptWatchers/claudeCodeWatcher'
import { TriggerSupervisor, setTriggerGitChecksPaused } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import { nodeAsyncFs } from '../../src/main/gitRefs'
import type { Workflow } from '../../src/renderer/src/types'

/** A registry that counts every pause and resume each registrant receives. */
function countingRegistry(inner: ShedRegistry): ShedRegistry & { counts: Map<string, { pause: number; resume: number }> } {
  const counts = new Map<string, { pause: number; resume: number }>()
  return {
    counts,
    register(name: string, hooks: ShedHooks) {
      const c = { pause: 0, resume: 0 }
      counts.set(name, c)
      return inner.register(name, {
        pause: () => { c.pause++; hooks.pause() },
        resume: () => { c.resume++; hooks.resume() },
      })
    },
    isShed: () => inner.isShed(),
    onShedChange: (cb) => inner.onShedChange(cb),
    setShed: (s) => inner.setShed(s),
    names: () => inner.names(),
  }
}

function fakeTargets(): ShedTargets & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    setWatchGatesPaused: (p, o) => { calls.push(`watch:${p}${o?.staggerMs ? `/${o.staggerMs}` : ''}`) },
    setMemoryRetryGovernor: (fn) => { calls.push(`retry:${fn ? fn({ attempt: 1 }) : 'null'}`) },
    setClaudeLocatePaused: (p) => { calls.push(`locate:${p}`) },
    setTriggerGitChecksPaused: (p) => { calls.push(`git:${p}`) },
  }
}

/** The real governor on a fake histogram: `sample(ms)` sets the next p99 and runs one 2 s sample. */
function governor(registry: ShedRegistry, env: NodeJS.ProcessEnv = {}) {
  let now = 1_000_000
  let tick: (() => void) | undefined
  let p99 = 0
  const deps: GovernorDeps = {
    env,
    platform: 'linux',
    createHistogram: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => p99 * 1e6 }),
    setInterval: (fn) => { tick = fn; return { unref() {} } },
    clearInterval: () => { tick = undefined },
    now: () => now,
    freemem: () => 8 * 1024 ** 3,
    log: () => {},
    registry,
    config: { idleFloorMs: 0 },
  }
  const handle = startLoopGovernor(deps)
  const sample = (ms: number): void => {
    p99 = ms
    now += 2000
    tick?.()
  }
  return { handle, sample, ticking: () => tick !== undefined }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  _resetIndexerForTests()
  setWatchGatesPaused(false)
  setClaudeLocatePaused(false)
  setTriggerGitChecksPaused(false)
  vi.useRealTimers()
})

describe('SHED on and off: every registration pauses and resumes exactly once (counted)', () => {
  it('the four Wire registrations and the memory indexer gate, through the real governor', async () => {
    const reg = countingRegistry(createShedRegistry())
    const targets = fakeTargets()
    const off = registerShedTargets(targets, reg.register)
    let passes = 0
    startIndexer({ run: async () => { passes++; return { written: 0 } }, initialDelayMs: 1000, intervalMs: 3_600_000, shedRegistry: reg })
    const g = governor(reg)
    expect(g.handle.enabled).toBe(true)

    const expected = [...SHED_REGISTRATION_NAMES, 'memoryIndexer.tick']
    expect([...reg.counts.keys()].sort()).toEqual([...expected].sort())

    for (let i = 0; i < 3; i++) g.sample(150) // three slow samples in a row: SHED
    expect(reg.isShed()).toBe(true)
    for (let i = 0; i < 4; i++) g.sample(400) // still slow: no second pause
    for (const name of expected) expect(reg.counts.get(name)).toEqual({ pause: 1, resume: 0 })
    expect(targets.calls).toEqual(['watch:true', `retry:${SHED_RETRY_WAIT_MS}`, 'locate:true', 'git:true'])

    // The indexer's first timer comes due while shed: the pass is skipped (zero runs), one is owed.
    await vi.advanceTimersByTimeAsync(1000)
    expect(passes).toBe(0)

    for (let i = 0; i < 7; i++) g.sample(5) // 10 s+ of calm: SHED ends
    expect(reg.isShed()).toBe(false)
    for (const name of expected) expect(reg.counts.get(name)).toEqual({ pause: 1, resume: 1 })
    expect(targets.calls.slice(4)).toEqual([`watch:false/${WATCH_RESUME_STAGGER_MS}`, 'retry:null', 'locate:false', 'git:false'])

    // No burst at the instant SHED ends: the owed pass is made up once, a minute later.
    expect(passes).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(passes).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(passes).toBe(1)

    off()
    _resetIndexerForTests()
    expect(reg.names()).toEqual([])
    g.handle.stop()
  })

  it('kill switch TERMPOLIS_NO_GOVERNOR=1: the same slow loop pauses nothing, and the indexer runs on time', async () => {
    const reg = countingRegistry(createShedRegistry())
    const targets = fakeTargets()
    registerShedTargets(targets, reg.register)
    let passes = 0
    startIndexer({ run: async () => { passes++; return { written: 0 } }, initialDelayMs: 1000, intervalMs: 3_600_000, shedRegistry: reg })
    const g = governor(reg, { TERMPOLIS_NO_GOVERNOR: '1' })
    expect(g.handle.enabled).toBe(false)
    expect(g.ticking()).toBe(false)
    for (let i = 0; i < 20; i++) g.sample(900)
    expect(reg.isShed()).toBe(false)
    for (const c of reg.counts.values()) expect(c).toEqual({ pause: 0, resume: 0 })
    expect(targets.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(passes).toBe(1)
    g.handle.stop()
  })

  it('control: the same counting registry DOES see a pause when the governor runs (the zero above is not a broken counter)', () => {
    const reg = countingRegistry(createShedRegistry())
    registerShedTargets(fakeTargets(), reg.register)
    const g = governor(reg)
    for (let i = 0; i < 3; i++) g.sample(150)
    expect(reg.counts.get('watchGates')).toEqual({ pause: 1, resume: 0 })
    g.handle.stop()
  })

  it('a registration that throws leaves the others registered (fail open)', () => {
    const names: string[] = []
    registerShedTargets(fakeTargets(), (name) => {
      if (name === 'memoryHost.retry') throw new Error('boom')
      names.push(name)
      return () => {}
    })
    expect(names).toEqual(['watchGates', 'transcript.locate', 'workflowTriggers.git'])
  })
})

describe('watch gates: SHED ending restarts them one stagger apart, never as a burst', () => {
  it('three dirty gates: one handler runs at resume, the other two one stagger apart; a re-pause stops the rest', () => {
    const runs = [0, 0, 0]
    const gates = runs.map((_, i) => createRunGate({ mode: 'leading', windowMs: 0, label: `g${i}`, run: () => { runs[i]++ } }))
    setWatchGatesPaused(true)
    for (const g of gates) { g.note(); g.note() }
    expect(runs).toEqual([0, 0, 0])
    const timers: Array<{ fn: () => void; ms: number }> = []
    setWatchGatesPaused(false, { staggerMs: 250, setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0 } })
    expect(runs).toEqual([1, 0, 0])
    expect(timers.map((t) => t.ms)).toEqual([250, 500])
    timers[0].fn()
    expect(runs).toEqual([1, 1, 0])
    setWatchGatesPaused(true) // SHED again before the last turn
    timers[1].fn()
    expect(runs).toEqual([1, 1, 0])
    setWatchGatesPaused(false)
    expect(runs).toEqual([1, 1, 1]) // lane M's default (no stagger) still resumes all at once
    for (const g of gates) g.dispose()
  })

  it('the default unref\'d timer is used when none is injected', async () => {
    let n = 0
    const a = createRunGate({ mode: 'leading', windowMs: 0, label: 'a', run: () => {} })
    const b = createRunGate({ mode: 'leading', windowMs: 0, label: 'b', run: () => { n++ } })
    setWatchGatesPaused(true)
    b.note()
    setWatchGatesPaused(false, { staggerMs: 100 })
    expect(n).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(n).toBe(1)
    a.dispose(); b.dispose()
  })
})

describe('whenNotShed: work already running holds at its next boundary', () => {
  it('resolves at once (false) while calm, when SHED ends (true), or at the cap (true)', async () => {
    const reg = createShedRegistry()
    await expect(whenNotShed({ registry: reg })).resolves.toBe(false)
    reg.setShed(true)
    let done: boolean | null = null
    void whenNotShed({ registry: reg }).then((v) => { done = v })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(done).toBeNull()
    reg.setShed(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    reg.setShed(true)
    let capped: boolean | null = null
    void whenNotShed({ registry: reg }).then((v) => { capped = v })
    await vi.advanceTimersByTimeAsync(SHED_WAIT_CAP_MS)
    expect(capped).toBe(true)
  })

  it('SHED starting again while it waits does not release it; the process registry is the default (calm in tests)', async () => {
    await expect(whenNotShed()).resolves.toBe(false)
    const reg = createShedRegistry()
    reg.setShed(true)
    let done: boolean | null = null
    void whenNotShed({ registry: reg, capMs: 5_000 }).then((v) => { done = v })
    reg.setShed(false)
    reg.setShed(true) // a second episode after the release changes nothing
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    // A listener registered earlier re-enters SHED inside the end transition: the waiter is told "calm" by the
    // outer pass, but the registry is shed again, so it keeps holding (until the cap here).
    let reentered = false
    reg.onShedChange((v) => { if (!v && !reentered) { reentered = true; reg.setShed(true) } })
    let held: boolean | null = null
    void whenNotShed({ registry: reg, capMs: 5_000 }).then((v) => { held = v })
    reg.setShed(false)
    expect(reg.isShed()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(held).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(held).toBe(true)
  })
})

describe('the real pause switches in the lanes\' files', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-shed-')) })
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

  it('transcript.locate: no look while paused (and no poll counted), the file is found after resume', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const SID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
    const cwd = path.join(tmp, 'project')
    fs.mkdirSync(cwd)
    const env = { CLAUDE_CONFIG_DIR: path.join(tmp, 'config') }
    const home = path.join(tmp, 'home')
    fs.mkdirSync(home)
    const elsewhere = path.join(tmp, 'config', 'projects', 'some-other-folder')
    fs.mkdirSync(elsewhere, { recursive: true })
    setClaudeLocatePaused(true)
    const h = attachClaudeSessionWatcher('t1', cwd, SID, env, home) as ClaudeSessionWatcherHandle
    const before = h.sessionFile
    fs.writeFileSync(path.join(elsewhere, `${SID}.jsonl`), '')
    for (let i = 0; i < 12; i++) { vi.advanceTimersByTime(1500); await h.settled() }
    expect(h.sessionFile).toBe(before) // twelve polls, none looked (a scan would have found it on the 4th)
    setClaudeLocatePaused(false)
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(1500); await h.settled() }
    expect(h.sessionFile).toBe(path.join(elsewhere, `${SID}.jsonl`))
    h.stop()
  })

  it('workflowTriggers.git: while paused a commit is not checked; the first calm tick fires it once', async () => {
    vi.useRealTimers()
    const SHA = (c: string): string => c.repeat(40)
    const ref = path.join(tmp, '.git', 'refs', 'heads', 'main')
    fs.mkdirSync(path.dirname(ref), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(ref, SHA('a') + '\n')
    const wf = { id: 'on-commit', name: 'on commit', version: 1, trigger: { type: 'gitCommit', config: {} }, steps: [] } as unknown as Workflow
    fs.mkdirSync(workflowsDir(tmp), { recursive: true })
    fs.writeFileSync(path.join(workflowsDir(tmp), 'on-commit.yml'), serializeWorkflow(wf))
    const fired: string[] = []
    const sup = new TriggerSupervisor({
      fs: fs as never,
      fsAsync: nodeAsyncFs,
      watch: () => ({ close() { /* none */ } }),
      setTimer: () => ({}),
      clearTimer: () => {},
      now: () => Date.now(),
      isTrusted: () => true,
      fire: (_cwd, id) => { fired.push(id); return undefined },
      tickMs: 15_000,
    })
    sup.watchProject(tmp)
    await sup.tick() // seeds the position
    setTriggerGitChecksPaused(true)
    fs.writeFileSync(ref, SHA('b') + '\n')
    for (let i = 0; i < 5; i++) await sup.tick()
    expect(fired).toEqual([])
    setTriggerGitChecksPaused(false)
    await sup.tick()
    expect(fired).toEqual(['on-commit'])
    await sup.tick()
    expect(fired).toEqual(['on-commit'])
    sup.stop()
  })
})
