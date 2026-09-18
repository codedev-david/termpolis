// gitWatcher — watch the repo instead of asking it (src/main/gitWatcher.ts).
//
// `watch` and the timers are injected, so none of this touches the filesystem: what is under test is
// the policy, not node's fs.
//
// The policy has three parts worth defending. The throttle fires on the LEADING edge, because a
// debounce would make every save wait out the window — reintroducing exactly the sluggishness this
// replaced. Handles are ref-counted, because a leaked one is held by main until the app exits, and
// on Windows a recursive handle pins the directory. And every failure to open a watch is a NON-error:
// an inotify budget spent by something else, a network share, a platform without recursive watch all
// mean "this repo uses the slow poll", never "this repo is broken".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FSWatcher } from 'fs'
import {
  createGitWatcherRegistry,
  isIgnoredPath,
  isIgnoredGitPath,
  DEFAULT_THROTTLE_MS,
  type GitWatcherDeps,
} from '../../src/main/gitWatcher'

type Listener = (event: string, filename: string | Buffer | null) => void

interface OpenWatch {
  path: string
  opts: { recursive?: boolean; persistent?: boolean }
  listener: Listener
  closed: number
  handle: FSWatcher
}

interface Harness {
  opened: OpenWatch[]
  watch: ReturnType<typeof vi.fn>
  onChange: ReturnType<typeof vi.fn>
  setTimer: ReturnType<typeof vi.fn>
  clearTimer: ReturnType<typeof vi.fn>
  /** Run the pending throttle callback, as the real timer would at the end of the window. */
  fireTimer(): void
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  /** The watch opened for `<root>/.git`, and the one for the working tree. */
  gitDir(): OpenWatch
  tree(): OpenWatch
}

