// watchGuard.ts — the ONE ignore rule and the ONE run limiter every file watcher in the main process
// shares (codeWatch, gitWatcher, workflow/triggers, transcriptWatchers/baseWatcher).
//
// Why it exists. node-pty lives in the Electron main process, so every keystroke echo waits behind
// whatever else the main thread is doing. A watcher handler is exactly that "whatever else": it
// indexes, spawns git, or reads files. On David's laptop Defender makes one spawn cost 10-283 ms and
// one synchronous file call up to 1.5 s, and his Claude Code terminals sit at a repo root whose
// `.worktrees/` holds agent swarms editing thousands of files. A recursive watcher on that root fires
// for every one of those edits, so before this module a swarm could keep four handlers re-running
// for as long as it worked. Two things stop that, and they are deliberately separate:
//
//   1. IGNORE what is not this tree. A nested git worktree or nested repository (a directory that has
//      its own `.git`, file or folder) is another checkout: its edits cannot change this one's
//      status, index or graph. Neither can a dependency or build folder, or a symlink/junction that
//      leads out of the tree. `createIgnoreFilter` drops those events before they cost anything,
//      learning nested repositories with ASYNC probes (bounded concurrency, bounded queue, bounded
//      cache) so the filter itself never makes a synchronous fs call.
//
//   2. PACE what is left. `createRunGate` coalesces events so a root's handler starts at most once per
//      window (2 s in production), never runs twice at once, and, when more than 200 events/s arrive
//      for 3 s in a row, stops running handlers, keeps a dirty flag, backs off 4 s, 8 s, ... up to
//      60 s and then runs ONCE. Per-event work is O(1) and creates no timer, so a 100,000-event storm
//      costs counters, not timers or syscalls.
//
// Nothing here spawns a process or touches the disk synchronously. Everything external (timers, the
// clock, the probe) is injectable, so the whole policy is unit-tested with counters and fake clocks.

import { promises as fsp } from 'fs'
import { join, sep } from 'path'

/** A root's handler starts at most this often. The production value every watcher passes. */
export const WATCH_MIN_INTERVAL_MS = 2000
/** "More than this many events in a second ..." */
export const FLOOD_EVENTS_PER_SECOND = 200
/** "... for this many seconds in a row is a flood." */
export const FLOOD_SECONDS = 3
/** First back-off while flooding; doubles each time it expires with the flood still on. */
export const FLOOD_BACKOFF_BASE_MS = 4000
export const FLOOD_BACKOFF_MAX_MS = 60_000
/** A handler that has not settled after this long is abandoned so one hung promise cannot silence a
 *  root for the rest of the session. */
export const RUN_TIMEOUT_MS = 10 * 60_000

// ── the ignore rule ───────────────────────────────────────────────────────────────────────────

/** Directory NAMES whose churn says nothing about the tree being watched. Lower case: matching is
 *  case-insensitive on every platform (a `Node_Modules` is not worth telling apart). */
const BASE_IGNORED_DIRS: readonly string[] = [
  // The repository's own metadata. gitWatcher has a dedicated, filtered watch on it.
  '.git',
  // Nested checkouts: where agent swarms and Claude Code Workflows edit thousands of files.
  '.worktrees',
  // Dependencies and build output.
  'node_modules', 'dist', 'out', 'build', 'target', 'coverage',
  '.venv', '__pycache__', '.next', '.nuxt', '.turbo', '.parcel-cache', '.svelte-kit', '.angular', '.gradle',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  // An IDE cache that rewrites binary files continuously while the IDE is open.
  '.vs',
]

const BASE_NAMES: ReadonlySet<string> = new Set(BASE_IGNORED_DIRS)

/** `a\b\c`, `./a/b`, `/a/b` -> `a/b/c`, `a/b`, `a/b`. */
function toSlashes(rel: string): string {
  const s = rel.indexOf('\\') === -1 ? rel : rel.replace(/\\/g, '/')
  return s.replace(/^(?:\.?\/)+/, '')
}

/** Start index of the first ignored directory name in an already lower-cased, slash-normalised
 *  path, or -1. `.claude/worktrees` (where Claude Code puts its worktrees) counts as one name. */
function firstIgnoredSegment(lower: string, names: ReadonlySet<string>): number {
  let start = 0
  let prev = ''
  for (;;) {
    const j = lower.indexOf('/', start)
    const end = j === -1 ? lower.length : j
    if (end > start) {
      const seg = lower.slice(start, end)
      if (names.has(seg) || (seg === 'worktrees' && prev === '.claude')) return start
      prev = seg
    }
    if (j === -1) return -1
    start = j + 1
  }
}

