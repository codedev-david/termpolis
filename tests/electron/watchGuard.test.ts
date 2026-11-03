// watchGuard — the shared ignore rule and run limiter (src/main/watchGuard.ts).
//
// Everything is proved with COUNTERS on injected fakes: probes started, timers armed, handler runs,
// runs in flight, gaps between run starts in FAKE milliseconds, log lines. No wall-clock ratios.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createIgnoreFilter,
  createRunGate,
  isIgnoredWatchPath,
  probeNestedRepo,
  WATCH_MIN_INTERVAL_MS,
  FLOOD_EVENTS_PER_SECOND,
  FLOOD_SECONDS,
  FLOOD_BACKOFF_BASE_MS,
  FLOOD_BACKOFF_MAX_MS,
  type RunGateOptions,
} from '../../src/main/watchGuard'

const slashes = (p: string): string => p.replace(/\\/g, '/')

/** Let already-resolved promises run their continuations. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

// ── the name rule ────────────────────────────────────────────────────────────

describe('isIgnoredWatchPath', () => {
  it.each([
    'node_modules/x/index.js', 'a/b/node_modules/x', 'NODE_MODULES\\x', './dist/a.js', '/out/a.js', 'build', 'target/debug/x',
    '.venv/lib/x.py', '__pycache__/m.pyc', '.next/cache/x', 'coverage/lcov.info', '.turbo/cache', '.nuxt/x', '.gradle/x',
    '.pytest_cache/v', '.vs/x.suo',
    '.worktrees/wt1/src/a.ts', 'a/.Worktrees/b', '.WORKTREES\\wt\\f.ts',
    '.claude/worktrees/x/a.ts', '.CLAUDE\\Worktrees\\x',
    '.git/index', 'sub/.git/HEAD', '.git',
  ])('ignores %s', (p) => {
    expect(isIgnoredWatchPath(p)).toBe(true)
  })

  it.each([
    'src/index.ts', 'district/plan.ts', 'my_node_modules/x.ts', 'outbox/mail.ts', 'builder.ts', 'targets/x.ts',
    'worktrees/readme.md', '.claude/settings.json', '.worktreesx/a', 'a.git/b', '.github/workflows/ci.yml', '.gitignore', '', '/', './',
  ])('does not over-match %s', (p) => {
    expect(isIgnoredWatchPath(p)).toBe(false)
  })

  it('takes extra names, in any case, for one watcher', () => {
    expect(isIgnoredWatchPath('Pods/x.swift')).toBe(false)
    expect(isIgnoredWatchPath('Pods/x.swift', ['PODS'])).toBe(true)
    expect(isIgnoredWatchPath('a/.termpolis/s.json', ['.termpolis'])).toBe(true)
    expect(isIgnoredWatchPath('src/a.ts', ['.termpolis'])).toBe(false)
  })

  it('exposes the contract numbers', () => {
    expect([WATCH_MIN_INTERVAL_MS, FLOOD_EVENTS_PER_SECOND, FLOOD_SECONDS, FLOOD_BACKOFF_BASE_MS, FLOOD_BACKOFF_MAX_MS]).toEqual([2000, 200, 3, 4000, 60_000])
  })
})

// ── the nested-repository filter ─────────────────────────────────────────────

describe('createIgnoreFilter', () => {
  /** A probe that answers from a fixed set of nested directories and counts what it was asked. */
  function probeOf(nested: string[]) {
    const asked: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const fn = vi.fn(async (abs: string): Promise<boolean> => {
      const rel = slashes(abs).replace(/^\/repo\//, '')
      asked.push(rel)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      return nested.includes(rel)
    })
    return { fn, asked, maxInFlight: () => maxInFlight }
  }
  const make = (probe: ReturnType<typeof probeOf>, extra: Partial<Parameters<typeof createIgnoreFilter>[0]> = {}) =>
    createIgnoreFilter({ root: '/repo', probeNested: probe.fn, caseInsensitive: false, ...extra })

  it('ignores by name without asking the disk anything', () => {
    const p = probeOf([])
    const f = make(p)
    for (let i = 0; i < 1000; i++) {
      expect(f.shouldIgnore(`.worktrees/wt${i % 20}/src/f${i}.ts`)).toBe(true)
      expect(f.shouldIgnore(`node_modules/x${i}/index.js`)).toBe(true)
    }
    expect(p.fn).not.toHaveBeenCalled()
    expect(f.stats.probes).toBe(0)
  })

  it('treats nothing and nameless paths as not ignored', () => {
    const f = make(probeOf([]))
    expect(f.shouldIgnore(null)).toBe(false)
    expect(f.shouldIgnore(undefined)).toBe(false)
    expect(f.shouldIgnore('')).toBe(false)
    expect(f.shouldIgnore('/')).toBe(false)
  })

  it('lets an unknown directory through, asks once per directory, and answers from memory afterwards', async () => {
    const p = probeOf([])
    const f = make(p)
    expect(f.shouldIgnore('src/app/a.ts')).toBe(false) // optimistic while the probes are out
    expect(p.fn).toHaveBeenCalledTimes(2) // src, src/app
    await microtasks()
    for (let i = 0; i < 5000; i++) expect(f.shouldIgnore(`src/app/f${i}.ts`)).toBe(false)
    expect(p.fn).toHaveBeenCalledTimes(2)
    expect(f.stats).toMatchObject({ probes: 2, learned: 0, dropped: 0, queued: 0, active: 0 })
  })

  it('does not ask about a file directly under the root, or about the file itself', () => {
    const p = probeOf([])
    const f = make(p)
    expect(f.shouldIgnore('package.json')).toBe(false)
    expect(p.fn).not.toHaveBeenCalled()
  })

  it('learns a nested repository from its probe and then ignores everything below it with no more probes', async () => {
    const p = probeOf(['vendor/lib'])
    const learned: string[] = []
    const f = make(p, { onLearn: (d) => learned.push(d) })
    expect(f.shouldIgnore('vendor/lib/src/first.ts')).toBe(false)
    await microtasks()
    const asked = p.fn.mock.calls.length
    expect(f.shouldIgnore('vendor/lib/src/second.ts')).toBe(true)
    expect(f.shouldIgnore('vendor/lib/deep/er/still/third.ts')).toBe(true)
    expect(f.shouldIgnore('vendor/other/ok.ts')).toBe(false)
    expect(p.fn.mock.calls.length).toBeLessThanOrEqual(asked + 2) // only `vendor/other` is new
    expect(learned).toEqual(['vendor/lib'])
    expect(f.stats.learned).toBe(1)
  })

  it('a .git below the root teaches the filter at once: no probe is needed for that directory', () => {
    const p = probeOf([])
    const learned: string[] = []
    const f = make(p, { onLearn: (d) => learned.push(d) })
    expect(f.shouldIgnore('vendor/lib/.git/index')).toBe(true)
    expect(f.shouldIgnore('vendor/lib/src/a.ts')).toBe(true)
    expect(p.asked).not.toContain('vendor/lib')
    expect(learned).toEqual(['vendor/lib'])
    // ... and a repeat of the same lesson is not a second lesson.
    expect(f.shouldIgnore('vendor/lib/.git/HEAD')).toBe(true)
    expect(learned).toEqual(['vendor/lib'])
  })

  it("the root's own .git, and names that merely start with .git, teach nothing", () => {
    const p = probeOf([])
    const f = make(p)
    expect(f.shouldIgnore('.git/index')).toBe(true)
    expect(f.shouldIgnore('.git')).toBe(true)
    expect(f.shouldIgnore('a/.github/workflows/x.yml')).toBe(false)
    expect(f.shouldIgnore('a/.gitignore')).toBe(false)
    expect(f.stats.learned).toBe(0)
  })

  it('never has more probes in flight than its concurrency, and drops (lets through) what does not fit the queue', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const resolvers: Array<() => void> = []
    const probe = vi.fn((_abs: string) => new Promise<boolean>((resolve) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      resolvers.push(() => { inFlight--; resolve(false) })
    }))
    const f = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false, concurrency: 2, maxQueue: 3 })
    for (let i = 0; i < 10; i++) expect(f.shouldIgnore(`d${i}/f.ts`)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(f.stats).toMatchObject({ active: 2, queued: 3, dropped: 5 })
    while (resolvers.length) { resolvers.shift()!(); await microtasks() }
    expect(maxInFlight).toBe(2)
    expect(probe).toHaveBeenCalledTimes(5) // 2 + the 3 that were queued; the 5 dropped were never asked
    expect(f.stats).toMatchObject({ active: 0, queued: 0 })
    // A dropped directory is simply asked about on its next event.
    expect(f.shouldIgnore('d9/g.ts')).toBe(false)
    expect(probe).toHaveBeenCalledTimes(6)
  })

  it('asks a directory only once at a time, however many events arrive while the probe is out', () => {
    const probe = vi.fn((_abs: string) => new Promise<boolean>(() => {}))
    const f = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false })
    for (let i = 0; i < 100; i++) f.shouldIgnore(`pkg/src/f${i}.ts`)
    expect(probe).toHaveBeenCalledTimes(2) // pkg, pkg/src
  })

  it('re-asks after the TTL, serves the old answer meanwhile, and notices a repository that went away', async () => {
    let clock = 1_000
    let nested = true
    const probe = vi.fn(async (abs: string) => nested && slashes(abs).endsWith('/vendor/lib'))
    const f = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false, now: () => clock, ttlMs: 1000 })
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(false)
    await microtasks()
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(true)
    const asked = probe.mock.calls.length
    clock += 500
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(true)
    expect(probe.mock.calls.length).toBe(asked) // inside the TTL: nothing asked
    clock += 2000
    nested = false
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(true) // stale answer served ...
    expect(probe.mock.calls.length).toBeGreaterThan(asked) // ... while it is re-asked
    await microtasks()
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(false) // and the repo that went away is watched again
  })

  it('an event for the directory entry itself makes it forget, so a recreated plain directory is not suppressed', async () => {
    let nested = true
    const probe = vi.fn(async (abs: string) => nested && slashes(abs).endsWith('/vendor/lib'))
    const f = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false })
    f.shouldIgnore('vendor/lib/a.ts')
    await microtasks()
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(true)
    nested = false
    expect(f.shouldIgnore('vendor/lib')).toBe(false) // the directory entry changed: forget it
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(false) // unknown again: let through while it is re-asked
    await microtasks()
    expect(f.shouldIgnore('vendor/lib/a.ts')).toBe(false)
  })

  it('keeps submodules (and only them) watched, in any case and with a trailing slash', async () => {
    const p = probeOf(['libs/sub', 'libs/other'])
    const f = make(p, { caseInsensitive: true })
    f.setKeep(['Libs/Sub/', '', 'libs\\x\\'])
    f.shouldIgnore('libs/sub/a.ts')
    f.shouldIgnore('libs/other/a.ts')
    await microtasks()
    expect(f.shouldIgnore('libs/sub/src/a.ts')).toBe(false) // a submodule: its dirty state is the parent's status
    expect(f.shouldIgnore('Libs/Sub/src/a.ts')).toBe(false)
    expect(f.shouldIgnore('libs/other/src/a.ts')).toBe(true) // any other nested repository: not this tree
    expect(f.shouldIgnore('libs/sub/.git/index')).toBe(true) // its own .git is still not ours
    f.setKeep([])
    expect(f.shouldIgnore('libs/sub/src/a.ts')).toBe(true)
  })

  it('matches directories case-insensitively where the file system is, and exactly where it is not', async () => {
    const ci = make(probeOf(['vendor/lib']), { caseInsensitive: true })
    ci.shouldIgnore('Vendor/LIB/a.ts')
    await microtasks()
    expect(ci.shouldIgnore('vendor/lib/b.ts')).toBe(true)
    expect(ci.shouldIgnore('VENDOR/Lib/c.ts')).toBe(true)

    const probe = vi.fn(async (abs: string) => slashes(abs).endsWith('/vendor/lib'))
    const cs = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false })
    cs.shouldIgnore('Vendor/LIB/a.ts')
    await microtasks()
    expect(cs.shouldIgnore('Vendor/LIB/b.ts')).toBe(false) // a different directory on a case-sensitive disk
  })

  it('treats a probe that rejects, or throws, as an ordinary directory and frees its slot', async () => {
    const probe = vi.fn((abs: string): Promise<boolean> => {
      if (abs.endsWith('boom')) throw new Error('sync')
      return Promise.reject(new Error('EACCES'))
    })
    const f = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false, concurrency: 1 })
    expect(f.shouldIgnore('a/b.ts')).toBe(false)
    expect(f.shouldIgnore('boom/b.ts')).toBe(false)
    await microtasks()
    expect(f.stats).toMatchObject({ active: 0, queued: 0, probes: 2, learned: 0 })
    expect(f.shouldIgnore('a/c.ts')).toBe(false)
  })

  it('close() discards queued and in-flight probes and answers only by name afterwards', async () => {
    const resolvers: Array<(v: boolean) => void> = []
    const probe = vi.fn((_abs: string) => new Promise<boolean>((r) => { resolvers.push(r) }))
    const f = createIgnoreFilter({ root: '/repo', probeNested: probe, caseInsensitive: false, concurrency: 1 })
    f.shouldIgnore('a/x.ts')
    f.shouldIgnore('b/x.ts')
    expect(probe).toHaveBeenCalledTimes(1)
    f.close()
    resolvers[0](true) // a late answer
    await microtasks()
    expect(probe).toHaveBeenCalledTimes(1) // the queued one was never asked
    expect(f.stats).toMatchObject({ cached: 0, queued: 0 })
    expect(f.shouldIgnore('a/x.ts')).toBe(false)
    expect(f.shouldIgnore('node_modules/x.js')).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(() => f.shouldIgnore('z/.git/HEAD')).not.toThrow() // teaching after close is a no-op
  })

  it('keeps its caches bounded, and keeps what it learned when it has to drop things', async () => {
    const p = probeOf(['d0'])
    const f = make(p, { maxCache: 8, concurrency: 8, maxQueue: 100 })
    f.shouldIgnore('d0/a.ts')
    await microtasks()
    for (let i = 1; i < 60; i++) { f.shouldIgnore(`d${i}/a.ts`); await microtasks() }
    expect(f.stats.cached).toBeLessThanOrEqual(8)
    expect(f.shouldIgnore('d0/b.ts')).toBe(true) // the learned repository survived the eviction
    // The memo of answers is bounded too.
    for (let i = 0; i < 100; i++) f.shouldIgnore(`d${i % 7}/x${i}/y.ts`)
    await microtasks()
    expect(f.stats.cached).toBeLessThanOrEqual(8)
  })

  it('keeps the memo of settled answers bounded as well, and stays correct while doing it', async () => {
    const p = probeOf(['q3'])
    const f = make(p, { maxCache: 4, concurrency: 30, maxQueue: 100 })
    for (let i = 0; i < 20; i++) {
      f.shouldIgnore(`q${i}/f.ts`)
      await microtasks()
      expect(f.shouldIgnore(`q${i}/g.ts`)).toBe(i === 3) // asked, answered, remembered, evicted: still right
    }
    expect(f.stats.cached).toBeLessThanOrEqual(4)
  })

  it('evicts even learned repositories when nothing else is left to drop', async () => {
    const p = probeOf(Array.from({ length: 12 }, (_, i) => `r${i}`))
    const f = make(p, { maxCache: 4, concurrency: 12, maxQueue: 100 })
    for (let i = 0; i < 12; i++) { f.shouldIgnore(`r${i}/a.ts`); await microtasks() }
    expect(f.stats.cached).toBeLessThanOrEqual(4)
  })
})

