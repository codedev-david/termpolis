// AC2, end to end, in the unit that actually costs the main thread: how many events the OPERATING SYSTEM
// delivers to JavaScript.
//
// Measured on David's laptop (Windows 11, Defender on, Node 24, synthetic files in a temp dir): every event
// the OS delivered cost the receiving thread about 1.5 ms of its own CPU, whatever the listener did with it;
// a recursive watch of a root cost 1.79 ms per event while a worker wrote into `<root>/.worktrees/`, and 16 ms
// in total when that subtree was not subscribed. A JavaScript filter, or a gate that stops running a handler,
// can only act after the event has been paid for. So this test models the OS faithfully (a delivery happens
// only to a watch whose directory is an ancestor (recursive) or the parent (non-recursive) of the changed
// path, and a file created directly inside a directory also makes its parent's watch hear `change:<dir>`, as
// Windows does), then writes 100,000 files through the REAL scopedRecursiveWatch + shedWatch and the REAL
// codeWatch / gitWatcher / TriggerSupervisor wiring, and counts: OS deliveries, handler runs, spawns and
// synchronous fs calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, sep, dirname, basename } from 'path'
import { watchRepo, fsBackedWatchDeps } from '../../src/main/codeWatch'
import { createGitWatcherRegistry } from '../../src/main/gitWatcher'
import { TriggerSupervisor } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import { scopedRecursiveWatch, openScopedGitWatch, scopedTriggerWatch, TRIGGER_SKIP_NAMES, type ScopedFsWatchFn, type ScopedFsWatcher } from '../../src/main/scopedWatch'
import type { Workflow } from '../../src/renderer/src/types'

type Listener = (event: string, filename: string | Buffer | null) => void

const ROOT = join('/repo')

/** A model of the operating system's change notification. Each watch is open or closed; writing a file
 *  delivers to exactly the open watches that would hear about it, and counts each delivery. */
function makeOs(realDirs: string[]) {
  const watches: Array<{ path: string; recursive: boolean; listener: Listener; open: boolean }> = []
  const dirs = new Set(realDirs.map((d) => join(ROOT, ...d.split('/'))))
  dirs.add(ROOT)
  let deliveries = 0
  const byTop = new Map<string, number>()
  const count = (top: string): void => {
    deliveries++
    byTop.set(top, (byTop.get(top) ?? 0) + 1)
  }
  const fsWatch: ScopedFsWatchFn = (p, o, l): ScopedFsWatcher => {
    const w = { path: p, recursive: !!o.recursive, listener: l, open: true }
    watches.push(w)
    return { close() { w.open = false }, on() { return this } }
  }
  return {
    watches,
    fsWatch,
    /** The OS side of a file at `rel` having been written. */
    write(rel: string): void {
      const abs = join(ROOT, ...rel.split('/'))
      const top = rel.split('/')[0]
      for (const w of watches) {
        if (!w.open || !abs.startsWith(w.path + sep)) continue
        const below = abs.slice(w.path.length + 1)
        if (!w.recursive && below.includes(sep)) continue // a non-recursive watch hears only its own children
        count(top)
        w.listener('change', below)
      }
      // A file created in a directory moves that directory's modification time, which a watch of ITS PARENT
      // (non-recursive: direct children) hears as `change:<dir>`. Deep writes never reach the root this way.
      const parent = dirname(abs)
      const grand = dirname(parent)
      for (const w of watches) {
        if (!w.open || w.recursive || w.path !== grand) continue
        count(top)
        w.listener('change', basename(parent))
      }
    },
    get deliveries(): number { return deliveries },
    deliveriesFor: (top: string): number => byTop.get(top) ?? 0,
    statDir: async (abs: string): Promise<string | null> => (dirs.has(abs) ? abs : null),
    listDirs: async (abs: string): Promise<string[]> => {
      const out: string[] = []
      for (const d of dirs) if (dirname(d) === abs) out.push(d.slice(abs.length + 1))
      return out
    },
  }
}

