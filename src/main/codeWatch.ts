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
//
// NEW DIRECTORIES. The scoped watch subscribes a directory a moment after it appears, so a file written
// in that instant (`mkdir -p src/payments` then `src/payments/index.ts`, what an agent does) raises no
// event of its own: the directory's `rename` is all that is heard. Such a name is listed when the
// re-index runs (`listSources`, async, bounded), and the source files already in it join the run.

import { promises as fsp, type Dirent } from 'fs'
import { join } from 'path'
import { CASE_FOLDING_PLATFORMS, createIgnoreFilter, createRunGate, makeNameRule } from './watchGuard'
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
  /** Async: the source files (relative to `absDir`, slash-separated) already inside a name that just
   *  appeared; rejects when it is not a directory. Without it, a new directory is not listed. */
  listSources?: (absDir: string) => Promise<string[]>
  /** The nested repositories (relative, slash-separated) the last listing mapped: their edits refresh the map as the
   *  root's do, instead of being dropped as another tree's. Asked when the watch starts, when a nested repository is
   *  learned, at the start of every run and again when it is done (a full re-sweep relists); applied only when it
   *  changed. A nested repository learned that it does not hold (a fresh clone) asks for one full re-sweep, once per
   *  folder, so its listing can map it. Without it, every nested repository stays out. */
  nestedKept?: () => Iterable<string>
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
/** Names that appeared (maybe directories) remembered per window; more are not listed. */
const MAX_APPEARED = 256
/** Directories one listing reads at most. */
const MAX_LIST_DIRS = 4096
/** HOLD-B #87 (WP1 F2): full re-sweeps for learned nested repositories that may map nothing new, per watch. git never lists a
 *  folder its .gitignore covers, so a repository there never reaches the listing and its re-sweep is spent for nothing: a
 *  .cache/ of 40 clones asked for 40 full re-sweeps of a big repository. Past this many, a learned repository asks for none
 *  (the 15-minute re-sweep and the next open still map it). One whose re-sweep mapped it, or one that failed, is not counted. */
export const MAX_IDLE_RESWEEPS = 3
const skippedDir = makeNameRule(CODE_SKIP_NAMES)

/** The source files below `dir` (relative, slash-separated), at most `limit`, never descending into an
 *  ignored directory (node_modules, .git, dist ...). Rejects when `dir` itself cannot be read (not a
 *  directory); a subdirectory that cannot be read is skipped. Async readdir only. */
