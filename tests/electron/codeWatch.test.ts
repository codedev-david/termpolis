import { describe, it, expect, vi } from 'vitest'
import { CODE_WATCH_GAP_MS, CODE_WATCH_MS, watchRepo, ensureRepoWatch, stopRepoWatch, stopRepoWatches, fsBackedWatchDeps, _activeWatchCountForTests, _resetWatchesForTests, type WatchDeps } from '../../src/main/codeWatch'

function harness(over: Partial<WatchDeps> = {}) {
  let listener: (event: string, filename: string | null) => void = () => {}
  const closes: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const deps: WatchDeps = {
    watch: (_dir, l) => {
      listener = l
      const h = { close: vi.fn() }
      closes.push(h)
      return h
    },
    reindex: vi.fn(),
    setTimer: (fn) => {
      const id = nextTimer++
      timers.set(id, fn)
      return id
    },
    clearTimer: (t) => { timers.delete(t as number) },
    debounceMs: 100,
    ...over,
  }
  return {
    deps,
    fire: (name: string | null) => listener('change', name),
    flush: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn() },
    closes,
  }
}

describe('codeWatch', () => {
  it('by default re-indexes 500 ms after a change: a live world shows a saved file within about a second and a half (round 3 D)', () => {
    expect(CODE_WATCH_MS).toBe(500)
    const waits: number[] = []
    const h = harness({ debounceMs: undefined, setTimer: (_fn, ms) => { waits.push(ms); return 1 } })
    watchRepo('/repo', h.deps)
    h.fire('src/a.ts')
    expect(waits).toEqual([500])
  })

  it('by default a change straight after a re-index still waits 2 s from that re-index: a busy session re-indexes no more often than before (round 3 D)', () => {
    expect(CODE_WATCH_GAP_MS).toBe(2000)
    let t = 0
    const h = harness({ debounceMs: undefined, now: () => t })
    const waits: number[] = []
    const set = h.deps.setTimer
    h.deps.setTimer = (fn, ms) => { waits.push(ms); return set(fn, ms) }
    watchRepo('/repo', h.deps)
    h.fire('src/a.ts')
    t = 500
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledTimes(1)
    t = 1000
    h.fire('src/b.ts')
    expect(waits).toEqual([500, 1500])
  })

  it('re-indexes after the debounce on a source-file change', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('src/a.ts')
    expect(h.deps.reindex).not.toHaveBeenCalled() // still debouncing
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['src/a.ts'])
  })

  it('passes the specific changed files to the re-index (incremental)', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('src/a.ts')
    h.fire('src/b.py')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['src/a.ts', 'src/b.py'])
  })

  it('dedupes repeated changes to the same file within a debounce window', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('a.ts')
    h.fire('a.ts')
    h.fire('a.ts')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo', ['a.ts'])
  })

  it('coalesces a burst of changes into a single re-index', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('a.ts')
    h.fire('b.py')
    h.fire('c.rs')
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledTimes(1)
  })

  it('ignores dependency/build churn, non-source files, and null filenames', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('node_modules/x/index.js')
    h.fire('dist/bundle.js')
    h.fire('.git/HEAD')
    h.fire('README.md')
    h.fire('notes.txt')
    h.fire(null)
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
  })

  it('close() cancels a pending re-index and stops the OS watch', () => {
    const h = harness()
    const w = watchRepo('/repo', h.deps)
    h.fire('a.ts')
    w.close()
    h.flush()
    expect(h.deps.reindex).not.toHaveBeenCalled()
    expect(h.closes[0].close).toHaveBeenCalled()
  })

  it('a failing re-index does not throw (last good graph stays)', () => {
    const h = harness({ reindex: vi.fn(() => { throw new Error('index boom') }) })
    watchRepo('/repo', h.deps)
    h.fire('a.ts')
    expect(() => h.flush()).not.toThrow()
  })

  it('degrades gracefully when the OS watch itself throws (no recursive support)', () => {
    const w = watchRepo('/repo', { watch: () => { throw new Error('ENOSYS') }, reindex: vi.fn(), setTimer: vi.fn(), clearTimer: vi.fn() })
    expect(() => w.close()).not.toThrow()
  })

  it('registry: dedups per root, ignores empty root, stops all on teardown', () => {
    _resetWatchesForTests()
    const h = harness()
    expect(ensureRepoWatch('/a', h.deps)).toBe(true)
    expect(ensureRepoWatch('/a', h.deps)).toBe(false) // already watched
    expect(ensureRepoWatch('', h.deps)).toBe(false) // no root
    ensureRepoWatch('/b', h.deps)
    expect(_activeWatchCountForTests()).toBe(2)
    stopRepoWatches()
    expect(_activeWatchCountForTests()).toBe(0)
  })

  it('registry: stopRepoWatch closes one root and leaves the others (a removed Build it folder)', () => {
    _resetWatchesForTests()
    const h = harness()
    ensureRepoWatch('/a', h.deps)
    ensureRepoWatch('/b', h.deps)
    expect(stopRepoWatch('/a')).toBe(true)
    expect(h.closes[0].close).toHaveBeenCalled()
    expect(h.closes[1].close).not.toHaveBeenCalled()
    expect(_activeWatchCountForTests()).toBe(1)
    expect(stopRepoWatch('/a')).toBe(false)
    // a watch whose handle throws on close is still forgotten
    const t = harness({ watch: () => ({ close: () => { throw new Error('gone') } }) })
    ensureRepoWatch('/c', t.deps)
    expect(stopRepoWatch('/c')).toBe(true)
    expect(ensureRepoWatch('/a', h.deps)).toBe(true) // it can be watched again
    stopRepoWatches()
  })

  it('fsBackedWatchDeps wires fs.watch (recursive) + real timers', () => {
    const closed = vi.fn()
    const fsWatchFn = vi.fn(() => ({ close: closed }))
    const reindex = vi.fn()
    const deps = fsBackedWatchDeps(fsWatchFn, reindex)
    const listener = vi.fn()
    const handle = deps.watch('/d', listener)
    expect(fsWatchFn).toHaveBeenCalledWith('/d', { recursive: true }, listener)
    handle.close()
    expect(closed).toHaveBeenCalled()
    expect(deps.reindex).toBe(reindex)
    const t = deps.setTimer(() => {}, 0) // real setTimeout
    expect(() => deps.clearTimer(t)).not.toThrow()
  })
})