/** The pure name rule, with no learning and no I/O: does any directory name on this event path say
 *  "not this tree"? `extra` adds names for one watcher (e.g. `.termpolis`). */
export function isIgnoredWatchPath(rel: string, extra?: Iterable<string>): boolean {
  const lower = toSlashes(rel).toLowerCase()
  if (!lower) return false
  if (!extra) return firstIgnoredSegment(lower, BASE_NAMES) !== -1
  const names = new Set(BASE_NAMES)
  for (const n of extra) names.add(n.toLowerCase())
  return firstIgnoredSegment(lower, names) !== -1
}

/** Does this directory hold its own `.git` (file OR folder: a worktree's is a file) or is it a link
 *  (symlink or Windows junction) that leads somewhere else? Async on purpose. */
export async function probeNestedRepo(absDir: string): Promise<boolean> {
  try {
    if ((await fsp.lstat(absDir)).isSymbolicLink()) return true
  } catch {
    return false // gone, or unreadable: treat as an ordinary directory and look again later
  }
  try {
    await fsp.stat(join(absDir, '.git'))
    return true
  } catch {
    return false
  }
}

export interface IgnoreFilterOptions {
  /** The watched root. Event names are relative to it. */
  root: string
  /** Extra directory names to ignore for this watcher (any case). */
  names?: Iterable<string>
  /** Is this directory a nested repository or a link? Default: lstat + stat(.git), both async. */
  probeNested?: (absDir: string) => Promise<boolean>
  /** Windows and macOS file systems are case-insensitive; Linux is not. Default: by platform. */
  caseInsensitive?: boolean
  /** Clock for the cache TTL. */
  now?: () => number
  /** How long a probe result is trusted before it is quietly re-checked (a repo can be deleted). */
  ttlMs?: number
  maxCache?: number
  /** Probes waiting for a slot; past this an unknown directory is simply let through. */
  maxQueue?: number
  /** Probes in flight at once. */
  concurrency?: number
  /** Called once each time a directory is learned to be a nested repository or link. */
  onLearn?: (relDir: string) => void
}

export interface IgnoreFilterStats {
  probes: number
  learned: number
  dropped: number
  queued: number
  active: number
  cached: number
}

export interface IgnoreFilter {
  /** True when this event is not about this tree and must be dropped. Synchronous and cheap; may
   *  start a background probe for a directory it has not seen. `event` is fs.watch's event type: a
   *  `rename` on a directory entry (created, removed, renamed) makes the filter forget what it knew
   *  about it, while a `change` on a nested repository's own entry (a child came or went inside it)
   *  is that repository's business, not ours. */
  shouldIgnore(rel: string | null | undefined, event?: string): boolean
  /** Directories (relative, any case) that are nested repositories but must STAY watched: git
   *  submodules, whose dirty state is part of the parent's `git status`. */
  setKeep(dirs: Iterable<string>): void
  /** Forget everything and discard probes still in flight. */
  close(): void
  readonly stats: IgnoreFilterStats
}

