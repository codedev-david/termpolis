// Watch the repo instead of asking it every three seconds.
//
// The Changes rail polled `git:changes` every 3 s — three git processes — and the dot polled every
// 5 s, per repo, forever, whether or not a single byte had changed. That is the wrong shape for the
// question. "Has this repo changed?" is something the filesystem already knows and will tell you.
//
// So the poll becomes a SAFETY NET rather than the mechanism: the watcher pushes an invalidation the
// moment anything moves, and a slow poll (15 s) covers the cases a watcher cannot see — a network
// share, a platform where recursive watching is unavailable, an inotify limit already exhausted by
// something else on the box. Missing an event then costs you a stale rail for a few seconds instead
// of a rail that is wrong until you click something.
//
// Two things are watched per repo:
//   1. `.git` — index (staging), HEAD (checkout), refs (commit, fetch, merge). These are the events
//      that change the answer the MOST, and they are cheap: one small directory tree.
//   2. the working tree — the ordinary case of editing a file. Recursive, which on Windows is one
//      ReadDirectoryChangesW handle and on macOS one FSEvents stream.
//
// Throttled with a LEADING edge on purpose. Debouncing (trailing only) would mean every save waits
// the full window before the UI moves, which is the sluggishness we are trying to remove. Firing
// first and then collapsing the rest of the burst gives an instant repaint on the keystroke that
// saved, and one more at the end of a `npm install`-sized storm rather than ten thousand.
//
// The window is a second rather than the 400 ms this first shipped with. The leading edge is what
// makes the UI feel instant, so widening the window costs nothing there — it only decides how
// often a SUSTAINED storm is allowed to re-ask, and each re-ask is three git processes per repo.
//
// STORM GUARD (watchGuard.ts). The window above paces an ordinary storm; it does not know what the
// events are ABOUT. David's repo roots hold `.worktrees/` where agent swarms edit thousands of files
// and run git constantly, and none of that can change THIS repo's status. So the working-tree watch
// drops events inside nested worktrees and nested repositories (git submodules are the one exception:
// a dirty submodule IS part of the parent's status), the `.git` watch drops `worktrees/` (the other
// checkouts' private HEAD and index), and one shared limiter holds the repaint to once per window,
// and, when more than 200 events/s arrive for 3 s, to one repaint per back-off (4 s .. 60 s). A ref
// that moves in `.git` (a commit, a checkout) is the answer changing, not noise, so it does not wait
// out a flood's back-off: it repaints as soon as the window since the last repaint allows.

import type { FSWatcher } from 'fs'
import { promises as fsp } from 'fs'
import { createIgnoreFilter, createRunGate, isIgnoredWatchPath, type IgnoreFilter, type RunGate } from './watchGuard'

