// scopedWatch.ts — subscribe to the parts of a tree that matter, not to the tree.
//
// WHY. A recursive fs.watch on a repo root hands EVERY change below it to JavaScript, wanted or not, and
// on this platform that is expensive: measured on David's laptop (Windows 11, Defender on), 7,284
// delivered events cost the watching thread 13,047 ms of its own CPU (1.79 ms per event) while a worker
// wrote 20,000 files into `.worktrees/`, against 16 ms when the same writes landed in a subtree that was
// simply not subscribed. His repo roots contain `.worktrees/`, where agent swarms write thousands of
// files, and `npm install`, builds and test runs do the same in node_modules, dist, target and
// coverage. A JavaScript filter (watchGuard.createIgnoreFilter) drops those events, but only AFTER the
// operating system delivered them and Node paid for them, on the very thread that echoes keystrokes.
// So the subtrees nobody wants are not subscribed at all.
//
// HOW. The root is watched NON-recursively (its own children: files, and directories coming and going)
// and every real directory directly below it that is not ignored by name gets its own recursive watch.
// Events from a sub-watch are re-prefixed with the directory's name, so a listener sees exactly the
// names a single recursive watch of the root would have reported, minus the ignored subtrees. Directories
// named in `expandNames` (default `.claude`, where Claude Code puts `worktrees/`) are scoped one level
// further, because a name rule that lives below the top level (`.claude/worktrees`) cannot be applied
// to a watch of `.claude` as a whole.
//
// STORMS IN WHAT IS LEFT. Every OS watch it opens is a shedding watch (shedWatch.ts): more than 200
// events in a second and that one watch is closed for 4 s (then 8, 16, 32, 60), and when it is reopened
// the listener gets one synthetic `overflow` event for it ("something changed in here, look again"). A
// flat build output directory (`dist/`, `node_modules/` as `npm install` fills it) still makes the
// non-recursive root watch deliver `change` events for its own entry, one per file created, and a
// codegen can flood a directory that IS wanted; neither can cost more than a few hundred events an attempt.
//
// WHAT IT KEEPS. A directory that appears later is noticed from the root's own `rename` event, looked at
// with an async lstat (at most 32 in flight) and subscribed; one synthetic `rename` for it is delivered
// once the subscription is open, so a file created in the instant before it counts. A `rename` for a
// name that is already watched is looked at too, by identity: a directory renamed away keeps its handle
// (Windows follows the directory, not the name), so the old watch would go on reporting the renamed
// directory's files under the OLD name; it is closed and the name is subscribed afresh. A watched
// directory that is deleted (Windows may report EPERM and close the handle) is dropped, and looked at
// again in case it came straight back. Links and junctions are never subscribed (the OS would watch
// their TARGET). More than `maxSubscriptions` directories, an unreadable root or a refused watch on a
// directory this module itself decided to watch fall back to ONE recursive watch of the root, which
// is what this module replaces, so the worst case is the old behaviour, never a silent loss of events.
//
// Nothing here is synchronous beyond opening the OS handles themselves, which are opened one per turn of
// the event loop so a root with thirty directories does not hold the thread for thirty opens at once.

import { promises as fsp } from 'fs'
import { join, sep } from 'path'
import { isIgnoredWatchPath, CASE_FOLDING_PLATFORMS } from './watchGuard'
import { openSheddingWatch, type ShedFsWatcher, type ShedFsWatchFn, type SheddingWatchOptions } from './shedWatch'

export type ScopedFsWatcher = ShedFsWatcher
/** fs.watch, as far as this module needs it. */
export type ScopedFsWatchFn = ShedFsWatchFn

export interface ScopedWatchOptions {
  /** Directory names (any case) that are never subscribed, on top of the shared list in watchGuard. */
  skipNames?: Iterable<string>
  /** Directory names whose CHILDREN are scoped one level further. Default: `.claude`. */
  expandNames?: Iterable<string>
  /** Passed to every watch it opens (gitWatcher asks for `false`). */
  persistent?: boolean
  /** More subscriptions than this and the whole thing falls back to one recursive watch of the root. */
  maxSubscriptions?: number
  /** Default: win32 and darwin. */
  caseInsensitive?: boolean
  /** Names of the entries directly inside `absDir` that might be directories. Default: async readdir. */
  listDirs?: (absDir: string) => Promise<string[]>
  /** The identity (device and inode) of the REAL directory at `absPath`, or null when there is none: not
   *  there, not a directory, or a link or junction. Default: async lstat. */
  statDir?: (absPath: string) => Promise<string | null>
  /** Yield to the event loop between opening two OS handles. Default: setImmediate. */
  yieldToLoop?: () => Promise<void>
  /** One line when it falls back to the recursive watch, and one when a storm closes a watch. */
  log?: (msg: string) => void
  /** Timing of the shedding watches (events per second, back-off, clock, timers). Tests only. */
  shed?: Pick<SheddingWatchOptions, 'eventsPerSecond' | 'backoffBaseMs' | 'backoffMaxMs' | 'calmMs' | 'now' | 'setTimer' | 'clearTimer'>
}