export function createIgnoreFilter(o: IgnoreFilterOptions): IgnoreFilter {
  const ci = o.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')
  const names = new Set<string>(BASE_NAMES)
  for (const n of o.names ?? []) names.add(n.toLowerCase())
  const probe = o.probeNested ?? probeNestedRepo
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 10 * 60_000
  const maxCache = o.maxCache ?? 4096
  const maxQueue = o.maxQueue ?? 64
  const concurrency = o.concurrency ?? 4
  /** dir (relative, normalised key) -> was it a nested repo/link when last asked, and when. */
  const kinds = new Map<string, { nested: boolean; at: number }>()
  /** dirname of an event path -> the settled answer, so a repeat event costs one Map lookup. */
  const verdicts = new Map<string, { ignore: boolean; at: number }>()
  const queued = new Set<string>() // waiting or in flight, so a directory is never asked twice at once
  const queue: string[] = []
  /** key -> the directory spelled as the OS gave it (the cache key is lower-cased where the disk is
   *  case-insensitive, but a macOS volume can be case-sensitive, so the probe is asked in the real case). */
  const spelled = new Map<string, string>()
  let keep: ReadonlySet<string> = new Set()
  let active = 0
  let closed = false
  const stats = { probes: 0, learned: 0, dropped: 0 }

  const keyOf = (s: string, lower: string): string => (ci || lower.length !== s.length ? lower : s)
  /** The first `n` slash-separated segments of `s`, spelled as the OS gave them: what a probe asks the disk about. */
  const spellPrefix = (s: string, n: number): string => {
    let end = -1
    for (let i = 0; i < n; i++) end = s.indexOf('/', end + 1)
    return end === -1 ? s : s.slice(0, end)
  }
  const absOf = (key: string): string => (o.root.endsWith(sep) ? o.root : o.root + sep) + key.split('/').join(sep)

  function invalidate(prefix: string): void {
    const under = prefix + '/'
    for (const k of verdicts.keys()) if (k === prefix || k.startsWith(under)) verdicts.delete(k)
  }

  function evict(): void {
    // Ordinary directories are the cheap ones to ask again; keep what was learned.
    let drop = Math.ceil(maxCache / 2)
    for (const [k, v] of kinds) {
      if (drop <= 0) break
      if (!v.nested) { kinds.delete(k); drop-- }
    }
    for (const k of kinds.keys()) {
      if (drop <= 0) break
      kinds.delete(k)
      drop--
    }
  }

  function setKind(key: string, nested: boolean): boolean {
    const prev = kinds.get(key)
    if (!prev && kinds.size >= maxCache) evict()
    kinds.set(key, { nested, at: now() })
    return !!prev && prev.nested !== nested
  }

  function learn(key: string): void {
    if (closed || !key) return
    const known = kinds.get(key)
    if (known?.nested) { known.at = now(); return }
    setKind(key, true)
    invalidate(key)
    stats.learned++
    o.onLearn?.(key)
  }

  function settle(key: string, nested: boolean): void {
    active--
    queued.delete(key)
    spelled.delete(key)
    if (!closed) {
      const changed = setKind(key, nested)
      if (nested && !changed) { stats.learned++; o.onLearn?.(key) }
      if (nested || changed) invalidate(key)
    }
    pump()
  }

  function pump(): void {
    while (!closed && active < concurrency && queue.length > 0) {
      const key = queue.shift() as string
      active++
      stats.probes++
      let p: Promise<boolean>
      try {
        p = Promise.resolve(probe(absOf(spelled.get(key) ?? key)))
      } catch {
        p = Promise.resolve(false)
      }
      void p.then((nested) => settle(key, nested === true), () => settle(key, false))
    }
  }

  function request(key: string, rel: string, segments: number): void {
    if (closed || queued.has(key)) return
    if (queue.length >= maxQueue) { stats.dropped++; return }
    queued.add(key)
    spelled.set(key, spellPrefix(rel, segments))
    queue.push(key)
    pump()
  }

  function remember(dir: string, ignore: boolean): void {
    if (verdicts.size >= maxCache) {
      let drop = Math.ceil(maxCache / 2)
      for (const k of verdicts.keys()) {
        if (drop-- <= 0) break
        verdicts.delete(k)
      }
    }
    verdicts.set(dir, { ignore, at: now() })
  }

  return {
    shouldIgnore(rel, event) {
      if (!rel) return false
      const s = toSlashes(String(rel))
      if (!s) return false
      const lower = s.toLowerCase()

      // 1. A directory name that says "not this tree". A `.git` below the root also TEACHES us: the
      //    directory that holds it is a nested repository, known without asking the disk.
      const hit = firstIgnoredSegment(lower, names)
      if (hit !== -1) {
        if (hit > 0 && lower.startsWith('.git', hit) && (lower.length === hit + 4 || lower.charCodeAt(hit + 4) === 47)) {
          learn(keyOf(s, lower).slice(0, hit - 1))
        }
        return true
      }

      const key = keyOf(s, lower)
      // An event for a directory ENTRY we know something about.
      const own = kinds.get(key)
      if (own) {
        // `change` on a nested repository's own entry is only its modification time moving because
        // something INSIDE it changed (Windows reports that for the directory and its parents). That
        // is the nested repository's business, and it must not make us forget what we know about it:
        // doing so let every other event through while the probe was out again.
        if (event === 'change' && own.nested && !keep.has(key)) return true
        // Anything else (`rename`: created, removed, renamed; or no type given): what we knew may no
        // longer be true, so forget it and let the next event below it ask again.
        if (event !== 'change') { kinds.delete(key); invalidate(key) }
      }

      // 2. A nested repository or link somewhere on the way down.
      const lastSlash = key.lastIndexOf('/')
      if (lastSlash <= 0) return false // a file directly under the root: no directory to ask about
      const dir = key.slice(0, lastSlash)
      const cached = verdicts.get(dir)
      // A remembered answer is only as good as the probes behind it: past the TTL, work it out again
      // (which serves the old probe answers while it re-asks), so a deleted repo is noticed.
      if (cached !== undefined) {
        if (now() - cached.at <= ttl) return cached.ignore
        verdicts.delete(dir)
      }
      let unresolved = false
      let segments = 0
      let p = key.indexOf('/')
      while (p !== -1 && p <= lastSlash) {
        segments++
        const prefix = key.slice(0, p)
        const k = kinds.get(prefix)
        if (k === undefined) {
          unresolved = true
          request(prefix, s, segments)
        } else {
          if (now() - k.at > ttl) request(prefix, s, segments) // stale: answer with what we know, re-check quietly
          if (k.nested && !keep.has(prefix)) {
            remember(dir, true)
            return true
          }
        }
        p = key.indexOf('/', p + 1)
      }
      // Optimistic while a probe is out: letting one event through is cheap, dropping a real change
      // is the failure this module must not have. Settled only when every directory has an answer.
      if (!unresolved) remember(dir, false)
      return false
    },
    setKeep(dirs) {
      const next = new Set<string>()
      for (const d of dirs) {
        const s = toSlashes(String(d)).replace(/\/+$/, '')
        if (s) next.add(ci ? s.toLowerCase() : s)
      }
      keep = next
      verdicts.clear()
    },
    close() {
      closed = true
      queue.length = 0
      queued.clear()
      spelled.clear()
      kinds.clear()
      verdicts.clear()
    },
    get stats(): IgnoreFilterStats {
      return { ...stats, queued: queue.length, active, cached: kinds.size }
    },
  }
}

