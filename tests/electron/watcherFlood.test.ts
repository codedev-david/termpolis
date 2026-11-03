// AC2 — watcher storm guard. 100,000+ synthetic file-system events through the REAL watcher modules
// (codeWatch, gitWatcher, workflow/triggers, transcriptWatchers/baseWatcher) with fake timers.
//
// Why this exists. Typing in Termpolis lags because node-pty runs on the Electron main thread and
// so does everything a watcher does. On David's laptop Defender makes one spawn cost 10-283 ms and
// one synchronous file call up to 1.5 s, and his Claude Code terminals sit at a repo root whose
// `.worktrees/` holds agent swarms editing thousands of files. A recursive watcher on that root
// fires for every one of them. Nothing here is proved with a wall-clock ratio: every assertion is a
// COUNTER (handler runs, timers armed, spawns, synchronous fs calls, probes, concurrent runs, gap
// between runs measured in FAKE milliseconds).
//
// What the counters guard:
//   * a storm inside a nested worktree or nested repository (own .git) runs NO handler and arms NO
//     timer, whatever the case or separator the OS delivers;
//   * a storm of real changes runs the handler a bounded number of times, never closer than 2 s,
//     never two at once, and eventually reports the change (no starvation, no over-suppression);
//   * none of it spawns a process or makes a synchronous fs call on the main thread.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, dirname } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const C = vi.hoisted(() => {
  const counts = { sync: {} as Record<string, number>, spawn: {} as Record<string, number> }
  return {
    armed: false,
    counts,
    bump(kind: 'sync' | 'spawn', name: string): void {
      if (this.armed) counts[kind][name] = (counts[kind][name] ?? 0) + 1
    },
    tail: {
      fake: false,
      listener: null as null | ((event: string, filename: string | null) => void),
      size: 0,
      stat: 0,
      open: 0,
      read: 0,
      active: 0,
      maxActive: 0,
      readDelayMs: 0,
      /** How many times the OS watch was opened: the first, and every reopening after a storm closed it. */
      watchOpens: 0,
    },
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of Object.keys(actual)) {
    const fn = (actual as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function' && name.endsWith('Sync')) {
      wrapped[name] = (...args: unknown[]) => {
        C.bump('sync', name)
        return (fn as (...a: unknown[]) => unknown)(...args)
      }
    }
  }
  wrapped.watch = (...args: unknown[]) => {
    if (C.tail.fake) {
      C.tail.listener = args[2] as (event: string, filename: string | null) => void
      C.tail.watchOpens++
      return { on() {}, close() {} }
    }
    return (actual.watch as unknown as (...a: unknown[]) => unknown)(...args)
  }
  // The async surface tailFile may use. While `fake` is on, the "file" is a counter: its size is
  // whatever the test says and every read hands back exactly the bytes asked for, one line long.
  const fakeHandle = {
    async read(buf: Buffer, off: number, len: number) {
      C.tail.read++
      C.tail.active++
      C.tail.maxActive = Math.max(C.tail.maxActive, C.tail.active)
      try {
        if (C.tail.readDelayMs) await new Promise<void>((r) => setTimeout(r, C.tail.readDelayMs))
        for (let i = 0; i < len; i++) buf[off + i] = i % 2 === 0 ? 0x61 : 0x0a // many short lines: the 64 KB line cap never swallows a read
        return { bytesRead: len, buffer: buf }
      } finally {
        C.tail.active--
      }
    },
    async close() {},
  }
  const promises = {
    ...actual.promises,
    stat: async (...args: unknown[]) => {
      if (!C.tail.fake) return (actual.promises.stat as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
      C.tail.stat++
      return { size: C.tail.size }
    },
    open: async (...args: unknown[]) => {
      if (!C.tail.fake) return (actual.promises.open as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
      C.tail.open++
      return fakeHandle
    },
  }
  wrapped.promises = promises
  return { ...wrapped, default: wrapped }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const fn = (actual as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function') {
      wrapped[name] = (...args: unknown[]) => {
        C.bump('spawn', name)
        return (fn as (...a: unknown[]) => unknown)(...args)
      }
    }
  }
  return { ...wrapped, default: wrapped }
})

import { watchRepo, fsBackedWatchDeps, stopRepoWatches } from '../../src/main/codeWatch'
import { createGitWatcherRegistry } from '../../src/main/gitWatcher'
import { TriggerSupervisor } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import { tailFile } from '../../src/main/transcriptWatchers/baseWatcher'
import type { Workflow } from '../../src/renderer/src/types'