describe('probeNestedRepo (the real, async default)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-wg-')) })
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ } })

  it('says no for a plain directory and for one that is not there', async () => {
    fs.mkdirSync(path.join(dir, 'plain'))
    expect(await probeNestedRepo(path.join(dir, 'plain'))).toBe(false)
    expect(await probeNestedRepo(path.join(dir, 'missing'))).toBe(false)
  })

  it('says yes for a repository, and for a worktree whose .git is a FILE', async () => {
    fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'wt'))
    fs.writeFileSync(path.join(dir, 'wt', '.git'), 'gitdir: ../repo/.git/worktrees/wt\n')
    expect(await probeNestedRepo(path.join(dir, 'repo'))).toBe(true)
    expect(await probeNestedRepo(path.join(dir, 'wt'))).toBe(true)
  })

  it('says yes for a symlink or Windows junction, which leads somewhere else', async () => {
    fs.mkdirSync(path.join(dir, 'target'))
    try {
      fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'junction')
    } catch {
      return // no permission to create links here: nothing to prove
    }
    expect(await probeNestedRepo(path.join(dir, 'link'))).toBe(true)
    expect(await probeNestedRepo(path.join(dir, 'target'))).toBe(false)
  })

  it('works end to end with no injected probe: a real nested repository is learned from the disk', async () => {
    fs.mkdirSync(path.join(dir, 'vendor', 'lib', 'src'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'vendor', 'lib', '.git'))
    fs.mkdirSync(path.join(dir, 'src'))
    const f = createIgnoreFilter({ root: dir })
    f.shouldIgnore('vendor/lib/src/a.ts')
    f.shouldIgnore('src/a.ts')
    await vi.waitFor(() => expect(f.shouldIgnore('vendor/lib/src/b.ts')).toBe(true), { timeout: 10_000, interval: 25 })
    expect(f.shouldIgnore('src/b.ts')).toBe(false)
    f.close()
  })
})