// ── the run limiter ───────────────────────────────────────────────────────────────────────────

/** Counts events in tumbling one-second buckets and decides "flooding": more than `threshold` events
 *  in each of `needHot` seconds in a row. Evaluated lazily when an event arrives, so it needs no
 *  timer of its own. Leaves the state after two calm seconds or one second of silence. */
class FloodMeter {
  flooding = false
  private start = -1
  private count = 0
  private hotRun = 0
  private calmRun = 0
  private last = -1

  constructor(private readonly threshold: number, private readonly needHot: number) {}

  tick(t: number): void {
    if (this.start < 0) {
      this.start = t
      this.count = 1
      this.last = t
      return
    }
    const elapsed = t - this.start
    if (elapsed >= 1000) {
      if (elapsed >= 2000) {
        // A whole quiet second sits between the last bucket and this event: the run is broken.
        this.hotRun = 0
        this.calmRun = 0
        this.flooding = false
      } else if (this.count > this.threshold) {
        this.hotRun++
        this.calmRun = 0
        if (this.hotRun >= this.needHot) this.flooding = true
      } else {
        this.hotRun = 0
        if (this.flooding && ++this.calmRun >= 2) {
          this.flooding = false
          this.calmRun = 0
        }
      }
      this.start = t
      this.count = 0
    }
    this.count++
    this.last = t
  }

  /** Still flooding right now (events within the last two seconds)? */
  hot(t: number): boolean {
    return this.flooding && t - this.last < 2000
  }

  reset(): void {
    this.flooding = false
    this.start = -1
    this.count = 0
    this.hotRun = 0
    this.calmRun = 0
    this.last = -1
  }
}

// ── the governor's switch ─────────────────────────────────────────────────────────────────────
// The main-thread event-loop governor (SHED mode) must be able to say "background work stops now"
// without knowing which watcher owns which gate. Every live gate registers here; one call pauses or
// resumes them all, and a gate created while paused starts paused.
const liveGates = new Set<{ pause(): void; resume(): void }>()
let allPaused = false

/** Pause (true) or resume (false) EVERY run gate in the process. Idempotent. While paused no watcher
 *  starts a handler (re-index, repaint, trigger pass, transcript read); events are counted and the
 *  gate remembers that something arrived, so resuming runs each handler once, not once per event. */
export function setWatchGatesPaused(paused: boolean): void {
  if (allPaused === paused) return
  allPaused = paused
  for (const g of [...liveGates]) {
    if (paused) g.pause()
    else g.resume()
  }
}

export function watchGatesPaused(): boolean {
  return allPaused
}

/** Gates currently alive (created and not disposed): what the governor would pause. */
export function liveWatchGateCount(): number {
  return liveGates.size
}