async function micro(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

// Counters for what must stay at zero on the main thread.
const C = vi.hoisted(() => ({ armed: false, sync: 0, spawn: 0 }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of Object.keys(actual)) {
    const fn = (actual as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function' && name.endsWith('Sync')) {
      wrapped[name] = (...a: unknown[]) => { if (C.armed) C.sync++; return (fn as (...x: unknown[]) => unknown)(...a) }
    }
  }
  return { ...wrapped, default: wrapped }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const fn = (actual as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function') wrapped[name] = (...a: unknown[]) => { if (C.armed) C.spawn++; return (fn as (...x: unknown[]) => unknown)(...a) }
  }
  return { ...wrapped, default: wrapped }
})

const TOP = ['src', 'docs', '.worktrees', 'node_modules', 'dist', 'target', '.git', 'vendor']
const REAL = [...TOP, '.worktrees/wt1', '.worktrees/wt1/src', 'node_modules/x']

/** What the OS model needs to be a watch of its own for each consumer: the scoped watch with the model's
 *  directory listing and lstat, nothing else changed. */
const modelHooks = (os: ReturnType<typeof makeOs>) => ({ caseInsensitive: false, statDir: os.statDir, listDirs: os.listDirs, yieldToLoop: async () => {} })

beforeEach(() => { vi.useFakeTimers(); C.armed = false; C.sync = 0; C.spawn = 0 })
afterEach(() => { C.armed = false; vi.useRealTimers() })

/** 100,000 writes: 50,000 into a nested worktree (the swarm), 50,000 into the working tree's own src. */
async function storm(os: ReturnType<typeof makeOs>): Promise<void> {
  for (let s = 0; s < 50; s++) {
    for (let i = 0; i < 1000; i++) {
      os.write(`.worktrees/wt1/src/f${i % 400}.ts`)
      os.write(`src/gen/g${i % 400}.ts`)
    }
    await vi.advanceTimersByTimeAsync(1000)
  }
}

/** 100,000 files written DIRECTLY into a flat build-output directory, over 50 s. */
async function flatStorm(os: ReturnType<typeof makeOs>, dir = 'dist'): Promise<void> {
  for (let s = 0; s < 50; s++) {
    for (let i = 0; i < 2000; i++) os.write(`${dir}/f${s * 2000 + i}.js`)
    await vi.advanceTimersByTimeAsync(1000)
  }
}