type Listener = (event: string, filename: string | null) => void

/** 105,000 events: a 70 s build at 1,500 events/s. The shape of `npm run build` in a big repo. */
const SUSTAINED = { seconds: 70, perSecond: 1500 }
/** 100,000 events in 10 s: the shape of a codegen or a `git checkout` across a monorepo. */
const BURST = { seconds: 10, perSecond: 10_000 }
/** The contract: a root's handler never starts closer than this to its previous run. */
const MIN_GAP_MS = 2000

const syncCalls = (): number => Object.values(C.counts.sync).reduce((a, b) => a + b, 0)
const spawnCalls = (): number => Object.values(C.counts.spawn).reduce((a, b) => a + b, 0)

/** Deliver `perSecond` events at the start of each simulated second, then let the second pass. */
async function drive(
  listener: Listener,
  o: { seconds: number; perSecond: number; name: (n: number) => string },
  fromN = 0,
): Promise<number> {
  let n = fromN
  for (let s = 0; s < o.seconds; s++) {
    for (let i = 0; i < o.perSecond; i++) listener('change', o.name(n++))
    await vi.advanceTimersByTimeAsync(1000)
  }
  return n
}

/** Distinct gaps, in fake ms, between consecutive handler STARTS. */
function minGap(times: number[]): number {
  let m = Infinity
  for (let i = 1; i < times.length; i++) m = Math.min(m, times[i] - times[i - 1])
  return m
}

/** Count global setTimeout calls: the timer churn a per-event re-arm would cost. */
function countSetTimeout(): { calls: () => number; restore: () => void } {
  const real = globalThis.setTimeout
  let calls = 0
  globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
    calls++
    return real(...a)
  }) as typeof setTimeout
  return { calls: () => calls, restore: () => { globalThis.setTimeout = real } }
}

let t0 = 0
beforeEach(() => {
  vi.useFakeTimers()
  t0 = Date.now()
  C.armed = false
  C.counts.sync = {}
  C.counts.spawn = {}
  Object.assign(C.tail, { fake: false, listener: null, size: 0, stat: 0, open: 0, read: 0, active: 0, maxActive: 0, readDelayMs: 0 })
})
afterEach(() => {
  C.armed = false
  stopRepoWatches()
  vi.useRealTimers()
})

// ── codeWatch ────────────────────────────────────────────────────────────────

function codeHarness(over: { reindex?: (root: string, files: string[]) => unknown; probe?: (dir: string) => Promise<boolean> } = {}) {
  let listener: Listener = () => {}
  const runs: { at: number; files: string[] }[] = []
  const logs: string[] = []
  let active = 0
  let maxActive = 0
  const reindex = (root: string, files: string[]): unknown => {
    runs.push({ at: Date.now() - t0, files })
    active++
    maxActive = Math.max(maxActive, active)
    const r = over.reindex?.(root, files)
    const done = (): void => { active-- }
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      return (r as Promise<unknown>).then(done, done)
    }
    done()
    return r
  }
  const deps = {
    ...fsBackedWatchDeps(((_dir: string, _o: unknown, l: Listener) => { listener = l; return { close() {} } }) as never, reindex as never, over.probe as never),
    log: (m: string) => { logs.push(m) },
  }
  const w = watchRepo('C:/repo', deps as never)
  return { w, emit: (n: string | null) => listener('change', n), listener: (e: string, f: string | null) => listener(e, f), runs, logs, maxActive: () => maxActive }
}

