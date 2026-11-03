import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assistantLine, lines, userLine } from './_transcriptFixture'
import type { RawTurn } from '../../src/main/mnemeEpisode'
import type { SessionCursor, SoloReflexDeps, TranscriptDelta } from '../../src/main/mnemeSession'

// Five terminals open on one repo all fire memory:reflect-session within the same second (the renderer
// fires it 60 s after the last output and again when a terminal closes), and the cursor is keyed on
// (cwd, agent), not on the terminal. So each of the five used to read the same transcript whole, find the
// same new turns (the cursor only moves after the reflex resolves) and reflect them five times.
// runSessionReflection runs ONE pass per (cwd, agent) at a time, and every request that arrives while it
// runs shares ONE trailing pass: a request is never answered by a pass that started before it arrived.
//
// Counters: passes that ran, readDelta calls, whole-transcript reads, reflex runs, and the most passes of
// one transcript that were ever in flight at once.

type PassMod = typeof import('../../src/main/sessionReflectPass')
type DeltaMod = typeof import('../../src/main/transcriptDelta')
type ListMod = typeof import('../../src/main/claudeSessionList')
type WatcherMod = typeof import('../../src/main/transcriptWatchers/claudeCodeWatcher')
type LiveMod = typeof import('../../src/main/liveTranscript')
type MnemeMod = typeof import('../../src/main/mnemeSession')
type CountersMod = typeof import('../../src/main/passCounters')
type StoreMod = typeof import('../../src/main/sessionCursorStore')

let home: string
let work: string
let pass: PassMod
let delta: DeltaMod
let list: ListMod
let watcher: WatcherMod
let live: LiveMod
let mneme: MnemeMod
let counters: CountersMod
let store: StoreMod
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-flight-home-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-flight-work-'))
  for (const k of ['USERPROFILE', 'HOME']) saved[k] = process.env[k]
  process.env.USERPROFILE = home
  process.env.HOME = home
  watcher = await import('../../src/main/transcriptWatchers/claudeCodeWatcher')
  list = await import('../../src/main/claudeSessionList')
  delta = await import('../../src/main/transcriptDelta')
  live = await import('../../src/main/liveTranscript')
  mneme = await import('../../src/main/mnemeSession')
  counters = await import('../../src/main/passCounters')
  store = await import('../../src/main/sessionCursorStore')
  pass = await import('../../src/main/sessionReflectPass')
  expect(path.resolve(watcher.CLAUDE_PROJECTS_DIR).toLowerCase().startsWith(path.resolve(home).toLowerCase())).toBe(true)
})