// ── the run gate ─────────────────────────────────────────────────────────────

/** A hand-driven clock and timer queue: the only time these tests know. */
function makeClock() {
  let t = 1_000_000
  let seq = 0
  let setCalls = 0
  let clearCalls = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => { setCalls++; const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimer: (id: unknown): void => { clearCalls++; timers.delete(id as number) },
    /** Move time forward, firing every timer that comes due, in order, with the clock set to its due time. */
    async advance(ms: number): Promise<void> {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        timers.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
        await microtasks()
      }
      t = end
      await microtasks()
    },
    delay: (ms: number): Promise<void> => new Promise<void>((resolve) => { timers.set(++seq, { at: t + ms, fn: resolve }) }),
    get pending(): number { return timers.size },
    get setCalls(): number { return setCalls },
    get clearCalls(): number { return clearCalls },
    get time(): number { return t },
  }
}

function setup(over: Partial<RunGateOptions> & { handler?: (n: number) => unknown } = {}) {
  const clock = makeClock()
  const starts: number[] = []
  const logs: string[] = []
  let active = 0
  let maxActive = 0
  const { handler, ...opts } = over
  const gate = createRunGate({
    mode: 'leading',
    windowMs: 2000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    label: 'test',
    log: (m) => { logs.push(m) },
    run: () => {
      starts.push(clock.time)
      active++
      maxActive = Math.max(maxActive, active)
      const r = handler?.(starts.length)
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        return (r as Promise<unknown>).finally(() => { active-- })
      }
      active--
      return r
    },
    ...opts,
  })
  return { clock, gate, starts, logs, maxActive: () => maxActive }
}

