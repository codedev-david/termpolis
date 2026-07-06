import { describe, it, expect, vi } from 'vitest'
import { watchRepo, ensureRepoWatch, stopRepoWatches, fsBackedWatchDeps, _activeWatchCountForTests, _resetWatchesForTests, type WatchDeps } from '../../src/main/codeWatch'

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
  it('re-indexes after the debounce on a source-file change', () => {
    const h = harness()
    watchRepo('/repo', h.deps)
    h.fire('src/a.ts')
    expect(h.deps.reindex).not.toHaveBeenCalled() // still debouncing
    h.flush()
    expect(h.deps.reindex).toHaveBeenCalledWith('/repo')
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