describe('codeWatch under a 100,000-event storm', () => {
  it('ignores a storm inside nested worktrees, in either case and either separator: no run, no timer, no spawn, no sync call', async () => {
    const h = codeHarness()
    C.armed = true
    await drive(h.listener, { ...BURST, name: (n) => (n % 2 ? `.worktrees/wt${n % 20}/src/f${n % 300}.ts` : `.Worktrees\\wt${n % 20}\\src\\f${n % 300}.ts`) })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.runs).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(spawnCalls()).toBe(0)
    expect(syncCalls()).toBe(0)
    h.w.close()
  })

  it('ignores a nested repository (a directory with its own .git) once it has been probed, with a bounded number of async probes', async () => {
    const probed: string[] = []
    const probe = async (dir: string): Promise<boolean> => {
      probed.push(dir)
      return dir.replace(/\\/g, '/').endsWith('/vendor/lib')
    }
    const h = codeHarness({ probe })
    C.armed = true
    h.emit('vendor/lib/src/first.ts') // the event that teaches us; it may run the handler once
    await vi.advanceTimersByTimeAsync(2500)
    const before = h.runs.length
    await drive(h.listener, { ...BURST, name: (n) => `vendor/lib/src/f${n % 500}.ts` })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.runs.length).toBe(before) // not one more run for 100,000 events in the nested repo
    expect(probed.length).toBeLessThanOrEqual(6) // vendor, vendor/lib, vendor/lib/src: asked once each
    // ... and the repo's OWN files are still noticed (no over-suppression).
    h.emit('src/main.ts')
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.runs.length).toBe(before + 1)
    expect(h.runs[before].files).toEqual(['src/main.ts'])
    expect(syncCalls()).toBe(0)
    expect(spawnCalls()).toBe(0)
    h.w.close()
  })

  it('rate limits a sustained flood of real changes, never closer than 2 s, and still reports them (no starvation)', async () => {
    const h = codeHarness()
    const timers = countSetTimeout()
    C.armed = true
    const n = await drive(h.listener, { ...SUSTAINED, name: (k) => `src/gen/f${k % 400}.ts` })
    expect(n).toBeGreaterThanOrEqual(100_000)
    const during = h.runs.length
    // Bounded: the exponential back-off allows a handful of runs in 70 s, not one per second.
    expect(during).toBeLessThanOrEqual(8)
    // No starvation: a flood must not hold a legitimate change back forever.
    expect(during).toBeGreaterThanOrEqual(3)
    expect(minGap(h.runs.map((r) => r.at))).toBeGreaterThanOrEqual(MIN_GAP_MS)
    // The per-event debounce re-arm of the old code was 100,000 setTimeout calls.
    expect(timers.calls()).toBeLessThanOrEqual(200)
    await vi.advanceTimersByTimeAsync(130_000)
    timers.restore()
    expect(h.runs.length).toBeLessThanOrEqual(9)
    expect(minGap(h.runs.map((r) => r.at))).toBeGreaterThanOrEqual(MIN_GAP_MS)
    // Every one of the 400 files was reported by some run: nothing was over-suppressed.
    expect(new Set(h.runs.flatMap((r) => r.files)).size).toBe(400)
    // The state change is logged once each way, not once per second.
    expect(h.logs).toHaveLength(2)
    expect(spawnCalls()).toBe(0)
    expect(syncCalls()).toBe(0)
    h.w.close()
  })

  it('never runs two re-indexes at once, even when each takes 5 s and changes keep arriving', async () => {
    const h = codeHarness({ reindex: () => new Promise<void>((r) => setTimeout(r, 5000)) })
    C.armed = true
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 500; i++) h.emit(`src/c${cycle}f${i % 50}.ts`)
      await vi.advanceTimersByTimeAsync(3000)
    }
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.maxActive()).toBe(1)
    expect(h.runs.length).toBeGreaterThanOrEqual(2)
    // Everything that arrived while a run was going was picked up by a later run.
    expect(new Set(h.runs.flatMap((r) => r.files)).size).toBe(300)
    h.w.close()
  })

  it('notices a legitimate change in a calm tree within one debounce, after a flood has ended', async () => {
    const h = codeHarness()
    await drive(h.listener, { seconds: 8, perSecond: 5000, name: (k) => `src/gen/f${k % 100}.ts` })
    await vi.advanceTimersByTimeAsync(200_000) // the flood is long over
    const before = h.runs.length
    h.emit('src/real.ts')
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.runs.length).toBe(before + 1)
    expect(h.runs[before].files).toEqual(['src/real.ts'])
    h.w.close()
  })
})

// ── gitWatcher ───────────────────────────────────────────────────────────────