/** Notes `n` events at the current instant, then lets one second pass. */
async function second(s: ReturnType<typeof setup>, n: number, o?: { priority?: boolean }): Promise<void> {
  for (let i = 0; i < n; i++) s.gate.note(o)
  await s.clock.advance(1000)
}

const gaps = (a: number[]): number[] => a.slice(1).map((v, i) => v - a[i])

describe('createRunGate: pacing', () => {
  it('leading: the first event after quiet runs at once, the rest of the window is ONE trailing run, then quiet is quiet', async () => {
    const s = setup()
    s.gate.note()
    expect(s.starts).toHaveLength(1) // at once
    for (let i = 0; i < 500; i++) s.gate.note()
    expect(s.starts).toHaveLength(1)
    await s.clock.advance(1999)
    expect(s.starts).toHaveLength(1)
    await s.clock.advance(1)
    expect(s.starts).toHaveLength(2) // one trailing run for 500 events
    expect(gaps(s.starts)).toEqual([2000])
    await s.clock.advance(10_000)
    expect(s.starts).toHaveLength(2) // nothing arrived: nothing runs
    expect(s.clock.pending).toBe(0)
    s.gate.note()
    expect(s.starts).toHaveLength(3) // a fresh leading edge
  })

  it('leading: a long storm keeps collapsing to one run per window and never closer than the window', async () => {
    const s = setup()
    for (let i = 0; i < 9; i++) { for (let k = 0; k < 150; k++) s.gate.note(); await s.clock.advance(1000) }
    expect(s.starts.length).toBeLessThanOrEqual(5)
    expect(Math.min(...gaps(s.starts))).toBeGreaterThanOrEqual(2000)
  })

  it('trailing: the first event arms ONE timer for the window, further events arm nothing, and the run happens when it fires', async () => {
    const s = setup({ mode: 'trailing' })
    s.gate.note()
    expect(s.starts).toHaveLength(0)
    for (let i = 0; i < 10_000; i++) s.gate.note()
    expect(s.clock.setCalls).toBe(1)
    expect(s.clock.pending).toBe(1)
    await s.clock.advance(1999)
    expect(s.starts).toHaveLength(0)
    await s.clock.advance(1)
    expect(s.starts).toHaveLength(1)
    s.gate.note()
    await s.clock.advance(2000)
    expect(s.starts).toHaveLength(2)
    expect(gaps(s.starts)).toEqual([2000])
  })

  it('evaluates a window function when it arms, and clamps a negative window to zero', async () => {
    let w = 5000
    const s = setup({ mode: 'trailing', windowMs: () => w })
    s.gate.note()
    await s.clock.advance(4999)
    expect(s.starts).toHaveLength(0)
    await s.clock.advance(1)
    expect(s.starts).toHaveLength(1)
    w = -50
    s.gate.note()
    await s.clock.advance(0)
    expect(s.starts).toHaveLength(2)
  })

  it('never runs two at once: events during a 5 s run wait for it, then run once', async () => {
    const s = setup({ handler: () => s.clock.delay(5000) })
    s.gate.note()
    expect(s.gate.running).toBe(true)
    for (let i = 0; i < 100; i++) s.gate.note()
    await s.clock.advance(2000) // the window ends mid-run: nothing may start
    expect(s.starts).toHaveLength(1)
    await s.clock.advance(3000) // the run ends: the follow-up starts at once (the window is long over)
    expect(s.starts).toHaveLength(2)
    expect(s.starts[1] - s.starts[0]).toBe(5000)
    await s.clock.advance(60_000)
    expect(s.maxActive()).toBe(1)
    expect(s.starts).toHaveLength(2) // nothing arrived since: no third run
    expect(s.gate.runs).toBe(2)
  })

  it('trailing: events during a run are picked up one window after it ends, never overlapping', async () => {
    const s = setup({ mode: 'trailing', handler: () => s.clock.delay(5000) })
    s.gate.note()
    await s.clock.advance(2000) // the run starts at 2 s and takes until 7 s
    expect(s.starts).toHaveLength(1)
    s.gate.note()
    s.gate.note()
    await s.clock.advance(5000) // it ends at 7 s; the follow-up is armed one window later
    expect(s.starts).toHaveLength(1)
    await s.clock.advance(2000)
    expect(s.starts).toHaveLength(2)
    expect(s.starts[1] - s.starts[0]).toBe(7000)
    expect(s.maxActive()).toBe(1)
  })

  it('a handler that throws, or whose promise rejects, is that run\'s failure and nothing more', async () => {
    const s = setup({ handler: (n) => { if (n === 1) throw new Error('sync boom') } })
    s.gate.note()
    expect(s.gate.running).toBe(false)
    s.gate.note()
    await s.clock.advance(2000)
    expect(s.starts).toHaveLength(2)

    const r = setup({ mode: 'trailing', handler: (n) => (n === 1 ? Promise.reject(new Error('async boom')) : undefined) })
    r.gate.note()
    await r.clock.advance(2000)
    expect(r.starts).toHaveLength(1)
    expect(r.gate.running).toBe(false)
    r.gate.note()
    await r.clock.advance(2000)
    expect(r.starts).toHaveLength(2)
  })

  it('a handler that notes while it runs does not re-enter itself; the follow-up waits its window', async () => {
    const s = setup({ handler: (n) => { if (n === 1) { s.gate.note(); s.gate.note() } } })
    s.gate.note()
    expect(s.starts).toHaveLength(1)
    expect(s.gate.running).toBe(false)
    await s.clock.advance(2000)
    expect(s.starts).toHaveLength(2)
    expect(s.starts[1] - s.starts[0]).toBe(2000)
  })

  it('poke() asks for one check without counting as an event: a poke storm is never a flood', async () => {
    const s = setup()
    s.gate.poke()
    expect(s.starts).toHaveLength(1)
    for (let sec = 0; sec < 30; sec++) { for (let i = 0; i < 1000; i++) s.gate.poke(); await s.clock.advance(1000) }
    expect(s.gate.flooding).toBe(false)
    expect(s.logs).toEqual([])
    expect(s.starts.length).toBeLessThanOrEqual(16)
    expect(Math.min(...gaps(s.starts))).toBeGreaterThanOrEqual(2000)
  })

  it('dispose(): clears the one pending timer, ignores everything after it, and a run that ends later schedules nothing', async () => {
    const s = setup({ mode: 'trailing' })
    s.gate.note()
    s.gate.dispose()
    expect(s.clock.clearCalls).toBe(1)
    expect(s.clock.pending).toBe(0)
    s.gate.note(); s.gate.poke()
    await s.clock.advance(10_000)
    expect(s.starts).toHaveLength(0)

    const idle = setup()
    idle.gate.dispose()
    expect(idle.clock.clearCalls).toBe(0) // nothing was pending: nothing to clear

    const late = setup({ handler: () => late.clock.delay(3000) })
    late.gate.note()
    late.gate.note()
    late.gate.dispose()
    await late.clock.advance(60_000)
    expect(late.starts).toHaveLength(1)
  })

  it('abandons a handler that never settles, once, so one hung promise cannot silence the root for good', async () => {
    const hung: Array<() => void> = []
    const s = setup({
      runTimeoutMs: 10_000,
      handler: (n) => (n === 1 ? new Promise<void>((resolve) => { hung.push(resolve) }) : undefined),
    })
    s.gate.note()
    await s.clock.advance(5000)
    s.gate.note()
    expect(s.starts).toHaveLength(1) // still inside its time: it is still running
    expect(s.gate.running).toBe(true)
    await s.clock.advance(6000)
    s.gate.note() // 11 s in: past the timeout
    expect(s.starts).toHaveLength(2)
    expect(s.logs.filter((l) => /not finished/.test(l))).toHaveLength(1)
    hung[0]() // the abandoned run finally ends: it must not disturb the new state
    await microtasks()
    expect(s.gate.running).toBe(false) // the second run (synchronous) is over; the stale finish changed nothing
    s.gate.note()
    await s.clock.advance(2000)
    expect(s.starts.length).toBeGreaterThanOrEqual(3)
  })

  it('works on the real timers and clock when none are injected', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      const g = createRunGate({ mode: 'trailing', windowMs: 100, run: () => { n++ } })
      g.note(); g.note()
      expect(n).toBe(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(n).toBe(1)
      g.note()
      g.dispose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(n).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a logger that throws does not take the gate down', async () => {
    const s = setup({ log: () => { throw new Error('logger') } })
    for (let i = 0; i < 4; i++) await second(s, 300)
    expect(s.gate.flooding).toBe(true)
    expect(() => s.gate.note()).not.toThrow()
  })
})