afterAll(() => {
  for (const k of ['USERPROFILE', 'HOME']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const d of [home, work]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const savedSwitch = process.env.TERMPOLIS_REFLECT_FAST
beforeEach(() => {
  delete process.env.TERMPOLIS_REFLECT_FAST
  pass.resetFlights()
  list.resetSessionListCache()
  delta.resetDeltaState()
  counters.resetPasses()
  store.resetSessionCursors()
})
afterEach(() => {
  if (savedSwitch === undefined) delete process.env.TERMPOLIS_REFLECT_FAST
  else process.env.TERMPOLIS_REFLECT_FAST = savedSwitch
  vi.restoreAllMocks()
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
const input = (terminalId: string, cwd = 'C:/repo/one') => ({ terminalId, cwd, agent: 'claude', project: 'one' })

/** A request whose delta read waits on a gate the test opens, so the order of events is the test's. */
function gated(label: string, shared: { running: number; maxRunning: number; gates: Array<() => void>; reflects: string[] }) {
  const readDelta = vi.fn(async (): Promise<TranscriptDelta | null> => {
    shared.running++
    shared.maxRunning = Math.max(shared.maxRunning, shared.running)
    await new Promise<void>((r) => shared.gates.push(r))
    shared.running--
    const turns: RawTurn[] = [{ role: 'user', text: `a task from ${label}` }, { role: 'assistant', text: 'done, tests pass' }]
    return { fresh: turns, cursor: { count: 2, hash: 'abc' } }
  })
  const reflect = vi.fn(async () => {
    shared.reflects.push(label)
    return { fired: true, lessons: shared.reflects.length }
  })
  const deps: SoloReflexDeps = {
    readTranscript: vi.fn(async () => []),
    readDelta,
    getCursor: () => undefined,
    setCursor: vi.fn(),
    reflect,
  }
  return { deps, readDelta, reflect }
}
const newShared = () => ({ running: 0, maxRunning: 0, gates: [] as Array<() => void>, reflects: [] as string[] })
const release = (s: { gates: Array<() => void> }): void => {
  const g = s.gates.shift()
  if (g) g()
}

describe('the kill switch', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['on', true],
    ['1', true],
    ['0', false],
    ['off', false],
    ['OFF', false],
    [' false ', false],
    ['No', false],
  ])('TERMPOLIS_REFLECT_FAST=%j -> enabled %s', (value, enabled) => {
    expect(pass.reflectFastEnabled(value === undefined ? {} : { TERMPOLIS_REFLECT_FAST: value })).toBe(enabled)
  })

  it('off: exactly the old call, with no delta reader and no sharing between requests', async () => {
    process.env.TERMPOLIS_REFLECT_FAST = 'off'
    const s = newShared()
    const calls = Array.from({ length: 3 }, (_, i) => {
      const g = gated(`t${i}`, s)
      // no readDelta given: the old path reads the whole transcript through readTranscript
      const deps: SoloReflexDeps = { ...g.deps, readDelta: undefined, readTranscript: vi.fn(async () => { s.running++; s.maxRunning = Math.max(s.maxRunning, s.running); await new Promise<void>((r) => s.gates.push(r)); s.running--; return [] }) }
      return { deps, promise: pass.runSessionReflection(input(`t${i}`), deps) }
    })
    await tick()
    expect(s.maxRunning).toBe(3) // three passes of the SAME transcript at once, as before
    expect(calls.every((c) => (c.deps.readTranscript as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true)
    while (s.gates.length) release(s)
    await Promise.all(calls.map((c) => c.promise))
    expect(pass.flightCount()).toBe(0)
  })

  it('off: the pass is still counted (one line per request, marked legacy), so before and after can be compared', async () => {
    process.env.TERMPOLIS_REFLECT_FAST = 'off'
    const ok = gated('ok', newShared())
    ok.deps.readDelta = undefined
    await expect(pass.runSessionReflection(input('t1'), ok.deps)).resolves.toEqual({ fired: false, lessons: 0 })
    const bad: SoloReflexDeps = { ...ok.deps, readTranscript: async () => { throw new Error('unreadable') } }
    await expect(pass.runSessionReflection(input('t2'), bad)).rejects.toThrow('unreadable') // the rejection is the old one, untouched

    const k = counters.snapshotPasses().kinds.reflect
    expect(k.n).toBe(2)
    expect(k.sum.legacy).toBe(2)
    expect(k.sum.failed).toBe(1)
    expect(k.sum.callers).toBe(2)
  })
})

describe('single flight per (cwd, agent)', () => {
  it('five requests while one runs: ONE pass at a time, then ONE trailing pass shared by the other four', async () => {
    const s = newShared()
    const requests = Array.from({ length: 5 }, (_, i) => {
      const g = gated(`t${i}`, s)
      return { g, promise: pass.runSessionReflection(input(`t${i}`), g.deps) }
    })
    await tick()
    // only the first request's pass is running
    expect(requests[0].g.readDelta).toHaveBeenCalledTimes(1)
    for (const r of requests.slice(1)) expect(r.g.readDelta).not.toHaveBeenCalled()
    expect(s.maxRunning).toBe(1)

    release(s)
    await tick()
    // it finished; the trailing pass started, run by the LAST request that joined it
    expect(requests[4].g.readDelta).toHaveBeenCalledTimes(1)
    for (const r of requests.slice(1, 4)) expect(r.g.readDelta).not.toHaveBeenCalled()
    release(s)
    const results = await Promise.all(requests.map((r) => r.promise))

    expect(s.maxRunning).toBe(1)
    expect(s.reflects).toEqual(['t0', 't4']) // two reflexes, not five
    expect(results[0]).toEqual({ fired: true, lessons: 1 })
    for (const r of results.slice(1)) expect(r).toEqual({ fired: true, lessons: 2 }) // all four share the trailing pass's answer
    expect(pass.flightCount()).toBe(0)
  })

  it('a request is never answered by a pass that began before it arrived', async () => {
    const s = newShared()
    const first = gated('first', s)
    const p1 = pass.runSessionReflection(input('t1'), first.deps)
    await tick()
    const late = gated('late', s)
    const p2 = pass.runSessionReflection(input('t2'), late.deps) // arrives while the first pass runs
    release(s)
    await tick()
    expect(late.readDelta).toHaveBeenCalledTimes(1) // so it gets a pass of its own, started after it arrived
    release(s)
    await Promise.all([p1, p2])
    expect(s.reflects).toEqual(['first', 'late'])
  })

  it('different transcripts do not wait for each other', async () => {
    const s = newShared()
    const a = gated('a', s)
    const b = gated('b', s)
    const c = gated('c', s)
    const pa = pass.runSessionReflection(input('t1', 'C:/repo/one'), a.deps)
    const pb = pass.runSessionReflection(input('t2', 'C:/repo/two'), b.deps)
    const pc = pass.runSessionReflection({ ...input('t3', 'C:/repo/one'), agent: 'codex' }, c.deps) // same repo, other agent
    await tick()
    expect(s.maxRunning).toBe(3)
    while (s.gates.length) release(s)
    await Promise.all([pa, pb, pc])
  })

  it('treats the same repo spelled two ways as one transcript', async () => {
    const s = newShared()
    const a = gated('a', s)
    const b = gated('b', s)
    const pa = pass.runSessionReflection(input('t1', 'C:\\Repos\\One\\'), a.deps)
    const pb = pass.runSessionReflection(input('t2', 'c:/repos/one'), b.deps)
    await tick()
    expect(s.maxRunning).toBe(1)
    while (s.gates.length || s.running) {
      release(s)
      await tick()
    }
    await Promise.all([pa, pb])
  })

  it('a failing pass rejects its own caller only; the requests waiting behind it get the trailing pass', async () => {
    const s = newShared()
    const first = gated('first', s)
    first.reflect.mockRejectedValueOnce(new Error('distill boom'))
    const second = gated('second', s)
    const third = gated('third', s)
    const p1 = pass.runSessionReflection(input('t1'), first.deps)
    const p2 = pass.runSessionReflection(input('t2'), second.deps)
    const p3 = pass.runSessionReflection(input('t3'), third.deps)
    const failed = p1.then(() => 'ok', (e: Error) => e.message)
    await tick()
    release(s)
    await tick()
    release(s)
    expect(await failed).toBe('distill boom')
    expect(await p2).toEqual(await p3)
    expect(await p2).toMatchObject({ fired: true })
    expect(pass.flightCount()).toBe(0)
  })

  it('a failing trailing pass rejects everyone who shared it, and the key is free again afterwards', async () => {
    const s = newShared()
    const first = gated('first', s)
    const second = gated('second', s)
    second.reflect.mockRejectedValueOnce(new Error('store locked'))
    const third = gated('third', s)
    third.reflect.mockRejectedValueOnce(new Error('store locked'))
    const p1 = pass.runSessionReflection(input('t1'), first.deps)
    const p2 = pass.runSessionReflection(input('t2'), second.deps)
    const p3 = pass.runSessionReflection(input('t3'), third.deps)
    const r2 = p2.then(() => 'ok', (e: Error) => e.message)
    const r3 = p3.then(() => 'ok', (e: Error) => e.message)
    await tick()
    release(s)
    await tick()
    release(s)
    await p1
    expect([await r2, await r3]).toEqual(['store locked', 'store locked'])
    expect(pass.flightCount()).toBe(0)

    const fresh = gated('fresh', s)
    const p4 = pass.runSessionReflection(input('t4'), fresh.deps)
    await tick()
    expect(fresh.readDelta).toHaveBeenCalledTimes(1)
    release(s)
    await p4
  })

  it('a pass that throws before it ever returns a promise is a rejection, not a crash, and frees the key', async () => {
    await expect(pass.singleFlight('k', () => { throw new Error('sync throw') })).rejects.toThrow('sync throw')
    expect(pass.flightCount()).toBe(0)
    await expect(pass.singleFlight('k', async () => 42)).resolves.toBe(42)
  })

  it('a cursor store that throws is a rejection of that request, not a crash', async () => {
    const deps: SoloReflexDeps = {
      readTranscript: vi.fn(async () => []),
      readDelta: () => { throw new Error('sync throw') },
      getCursor: () => { throw new Error('cursor store gone') },
      setCursor: vi.fn(),
      reflect: vi.fn(async () => ({ fired: false, lessons: 0 })),
    }
    await expect(pass.runSessionReflection(input('t1'), deps)).rejects.toThrow('cursor store gone')
    expect(pass.flightCount()).toBe(0)
  })

  it('does not wait for a pass that has hung for FLIGHT_STALE_MS: a new request starts its own, and the late settle of the old one starts nothing', async () => {
    let now = 1_000_000
    const hungShared = newShared()
    const hung = gated('hung', hungShared)
    void pass.runSessionReflection(input('t1'), hung.deps, { now: () => now })
    await tick()
    const queued = gated('queued', hungShared)
    const pq = pass.runSessionReflection(input('t2'), queued.deps, { now: () => now }) // joins the hung pass as its trailing pass
    now += pass.FLIGHT_STALE_MS
    const s2 = newShared()
    const takeover = gated('takeover', s2)
    const pt = pass.runSessionReflection(input('t3'), takeover.deps, { now: () => now })
    await tick()
    // the takeover did not wait: the queued request's pass (the latest closure is the takeover's) is running now
    expect(takeover.readDelta).toHaveBeenCalledTimes(1)
    expect(queued.readDelta).not.toHaveBeenCalled()
    release(s2)
    await Promise.all([pq, pt])

    // the hung pass finally comes back: it must not launch the trailing pass a second time
    release(hungShared)
    await tick()
    expect(takeover.readDelta).toHaveBeenCalledTimes(1)
    expect(queued.readDelta).not.toHaveBeenCalled()
    expect(pass.flightCount()).toBe(0)
  })

  it('treats a clock that went backwards as a stale pass rather than waiting for it for ever', async () => {
    let now = 5_000_000
    const s = newShared()
    const first = gated('first', s)
    void pass.runSessionReflection(input('t1'), first.deps, { now: () => now })
    await tick()
    now -= 10_000
    const second = gated('second', s)
    void pass.runSessionReflection(input('t2'), second.deps, { now: () => now })
    await tick()
    expect(second.readDelta).toHaveBeenCalledTimes(1)
    while (s.gates.length) release(s)
    await tick()
  })

  it('records one line of counters per pass: how many requests it served, never content', async () => {
    const s = newShared()
    const reqs = Array.from({ length: 4 }, (_, i) => {
      const g = gated(`t${i}`, s)
      return pass.runSessionReflection(input(`t${i}`, 'C:/very/secret/project'), g.deps)
    })
    await tick()
    release(s)
    await tick()
    release(s)
    await Promise.all(reqs)

    const snap = counters.snapshotPasses()
    expect(snap.kinds.reflect.n).toBe(2)
    expect(snap.kinds.reflect.sum.callers).toBe(4) // 1 for the first pass, 3 for the trailing one
    expect(snap.kinds.reflect.max.callers).toBe(3)
    const json = JSON.stringify(snap)
    expect(json).not.toContain('secret')
    expect(json).not.toContain('a task from')
  })
})

describe('the delta reader is wired in unless the caller brings its own', () => {
  it('uses readSessionDelta when the deps carry none', async () => {
    const deps: SoloReflexDeps = {
      readTranscript: vi.fn(async () => []),
      getCursor: () => undefined,
      setCursor: vi.fn(),
      reflect: vi.fn(async () => ({ fired: false, lessons: 0 })),
    }
    await pass.runSessionReflection({ terminalId: 't1', cwd: path.join(work, 'nowhere'), agent: 'claude', project: 'p' }, deps)
    // no transcript exists, so the real delta reader answered (an empty delta): the whole-transcript read was NOT needed
    expect(deps.readTranscript).not.toHaveBeenCalled()
  })

  it('keeps the caller\'s own readDelta', async () => {
    const own = vi.fn(async () => null)
    const deps: SoloReflexDeps = {
      readTranscript: vi.fn(async () => []),
      readDelta: own,
      getCursor: () => undefined,
      setCursor: vi.fn(),
      reflect: vi.fn(async () => ({ fired: false, lessons: 0 })),
    }
    await pass.runSessionReflection(input('t1'), deps)
    expect(own).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------------------------------
// The whole thing, over a real transcript: five terminals, one repo.
// ---------------------------------------------------------------------------------------------------

describe('five terminals open on one repo (real files, the production delta reader)', () => {
  function fixture() {
    const cwd = path.join(work, `repo-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(cwd, { recursive: true })
    const dir = path.join(watcher.CLAUDE_PROJECTS_DIR, watcher.mangleCwd(watcher.claudeCwd(cwd)))
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, lines(userLine('the build is broken with a module error'), assistantLine('fixed it; tests pass now')))
    const cursors = new Map<string, SessionCursor>()
    const key = store.sessionCursorKey(cwd, 'claude')
    const reflect = vi.fn(async () => ({ fired: true, lessons: 1 }))
    const wholeReads = vi.fn()
    // The control needs all five whole reads to finish before any cursor moves (the reflex is async, so
    // without this a slow read would see the cursor an earlier pass advanced and the count would depend on timing).
    let arrived = 0
    let open!: () => void
    const barrier = new Promise<void>((r) => { open = r })
    const deps = (): SoloReflexDeps => ({
      readTranscript: async (c, a) => {
        wholeReads()
        const turns = await live.readSessionTranscript(c, a)
        if (++arrived >= 5) open()
        await barrier
        return turns
      },
      getCursor: () => cursors.get(key),
      setCursor: (_id, c) => { cursors.set(key, c) },
      reflect,
    })
    return { cwd, file, cursors, key, reflect, wholeReads, deps }
  }

  it('reads the transcript once and reflects once; the other four share a trailing pass that opens nothing', async () => {
    const f = fixture()
    const all = await Promise.all(Array.from({ length: 5 }, (_, i) => pass.runSessionReflection({ terminalId: `t${i}`, cwd: f.cwd, agent: 'claude', project: 'p' }, f.deps())))

    expect(all[0]).toEqual({ fired: true, lessons: 1 })
    expect(all.slice(1).every((r) => r.fired === false)).toBe(true) // nothing new for the trailing pass
    expect(f.reflect).toHaveBeenCalledTimes(1)
    expect(f.wholeReads).not.toHaveBeenCalled()

    const snap = counters.snapshotPasses()
    expect(snap.kinds.reflect.n).toBe(2)
    expect(snap.kinds.reflect.sum.callers).toBe(5)
    expect(snap.kinds['reflect-read'].n).toBe(2)
    expect(snap.kinds['reflect-read'].sum.opens).toBe(1) // ONE open of the transcript for five terminals
    expect(snap.kinds['reflect-read'].sum.full).toBe(1)
    expect(snap.kinds['reflect-read'].sum.unchanged).toBe(1)
    expect(f.cursors.get(f.key)!.pos).toMatchObject({ file: f.file })
  })

  it('CONTROL: with the switch off the same five requests read the transcript five times and reflect the same turns five times', async () => {
    process.env.TERMPOLIS_REFLECT_FAST = 'off'
    const f = fixture()
    await Promise.all(Array.from({ length: 5 }, (_, i) => pass.runSessionReflection({ terminalId: `t${i}`, cwd: f.cwd, agent: 'claude', project: 'p' }, f.deps())))
    expect(f.wholeReads).toHaveBeenCalledTimes(5)
    expect(f.reflect).toHaveBeenCalledTimes(5)
    expect(counters.snapshotPasses().kinds['reflect-read']).toBeUndefined()
  })

  it('later passes cost a stat, not a read: 20 more passes after one append open the file once', async () => {
    const f = fixture()
    const run = (id: string) => pass.runSessionReflection({ terminalId: id, cwd: f.cwd, agent: 'claude', project: 'p' }, f.deps())
    await run('t0')
    fs.appendFileSync(f.file, lines(userLine('and the tests?'), assistantLine('all green now')))
    await run('t0')
    for (let i = 0; i < 20; i++) await run('t0')
    const k = counters.snapshotPasses().kinds['reflect-read']
    expect(k.n).toBe(22)
    expect(k.sum.opens).toBe(2) // the first read, and the one append
    expect(k.sum.incremental).toBe(1)
    expect(k.sum.unchanged).toBe(20)
    expect(f.reflect).toHaveBeenCalledTimes(2)
  })
})