function gitHarness(over: { probe?: (dir: string) => Promise<boolean> } = {}) {
  const opened: { path: string; listener: Listener }[] = []
  const changes: number[] = []
  const logs: string[] = []
  const reg = createGitWatcherRegistry({
    watch: ((path: string, _o: unknown, listener: Listener) => {
      opened.push({ path, listener })
      return { close() {} }
    }) as never,
    onChange: () => { changes.push(Date.now() - t0) },
    // Production passes the shared 2 s window (index.ts, WATCH_MIN_INTERVAL_MS); the module's own
    // default stays 1 s because tests pin it.
    throttleMs: 2000,
    probeNested: over.probe,
    log: (m: string) => { logs.push(m) },
  } as never)
  reg.add('C:/repo')
  const tree = opened.find((w) => !w.path.endsWith('.git'))!.listener
  const gitDir = opened.find((w) => w.path.endsWith('.git'))!.listener
  return { reg, tree, gitDir, changes, logs }
}

describe('gitWatcher under a 100,000-event storm', () => {
  it('ignores a storm inside nested worktrees and a nested repository: no repaint, no timer', async () => {
    const probe = async (dir: string): Promise<boolean> => dir.replace(/\\/g, '/').endsWith('/vendor/lib')
    const h = gitHarness({ probe })
    C.armed = true
    h.tree('change', 'vendor/lib/src/first.ts')
    await vi.advanceTimersByTimeAsync(2500)
    const before = h.changes.length
    await drive(h.tree, { ...BURST, name: (n) => (n % 3 === 0 ? `.worktrees/wt${n % 20}/src/f${n % 300}.ts` : n % 3 === 1 ? `.WORKTREES\\wt${n % 20}\\src\\f.ts` : `vendor/lib/src/f${n % 500}.ts`) })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.changes.length).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
    h.tree('change', 'src/real.ts')
    expect(h.changes.length).toBe(before + 1) // the leading edge still repaints an ordinary edit at once
    expect(spawnCalls()).toBe(0)
    expect(syncCalls()).toBe(0)
    h.reg.closeAll()
  })

  it("also ignores the `change` events Windows reports for a nested repository's OWN directory entries", async () => {
    // The shape of the real stream: a write to vendor/lib/src/x.ts is followed by `change` events for
    // vendor/lib/src and vendor/lib (a directory's modification time moves when anything inside it
    // does). Those are not under any ignored NAME, and before the filter was told the event type they
    // made it forget the nested repository and let the next events through.
    const probe = async (dir: string): Promise<boolean> => dir.replace(/\\/g, '/').endsWith('/vendor/lib')
    const h = gitHarness({ probe })
    h.tree('change', 'vendor/lib/src/first.ts')
    await vi.advanceTimersByTimeAsync(2500)
    const before = h.changes.length
    C.armed = true
    await drive(h.tree, { ...BURST, name: (n) => (n % 3 === 0 ? `vendor/lib/src/f${n % 500}.ts` : n % 3 === 1 ? 'vendor\\lib\\src' : 'vendor\\lib') })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.changes.length).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
    expect(syncCalls()).toBe(0)
    h.reg.closeAll()
  })

  it('collapses a sustained flood to a handful of repaints, never closer than 2 s, and ends calm', async () => {
    const h = gitHarness()
    C.armed = true
    const n = await drive(h.tree, { ...SUSTAINED, name: (k) => `src/gen/f${k % 400}.ts` })
    expect(n).toBeGreaterThanOrEqual(100_000)
    expect(h.changes.length).toBeLessThanOrEqual(8) // the old 1 s window would have run ~70 times
    expect(h.changes.length).toBeGreaterThanOrEqual(3)
    expect(minGap(h.changes)).toBeGreaterThanOrEqual(MIN_GAP_MS)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.changes.length).toBeLessThanOrEqual(9)
    expect(h.logs).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(spawnCalls()).toBe(0)
    expect(syncCalls()).toBe(0)
    h.reg.closeAll()
  })

  it('a commit or checkout (.git) does not wait out the flood back-off: it repaints as soon as the 2 s window allows', async () => {
    const h = gitHarness()
    await drive(h.tree, { seconds: 31, perSecond: 1500, name: (k) => `src/gen/f${k % 400}.ts` })
    // The flood's own schedule has runs at 0, 2, 7, 15, 31 s and the next one at 63 s.
    expect(h.changes.slice(-1)[0]).toBe(31_000)
    await vi.advanceTimersByTimeAsync(1500) // 32.5 s: 1.5 s after the last repaint, the tree flood still on
    const before = h.changes.length
    h.gitDir('change', 'refs/heads/main')
    // A ref moved: that is the answer changing, not noise. Still held to ONE repaint per window, so it
    // waits out the 0.5 s left of this one, not the 30 s left of the back-off.
    expect(h.changes.length).toBe(before)
    await vi.advanceTimersByTimeAsync(600)
    expect(h.changes.length).toBe(before + 1)
    expect(h.changes[before] - h.changes[before - 1]).toBeGreaterThanOrEqual(MIN_GAP_MS)
    expect(h.changes[before]).toBeLessThan(40_000)
    h.reg.closeAll()
  })

  it('a commit repaints at once when the window since the last repaint has already passed', async () => {
    const h = gitHarness()
    await drive(h.tree, { seconds: 31, perSecond: 1500, name: (k) => `src/gen/f${k % 400}.ts` })
    await vi.advanceTimersByTimeAsync(3500) // 34.5 s, the tree flood still on, last repaint 3.5 s ago
    const before = h.changes.length
    h.gitDir('change', 'refs/heads/main')
    expect(h.changes.length).toBe(before + 1)
    h.reg.closeAll()
  })

  it('a flood of .git events is NOT given that privilege: it backs off like any other', async () => {
    const h = gitHarness()
    await drive(h.gitDir, { ...SUSTAINED, name: (k) => `refs/heads/b${k % 300}` })
    expect(h.changes.length).toBeLessThanOrEqual(8)
    expect(minGap(h.changes)).toBeGreaterThanOrEqual(MIN_GAP_MS)
    h.reg.closeAll()
  })
})