describe('100,000 writes: what the operating system hands to JavaScript', () => {
  it('code index: nothing from .worktrees or node_modules is delivered; the one flooded directory that IS watched is shed; the handler runs a bounded number of times', async () => {
    const os = makeOs(REAL)
    const reindex = vi.fn()
    const w = watchRepo(ROOT, {
      ...fsBackedWatchDeps(os.fsWatch as never, reindex, async () => false),
      watch: (dir, listener) => scopedRecursiveWatch(os.fsWatch, dir, listener, modelHooks(os)),
    })
    await micro()
    C.armed = true
    await storm(os)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(os.deliveriesFor('.worktrees')).toBe(0)
    expect(os.deliveriesFor('node_modules')).toBe(0)
    // src IS watched, and 50,000 writes into it in 50 s is a storm: its OS watch is closed after 200 events and
    // reopened on the shedding schedule (4, 8, 16, 32, 60 s ...), so the OS delivered a few hundred, not 50,000.
    expect(os.deliveriesFor('src')).toBeGreaterThanOrEqual(200)
    expect(os.deliveriesFor('src')).toBeLessThanOrEqual(1400)
    // handler runs: bounded; each is a re-sweep after an overflow (no names) or names files of src only
    expect(reindex.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(reindex.mock.calls.length).toBeLessThanOrEqual(12)
    for (const call of reindex.mock.calls) {
      expect((call[1] as string[]).every((f) => f.replace(/\\/g, '/').startsWith('src/'))).toBe(true)
    }
    expect(C.spawn).toBe(0)
    expect(C.sync).toBe(0)
    w.close()
  })

  it('code index, a flat build output (100,000 files straight into dist/): the root watch is shed, the OS delivers a few hundred, nothing is re-indexed', async () => {
    const os = makeOs(REAL)
    const reindex = vi.fn()
    const w = watchRepo(ROOT, {
      ...fsBackedWatchDeps(os.fsWatch as never, reindex, async () => false),
      watch: (dir, listener) => scopedRecursiveWatch(os.fsWatch, dir, listener, modelHooks(os)),
    })
    await micro()
    C.armed = true
    await flatStorm(os)
    await vi.advanceTimersByTimeAsync(130_000)
    // the root watch hears `change:dist` once per file: 100,000 of them without shedding
    expect(os.deliveriesFor('dist')).toBeGreaterThanOrEqual(200)
    expect(os.deliveriesFor('dist')).toBeLessThanOrEqual(1400)
    expect(reindex).not.toHaveBeenCalled() // every event heard was about an ignored name, so nothing is owed
    expect(C.spawn).toBe(0)
    expect(C.sync).toBe(0)
    w.close()
  })

  it('git rail: nothing from .worktrees, node_modules or the objects directory is delivered; a ref moving still is', async () => {
    const os = makeOs([...REAL, '.git/objects', '.git/refs', '.git/logs', '.git/worktrees', '.git/refs/heads'])
    const changes: number[] = []
    const reg = createGitWatcherRegistry({
      watch: ((target: string, opts: { recursive?: boolean; persistent?: boolean }, listener: Listener) =>
        openScopedGitWatch(os.fsWatch, target, opts, listener, undefined, modelHooks(os))) as never,
      onChange: () => { changes.push(Date.now()) },
      throttleMs: 2000,
      probeNested: async () => false,
      readSubmodulePaths: async () => [],
    })
    reg.add(ROOT)
    await micro()
    C.armed = true
    for (let s = 0; s < 50; s++) {
      for (let i = 0; i < 1000; i++) {
        os.write(`.worktrees/wt1/src/f${i % 400}.ts`)
        os.write(`.git/objects/ab/o${i % 400}`)
        os.write(`.git/logs/l${i % 40}`)
        os.write(`.git/worktrees/wt1/index${i % 40}`)
      }
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.advanceTimersByTimeAsync(130_000)
    expect(changes).toHaveLength(0) // not one repaint
    expect(os.deliveriesFor('.worktrees')).toBe(0) // and nothing at all from the nested worktree
    // `.git/logs/` is a flat directory: a file created in it makes the watch of `.git` itself hear
    // `change:logs`, 50,000 times without shedding. That watch is closed after 200 and reopened on the
    // schedule, so what arrived is a few hundred, all about an ignored name, none of it a reason to repaint.
    const noise = os.deliveriesFor('.git')
    expect(noise).toBeLessThanOrEqual(1400)
    os.write('.git/refs/heads/main') // a branch tip moved: the one thing in there that matters
    expect(changes).toHaveLength(1)
    os.write('.git/index') // and the index: heard by the watch of .git, and as `change:.git` by the root's
    expect(os.deliveriesFor('.git')).toBe(noise + 3)
    expect(C.spawn).toBe(0)
    expect(C.sync).toBe(0)
    reg.closeAll()
  })

  it('git rail, a flat build output: the root watch is shed, the OS delivers a few hundred, and not one repaint is made for them', async () => {
    const os = makeOs([...REAL, '.git/refs'])
    const changes: number[] = []
    const reg = createGitWatcherRegistry({
      watch: ((target: string, opts: { recursive?: boolean; persistent?: boolean }, listener: Listener) =>
        openScopedGitWatch(os.fsWatch, target, opts, listener, undefined, modelHooks(os))) as never,
      onChange: () => { changes.push(Date.now()) },
      throttleMs: 2000,
      probeNested: async () => false,
      readSubmodulePaths: async () => [],
    })
    reg.add(ROOT)
    await micro()
    C.armed = true
    await flatStorm(os)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(os.deliveriesFor('dist')).toBeLessThanOrEqual(1400)
    expect(changes).toHaveLength(0)
    expect(C.spawn).toBe(0)
    reg.closeAll()
  })

  it('fileWatch triggers: nothing from .worktrees, node_modules or .termpolis is delivered, no workflow starts for it', async () => {
    const os = makeOs([...REAL, '.termpolis', '.termpolis/workflows'])
    const sup = makeSupervisor(os)
    sup.start()
    await micro()
    C.armed = true
    for (let s = 0; s < 50; s++) {
      for (let i = 0; i < 1000; i++) {
        os.write(`.worktrees/wt1/src/f${i % 400}.ts`)
        os.write(`.termpolis/workflows/h${i % 40}.json`)
        os.write(`node_modules/x/i${i % 400}.js`)
      }
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.advanceTimersByTimeAsync(130_000)
    expect(sup.fires).toEqual([])
    expect(os.deliveriesFor('.worktrees') + os.deliveriesFor('.termpolis') + os.deliveriesFor('node_modules')).toBe(0)
    os.write('src/real.ts')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sup.fires).toHaveLength(1)
    expect(sup.fires[0]).toContain('src')
    expect(C.spawn).toBe(0)
    sup.stop()
  })

  it('fileWatch triggers, a flat build output: a few hundred deliveries, and no workflow runs for the noise', async () => {
    const os = makeOs(REAL)
    const sup = makeSupervisor(os)
    sup.start()
    await micro()
    C.armed = true
    await flatStorm(os)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(os.deliveriesFor('dist')).toBeLessThanOrEqual(1400)
    expect(sup.fires).toEqual([])
    sup.stop()
  })

  it('the control: ONE recursive watch of the same root is handed every one of them', async () => {
    const os = makeOs(REAL)
    const seen: string[] = []
    os.fsWatch(ROOT, { recursive: true }, (_e, f) => { seen.push(String(f)) })
    await storm(os)
    // This is the shape the scoped watch replaces: the swarm's and the install's events all arrive.
    expect(os.deliveriesFor('.worktrees')).toBe(50_000)
    expect(os.deliveriesFor('src')).toBe(50_000)
    expect(seen.length).toBe(100_000)
  })
})

/** A TriggerSupervisor with one fileWatch workflow on src/, watching through the scoped watch over the model OS. */
function makeSupervisor(os: ReturnType<typeof makeOs>) {
  const store = new Map<string, string>()
  const dirsSet = new Set<string>()
  const addDirs = (p: string): void => { let d = dirname(p); while (d && d !== dirname(d)) { dirsSet.add(d); d = dirname(d) } }
  const fsLike = {
    existsSync: (p: string) => store.has(p) || dirsSet.has(p),
    mkdirSync: (p: string) => { dirsSet.add(p); addDirs(p) },
    readdirSync: (d: string) => [...store.keys()].filter((k) => dirname(k) === d).map((k) => k.slice(d.length + 1)),
    readFileSync: (p: string) => { if (!store.has(p)) throw new Error('ENOENT'); return store.get(p)! },
    writeFileSync: (p: string, c: string) => { store.set(p, c); addDirs(p) },
    appendFileSync: (p: string, c: string) => { store.set(p, (store.get(p) ?? '') + c); addDirs(p) },
    rmSync: (p: string) => { store.delete(p) },
  }
  const wf = { id: 'f', name: 'wf', version: 1, trigger: { type: 'fileWatch', config: { paths: 'src/' } }, steps: [] } as unknown as Workflow
  store.set(join(workflowsDir(ROOT), 'f.yml'), serializeWorkflow(wf))
  addDirs(join(workflowsDir(ROOT), 'f.yml'))
  const fires: string[] = []
  expect(typeof scopedTriggerWatch(os.fsWatch)).toBe('function') // the app's own builder has the same shape
  const sup = new TriggerSupervisor({
    fs: fsLike as never,
    readBytes: (p: string) => Buffer.from(fsLike.readFileSync(p)),
    watch: (dir, listener) => scopedRecursiveWatch(os.fsWatch, dir, listener, { skipNames: TRIGGER_SKIP_NAMES, ...modelHooks(os) }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    isTrusted: () => true,
    fire: (_cwd, _id, reason) => { fires.push(reason); return undefined },
    probeNested: async () => false,
    tickMs: 15_000,
  })
  return {
    fires,
    start(): void { sup.watchProject(ROOT) },
    stop(): void { sup.stop() },
  }
}