export interface RunGateOptions {
  /** The work. If it returns a promise the gate starts nothing else until that settles. */
  run: () => unknown
  /** `leading`: the first event after quiet runs at once and the rest of the window collapses into
   *  ONE trailing run (what a git status repaint wants). `trailing`: the first event arms a timer
   *  for `windowMs` and the run happens when it fires (what an indexer wants). */
  mode: 'leading' | 'trailing'
  windowMs: number | (() => number)
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** Clock for the flood meter and the hung-run watchdog ONLY. Pacing itself is driven by timers, so
   *  a test that injects timers and no clock still sees the window behave. */
  now?: () => number
  floodEventsPerSecond?: number
  floodSeconds?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  runTimeoutMs?: number
  /** Names the root in the two log lines (flood started / flood over). */
  label?: string
  log?: (msg: string) => void
}

export interface RunGate {
  /** A watcher event. `priority` marks the low-volume events that must not wait out a flood's
   *  back-off (a ref moved in `.git`); they are still held to one run per window and they do not
   *  get this privilege while THEIR OWN stream is flooding. */
  note(opts?: { priority?: boolean }): void
  /** A poll or safety-net request: "check once". Marks the gate dirty without counting as an event. */
  poke(): void
  /** Stop starting handlers (timers are cancelled, events still count and mark the gate dirty). A
   *  handler already running is left to finish. Used by the event-loop governor, see setWatchGatesPaused. */
  pause(): void
  /** Start again: if anything arrived meanwhile the handler runs ONCE, no sooner than one window
   *  after the previous run started. */
  resume(): void
  dispose(): void
  readonly paused: boolean
  readonly flooding: boolean
  readonly running: boolean
  readonly runs: number
}

type TimerKind = 'window' | 'backoff' | 'priority'