export async function listSourceFiles(
  dir: string,
  limit = MAX_PENDING_FILES + 1,
  readDir: (p: string) => Promise<Dirent[]> = (p) => fsp.readdir(p, { withFileTypes: true }),
): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  let visited = 0
  while (queue.length > 0 && out.length < limit && visited < MAX_LIST_DIRS) {
    const rel = queue.shift() as string
    visited++
    let entries: Dirent[]
    try {
      entries = await readDir(rel ? join(dir, rel) : dir)
    } catch (e) {
      if (!rel) throw e
      continue
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!skippedDir(e.name)) queue.push(r)
      } else if (e.isFile() && SRC_EXT.test(e.name)) {
        out.push(r)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

/**
 * The re-index window: a change after quiet is re-indexed this long after it is first heard. Short enough
 * that a live world shows a saved file within about a second and a half (the world recompiles straight
 * after). Busy editing is paced by CODE_WATCH_GAP_MS and a storm by the flood guard, not by this window.
 */
export const CODE_WATCH_MS = 500
/** The least time between two re-index starts by default: a busy session re-indexes no more often than it
 *  did before the window shrank. */
export const CODE_WATCH_GAP_MS = 2000

/** Watch `root` and re-index (debounced) whenever a source file changes. Returns a disposer. */
export function watchRepo(root: string, deps: WatchDeps): RepoWatcher {
  const debounceMs = deps.debounceMs ?? CODE_WATCH_MS
  // A caller that sets its own window is paced by it alone, as before.
  const minGapMs = deps.debounceMs === undefined ? CODE_WATCH_GAP_MS : debounceMs
  let handle: WatchHandle | null = null
  const changed = new Set<string>() // source files touched during the current debounce window
  const appeared = new Set<string>() // non-source names renamed in (maybe new directories), to list
  let overflowed = false
  let closed = false
  const reindex = (files: string[]): unknown => {
    try {
      return deps.reindex(root, files) // incremental: re-index only the files that changed
    } catch {
      return undefined /* best effort — a failed re-index leaves the last good graph in place */
    }
  }
  /** The run once the appeared names are listed: what they hold joins the named files. */
  const listThenReindex = async (named: string[], names: string[], list: (absDir: string) => Promise<string[]>): Promise<unknown> => {
    const found = new Set(named)
    let mass = false
    for (const name of names) {
      let inside: string[]
      try {
        inside = await list(join(root, name))
      } catch {
        continue // not a directory (or gone): nothing to add
      }
      for (const f of inside) {
        const rel = join(name, f)
        if (!SRC_EXT.test(f) || filter.shouldIgnore(rel, 'rename')) continue
        found.add(rel)
        if (found.size > MAX_PENDING_FILES) { mass = true; break }
      }
      if (mass) break
    }
    if (closed || (!mass && found.size === 0)) return undefined
    return reindex(mass ? [] : [...found])
  }
  let keptSig = ''
  const foldCase = CASE_FOLDING_PLATFORMS.has(process.platform)
  const keyOf = (dir: string): string => (foldCase ? dir.toLowerCase() : dir)
  let keptKeys: ReadonlySet<string> = new Set()
  /** Re-reads the nested repositories the listing mapped and hands them to the filter when they changed. False when
   *  there is no list to read. */
  const refreshKept = (): boolean => {
    if (!deps.nestedKept) return false
    let dirs: string[]
    try {
      dirs = [...deps.nestedKept()].sort()
    } catch {
      return false // best effort: what the filter already keeps stays as it was
    }
    const sig = dirs.join('\n')
    if (sig === keptSig) return true
    keptSig = sig
    keptKeys = new Set(dirs.map(keyOf))
    filter.setKeep(dirs)
    return true
  }
  /** Nested repositories a re-sweep was already asked for: one each, however often they are learned again. */
  const resweepAsked = new Set<string>()
  /** The repositories the next full re-sweep is asked for, and how many re-sweeps mapped none of theirs. */
  const awaiting = new Set<string>()
  let idleResweeps = 0
  let resweep = false
  const onLearn = (dir: string): void => {
    if (idleResweeps >= MAX_IDLE_RESWEEPS || !refreshKept()) return
    const key = keyOf(dir)
    if (keptKeys.has(key) || resweepAsked.has(key)) return
    resweepAsked.add(key)
    awaiting.add(key)
    resweep = true
    gate.note()
  }
  /** After a re-sweep that ran (and relisted), whether the listing now maps any repository it was asked for. */
  const tally = (asked: readonly string[]): void => {
    if (asked.length > 0 && !asked.some((key) => keptKeys.has(key))) idleResweeps++
  }
  const filter = createIgnoreFilter({ root, names: EXTRA_IGNORED, probeNested: deps.probeNested, onLearn })
  refreshKept()
  const gate = createRunGate({
    mode: 'trailing',
    windowMs: debounceMs,
    minGapMs,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    now: deps.now,
    label: `code index ${root}`,
    log: deps.log,
    run: () => {
      refreshKept()
      const all = overflowed || resweep
      const asked = resweep ? [...awaiting] : []
      awaiting.clear()
      const files = all ? [] : [...changed]
      const names = all ? [] : [...appeared]
      changed.clear()
      appeared.clear()
      overflowed = false
      resweep = false
      const done = names.length > 0 && deps.listSources ? listThenReindex(files, names, deps.listSources) : reindex(files)
      // A full re-sweep relists the repository: what it now maps is kept from the next event on, not the next run.
      if (done instanceof Promise) {
        return done.then(
          (got) => { refreshKept(); tally(asked); return got },
          (err: unknown) => { refreshKept(); throw err },
        )
      }
      refreshKept()
      tally(asked)
      return done
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
      if (filter.shouldIgnore(name, event)) return // ignore noise
      if (!SRC_EXT.test(name)) {
        // Non-source churn, except a name renamed in: maybe a new directory with files already in it.
        if (event === 'rename' && deps.listSources && appeared.size < MAX_APPEARED) {
          appeared.add(name)
          gate.note()
        }
        return
      }
      if (changed.size < MAX_PENDING_FILES) changed.add(name)
      else overflowed = true
      gate.note()
    })
  } catch {
    handle = null // fs.watch can throw (e.g. no recursive support) — degrade to the periodic re-sweep
  }
  return {
    close: () => {
      closed = true
      gate.dispose()
      filter.close()
      changed.clear()
      appeared.clear()
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

/** Stop and forget the watch on `root` (a removed Build it folder). Returns true if one was running. */
export function stopRepoWatch(root: string): boolean {
  const w = active.get(root)
  if (!w) return false
  active.delete(root)
  try {
    w.close()
  } catch {
    /* best effort */
  }
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
    listSources: (absDir) => listSourceFiles(absDir),
  }
}
