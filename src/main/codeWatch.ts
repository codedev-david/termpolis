// codeWatch.ts — keep the code graph FRESH in real time (the CodeGraph-parity gap). Watches a
// repo for source-file changes and re-indexes after a short debounce, so edits are reflected in
// seconds instead of waiting for the 15-minute re-sweep.
//
// Native-free: uses Node's built-in fs.watch (recursive on Windows/macOS). Fully injectable — the
// watcher, the re-index action, and the timers are all passed in, so it's unit-tested without touching
// the filesystem or the clock. Ignores dependency/build dirs and non-source churn so it doesn't
// thrash on node_modules or log files.

export interface RepoWatcher {
  close: () => void
}

export interface WatchHandle {
  close: () => void
}

export interface WatchDeps {
  /** Start an OS watch on `dir`, invoking the listener on each change. */
  watch: (dir: string, listener: (event: string, filename: string | null) => void) => WatchHandle
  /** Re-index the repo (build the code graph). Called at most once per debounce window. */
  reindex: (root: string) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  debounceMs?: number
}

// Dependency / build / cache dirs whose churn should never trigger a re-index.
const IGNORE = /(^|[\\/])(node_modules|\.git|dist|out|build|target|\.venv|Pods|\.next|coverage|\.turbo)([\\/]|$)/i
// Only re-index when a SOURCE file (a language the graph understands) changes.
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|csx|rb|swift|tf|bicep)$/i

/** Watch `root` and re-index (debounced) whenever a source file changes. Returns a disposer. */
export function watchRepo(root: string, deps: WatchDeps): RepoWatcher {
  const debounceMs = deps.debounceMs ?? 2000
  let timer: unknown = null
  let handle: WatchHandle | null = null
  try {
    handle = deps.watch(root, (_event, filename) => {
      if (!filename) return
      const name = String(filename)
      if (IGNORE.test(name) || !SRC_EXT.test(name)) return // ignore noise + non-source churn
      if (timer) deps.clearTimer(timer)
      timer = deps.setTimer(() => {
        timer = null
        try {
          deps.reindex(root)
        } catch {
          /* best effort — a failed re-index leaves the last good graph in place */
        }
      }, debounceMs)
    })
  } catch {
    handle = null // fs.watch can throw (e.g. no recursive support) — degrade to the periodic re-sweep
  }
  return {
    close: () => {
      if (timer) {
        deps.clearTimer(timer)
        timer = null
      }
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
  reindex: (root: string) => void,
): WatchDeps {
  return {
    watch: (dir, listener) => {
      const w = fsWatchFn(dir, { recursive: true }, listener)
      return { close: () => w.close() }
    },
    reindex,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }
}
