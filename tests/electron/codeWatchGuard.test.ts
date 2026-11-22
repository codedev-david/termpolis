// codeWatch under the storm guard (src/main/codeWatch.ts + watchGuard.ts): what a re-index is and is
// not asked to do. The 100,000-event runs are in watcherFlood.test.ts; these are the single-case
// behaviours, each on counters: re-index calls, the files named in each, timers armed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchRepo, fsBackedWatchDeps, type WatchDeps } from '../../src/main/codeWatch'
import { setWatchGatesPaused } from '../../src/main/watchGuard'

type Listener = (event: string, filename: string | null) => void

function harness(over: Partial<WatchDeps> = {}) {
  let listener: Listener = () => {}
  const timers = new Map<number, () => void>()
  let seq = 0
  const closed = { n: 0 }
  const deps: WatchDeps = {
    watch: (_dir, l) => { listener = l; return { close: () => { closed.n++ } } },
    reindex: vi.fn(),
    setTimer: (fn) => { const id = ++seq; timers.set(id, fn); return id },
    clearTimer: (t) => { timers.delete(t as number) },
    probeNested: async () => false,
    ...over,
  }
  return {
    deps,
    closed,
    emit: (n: string | null) => listener('change', n),
    raw: (e: string, n: string | null) => listener(e, n),
    flush: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn() },
    get armed() { return timers.size },
    get armedTotal() { return seq },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  setWatchGatesPaused(false)
})