// ── workflow/triggers ────────────────────────────────────────────────────────

function makeFs() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const addDirs = (p: string) => {
    let d = dirname(p)
    while (d && d !== dirname(d)) { dirs.add(d); d = dirname(d) }
  }
  return {
    files,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    mkdirSync: (p: string) => { dirs.add(p); addDirs(p) },
    readdirSync: (d: string) => [...files.keys()].filter((k) => dirname(k) === d).map((k) => k.slice(d.length + 1)),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error(dirs.has(p) ? 'EISDIR' : `ENOENT: ${p}`)
      return files.get(p)!
    },
    writeFileSync: (p: string, data: string) => { files.set(p, data); addDirs(p) },
    appendFileSync: (p: string, data: string) => { files.set(p, (files.get(p) ?? '') + data); addDirs(p) },
    rmSync: (p: string) => { files.delete(p) },
    put(p: string, content: string) { files.set(p, content); addDirs(p) },
  }
}

const ROOT = join('/repo')

function triggerHarness(config: Record<string, string> = {}, over: { probe?: (dir: string) => Promise<boolean> } = {}) {
  const fs = makeFs()
  const wf = { id: 'f', name: 'wf-f', version: 1, trigger: { type: 'fileWatch', config }, steps: [] } as unknown as Workflow
  fs.put(join(workflowsDir(ROOT), 'f.yml'), serializeWorkflow(wf))
  const fires: { at: number; reason: string }[] = []
  const logs: string[] = []
  let listener: Listener = () => {}
  const sup = new TriggerSupervisor({
    fs: fs as never,
    readBytes: (p: string) => Buffer.from(fs.readFileSync(p)),
    watch: (_dir: string, l: Listener) => { listener = l; return { close() {} } },
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    isTrusted: () => true,
    fire: (_cwd: string, _id: string, reason: string) => { fires.push({ at: Date.now() - t0, reason }); return undefined },
    log: (m: string) => { logs.push(m) },
    probeNested: over.probe,
    tickMs: 15_000,
  } as never)
  sup.watchProject(ROOT)
  return { sup, listener: (e: string, f: string | null) => listener(e, f), fires, logs }
}