export interface ScopedWatch {
  close(): void
  /** Sub-watches currently open (the non-recursive root watch is not counted). */
  readonly subscriptions: number
  /** True once it gave up scoping and watches the root recursively instead. */
  readonly fellBack: boolean
}

const DEFAULT_MAX_SUBSCRIPTIONS = 96
const MAX_PENDING_CHECKS = 32

async function defaultStatDir(absPath: string): Promise<string | null> {
  try {
    const st = await fsp.lstat(absPath, { bigint: true })
    return st.isDirectory() && !st.isSymbolicLink() ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

async function defaultListDirs(absDir: string): Promise<string[]> {
  const entries = await fsp.readdir(absDir, { withFileTypes: true })
  return entries.filter((e) => !e.isFile()).map((e) => e.name)
}

interface SubWatch {
  handle: ScopedFsWatcher
  /** statDir's identity of the directory it was opened on. */
  id: string
}

export function scopedRecursiveWatch(
  fsWatch: ScopedFsWatchFn,
  root: string,
  listener: (event: string, filename: string | null) => void,
  options: ScopedWatchOptions = {},
): ScopedWatch {
  const ci = options.caseInsensitive ?? CASE_FOLDING_PLATFORMS.has(process.platform)
  const extra = [...(options.skipNames ?? [])]
  const expand = new Set([...(options.expandNames ?? ['.claude'])].map((n) => n.toLowerCase()))
  const maxSubs = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS
  const listDirs = options.listDirs ?? defaultListDirs
  const statDir = options.statDir ?? defaultStatDir
  const yieldToLoop = options.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  const persistent = options.persistent === undefined ? {} : { persistent: options.persistent }

  /** Open sub-watches by lower-cased (where the disk is) slash path below the root. */
  const nodes = new Map<string, SubWatch>()
  /** Names being looked at; true = another event for the name arrived meanwhile, so look again afterwards. */
  const pending = new Map<string, boolean>()
  let closed = false
  let fellBack = false
  let rootHandle: ScopedFsWatcher | null = null
  let fullHandle: ScopedFsWatcher | null = null

  const keyOf = (rel: string): string => (ci ? rel.toLowerCase() : rel)
  const native = (rel: string): string => rel.split('/').join(sep)
  const text = (name: string | Buffer | null): string | null => (name === null ? null : typeof name === 'string' ? name : name.toString())

  function closeQuietly(h: ScopedFsWatcher | null | undefined): void {
    try { h?.close() } catch { /* already closed */ }
  }

  /** One OS watch of this module's: the shedding kind, so a storm in it is bounded (shedWatch.ts). `onResume`
   *  runs when a storm closed it and it has been reopened, told whether any event it DID hear before closing
   *  was about something wanted. A storm whose every heard event was about an ignored name (the root watch
   *  hearing `change:dist` once per file a build writes) is taken to be that storm all the way through, and
   *  owes nobody an `overflow`: it would only make a re-sweep, a repaint or a workflow run for noise. */
  function openWatch(
    path: string,
    recursive: boolean,
    onEvent: (event: string, name: string | Buffer | null) => void,
    onResume: (heardWanted: boolean) => void,
  ): ScopedFsWatcher {
    let wanted = 0
    return openSheddingWatch(
      fsWatch,
      path,
      { recursive, ...persistent },
      (event, name) => {
        const t = text(name)
        if (t === null || !isIgnoredWatchPath(t, extra)) wanted++
        onEvent(event, name)
      },
      {
        ...options.shed,
        label: path,
        log: options.log,
        onResume: () => {
          const heard = wanted > 0
          wanted = 0
          onResume(heard)
        },
      },
    )
  }

  /** A watch that errors has already been closed by Node; this adds the bookkeeping. */
  function onWatchError(h: ScopedFsWatcher, then: () => void): void {
    try {
      h.on?.('error', () => {
        closeQuietly(h)
        then()
      })
    } catch { /* a watcher without an event emitter */ }
  }

  /** Deliver one event to the listener, named as a single recursive watch of the root would have named it.
   *  `prefix` is the watched level's path below the root in this platform's own separators ('' for the
   *  root), worked out once when the watch is opened, not once per event. */
  function deliver(prefix: string, event: string, name: string | null): void {
    if (closed) return // (an error from a watch already closed reaches here through its error handler)
    listener(event, name === null ? (prefix || null) : prefix ? prefix + sep + name : name)
  }

  /** "Something changed in here and I did not hear what": a storm closed this watch and it is back. */
  function deliverOverflow(prefix: string): void {
    listener('overflow', prefix || null)
  }

  function fallBack(reason: string): void {
    if (fellBack || closed) return
    fellBack = true
    for (const n of nodes.values()) closeQuietly(n.handle)
    nodes.clear()
    pending.clear()
    closeQuietly(rootHandle)
    rootHandle = null
    try {
      fullHandle = openWatch(root, true, (event, name) => deliver('', event, text(name)), (heard) => { if (heard) deliverOverflow('') })
      onWatchError(fullHandle, () => { deliver('', 'rename', null) })
    } catch {
      fullHandle = null // nothing more can be done here: the caller's slow poll is the safety net
    }
    try { options.log?.(`[watch] ${root}: ${reason}; watching it recursively instead`) } catch { /* a logger must not take the watch down */ }
  }

  /** What to do about `levelRel/name` once its directory has been looked at (`id`: its identity, or null). */
  function reconcile(levelRel: string, name: string, id: string | null): void {
    const rel = levelRel ? `${levelRel}/${name}` : name
    const k = keyOf(rel)
    const cur = nodes.get(k)
    if (cur && cur.id === id) return // the same directory: nothing changed that we need to act on
    if (cur) { // renamed away, replaced or gone: that watch follows the OLD directory, whatever its name now says
      closeQuietly(cur.handle)
      nodes.delete(k)
    }
    if (id) void subscribe(levelRel, name, true, id)
  }

  /** A `rename` below a non-recursive level: a child directory may have appeared, gone, or been replaced. */
  function considerChild(levelRel: string, name: string): void {
    if (closed || fellBack) return
    const rel = levelRel ? `${levelRel}/${name}` : name
    if (isIgnoredWatchPath(rel, extra)) return
    const k = keyOf(rel)
    if (pending.has(k)) {
      // Another event for a name that is being looked at: the answer in flight may predate it (a directory
      // removed and recreated back to back, as a branch switch does), so look once more when it lands.
      pending.set(k, true)
      return
    }
    if (pending.size >= MAX_PENDING_CHECKS) return
    pending.set(k, false)
    const finish = (id: string | null): void => {
      const again = pending.get(k) === true
      pending.delete(k)
      if (closed || fellBack) return
      reconcile(levelRel, name, id)
      if (again) considerChild(levelRel, name)
    }
    void statDir(join(root, ...rel.split('/'))).then(finish, () => {
      // The look failed (EIO ...): that says nothing about the directory, so nothing is changed.
      const again = pending.get(k) === true
      pending.delete(k)
      if (again) considerChild(levelRel, name)
    })
  }

  /** A level's watch was closed by a storm and is back: what came and went in it meanwhile is unknown, so look
   *  at every directory in it (and at every one we hold for it that is no longer listed). */
  async function rescan(levelRel: string): Promise<void> {
    const abs = levelRel ? join(root, ...levelRel.split('/')) : root
    let names: string[]
    try { names = await listDirs(abs) } catch { return }
    const kept = new Set<string>()
    for (const n of names) {
      if (closed || fellBack) return
      const rel = levelRel ? `${levelRel}/${n}` : n
      if (isIgnoredWatchPath(rel, extra)) continue
      kept.add(keyOf(rel))
      await yieldToLoop()
      if (closed || fellBack) return
      reconcile(levelRel, n, await statDir(join(abs, n)))
    }
    const prefix = levelRel ? keyOf(levelRel) + '/' : ''
    for (const [k, node] of [...nodes]) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && !kept.has(k)) {
        closeQuietly(node.handle)
        nodes.delete(k)
      }
    }
  }

  /** Open the watch for `levelRel/name`: recursive, or a non-recursive level for an expanded name. */
  async function subscribe(levelRel: string, name: string, announce: boolean, knownId?: string): Promise<void> {
    if (closed || fellBack) return
    const rel = levelRel ? `${levelRel}/${name}` : name
    const k = keyOf(rel)
    const abs = join(root, ...rel.split('/'))
    const id = knownId ?? (await statDir(abs)) // a link, a file or nothing at all: not ours to watch
    if (id === null || closed || fellBack) return
    if (nodes.has(k)) return
    if (nodes.size >= maxSubs) { fallBack(`more than ${maxSubs} directories to watch`); return }
    const asLevel = levelRel === '' && expand.has(name.toLowerCase())
    const prefix = native(rel)
    let handle: ScopedFsWatcher
    try {
      handle = openWatch(
        abs,
        !asLevel,
        asLevel
          ? (event, n) => {
            const t = text(n)
            deliver(prefix, event, t)
            if (event === 'rename' && t) considerChild(rel, t)
          }
          : (event, n) => deliver(prefix, event, text(n)),
        (heard) => {
          if (heard) deliverOverflow(prefix)
          if (asLevel) void rescan(rel)
        },
      )
    } catch {
      return // it vanished before we got to it, or the platform refused: the level above still reports it
    }
    nodes.set(k, { handle, id })
    onWatchError(handle, () => {
      // Deleted (Windows: EPERM, and the handle is closed): forget it, tell the listener something
      // moved, and look again in case it was recreated before this error arrived.
      if (nodes.get(k)?.handle === handle) nodes.delete(k)
      if (!closed) listener('rename', prefix)
      considerChild(levelRel, name)
    })
    if (announce && !closed) listener('rename', prefix)
    if (asLevel) {
      let children: string[] = []
      try { children = await listDirs(abs) } catch { /* unreadable: the level's own events still arrive */ }
      for (const child of children) {
        if (closed || fellBack) return
        if (isIgnoredWatchPath(`${rel}/${child}`, extra)) continue
        await yieldToLoop()
        await subscribe(rel, child, false)
      }
    }
  }

  async function init(): Promise<void> {
    let names: string[]
    try {
      names = await listDirs(root)
    } catch {
      fallBack('could not list it')
      return
    }
    if (closed) return
    const eligible = names.filter((n) => !isIgnoredWatchPath(n, extra))
    if (eligible.length > maxSubs) { fallBack(`more than ${maxSubs} directories to watch`); return }
    for (const n of eligible) {
      if (closed || fellBack) return
      await yieldToLoop()
      await subscribe('', n, false)
    }
  }

  // The root, non-recursively. A throw here (ENOENT, EPERM, no watch support) is the caller's to handle,
  // exactly as it was for the single recursive watch this replaces.
  rootHandle = openWatch(
    root,
    false,
    (event, n) => {
      const t = text(n)
      deliver('', event, t)
      if (event === 'rename' && t) considerChild('', t)
    },
    (heard) => {
      if (heard) deliverOverflow('')
      void rescan('')
    },
  )
  onWatchError(rootHandle, () => { deliver('', 'rename', null) })
  void init()

  return {
    close() {
      if (closed) return
      closed = true
      closeQuietly(rootHandle)
      closeQuietly(fullHandle)
      for (const n of nodes.values()) closeQuietly(n.handle)
      nodes.clear()
      pending.clear()
    },
    get subscriptions(): number { return nodes.size },
    get fellBack(): boolean { return fellBack },
  }
}