function harness(opts: { failOn?: (path: string) => boolean; closeThrows?: boolean } = {}): Harness {
  const opened: OpenWatch[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const h: Harness = {
    opened,
    timers,
    watch: vi.fn((path: string, o: OpenWatch['opts'], listener: Listener) => {
      if (opts.failOn?.(path)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      const rec: OpenWatch = {
        path, opts: o, listener, closed: 0,
        handle: {
          close: () => {
            rec.closed++
            if (opts.closeThrows) throw new Error('already closed')
          },
        } as unknown as FSWatcher,
      }
      opened.push(rec)
      return rec.handle
    }),
    onChange: vi.fn(),
    setTimer: vi.fn((fn: () => void, ms: number) => {
      timers.push({ fn, ms, cleared: false })
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }),
    clearTimer: vi.fn((t: unknown) => { timers[(t as number) - 1].cleared = true }),
    fireTimer: () => {
      const pending = timers.filter((t) => !t.cleared && !(t as { ran?: boolean }).ran).at(-1)!
      ;(pending as { ran?: boolean }).ran = true
      pending.fn()
    },
    gitDir: () => opened.find((w) => w.path.endsWith('.git'))!,
    tree: () => opened.find((w) => !w.path.endsWith('.git'))!,
  }
  return h
}

function registry(h: Harness, extra: Partial<GitWatcherDeps> = {}) {
  return createGitWatcherRegistry({
    watch: h.watch as unknown as GitWatcherDeps['watch'],
    onChange: h.onChange,
    setTimer: h.setTimer as unknown as GitWatcherDeps['setTimer'],
    clearTimer: h.clearTimer as unknown as GitWatcherDeps['clearTimer'],
    throttleMs: 400,
    ...extra,
  })
}

describe('isIgnoredPath', () => {
  it('ignores the noisy directories whose churn says nothing about git status', () => {
    expect(isIgnoredPath('node_modules/react/index.js')).toBe(true)
    expect(isIgnoredPath('dist/main.js')).toBe(true)
    expect(isIgnoredPath('coverage/lcov.info')).toBe(true)
    expect(isIgnoredPath('.venv/lib/site-packages/x.py')).toBe(true)
  })

  it('ignores them nested, not only at the top level', () => {
    expect(isIgnoredPath('packages/app/node_modules/x/y.js')).toBe(true)
    expect(isIgnoredPath('a/b/__pycache__/m.pyc')).toBe(true)
  })

  it('ignores the directory itself, with no trailing slash', () => {
    expect(isIgnoredPath('node_modules')).toBe(true)
    expect(isIgnoredPath('.git')).toBe(true)
  })

  it('ignores .git — it has its own watcher, and letting the tree see it doubles every event', () => {
    expect(isIgnoredPath('.git/index')).toBe(true)
    expect(isIgnoredPath('sub/.git/HEAD')).toBe(true)
  })

  it('handles the backslashes Windows actually delivers', () => {
    expect(isIgnoredPath('node_modules\\react\\index.js')).toBe(true)
    expect(isIgnoredPath('src\\components\\App.tsx')).toBe(false)
  })

  it('does not over-match a real source file whose name merely starts the same', () => {
    // The trap: `dist/` must not swallow `district/`, and `node_modules` must not swallow a
    // directory that merely ends with it. Over-matching here means edits that never repaint.
    expect(isIgnoredPath('src/index.ts')).toBe(false)
    expect(isIgnoredPath('district/plan.ts')).toBe(false)
    expect(isIgnoredPath('my_node_modules/x.ts')).toBe(false)
    expect(isIgnoredPath('outbox/mail.ts')).toBe(false)
    expect(isIgnoredPath('builder.ts')).toBe(false)
  })
})

describe('isIgnoredGitPath', () => {
  it('keeps everything the status answer actually depends on', () => {
    expect(isIgnoredGitPath('index')).toBe(false)
    expect(isIgnoredGitPath('HEAD')).toBe(false)
    expect(isIgnoredGitPath('refs/heads/main')).toBe(false)
    expect(isIgnoredGitPath('packed-refs')).toBe(false)
    expect(isIgnoredGitPath('MERGE_HEAD')).toBe(false)
  })

  it('drops loose objects and packs, which are the bulk of the churn', () => {
    // A fetch or a commit writes hundreds of these, and not one of them changes the answer on its
    // own — whatever they are part of also lands on a ref or the index.
    expect(isIgnoredGitPath('objects/ab/cdef0123')).toBe(true)
    expect(isIgnoredGitPath('objects/pack/pack-abc.pack')).toBe(true)
    expect(isIgnoredGitPath('objects')).toBe(true)
  })

  it('drops the reflog, which only ever echoes a ref update we already saw', () => {
    expect(isIgnoredGitPath('logs/HEAD')).toBe(true)
    expect(isIgnoredGitPath('logs/refs/heads/main')).toBe(true)
    expect(isIgnoredGitPath('logs')).toBe(true)
  })

  it('drops lock files, because the lock is RENAMED onto the target and the target fires', () => {
    // index.lock is the loud one: every `git status` this watcher triggers takes it, so passing it
    // through is how the watcher ends up feeding itself.
    expect(isIgnoredGitPath('index.lock')).toBe(true)
    expect(isIgnoredGitPath('config.lock')).toBe(true)
    expect(isIgnoredGitPath('refs/heads/main.lock')).toBe(true)
  })

  it('does not over-match a name that merely begins the same way', () => {
    expect(isIgnoredGitPath('objects-backup/x')).toBe(false)
    expect(isIgnoredGitPath('logsomething')).toBe(false)
    expect(isIgnoredGitPath('locked')).toBe(false)
  })

  it('handles the backslashes Windows actually delivers', () => {
    expect(isIgnoredGitPath('objects\\ab\\cdef')).toBe(true)
    expect(isIgnoredGitPath('refs\\heads\\main')).toBe(false)
  })
})

describe('opening watches', () => {
  it('watches .git and the working tree, recursively and non-persistently', () => {
    const h = harness()
    registry(h).add('/repo')
    expect(h.opened.map((w) => w.path)).toEqual(['/repo/.git', '/repo'])
    for (const w of h.opened) expect(w.opts).toEqual({ recursive: true, persistent: false })
  })

  it('never keeps the app alive on a file watcher alone', () => {
    const h = harness()
    registry(h).add('/repo')
    // persistent:false is the difference between "the window closed" and "the process is still
    // running with no window", which on Windows is a second instance that will not start.
    expect(h.opened.every((w) => w.opts.persistent === false)).toBe(true)
  })

  it('joins the .git path in the root\'s own spelling', () => {
    const win = harness()
    registry(win).add('C:\\Users\\d\\repo')
    expect(win.gitDir().path).toBe('C:\\Users\\d\\repo\\.git')

    const posix = harness()
    registry(posix).add('/home/d/repo')
    expect(posix.gitDir().path).toBe('/home/d/repo/.git')
  })

  it('does not double the separator on a root that already ends with one', () => {
    const h = harness()
    registry(h).add('/repo/')
    expect(h.gitDir().path).toBe('/repo/.git')
  })

  it('reports isWatching, and reports FALSE when the platform refused', () => {
    const ok = harness()
    const a = registry(ok)
    a.add('/repo')
    expect(a.isWatching('/repo')).toBe(true)
    expect(a.isWatching('/elsewhere')).toBe(false)

    const refused = harness({ failOn: () => true })
    const b = registry(refused)
    b.add('/repo')
    // Not an error, and the root is still tracked so remove() stays balanced — it just means this
    // repo is on the slow poll.
    expect(b.isWatching('/repo')).toBe(false)
    expect(b.watchedRoots()).toEqual(['/repo'])
  })

  it('keeps the half it could open when only one watch fails', () => {
    const h = harness({ failOn: (p) => p.endsWith('.git') })
    const r = registry(h)
    r.add('/repo')
    expect(h.opened.map((w) => w.path)).toEqual(['/repo'])
    expect(r.isWatching('/repo')).toBe(true)
  })
})

describe('ref counting', () => {
  it('opens one set of handles however many panels ask', () => {
    const h = harness()
    const r = registry(h)
    r.add('/repo')
    r.add('/repo')
    r.add('/repo')
    expect(h.opened).toHaveLength(2)
    expect(r.watchedRoots()).toEqual(['/repo'])
  })

  it('closes only when the LAST one leaves', () => {
    const h = harness()
    const r = registry(h)
    r.add('/repo')
    r.add('/repo')
    r.remove('/repo')
    expect(h.opened.every((w) => w.closed === 0)).toBe(true)
    expect(r.isWatching('/repo')).toBe(true)

    r.remove('/repo')
    expect(h.opened.every((w) => w.closed === 1)).toBe(true)
    expect(r.watchedRoots()).toEqual([])
  })

  it('ignores a remove for a root it never watched', () => {
    const h = harness()
    const r = registry(h)
    expect(() => r.remove('/never')).not.toThrow()
    expect(h.opened).toHaveLength(0)
  })

  it('cancels a pending throttle window when the root goes away', () => {
    const h = harness()
    const r = registry(h)
    r.add('/repo')
    h.tree().listener('change', 'a.ts')
    r.remove('/repo')
    expect(h.clearTimer).toHaveBeenCalledTimes(1)
  })

  it('ignores an event that arrives after the root was removed', () => {
    // fs delivers events that were already queued when close() was called, so this is ordinary,
    // not hypothetical — and pushing an invalidation for a repo nobody is watching would repaint a
    // panel that has already unmounted.
    const h = harness()
    const r = registry(h)
    r.add('/repo')
    const { listener } = h.tree()
    r.remove('/repo')
    expect(() => listener('change', 'a.ts')).not.toThrow()
    expect(h.onChange).not.toHaveBeenCalled()
  })

  it('survives a handle that throws on close', () => {
    const h = harness({ closeThrows: true })
    const r = registry(h)
    r.add('/repo')
    expect(() => r.remove('/repo')).not.toThrow()
    expect(r.watchedRoots()).toEqual([])
  })

  it('closeAll drops every root regardless of how many refs it holds', () => {
    const h = harness()
    const r = registry(h)
    r.add('/a'); r.add('/a'); r.add('/a')
    r.add('/b')
    r.closeAll()
    expect(r.watchedRoots()).toEqual([])
    expect(h.opened.every((w) => w.closed === 1)).toBe(true)
  })
})

describe('throttling', () => {
  let h: Harness
  let r: ReturnType<typeof registry>

  beforeEach(() => {
    h = harness()
    r = registry(h)
    r.add('/repo')
  })

  it('fires IMMEDIATELY on the first event — the leading edge is the whole point', () => {
    h.tree().listener('change', 'src/a.ts')
    expect(h.onChange).toHaveBeenCalledTimes(1)
    expect(h.onChange).toHaveBeenCalledWith('/repo')
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), 400)
  })

  it('collapses a storm into one more fire at the end of the window', () => {
    // An `npm install` produces tens of thousands of events. One repaint now and one when it
    // settles is the correct answer; ten thousand repaints is the bug.
    for (let i = 0; i < 5000; i++) h.tree().listener('change', `src/f${i}.ts`)
    expect(h.onChange).toHaveBeenCalledTimes(1)
    h.fireTimer()
    expect(h.onChange).toHaveBeenCalledTimes(2)
  })

  it('does not fire a second time when the window passed quietly', () => {
    h.tree().listener('change', 'a.ts')
    h.fireTimer()
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('opens a fresh window after the trailing fire, so a long storm keeps collapsing', () => {
    h.tree().listener('change', 'a.ts')
    h.tree().listener('change', 'b.ts')
    h.fireTimer()
    expect(h.onChange).toHaveBeenCalledTimes(2)
    h.tree().listener('change', 'c.ts')
    expect(h.onChange).toHaveBeenCalledTimes(2)
    h.fireTimer()
    expect(h.onChange).toHaveBeenCalledTimes(3)
  })

  it('fires again once the window has closed', () => {
    h.tree().listener('change', 'a.ts')
    h.fireTimer()
    h.tree().listener('change', 'b.ts')
    expect(h.onChange).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the window closes after the root was removed', () => {
    h.tree().listener('change', 'a.ts')
    h.tree().listener('change', 'b.ts')
    r.remove('/repo')
    expect(() => h.timers[0].fn()).not.toThrow()
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('does not let a throwing listener take the watcher down', () => {
    h.onChange.mockImplementation(() => { throw new Error('renderer gone') })
    expect(() => h.tree().listener('change', 'a.ts')).not.toThrow()
    // The throttle state has to survive the throw, or the next edit is either lost or storms.
    h.onChange.mockImplementation(() => {})
    h.tree().listener('change', 'b.ts')
    h.fireTimer()
    expect(h.onChange).toHaveBeenCalledTimes(2)
  })
})

describe('filtering', () => {
  it('drops working-tree events from the ignored directories', () => {
    const h = harness()
    registry(h).add('/repo')
    h.tree().listener('change', 'node_modules/react/index.js')
    h.tree().listener('change', 'dist/out.js')
    expect(h.onChange).not.toHaveBeenCalled()
  })

  it('passes through a real source edit', () => {
    const h = harness()
    registry(h).add('/repo')
    h.tree().listener('change', 'src/App.tsx')
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('decodes a Buffer filename rather than ignoring the event', () => {
    const h = harness()
    registry(h).add('/repo')
    h.tree().listener('change', Buffer.from('node_modules/x.js'))
    expect(h.onChange).not.toHaveBeenCalled()
    h.tree().listener('change', Buffer.from('src/x.ts'))
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('fires on an event with no filename — unknown is not the same as ignorable', () => {
    // Platforms do deliver a null filename. Dropping those would silently lose changes on whichever
    // platform does it most.
    const h = harness()
    registry(h).add('/repo')
    h.tree().listener('rename', null)
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('passes the .git paths that matter — its filenames are relative to `.git`', () => {
    const h = harness()
    registry(h).add('/repo')
    h.gitDir().listener('change', 'index')
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('filters the .git watcher with its OWN list, not the working tree one', () => {
    // These two watchers see different namespaces, and giving `.git` the tree's filter would be
    // exactly backwards: the tree list exists to drop `.git/` entirely.
    const h = harness()
    registry(h).add('/repo')
    h.gitDir().listener('change', 'objects/ab/cdef')
    h.gitDir().listener('change', 'index.lock')
    h.gitDir().listener('change', 'logs/HEAD')
    expect(h.onChange).not.toHaveBeenCalled()
    h.gitDir().listener('change', 'refs/heads/main')
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('does not drop a .git event with no filename', () => {
    const h = harness()
    registry(h).add('/repo')
    h.gitDir().listener('rename', null)
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })

  it('decodes a Buffer filename on the .git watcher too', () => {
    const h = harness()
    registry(h).add('/repo')
    h.gitDir().listener('change', Buffer.from('index.lock'))
    expect(h.onChange).not.toHaveBeenCalled()
    h.gitDir().listener('change', Buffer.from('HEAD'))
    expect(h.onChange).toHaveBeenCalledTimes(1)
  })
})

describe('defaults', () => {
  it('throttles at DEFAULT_THROTTLE_MS when the caller gives none', () => {
    const h = harness()
    createGitWatcherRegistry({
      watch: h.watch as unknown as GitWatcherDeps['watch'],
      onChange: h.onChange,
      setTimer: h.setTimer as unknown as GitWatcherDeps['setTimer'],
      clearTimer: h.clearTimer as unknown as GitWatcherDeps['clearTimer'],
    }).add('/repo')
    h.tree().listener('change', 'a.ts')
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), DEFAULT_THROTTLE_MS)
    expect(DEFAULT_THROTTLE_MS).toBe(1000)
  })

  it('uses the real timers when none are injected', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const r = createGitWatcherRegistry({ watch: h.watch as unknown as GitWatcherDeps['watch'], onChange: h.onChange })
      r.add('/repo')
      h.tree().listener('change', 'a.ts')
      h.tree().listener('change', 'b.ts')
      expect(h.onChange).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(DEFAULT_THROTTLE_MS)
      expect(h.onChange).toHaveBeenCalledTimes(2)
      // And the real clearTimeout path, on teardown with a window still open.
      h.tree().listener('change', 'c.ts')
      expect(() => r.remove('/repo')).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