export type WatchFn = (
  path: string,
  opts: { recursive?: boolean; persistent?: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

export interface GitWatcherDeps {
  watch: WatchFn
  /** Called at most once per throttle window per root, with the root that changed. */
  onChange: (root: string) => void
  /** Injected in tests; real callers get the global timers. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
  throttleMs?: number
  /** Clock for the flood meter. Defaults to Date.now. */
  now?: () => number
  /** One line when a flood starts and one when it is over. */
  log?: (msg: string) => void
  /** Async: is this directory a nested repository (own .git) or a link? Defaults to lstat + stat. */
  probeNested?: (absDir: string) => Promise<boolean>
  /** Async: the submodule paths (relative to the root) declared in `.gitmodules`. A submodule is a
   *  nested repository whose edits DO show in the parent's status, so it stays watched. */
  readSubmodulePaths?: (root: string) => Promise<string[]>
}

export const DEFAULT_THROTTLE_MS = 1000

/** Paths whose churn says nothing about the repo's git status but can produce thousands of events a
 *  second: dependency and build folders, `.git` (it has its own dedicated watcher, and letting the
 *  recursive tree watcher see it as well would double every event), and nested worktrees. The rule is
 *  shared with every other watcher (watchGuard.ts). */
export function isIgnoredPath(filename: string): boolean {
  return isIgnoredWatchPath(filename)
}

/** The `.git` watcher is the amplifier in this design: every event it passes costs three git
 *  processes, and git rewrites far more of `.git` than the status answer depends on. Loose objects
 *  and packs (`objects/`), the reflog (`logs/`) and every `*.lock` are noise — a lock file is
 *  created and then RENAMED onto its target, so the target fires on its own — and so is `worktrees/`,
 *  where every OTHER checkout of this repo keeps its own HEAD, index and logs and rewrites them on
 *  every `git add` and `git status` it runs. A change that really moves the needle always lands on
 *  `index`, `HEAD`, `refs/**`, `packed-refs` or a MERGE/REBASE head, none of which are dropped here. */
export function isIgnoredGitPath(filename: string): boolean {
  const p = filename.replace(/\\/g, '/')
  return (
    p.endsWith('.lock') ||
    p === 'objects' || p.startsWith('objects/') ||
    p === 'logs' || p.startsWith('logs/') ||
    p === 'worktrees' || p.startsWith('worktrees/')
  )
}

interface RepoWatch {
  refs: number
  watchers: FSWatcher[]
  gate: RunGate
  filter: IgnoreFilter
}

export interface GitWatcherRegistry {
  /** Ref-counted: the Nth caller to watch a root does not open an (N)th set of handles. */
  add(root: string): void
  remove(root: string): void
  closeAll(): void
  watchedRoots(): string[]
  /** True when at least one real handle was opened for this root — false means the platform or the
   *  box refused, and the caller is relying on the slow poll alone. */
  isWatching(root: string): boolean
}

/** The `path = ...` lines of a `.gitmodules` file (LF or CRLF). Bounded: a file this big is not a real one. */
async function readGitmodulePaths(root: string): Promise<string[]> {
  try {
    const text = await fsp.readFile(joinPath(root, '.gitmodules'), 'utf8')
    if (text.length > 256 * 1024) return []
    const out: string[] = []
    for (const m of text.matchAll(/^[ \t]*path[ \t]*=[ \t]*(.+?)[ \t\r]*$/gm)) out.push(m[1])
    return out
  } catch {
    return [] // no .gitmodules: nearly every repo
  }
}

export function createGitWatcherRegistry(deps: GitWatcherDeps): GitWatcherRegistry {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t))
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS
  const readSubmodules = deps.readSubmodulePaths ?? readGitmodulePaths
  const repos = new Map<string, RepoWatch>()

  function fire(root: string): void {
    try { deps.onChange(root) } catch { /* a listener must not take the watcher down */ }
  }

  function open(
    gate: RunGate,
    target: string,
    recursive: boolean,
    ignore: (name: string) => boolean,
    priority: boolean,
  ): FSWatcher | null {
    try {
      // persistent:false — a file watcher must never be the reason the process stays alive.
      return deps.watch(target, { recursive, persistent: false }, (_event, filename) => {
        if (filename) {
          const name = typeof filename === 'string' ? filename : filename.toString()
          if (ignore(name)) return
        }
        gate.note({ priority })
      })
    } catch {
      // ENOSPC (inotify limit), ENOENT (not a repo), EPERM, or a platform without recursive watch.
      // All of them mean the same thing here: this repo falls back to the slow poll. Not an error.
      return null
    }
  }

  return {
    add(root) {
      const existing = repos.get(root)
      if (existing) { existing.refs++; return }
      const filter = createIgnoreFilter({ root, probeNested: deps.probeNested })
      const gate = createRunGate({
        mode: 'leading',
        windowMs: throttleMs,
        setTimer,
        clearTimer: (t) => clearTimer(t as ReturnType<typeof setTimeout>),
        now: deps.now,
        label: `git ${root}`,
        log: deps.log,
        run: () => fire(root),
      })
      const watchers: FSWatcher[] = []
      // `.git` events are the low-volume ones that say the answer changed: they get priority.
      const gitDir = open(gate, joinPath(root, '.git'), true, isIgnoredGitPath, true)
      if (gitDir) watchers.push(gitDir)
      const tree = open(gate, root, true, (name) => filter.shouldIgnore(name), false)
      if (tree) watchers.push(tree)
      repos.set(root, { refs: 1, watchers, gate, filter })
      // Submodules stay watched. Asked once, async, and only matters once a nested repo is learned.
      void readSubmodules(root).then(
        (paths) => { if (repos.get(root)?.filter === filter) filter.setKeep(paths) },
        () => { /* no list: every nested repository is ignored */ },
      )
    },
    remove(root) {
      const w = repos.get(root)
      if (!w) return
      w.refs--
      if (w.refs > 0) return
      w.gate.dispose()
      w.filter.close()
      for (const fsw of w.watchers) { try { fsw.close() } catch { /* already closed */ } }
      repos.delete(root)
    },
    closeAll() {
      for (const root of [...repos.keys()]) {
        const w = repos.get(root)!
        w.refs = 1
        this.remove(root)
      }
    },
    watchedRoots() { return [...repos.keys()] },
    isWatching(root) { return (repos.get(root)?.watchers.length ?? 0) > 0 },
  }
}

/** Deliberately not `path.join`: the root is already absolute and in the platform's own spelling,
 *  so a child is only appended to it, in the separator it already uses. */
function joinPath(root: string, child: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return root.endsWith(sep) ? root + child : root + sep + child
}