describe('workflow fileWatch triggers under a 100,000-event storm', () => {
  it('ignores a storm inside nested worktrees and a nested repository: no workflow starts, no timer', async () => {
    const probe = async (dir: string): Promise<boolean> => dir.replace(/\\/g, '/').endsWith('/vendor/lib')
    const h = triggerHarness({}, { probe })
    C.armed = true
    h.listener('change', 'vendor/lib/src/first.ts')
    await vi.advanceTimersByTimeAsync(5000)
    const before = h.fires.length
    await drive(h.listener, { ...BURST, name: (n) => (n % 2 ? `.worktrees/wt${n % 20}/src/f${n % 300}.ts` : `vendor/lib/src/f${n % 500}.ts`) })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(h.fires.length).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
    h.sup.stop()
  })

  it('starts a workflow a bounded number of times during a sustained flood, never closer than 2 s, and does not starve it', async () => {
    const h = triggerHarness()
    const timers = countSetTimeout()
    C.armed = true
    const n = await drive(h.listener, { ...SUSTAINED, name: (k) => `src/gen/f${k % 400}.ts` })
    expect(n).toBeGreaterThanOrEqual(100_000)
    expect(h.fires.length).toBeLessThanOrEqual(8)
    expect(h.fires.length).toBeGreaterThanOrEqual(3)
    expect(minGap(h.fires.map((f) => f.at))).toBeGreaterThanOrEqual(MIN_GAP_MS)
    expect(timers.calls()).toBeLessThanOrEqual(200)
    timers.restore()
    await vi.advanceTimersByTimeAsync(130_000) // the flood is over: the back-off timer runs once more and says so
    expect(h.logs.filter((l) => /flood/i.test(l))).toHaveLength(2)
    expect(spawnCalls()).toBe(0)
    h.sup.stop()
  })

  it('a burst that ENDS with an unrelated file still reports the matching file seen earlier in it', async () => {
    const h = triggerHarness({ paths: 'src/', debounceMs: '500' })
    h.listener('change', 'src/a.ts')
    h.listener('change', 'README.md') // the old code kept only this last name and matched nothing
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.fires).toHaveLength(1)
    expect(h.fires[0].reason).toContain('src/a.ts')
    h.sup.stop()
  })
})

// ── transcriptWatchers/baseWatcher (tailFile) ────────────────────────────────

describe('tailFile under a 100,000-event storm', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'termpolis-flood-'))
    file = join(dir, 'session.jsonl')
    writeFileSync(file, '')
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
  })

  function attach() {
    C.tail.fake = true
    const lines: string[] = []
    const handle = tailFile(file, (l) => { lines.push(l) }, { startAtEnd: true })
    const listener = C.tail.listener as unknown as () => void
    return { handle, lines, emit: (): void => { C.tail.size += 13; listener() } }
  }

  it('a write storm makes zero synchronous fs calls and zero spawns, and ticks at most once per 2 s', async () => {
    const t = attach()
    C.armed = true // attach-time work is over; everything from here is a reaction to events
    for (let s = 0; s < SUSTAINED.seconds; s++) {
      for (let i = 0; i < SUSTAINED.perSecond; i++) t.emit()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(syncCalls()).toBe(0)
    expect(spawnCalls()).toBe(0)
    // The OS watch sheds itself (shedWatch.ts): closed after 200 events in a second, reopened at 4, 12, 28 and
    // 60 s, so of the 105,000 write notifications about a thousand reached the tail at all.
    expect(C.tail.watchOpens).toBeGreaterThanOrEqual(4)
    expect(C.tail.watchOpens).toBeLessThanOrEqual(8)
    // What reads the file is then its 1.5 s poll through the 2 s window: one read per window, never one per
    // event, and the data of the flood still arrives. Each tick is one async stat; a tick that finds growth adds
    // one open + one read.
    expect(C.tail.read).toBeLessThanOrEqual(SUSTAINED.seconds / 2 + 4)
    expect(C.tail.stat).toBeLessThanOrEqual(SUSTAINED.seconds / 2 + 8)
    expect(C.tail.read).toBeGreaterThanOrEqual(SUSTAINED.seconds / 2 - 10)
    expect(t.lines.length).toBeGreaterThanOrEqual(C.tail.read)
    expect(C.tail.maxActive).toBeLessThanOrEqual(1)
    t.handle.stop()
  })

  it('never reads twice at once, even when a read takes 50 ms and events keep coming', async () => {
    C.tail.readDelayMs = 50
    const t = attach()
    C.armed = true
    for (let s = 0; s < 20; s++) {
      for (let i = 0; i < 5000; i++) t.emit()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(C.tail.maxActive).toBe(1)
    expect(C.tail.read).toBeGreaterThanOrEqual(3)
    expect(syncCalls()).toBe(0)
    t.handle.stop()
  })

  it('a stopped tail ignores late events and finishes no read it had started', async () => {
    const t = attach()
    C.armed = true
    t.emit()
    t.handle.stop()
    const seen = t.lines.length
    for (let i = 0; i < 1000; i++) t.emit()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.lines.length).toBe(seen)
    expect(syncCalls()).toBe(0)
  })
})