export function createRunGate(o: RunGateOptions): RunGate {
  const setT = o.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearT = o.clearTimer ?? ((t: unknown): void => clearTimeout(t as ReturnType<typeof setTimeout>))
  const now = o.now ?? Date.now
  const windowMs = (): number => Math.max(0, typeof o.windowMs === 'function' ? o.windowMs() : o.windowMs)
  const base = o.backoffBaseMs ?? FLOOD_BACKOFF_BASE_MS
  const cap = o.backoffMaxMs ?? FLOOD_BACKOFF_MAX_MS
  const runTimeout = o.runTimeoutMs ?? RUN_TIMEOUT_MS
  const threshold = o.floodEventsPerSecond ?? FLOOD_EVENTS_PER_SECOND
  const needHot = o.floodSeconds ?? FLOOD_SECONDS
  const meters = [new FloodMeter(threshold, needHot), new FloodMeter(threshold, needHot)]
  const label = o.label ?? 'watcher'

  let timer: unknown = null
  let timerKind: TimerKind | null = null
  let running = false
  let runSeq = 0
  let runStartedAt = -Infinity
  let dirty = false
  let disposed = false
  let paused = allPaused
  let floodActive = false
  let backoffMs = base
  let runs = 0

  const flooding = (): boolean => meters[0].flooding || meters[1].flooding

  function arm(kind: TimerKind, ms: number, fn: () => void): void {
    timerKind = kind
    timer = setT(fn, ms)
  }

  function clear(): void {
    if (timer !== null) clearT(timer)
    timer = null
    timerKind = null
  }

  function say(msg: string): void {
    try { o.log?.(msg) } catch { /* a logger must not take the gate down */ }
  }

  function startFlood(): void {
    floodActive = true
    say(`[watch] flood on ${label}: more than ${threshold} events/s for ${needHot} s. Handlers paused; one run in ${Math.round(backoffMs / 1000)} s, then the wait doubles up to ${Math.round(cap / 1000)} s while it lasts`)
  }

  function endFlood(): void {
    floodActive = false
    backoffMs = base
    meters[0].reset()
    meters[1].reset()
    say(`[watch] flood over on ${label}: handlers resumed`)
  }

  /** Start the handler. Everything that must happen AFTER it (the window, a follow-up) is the
   *  caller's, because a handler that calls back into note() must not re-enter itself. */
  function runNow(): void {
    dirty = false
    running = true
    const seq = ++runSeq
    runStartedAt = now()
    runs++
    let result: unknown
    try {
      result = o.run()
    } catch {
      result = undefined // a throwing handler is that run's failure, not the gate's
    }
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      const finish = (): void => {
        if (seq !== runSeq || disposed) return // abandoned as hung, or the gate is gone
        running = false
        if (dirty) schedule()
      }
      ;(result as PromiseLike<unknown>).then(finish, finish)
    } else {
      running = false
    }
  }

  /** After a synchronous run: open the window (leading) or re-arm for what arrived meanwhile. */
  function afterRun(): void {
    if (o.mode === 'leading') startWindow()
    else if (!running && dirty) schedule()
  }

  function startWindow(): void {
    if (paused) return
    clear()
    arm('window', windowMs(), onTimer)
  }

  /** How much of the window since the last run START is still left. Only the back-off and priority
   *  paths need it: a window or debounce timer already encodes the gap in its own delay. */
  const gapLeft = (): number => windowMs() - (now() - runStartedAt)

  function onTimer(): void {
    const kind = timerKind
    timer = null
    timerKind = null
    if (disposed || running) return // a running handler's completion reschedules
    if (kind === 'backoff' || kind === 'priority') {
      const wait = gapLeft()
      if (wait > 0) {
        // Another run slipped in since this was armed (an expedited one): keep the once-per-window rule.
        arm(kind, wait, onTimer)
        return
      }
    }
    if (kind === 'backoff') {
      // "Then runs once." Is the flood still on? Then wait longer next time; otherwise it is over.
      const t = now()
      const hot = meters[0].hot(t) || meters[1].hot(t)
      runNow()
      if (hot) backoffMs = Math.min(backoffMs * 2, cap)
      else endFlood()
      afterRun()
      return
    }
    if (kind === 'priority') {
      runNow()
      afterRun()
      return
    }
    // A window closed.
    if (o.mode === 'trailing') {
      runNow()
      afterRun()
    } else if (dirty) {
      schedule()
    }
  }

  function armBackoff(expedite: boolean): void {
    if (!floodActive) startFlood()
    if (timerKind === 'priority') return // one is already on its way
    if (expedite) {
      // A ref moved while the tree is flooding: do not make that wait out a 60 s back-off. It still
      // waits for the window to pass since the last run, so the once-per-window rule holds.
      clear()
      const wait = gapLeft()
      if (wait <= 0) {
        runNow()
        afterRun()
      } else {
        arm('priority', wait, onTimer)
      }
      return
    }
    if (timerKind === 'backoff') return
    clear() // a window that was open when the flood began: handlers stop for the flood
    arm('backoff', backoffMs, onTimer)
  }

  function schedule(expedite = false): void {
    if (disposed || paused) return
    if (running) {
      if (now() - runStartedAt <= runTimeout) return
      running = false // hung: abandon it so this root can run again
      runSeq++
      say(`[watch] a handler on ${label} has not finished in ${Math.round(runTimeout / 1000)} s; abandoning it`)
    }
    if (flooding()) {
      armBackoff(expedite)
      return
    }
    if (floodActive) endFlood()
    if (timer !== null) {
      if (timerKind !== 'backoff') return // a window or debounce is already pending: coalesce
      clear() // the flood that armed this back-off is over: pace normally again ...
      const wait = gapLeft()
      if (wait > 0) {
        arm('window', wait, onTimer) // ... but not sooner than one window after the last run started
        return
      }
    }
    if (o.mode === 'leading') {
      runNow()
      afterRun()
    } else {
      arm('window', windowMs(), onTimer)
    }
  }

  function pause(): void {
    if (paused || disposed) return
    paused = true
    clear() // a window, a back-off or a priority timer: none of them may start a handler now
  }

  function resume(): void {
    if (!paused || disposed) return
    paused = false
    if (!dirty || running) return // nothing arrived, or the running handler's completion reschedules
    const wait = gapLeft()
    if (wait > 0 && !flooding()) {
      arm('window', wait, onTimer) // once per window holds across a pause too
      return
    }
    schedule()
  }

  const control = { pause, resume }
  liveGates.add(control)

  return {
    note(opts) {
      if (disposed) return
      const priority = opts?.priority === true
      meters[priority ? 1 : 0].tick(now())
      dirty = true
      if (paused) return
      schedule(priority && !meters[1].flooding)
    },
    poke() {
      if (disposed) return
      dirty = true
      if (paused) return
      schedule()
    },
    pause,
    resume,
    dispose() {
      disposed = true
      dirty = false
      liveGates.delete(control)
      clear()
    },
    get paused(): boolean { return paused },
    get flooding(): boolean { return flooding() },
    get running(): boolean { return running },
    get runs(): number { return runs },
  }
}
