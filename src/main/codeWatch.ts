// codeWatch.ts — keep the code graph FRESH in real time (the CodeGraph-parity gap). Watches a
// repo for source-file changes and re-indexes after a short debounce, so edits are reflected in
// seconds instead of waiting for the 15-minute re-sweep.
//
// Native-free: uses Node's built-in fs.watch (recursive on Windows/macOS). Fully injectable — the
// watcher, the re-index action, and the timers are all passed in, so it's unit-tested without touching
// the filesystem or the clock. Ignores dependency/build dirs and non-source churn so it doesn't
// thrash on node_modules or log files.
//
// STORM GUARD (watchGuard.ts). This watcher sits on a repo ROOT, and David's roots contain
// `.worktrees/` where agent swarms edit thousands of files. Edits inside a nested git worktree or
// nested repository cannot change THIS repo's graph (`git ls-files` does not list them), so they are
// dropped before they cost anything; what is left is paced by one shared limiter: at most one
// re-index per debounce window, never two at once (the re-index is async and the gate waits for it),
// and a flood (> 200 events/s for 3 s) stops re-indexing, keeps a dirty flag and backs off 4 s .. 60 s
// before running once.

import { createIgnoreFilter, createRunGate } from './watchGuard'
import { scopedRecursiveWatch, CODE_SKIP_NAMES, type ScopedFsWatchFn } from './scopedWatch'

export interface RepoWatcher {
  close: () => void
}

export interface WatchHandle {
  close: () => void
}

export interface WatchDeps {
  /** Start an OS watch on `dir`, invoking the listener on each change. */
  watch: (dir: string, listener: (event: string, filename: string | null) => void) => WatchHandle
  /** Re-index the files that changed (update the code graph). Called at most once per debounce
   *  window, never while the previous call is still running (return its promise), with the set of
   *  source files that changed during it. An EMPTY list means "so many changed (or none could be
   *  named) that the whole repo must be re-swept". */
  reindex: (root: string, files: string[]) => void | Promise<unknown>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  debounceMs?: number
  /** Clock for the flood meter. Defaults to Date.now. */
  now?: () => number
  /** One line when a flood starts and one when it is over. */
  log?: (msg: string) => void
  /** Async: is this directory a nested repository (own .git) or a link? Defaults to lstat + stat. */
  probeNested?: (absDir: string) => Promise<boolean>
}

// Names that are not source of THIS repo beyond the shared list (watchGuard.ts): vendored Pods and the
// Turborepo cache (scopedWatch.ts). The shared list already covers node_modules, .git, .worktrees, dist,
// out, build, target, .venv, .next, coverage and the usual tool caches.
const EXTRA_IGNORED = CODE_SKIP_NAMES
// Only re-index when a SOURCE file (a language the graph understands) changes.
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|csx|rb|swift|tf|bicep)$/i
/** More distinct changed files than this in one window means a mass change (a checkout, a codegen):
 *  stop remembering names and re-sweep instead. Bounds the memory a storm can cost. */
const MAX_PENDING_FILES = 2048

/** Watch `root` and re-index (debounced) whenever a source file changes. Returns a disposer. */
export function watchRepo(root: string, deps: WatchDeps): RepoWatcher {
  const debounceMs = deps.debounceMs ?? 2000
  let handle: WatchHandle | null = null
  const changed = new Set<string>() // source files touched during the current debounce window
  let overflowed = false
  const filter = createIgnoreFilter({ root, names: EXTRA_IGNORED, probeNested: deps.probeNested })
  const gate = createRunGate({
    mode: 'trailing',
    windowMs: debounceMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    now: deps.now,
    label: `code index ${root}`,
    log: deps.log,
    run: () => {
      const files = overflowed ? [] : [...changed]
      changed.clear()
      overflowed = false
      try {
        return deps.reindex(root, files) // incremental: re-index only the files that changed
      } catch {
        return undefined /* best effort — a failed re-index leaves the last good graph in place */
      }
    },
  })
  try {
    handle = deps.watch(root, (event, filename) => {
      // A storm closed an OS watch (shedWatch.ts) and it is back: what changed meanwhile was not heard, so the
      // next run re-sweeps the whole repo instead of naming files.
      if (event === 'overflow') {
        overflowed = true
        gate.note()
        return
      }
      if (!filename) return
      const name = String(filename)
      // The filter first, on EVERY event: a `.git` event below the root is how it learns a nested repo.
      if (filter.shouldIgnore(name, event) || !SRC_EXT.test(name)) return // ignore noise + non-source churn
      if (changed.size < MAX_PENDING_FILES) changed.add(name)
      else overflowed = true
      gate.note()
    })
  } catch {
    handle = null // fs.watch can throw (e.g. no recursive support) — degrade to the periodic re-sweep
  }
  return {
    close: () => {
      gate.dispose()
      filter.close()
      changed.clear()
      try {
        handle?.close()
      } catch {
        /* best effort */
      }
    },
  }
}

// A process-wide registry so each open repo is watched at most once and all watches are torn
// down on quit. Kept here (not in index.ts) so the lifecycle is unit-tested.
const active = new Map<string, RepoWatcher>()

/** Start watching `root` if it isn't already. Returns true if a new watch was started. */
export function ensureRepoWatch(root: string, deps: WatchDeps): boolean {
  if (!root || active.has(root)) return false
  active.set(root, watchRepo(root, deps))
  return true
}

/** Stop and forget every active watch (call on app quit). */
export function stopRepoWatches(): void {
  for (const w of active.values()) {
    try {
      w.close()
    } catch {
      /* best effort */
    }
  }
  active.clear()
}

export function _activeWatchCountForTests(): number {
  return active.size
}
export function _resetWatchesForTests(): void {
  stopRepoWatches()
}

export interface FsWatchLike {
  close: () => void
}

/** Build real (fs-backed) WatchDeps — kept out of index.ts so the wiring is tested, not a dark
 *  corner of the entrypoint. `fsWatchFn` is Node's fs.watch; `reindex` rebuilds the code graph. */
export function fsBackedWatchDeps(
  fsWatchFn: (dir: string, opts: { recursive: boolean }, listener: (event: string, filename: string | null) => void) => FsWatchLike,
  reindex: (root: string, files: string[]) => void | Promise<unknown>,
  probeNested?: (absDir: string) => Promise<boolean>,
  /** Subscribe to the directories that matter instead of to the whole tree (scopedWatch.ts): nothing under
   *  `.worktrees`, `node_modules`, `dist` ... is ever delivered. What the app passes; off by default so
   *  the plain recursive shape stays what the function's own tests pin. */
  scoped = false,
): WatchDeps {
  return {
    watch: (dir, listener) => {
      if (scoped) {
        const s = scopedRecursiveWatch(fsWatchFn as unknown as ScopedFsWatchFn, dir, listener, { skipNames: CODE_SKIP_NAMES, log: (m) => console.warn(m) })
        return { close: () => s.close() }
      }
      const w = fsWatchFn(dir, { recursive: true }, listener)
      return { close: () => w.close() }
    },
    reindex,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    // console.warn reaches the in-app log (appLog.captureConsole), which is where a flood belongs.
    log: (msg) => console.warn(msg),
    probeNested,
  }
}