describe('createRunGate: flood', () => {
  it('"more than 200 events per second for 3 s": exactly 200 never floods, 201 does, on the third closed second', async () => {
    const at200 = setup()
    for (let i = 0; i < 20; i++) await second(at200, 200)
    expect(at200.gate.flooding).toBe(false)
    expect(at200.logs).toEqual([])

    const at201 = setup()
    await second(at201, 201)
    await second(at201, 201)
    await second(at201, 201)
    expect(at201.gate.flooding).toBe(false) // three hot seconds have passed, the third is not CLOSED yet
    await second(at201, 201)
    expect(at201.gate.flooding).toBe(true)
    expect(at201.logs).toHaveLength(1)
    expect(at201.logs[0]).toMatch(/flood on test.*200 events\/s for 3 s/)
  })

  it('a quiet second between hot ones breaks the run: two hot seconds, a gap, two more is not a flood', async () => {
    const s = setup()
    await second(s, 500)
    await second(s, 500)
    await s.clock.advance(2500) // silence
    await second(s, 500)
    await second(s, 500)
    expect(s.gate.flooding).toBe(false)
    await second(s, 500)
    await second(s, 500)
    expect(s.gate.flooding).toBe(true) // three hot seconds in a row now
  })

  it('stops running handlers during a flood and backs off 4, 8, 16, 32, then 60 s, running ONCE each time', async () => {
    const s = setup({ mode: 'trailing' })
    for (let sec = 0; sec < 200; sec++) await second(s, 500)
    // Before the flood is detected (at 3 s) the 2 s debounce ran once, at 2 s. Then one run per back-off.
    const t0 = s.starts[0]
    expect(s.starts.map((t) => t - t0)).toEqual([0, 5000, 13_000, 29_000, 61_000, 121_000, 181_000])
    expect(gaps(s.starts)).toEqual([5000, 8000, 16_000, 32_000, 60_000, 60_000])
    expect(s.logs).toHaveLength(1) // the flood is still on
    expect(s.maxActive()).toBe(1)
    // The flood ends: the armed back-off runs the handler ONCE more, and the gate says it is over.
    await s.clock.advance(300_000)
    expect(s.starts).toHaveLength(8)
    expect(s.logs).toHaveLength(2)
    expect(s.logs[1]).toMatch(/flood over/)
    expect(s.gate.flooding).toBe(false)
    // Calm again: back to one run per window.
    s.gate.note()
    await s.clock.advance(2000)
    expect(s.starts).toHaveLength(9)
    expect(s.logs).toHaveLength(2)
    expect(s.clock.pending).toBe(0)
  })

  it('a 100,000-event flood arms a handful of timers, not one per event', async () => {
    const s = setup({ mode: 'trailing' })
    for (let sec = 0; sec < 100; sec++) await second(s, 1000)
    expect(s.starts.length).toBeLessThanOrEqual(8)
    expect(s.clock.setCalls).toBeLessThanOrEqual(30)
  })

  it('leaves the flood when the rate stays calm for two seconds, and paces normally again without breaking the window', async () => {
    const s = setup({ mode: 'trailing', windowMs: 10_000 })
    for (let sec = 0; sec < 7; sec++) await second(s, 500) // hot from 0 to 7 s: flood from 3 s, the back-off run at 7 s
    expect(s.gate.flooding).toBe(true)
    expect(s.starts).toHaveLength(1)
    const firstRun = s.starts[0]
    for (let sec = 0; sec < 4; sec++) await second(s, 50) // calm: two closed calm seconds end the flood
    expect(s.gate.flooding).toBe(false)
    expect(s.logs.filter((l) => /flood over/.test(l))).toHaveLength(1)
    // The pending back-off was replaced by a window that still honours the gap since the last run.
    await s.clock.advance(60_000)
    expect(s.starts.length).toBeGreaterThanOrEqual(2)
    expect(s.starts[1] - firstRun).toBeGreaterThanOrEqual(10_000)
  })

  it('a window longer than the back-off still holds: the back-off run waits out what is left of it', async () => {
    const s = setup({ mode: 'leading', windowMs: 10_000 })
    for (let sec = 0; sec < 40; sec++) await second(s, 500)
    expect(Math.min(...gaps(s.starts))).toBeGreaterThanOrEqual(10_000)
    expect(s.starts.length).toBeGreaterThanOrEqual(3)
  })

  it('trailing mode picks up what arrived during a backed-off run: the next back-off is armed straight away', async () => {
    const s = setup({ mode: 'trailing', handler: (n) => { if (n === 2) s.gate.note() } })
    for (let sec = 0; sec < 8; sec++) await second(s, 500)
    expect(s.starts).toHaveLength(2) // the debounce at 2 s, then the first back-off at 7 s (whose handler noted)
    expect(s.gate.running).toBe(false)
    expect(s.clock.pending).toBe(1)
    await s.clock.advance(8000 - 1000)
    expect(s.starts.length).toBeGreaterThanOrEqual(3)
  })

  it('while a flood is on, a poke or an event arms nothing new once the back-off is pending', async () => {
    const s = setup({ mode: 'trailing' })
    for (let sec = 0; sec < 5; sec++) await second(s, 500)
    expect(s.gate.flooding).toBe(true)
    const armed = s.clock.setCalls
    for (let i = 0; i < 5000; i++) { s.gate.note(); s.gate.poke() }
    expect(s.clock.setCalls).toBe(armed)
    expect(s.clock.pending).toBe(1)
  })

  it('a leading gate stops its open window when a flood starts and puts the back-off in its place', async () => {
    const s = setup({ mode: 'leading' })
    for (let sec = 0; sec < 5; sec++) await second(s, 500)
    expect(s.gate.flooding).toBe(true)
    expect(s.clock.pending).toBe(1) // the back-off, nothing else
    expect(s.starts.length).toBeLessThanOrEqual(3)
  })

  it('does not start a run while the previous one is still going, and arms the back-off only once it has ended', async () => {
    const s = setup({ mode: 'trailing', handler: () => s.clock.delay(30_000) })
    for (let sec = 0; sec < 40; sec++) await second(s, 500)
    expect(s.maxActive()).toBe(1)
    expect(s.starts).toHaveLength(2) // 2 s (ends at 32 s), then the back-off armed at 32 s runs at 36 s
    expect(s.gate.running).toBe(true)
  })
})