describe('codeWatch storm guard', () => {
  it('a mass change (more than 2048 distinct files in one window) asks for a re-sweep instead of naming them', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    for (let i = 0; i < 2048; i++) h.emit(`src/gen/f${i}.ts`)
    h.flush()
    expect(h.deps.reindex).toHaveBeenLastCalledWith('/repo', expect.any(Array))
    expect((h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls[0][1]).toHaveLength(2048)
    for (let i = 0; i < 2049; i++) h.emit(`src/gen/g${i}.ts`)
    h.flush()
    expect((h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual([]) // "everything may have changed"
    // The next window is an ordinary one again: the overflow flag does not stick.
    h.emit('src/a.ts')
    h.flush()
    expect((h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls[2][1]).toEqual(['src/a.ts'])
  })

  it('an overflow (a storm closed an OS watch and it is back) makes the next run a full re-sweep: no names, and it does not stick', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.emit('src/a.ts')
    h.raw('overflow', 'src')
    h.flush()
    const calls = (h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['/repo', []]) // "everything may have changed": the whole repo is re-swept
    h.emit('src/b.ts')
    h.flush()
    expect(calls[1]).toEqual(['/repo', ['src/b.ts']]) // the next window is an ordinary one again
    h.raw('overflow', null) // a bare one (the root watch's) is the same
    h.flush()
    expect(calls[2]).toEqual(['/repo', []])
  })

  it('arms ONE timer however many events arrive in the window', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    for (let i = 0; i < 5000; i++) h.emit(`src/f${i % 50}.ts`)
    expect(h.armedTotal).toBe(1)
    expect(h.armed).toBe(1)
  })

  it.each([
    'Pods/Alamofire/Source.swift', '.turbo/cache/x.ts', 'node_modules/x/index.js', '.worktrees/wt1/src/a.ts',
    '.WORKTREES\\wt1\\src\\a.ts', '.claude/worktrees/x/src/a.ts', 'dist/a.js', '.git/hooks/x.js',
  ])('ignores %s: nothing is armed and nothing is re-indexed', (name) => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.emit(name)
    expect(h.armedTotal).toBe(0)
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
  })

  it('learns a nested repository from a .git event and stops indexing what happens inside it', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.emit('vendor/lib/.git/index') // not source, but it teaches the filter
    h.emit('vendor/lib/src/a.ts')
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
    h.emit('src/a.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['src/a.ts'])
  })

  it('keeps indexing inside the nested repositories the last listing mapped, as it does the root\'s own files', async () => {
    let kept: string[] = []
    const nestedKept = vi.fn(() => kept)
    const h = harness({ nestedKept })
    watchRepo('/repo', h.deps)
    // Before the first listing lands, a nested repository's edits stay out; learning it asks for one re-sweep (below).
    h.emit('vendor/lib/.git/index')
    h.emit('vendor/lib/src/a.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledTimes(1)
    expect(h.deps.reindex).toHaveBeenLastCalledWith('/repo', [])
    // The listing maps vendor/lib: the next run picks that up, and its edits refresh the map.
    kept = ['vendor/lib']
    h.emit('src/root.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenLastCalledWith('/repo', ['src/root.ts'])
    h.emit('vendor/lib/src/a.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenLastCalledWith('/repo', ['vendor/lib/src/a.ts'])
    // A repository learned later is checked against the listing the moment it is learned.
    kept = ['vendor/lib', 'tools/sdk']
    h.emit('tools/sdk/.git/HEAD')
    h.emit('tools/sdk/x.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenLastCalledWith('/repo', ['tools/sdk/x.ts'])
    // One the listing no longer maps (it was cut at the cap, say) drops out again.
    kept = ['tools/sdk']
    h.emit('src/root.ts')
    h.flush()
    const before = (h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls.length
    h.emit('vendor/lib/src/a.ts')
    h.flush()
    expect((h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
    // The listing is asked again on every run (a map lookup; it is only re-applied when it changed).
    const asked = nestedKept.mock.calls.length
    h.emit('src/root.ts')
    h.flush()
    expect(nestedKept.mock.calls.length).toBeGreaterThan(asked)
  })

  it('a nested repository the last listing does not map (a fresh clone) asks for one full re-sweep, which relists; the list is read again once it lands, so the first edit inside counts', async () => {
    let kept: string[] = []
    let land: () => void = () => {}
    const reindex = vi.fn((_root: string, files: string[]) =>
      files.length === 0 ? new Promise<void>((done) => { land = () => { kept = ['vendor/new']; done() } }) : undefined)
    const h = harness({ nestedKept: () => kept, reindex })
    watchRepo('/repo', h.deps)
    h.emit('vendor/new/.git/HEAD')
    h.flush()
    expect(reindex).toHaveBeenCalledTimes(1)
    expect(reindex).toHaveBeenLastCalledWith('/repo', [])
    // The re-sweep's listing maps the new repository; the watcher reads that the moment the run is done, with no
    // edit outside it needed first.
    land()
    await new Promise((r) => setImmediate(r))
    h.flush()
    h.emit('vendor/new/src/a.ts')
    h.flush()
    expect(reindex).toHaveBeenLastCalledWith('/repo', ['vendor/new/src/a.ts'])
    // Asked once per repository: one learned again, or one the listing leaves out on purpose, re-sweeps no more.
    h.emit('ignored/repo/.git/HEAD')
    h.flush()
    expect(reindex).toHaveBeenCalledTimes(3)
    expect(reindex).toHaveBeenLastCalledWith('/repo', [])
    land()
    await new Promise((r) => setImmediate(r))
    h.flush()
    h.raw('rename', 'ignored/repo') // forgotten, then learned again
    h.emit('ignored/repo/.git/index')
    h.flush()
    expect(reindex).toHaveBeenCalledTimes(3)
  })

  it('compares a learned repository with the listing by the platform: case folded on Windows and macOS, as written on Linux', () => {
    const real = process.platform
    for (const [platform, sweeps] of [['linux', 1], ['win32', 0], ['darwin', 0]] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      try {
        const h = harness({ nestedKept: () => ['vendor/new'] })
        watchRepo('/repo', h.deps)
        h.emit('Vendor/New/.git/HEAD')
        h.flush()
        expect((h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls.length, platform).toBe(sweeps)
      } finally {
        Object.defineProperty(process, 'platform', { value: real, configurable: true })
      }
    }
  })

  it('a nested repository learned with no listing to keep it asks for no re-sweep', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.emit('vendor/new/.git/HEAD')
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
  })

  it('a nestedKept that throws is the same as none', () => {
    const h = harness({ nestedKept: () => { throw new Error('boom') } })
    watchRepo('/repo', h.deps)
    h.emit('vendor/lib/.git/index')
    h.emit('vendor/lib/src/a.ts')
    h.emit('src/a.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['src/a.ts'])
  })

  it('learns a nested repository from the disk (async probe) with the default probe too', async () => {
    const probe = vi.fn(async (abs: string) => abs.replace(/\\/g, '/').endsWith('/vendor/lib'))
    const h = harness({ probeNested: probe })
    watchRepo('/repo', h.deps)
    h.emit('vendor/lib/src/first.ts')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledTimes(1) // the one event that taught us got through
    h.emit('vendor/lib/src/second.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledTimes(1)
  })

  it('a re-index that rejects is swallowed and does not stop the next one', async () => {
    const reindex = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const h = harness({ reindex })
    watchRepo('/repo', h.deps)
    h.emit('a.ts')
    h.flush()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    h.emit('b.ts')
    h.flush()
    expect(reindex).toHaveBeenCalledTimes(2)
  })

  it('does not start a second re-index while the first is still running', async () => {
    let finish!: () => void
    const reindex = vi.fn(() => new Promise<void>((r) => { finish = r }))
    const h = harness({ reindex })
    watchRepo('/repo', h.deps)
    h.emit('a.ts')
    h.flush()
    h.emit('b.ts')
    h.flush() // would start a second one, if the gate let it
    expect(reindex).toHaveBeenCalledTimes(1)
    finish()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    h.flush()
    expect(reindex).toHaveBeenCalledTimes(2)
    expect(reindex).toHaveBeenLastCalledWith('/repo', ['b.ts'])
  })

  it('the governor can pause it: nothing is re-indexed while paused, and ONE re-index names everything on resume', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.emit('src/a.ts') // a window is open
    setWatchGatesPaused(true)
    expect(h.armed).toBe(0) // the pending timer was cancelled
    for (let i = 0; i < 1000; i++) h.emit(`src/f${i % 20}.ts`)
    expect(h.armedTotal).toBe(1) // nothing was armed while paused
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
    setWatchGatesPaused(false)
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledTimes(1)
    // src/a.ts (before the pause) + src/f0..f19 (during it): every name, none lost, none repeated.
    expect((h.deps.reindex as ReturnType<typeof vi.fn>).mock.calls[0][1]).toHaveLength(21)
  })

  it('close() stops the OS watch, cancels the pending timer, and ignores an event that arrives late', () => {
    const h = harness()
    const w = watchRepo('/repo', h.deps)
    h.emit('a.ts')
    expect(h.armed).toBe(1)
    w.close()
    expect(h.armed).toBe(0)
    expect(h.closed.n).toBe(1)
    h.emit('b.ts') // fs.watch can deliver one that was already queued
    expect(h.armed).toBe(0)
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
  })

  it('a handle that throws on close does not stop close()', () => {
    const h = harness({ watch: () => ({ close: () => { throw new Error('already closed') } }) })
    expect(() => watchRepo('/repo', h.deps).close()).not.toThrow()
  })
})

describe('fsBackedWatchDeps', () => {
  it('carries the probe through and logs a flood to the in-app log (console.warn)', () => {
    const probe = async (): Promise<boolean> => false
    const deps = fsBackedWatchDeps((() => ({ close() {} })) as never, vi.fn(), probe)
    expect(deps.probeNested).toBe(probe)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deps.log?.('[watch] flood on x')
    expect(warn).toHaveBeenCalledWith('[watch] flood on x')
  })

  it('scoped: opens the root NON-recursively (the directories below are subscribed one by one), and closes it', () => {
    const opened: Array<{ dir: string; recursive?: boolean; close: ReturnType<typeof vi.fn> }> = []
    const fsWatchFn = vi.fn((dir: string, o: { recursive?: boolean }) => {
      const rec = { dir, recursive: o.recursive, close: vi.fn() }
      opened.push(rec)
      return rec
    })
    const deps = fsBackedWatchDeps(fsWatchFn as never, vi.fn(), undefined, true)
    const handle = deps.watch('/repo', vi.fn())
    expect(opened[0]).toMatchObject({ dir: '/repo', recursive: false })
    handle.close()
    expect(opened[0].close).toHaveBeenCalled()
  })

  it('scoped: a root it cannot list falls back to ONE recursive watch and says so in the app log (console.warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opened: Array<{ recursive?: boolean }> = []
    const fsWatchFn = vi.fn((_dir: string, o: { recursive?: boolean }) => { opened.push({ recursive: o.recursive }); return { close() {} } })
    const handle = fsBackedWatchDeps(fsWatchFn as never, vi.fn(), undefined, true).watch('/definitely/not/here/' + process.pid, vi.fn())
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not list it; watching it recursively instead/)), { timeout: 15_000, interval: 25 })
    expect(opened.map((o) => o.recursive)).toEqual([false, true])
    handle.close()
  })

  it('unscoped (the default): ONE recursive watch of the root, exactly as before', () => {
    const fsWatchFn = vi.fn(() => ({ close() {} }))
    const deps = fsBackedWatchDeps(fsWatchFn as never, vi.fn())
    deps.watch('/repo', vi.fn())
    expect(fsWatchFn).toHaveBeenCalledWith('/repo', { recursive: true }, expect.any(Function))
  })
})