/** Directory names the code index never subscribes (beyond the shared list): vendored Pods and the Turborepo cache. */
export const CODE_SKIP_NAMES: readonly string[] = ['Pods', '.turbo']

/** The same for workflow fileWatch triggers, plus `.termpolis`, where run history and the supervisor's own state
 *  file live: watching it would retrigger a workflow from its own bookkeeping, forever. */
export const TRIGGER_SKIP_NAMES: readonly string[] = ['.termpolis', 'Pods', '.turbo']

/**
 * The directory watch the workflow trigger supervisor is built with: scoped, and without `.termpolis`,
 * `Pods` and `.turbo`. Returns the shape TriggerDeps.watch wants.
 */
export function scopedTriggerWatch(
  fsWatch: ScopedFsWatchFn,
  log?: (msg: string) => void,
): (dir: string, listener: (event: string, filename: string | null) => void) => { close(): void } {
  return (dir, listener) => scopedRecursiveWatch(fsWatch, dir, listener, { skipNames: TRIGGER_SKIP_NAMES, log })
}

/** The name rule for what is inside a repository's `.git` directory: the pieces whose churn never moves
 *  `git status` and is the bulk of it (loose objects and packs, the reflog, and the private HEAD/index
 *  of every other checkout of the repository). Everything that CAN move it (`index`, `HEAD`, `refs/**`,
 *  `packed-refs`, MERGE/REBASE state, `modules/**`) stays subscribed. */
export const GIT_DIR_SKIP: readonly string[] = ['objects', 'logs', 'worktrees']

/**
 * Open a watch the way the git rail wants it: a recursive watch of a repository's working tree is scoped
 * (see above); a recursive watch of its `.git` directory is scoped to what matters inside it; anything
 * non-recursive is passed straight to fs.watch.
 */
export function openScopedGitWatch(
  fsWatch: ScopedFsWatchFn,
  target: string,
  opts: { recursive?: boolean; persistent?: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
  log?: (msg: string) => void,
  /** Hooks for tests (directory listing, lstat, yielding, case rule). */
  extra: ScopedWatchOptions = {},
): ScopedFsWatcher {
  if (!opts.recursive) return fsWatch(target, opts, listener)
  const isGitDir = /(^|[\\/])\.git[\\/]?$/.test(target)
  return scopedRecursiveWatch(fsWatch, target, listener, {
    ...extra,
    persistent: opts.persistent,
    skipNames: isGitDir ? GIT_DIR_SKIP : undefined,
    expandNames: isGitDir ? [] : undefined,
    log,
  })
}