describe('createRunGate: priority events', () => {
  async function flooded(): Promise<ReturnType<typeof setup>> {
    const s = setup({ mode: 'leading' })
    for (let sec = 0; sec < 31; sec++) await second(s, 1500)
    return s
  }

  it('does not wait out a back-off: it runs once the window since the last run allows, then the schedule resumes', async () => {
    const s = await flooded()
    const last = s.starts[s.starts.length - 1]
    await s.clock.advance(1500)
    const before = s.starts.length
    s.gate.note({ priority: true })
    expect(s.starts).toHaveLength(before) // 1.5 s since the last run: held to one run per window
    await s.clock.advance(500)
    expect(s.starts).toHaveLength(before + 1)
    expect(s.starts[before] - last).toBe(2000)
    // A second priority event inside the new window does not arm a second timer or a second run.
    const armed = s.clock.setCalls
    s.gate.note({ priority: true })
    s.gate.note({ priority: true })
    expect(s.clock.setCalls).toBeLessThanOrEqual(armed + 1)
    await s.clock.advance(100)
    expect(s.starts).toHaveLength(before + 1)
  })

  it('runs at once when the window since the last run has already passed', async () => {
    const s = await flooded()
    await s.clock.advance(3500)
    const before = s.starts.length
    s.gate.note({ priority: true })
    expect(s.starts).toHaveLength(before + 1)
  })

  it('a pending priority run is not cancelled by the flood\'s own events', async () => {
    const s = await flooded()
    await s.clock.advance(1500)
    const before = s.starts.length
    s.gate.note({ priority: true })
    for (let i = 0; i < 1500; i++) s.gate.note() // the tree flood goes on
    await s.clock.advance(600)
    expect(s.starts).toHaveLength(before + 1)
  })

  it('is NOT given that privilege while the priority stream is itself flooding', async () => {
    const s = setup({ mode: 'leading' })
    for (let sec = 0; sec < 70; sec++) await second(s, 1500, { priority: true })
    expect(s.gate.flooding).toBe(true)
    expect(s.starts.length).toBeLessThanOrEqual(8)
    expect(Math.min(...gaps(s.starts))).toBeGreaterThanOrEqual(2000)
  })

  it('is just an ordinary event when nothing is flooding', async () => {
    const s = setup({ mode: 'leading' })
    s.gate.note({ priority: true })
    expect(s.starts).toHaveLength(1)
    s.gate.note({ priority: true })
    await s.clock.advance(2000)
    expect(s.starts).toHaveLength(2)
  })

  it('waits out a long window too: the priority run comes when the window since the last run allows, not before', async () => {
    const s = setup({ mode: 'leading', windowMs: 10_000 })
    for (let sec = 0; sec < 12; sec++) await second(s, 500)
    expect(s.gate.flooding).toBe(true)
    const before = s.starts.length
    s.gate.note({ priority: true }) // 2 s after the last run, in a 10 s window
    expect(s.starts).toHaveLength(before)
    await s.clock.advance(60_000)
    expect(Math.min(...gaps(s.starts))).toBeGreaterThanOrEqual(10_000)
    expect(s.starts.length).toBeGreaterThan(before)
  })
})
