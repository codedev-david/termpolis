// Lumopolis world client: the MAIN half of the world compiler. worldHost.ts runs in a utilityProcess
// (serviceName `termpolis-lumopolis`); this file spawns it on the first call (never at app start),
// correlates request ids, answers the host's labelling requests (`llm`) with the model runner main
// owns, and fans the host's `progress` / `updated` pushes out to subscribers. Every world's labelling
// calls pass one gate (llmGate.ts): at most WORLD_LLM_HOST_LIMIT model calls run at once on this computer.
//
// A host that exits rejects every call still waiting, and the next call starts a fresh one.
// The transport factory at the bottom is the only Electron-aware code; worldHostTransport.test.ts covers it
// against a stand-in utilityProcess.
import { access } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { app, utilityProcess } from 'electron'
import { graphKeyForRoot, graphSnapshot, type GraphSnapshot } from '../codeGraph'
import { killUtility } from '../utilityKill'
import { abortError } from '../hostLane'
import type { Claim, Evidence, WorldDoc, WorldProgressEvent, WorldQuery, WorldReadResult, WorldUpdatedEvent } from '../../shared/world/types'
import type { CloneSourceResult, SerializedError, UpdateSourceResult, WorldHead, WorldHostRequest, WorldHostResponse } from './worldHost'
import { hideValue, type RepoAccess, type RepoLogin } from '../../shared/world/repoAccess'
import type { TestRun } from './testStatus'
import { shownAsIs, shownError } from './windowError'
import { worldFileName } from './worldStore'
import { createLlmGate, GATE_SETTLE_GRACE_MS, type LlmGate } from './llmGate'
import { LABEL_ANSWER_LIMIT_MS, LABEL_CALL_TIMEOUT_MS } from './label'
import { linkedPlanStamp, planStamp } from '../../shared/world/reconcile'

/** PENDING SIGN-OFF (M6): what a call says when the world host exited, did not start or did not answer in time. Which of
 *  them, and the exit code or the call, goes to the log only. */
export const HOST_STOPPED_MESSAGE = 'Lumopolis stopped responding. Try again.'

/** The error for a host that stopped answering: logged as `detail`, shown with fixed words. */
const hostStopped = (detail: string): Error => {
  console.warn(`[world] ${detail}`)
  return shownError(HOST_STOPPED_MESSAGE)
}

export interface WorldHostTransport {
  postMessage(msg: WorldHostRequest): void
  onMessage(cb: (msg: WorldHostResponse) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
  pid?: number
}

/** The gate every client in this process shares unless it is given its own, made on first use: a second client
 *  cannot double the limit. A labelling CLI told to stop may not end at once (`claude -p` runs on the proc host, which
 *  ends it only at its own LABEL_CALL_TIMEOUT_MS), so its slot is held until it really exits, and no more than its own
 *  limit after that. */
let sharedLlmGate: LlmGate | null = null
const processLlmGate = (): LlmGate => (sharedLlmGate ??= createLlmGate({ graceMs: LABEL_CALL_TIMEOUT_MS + GATE_SETTLE_GRACE_MS }))

export interface WorldClientOptions {
  /** Electron's userData folder (the store lives under `<it>/world/`). Default: `app.getPath('userData')`. */
  userDataPath?: string | (() => string)
  /** The askpass Termpolis ships, handed to the host in init beside userData (a token run needs it). Absent or '': none. */
  askpassPath?: string | (() => string)
  /** The `worldLabelling` setting, read when a host starts, when `applySettings` runs, and again on every
   *  labelling request (off: the request is answered null without asking the model). Default: on. */
  labelling?: () => boolean
  /** Who `llm` asks (the Lumopolis agent and its model), read with `labelling`: the host holds a reply that described
   *  nothing under this name, so another agent or model is asked again. Absent or '': unnamed. */
  labeller?: () => string
  /** Runs one labelling prompt for the project at `root`. Absent, or throwing, the host labels from code. `signal` is
   *  aborted when nobody waits for the answer any more (its limit passed, its compile ended, its world was removed). */
  llm?: (root: string, prompt: string, signal: AbortSignal) => Promise<string | null>
  /** The limit every world's labelling calls share. Default: the one gate of this process (WORLD_LLM_HOST_LIMIT calls
   *  at once across every client, a stopped call's slot held until its CLI exits). */
  llmGate?: LlmGate
  /** Evidence about a building's files (commit subjects, docs lines, memory decisions) for labelling, for the project at
   *  `root`. Absent, or throwing: labelling uses file excerpts alone. */
  context?: (root: string, members: string[]) => Promise<Evidence[]>
  /** The agent transcript files of the project at `root` (at most the 20 newest). The world host reads and parses them, never main. Absent, or throwing: none. */
  transcriptFiles?: (root: string) => Promise<string[]>
  /** The newest CI conclusion of the project at `root`, as runs of the files the commit changed. Absent, or throwing: none. */
  ciRuns?: (root: string) => Promise<TestRun[]>
  /** The repository revision stamped on a world. Default: `{ head: '', dirty: false }`. */
  head?: (root: string) => Promise<WorldHead>
  /** The code-graph snapshot posted to the host. Default: the structure-only
   *  `graphSnapshot(graphKeyForRoot(root), root, { structureOnly: true })` (the world reads no symbols). */
  snapshot?: (root: string) => GraphSnapshot | Promise<GraphSnapshot>
  /** The design linked to a project (plan versus built), or null. Absent, or throwing: no plan. */
  planFor?: (projectKey: string) => Promise<WorldDoc | null>
  /** Whether a world is stored for a project. Default: the store file exists under userData. */
  hasStoredWorld?: (projectKey: string) => boolean | Promise<boolean>
  /** How long one call may wait for its answer. Default 10 minutes (a first compile of a big repo). */
  callTimeoutMs?: number
  /** How long a new host may take to answer init. Default 30 seconds. */
  initTimeoutMs?: number
}

/** What `get` does besides reading the stored world. */
export interface WorldGetOptions {
  /** False: never start a background refresh (the ask path: a refresh landing mid-answer would wipe it). Default true.
   *  It also says who asks: false is a read, true (the default, the pane's world:get) a person opening the world. Only
   *  a person opening takes a removed world back (cancelLabelling), so a pane path that opens a world must keep it on. */
  refresh?: boolean
  /** The caller gave up (a cancelled Ask): the call is let go of and rejects with an AbortError. */
  signal?: AbortSignal
  /** True only for the pane: before the first world is saved, the first map drawn from the listing is returned too.
   *  Export and Ask never ask for it, so they never take an unfinished map for the project's (fix round 1, I1). */
  provisional?: boolean
}

export const DEFAULT_CALL_TIMEOUT_MS = 600_000
export const DEFAULT_INIT_TIMEOUT_MS = 30_000
/** After a background refresh fails, the same commit is not tried again for this long. */
export const REFRESH_BACKOFF_MS = 5 * 60_000

interface Waiter {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: ReturnType<typeof setTimeout>
  /** The project a long call works for: each progress the host reports for it starts the call's timeout again, so a
   *  compile that keeps moving never times out while the host works. */
  key?: string
  /** Starts the timeout again. */
  rearm?: () => void
}

const toError = (e: SerializedError | undefined): Error => {
  const err: Error & { code?: string } = new Error(e?.message || 'Lumopolis host call failed')
  err.name = e?.name || 'Error'
  if (e?.code) err.code = e.code
  return shownAsIs(err) // outwardError mapped it in the host: the window may show it as it is
}

/** Call arguments without the trailing ones left out (the host reads a missing one as undefined). */
const argsOf = (...args: unknown[]): unknown[] => {
  let n = args.length
  while (n > 1 && args[n - 1] === undefined) n--
  return args.slice(0, n)
}

/** The token a request carries, trimmed as the host trims it; '' for any other access. */
const tokenOf = (access: RepoAccess | undefined): string =>
  access && access.mode === 'token' && typeof access.value === 'string' ? access.value.trim() : ''

/**
 * A clone or update run with a token: whatever comes back (a failed result, a timeout, a crash, a thrown
 * error) passes through hideValue, so the token never reaches an IPC answer or a log line from here.
 */
async function hiddenFrom<T extends { ok: boolean; error?: string }>(p: Promise<T>, value: string): Promise<T> {
  if (!value) return p
  let res: T
  try {
    res = await p
  } catch (e) {
    // call() only ever rejects with an Error (it wraps anything else), so the message is text.
    throw new Error(hideValue((e as Error).message, value))
  }
  return !res.ok && typeof res.error === 'string' ? { ...res, error: hideValue(res.error, value) } : res
}

/** A watcher's paths, relative to the root, with forward slashes. */
const normaliseFiles = (files: string[]): string[] =>
  (Array.isArray(files) ? files : [])
    .filter((f): f is string => typeof f === 'string' && f !== '')
    .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))

export function createWorldClient(
  spawn: () => WorldHostTransport = () => createWorldHostTransport(),
  opts: WorldClientOptions = {}
) {
  const dataPath = (): string => {
    const p = opts.userDataPath ?? (() => app.getPath('userData'))
    return typeof p === 'function' ? p() : p
  }
  const askpassOf = (): string => {
    const p = opts.askpassPath
    const v = typeof p === 'function' ? p() : p
    return typeof v === 'string' ? v : ''
  }
  const labelling = opts.labelling ?? (() => true)
  const labellerOf = (): { labeller?: string } => {
    const name = opts.labeller?.()
    return name ? { labeller: name } : {}
  }
  const headOf = opts.head ?? (async () => ({ head: '', dirty: false }))
  const snapshotOf = opts.snapshot ?? ((root: string) => graphSnapshot(graphKeyForRoot(root), root, { structureOnly: true }))
  const hasStoredWorld =
    opts.hasStoredWorld ??
    (async (key: string) => {
      try {
        await access(join(dataPath(), 'world', worldFileName(key)))
        return true
      } catch {
        return false
      }
    })
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const gate = opts.llmGate ?? processLlmGate()
  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS

  let current: WorldHostTransport | null = null
  let live: Promise<WorldHostTransport> | null = null
  let initWaiter: { resolve(): void; reject(e: Error): void } | null = null
  let disposed = false
  let seq = 0
  const pending = new Map<number, Waiter>()
  /** projectKey → the root the renderer named, so pushes and labelling requests map back to a folder. */
  const roots = new Map<string, string>()
  /** Projects with a world (compiled or loaded this run): the only ones a watcher may refresh. */
  const known = new Set<string>()
  /** Projects whose stored world is being checked against HEAD, or refreshed: at most one at a time each. */
  const refreshing = new Set<string>()
  /** projectKey → the HEAD and linked plan stamp whose background refresh last failed, and when (REFRESH_BACKOFF_MS). */
  const refreshFailed = new Map<string, { head: string; at: number }>()
  /** Worlds removed since they were last asked for: no labelling request of theirs starts a CLI (cancelLabelling). */
  const removed = new Set<string>()
  /** Tells the host which worlds were removed, so their label runs stop asking (worldHost `labelling-stopped`). */
  const tellRemoved = (): void => {
    try {
      current?.postMessage({ kind: 'labelling-stopped', keys: [...removed] })
    } catch {
      // the host is going away; a new one asks nothing for a world nobody opens
    }
  }
  /** Labelling requests waiting for a slot or running, each with the abort that takes it out (llmGate.ts). */
  const llmCalls = new Set<{ tr: WorldHostTransport; id: number; projectKey: string; ctl: AbortController }>()
  /** Stops the labelling requests `which` picks: a waiting one never starts, a running one is answered null. */
  const cancelLlm = (which: (c: { tr: WorldHostTransport; id: number; projectKey: string }) => boolean): void => {
    for (const c of llmCalls) {
      if (!which(c)) continue
      llmCalls.delete(c)
      c.ctl.abort()
    }
  }
  const progressSubs = new Set<(e: WorldProgressEvent) => void>()
  const updatedSubs = new Set<(e: WorldUpdatedEvent) => void>()

  const emit = <T>(subs: Set<(e: T) => void>, e: T): void => {
    for (const cb of subs) {
      try {
        cb(e)
      } catch {
        // one bad subscriber never stops the others
      }
    }
  }

  const reset = (tr: WorldHostTransport, why: Error): void => {
    if (current !== tr) return
    current = null
    live = null
    // The host is gone, and with it every compile that asked: none of its waiting calls may start a CLI.
    cancelLlm((c) => c.tr === tr)
    initWaiter?.reject(why)
    initWaiter = null
    for (const [id, w] of pending) {
      clearTimeout(w.timer)
      pending.delete(id)
      w.reject(why)
    }
  }

  const answerLlm = async (tr: WorldHostTransport, id: number, projectKey: string, prompt: string): Promise<void> => {
    let text: string | null = null
    const root = roots.get(projectKey)
    const llm = opts.llm
    // Consent is checked at the moment of asking, and again when the call gets its slot: turning
    // "Describe parts with AI" off stops model calls at once, even mid-compile.
    if (llm && root !== undefined && labelling() !== false && !removed.has(projectKey)) {
      const entry = { tr, id, projectKey, ctl: new AbortController() }
      llmCalls.add(entry)
      // The wait for a slot is not the call's time: the host starts its limit on `llm-started`. Its limit is the
      // host's, the CLI's own plus what main does before the CLI starts, so neither side drops a reply the CLI gave in time.
      text = await gate.run((signal) => (labelling() !== false ? llm(root, prompt, signal) : Promise.resolve(null)), {
        signal: entry.ctl.signal,
        timeoutMs: LABEL_ANSWER_LIMIT_MS,
        onStart: () => tr.postMessage({ kind: 'llm-started', id }),
      })
      llmCalls.delete(entry)
    }
    try {
      tr.postMessage({ kind: 'llm-result', id, text })
    } catch {
      // the host went away while the model ran; its exit already failed the compile
    }
  }

  const answerContext = async (tr: WorldHostTransport, id: number, projectKey: string, members: unknown): Promise<void> => {
    let evidence: Evidence[] = []
    const root = roots.get(projectKey)
    if (opts.context && root !== undefined && labelling() !== false && Array.isArray(members)) {
      try {
        const r = await opts.context(root, members.filter((x): x is string => typeof x === 'string'))
        evidence = Array.isArray(r) ? r : []
      } catch {
        evidence = []
      }
    }
    try {
      tr.postMessage({ kind: 'context-result', id, evidence })
    } catch {
      // the host went away while main looked; its exit already failed the compile
    }
  }

  const answerRuns = async (tr: WorldHostTransport, id: number, projectKey: string, source: unknown): Promise<void> => {
    let runs: TestRun[] = []
    let files: string[] = []
    const root = roots.get(projectKey)
    if (root !== undefined) {
      try {
        if (source === 'ci' && opts.ciRuns) {
          const r = await opts.ciRuns(root)
          runs = Array.isArray(r) ? r : []
        } else if (source === 'transcript' && opts.transcriptFiles) {
          const f = await opts.transcriptFiles(root)
          files = Array.isArray(f) ? f : []
        }
      } catch {
        runs = []
        files = []
      }
    }
    try {
      tr.postMessage({ kind: 'runs-result', id, runs, files })
    } catch {
      // the host went away while main looked; its exit already failed the compile
    }
  }

  const onMessage = (tr: WorldHostTransport, m: WorldHostResponse): void => {
    if (current !== tr || !m || typeof m !== 'object') return
    switch (m.kind) {
      case 'ready':
        initWaiter?.resolve()
        initWaiter = null
        return
      case 'init-error': {
        const why = toError(m.error)
        reset(tr, why)
        try {
          tr.kill()
        } catch {
          // already gone
        }
        return
      }
      case 'result': {
        const w = pending.get(m.id)
        if (!w) return
        pending.delete(m.id)
        clearTimeout(w.timer)
        if (m.ok) w.resolve(m.result)
        else w.reject(toError(m.error))
        return
      }
      case 'progress':
        for (const w of pending.values()) if (w.key === m.projectKey) w.rearm?.()
        emit(progressSubs, { root: roots.get(m.projectKey) ?? '', projectKey: m.projectKey, stage: m.stage, pct: m.pct })
        return
      case 'updated':
        emit(updatedSubs, { root: roots.get(m.projectKey) ?? '', projectKey: m.projectKey, ...(typeof m.error === 'string' ? { error: m.error } : {}) })
        return
      case 'llm':
        void answerLlm(tr, m.id, m.projectKey, m.prompt)
        return
      case 'llm-cancel':
        cancelLlm((c) => c.tr === tr && c.id === m.id)
        return
      case 'context':
        void answerContext(tr, m.id, m.projectKey, m.members)
        return
      case 'runs':
        void answerRuns(tr, m.id, m.projectKey, m.source)
        return
    }
  }

  const start = (): Promise<WorldHostTransport> => {
    if (live) return live
    const p = new Promise<WorldHostTransport>((resolve, reject) => {
      const tr = spawn()
      current = tr
      // A host that neither answers init nor exits would otherwise hang every call forever (the
      // per-call timer only starts once init is done). Give up, kill it, and let the next call respawn.
      const initTimer = setTimeout(() => {
        reset(tr, hostStopped('Lumopolis host did not start in time'))
        try {
          tr.kill()
        } catch {
          // already gone
        }
      }, initTimeoutMs)
      initWaiter = {
        resolve: () => {
          clearTimeout(initTimer)
          resolve(tr)
        },
        reject: (e) => {
          clearTimeout(initTimer)
          reject(e)
        }
      }
      tr.onMessage((m) => onMessage(tr, m))
      tr.onExit((code) => reset(tr, hostStopped(`Lumopolis host exited (code ${code})`)))
      const askpassPath = askpassOf()
      tr.postMessage({ kind: 'init', userDataPath: dataPath(), labelling: labelling() !== false, ...labellerOf(), ...(askpassPath ? { askpassPath } : {}) })
      // A host started after a world was removed (a restart, or a first start by a call for another world) is told at
      // once, before any call, so a label run it starts for that world asks nothing.
      if (removed.size > 0) tellRemoved()
    })
    live = p
    // A spawn that throws leaves nothing running: let the next call try again.
    p.catch(() => {
      if (live === p) live = null
    })
    return p
  }

  /** Calls the host. `key`: the project the call works for; its progress keeps the call from timing out (Waiter.key).
   *  `signal` (WPA): the caller gave up (a cancelled Ask). The host has no cancel for a call, and the reads an Ask makes are
   *  quick in-memory work there, so the call is let go of: never posted if it was not yet, or its waiter dropped, so the
   *  answer, if it comes, is ignored. It rejects with an AbortError. */
  const call = async <T>(fn: string, args: unknown[], key?: string, signal?: AbortSignal): Promise<T> => {
    if (disposed) throw shownError('Lumopolis host is shut down')
    if (signal?.aborted) throw abortError()
    const tr = await start()
    if (signal?.aborted) throw abortError()
    return new Promise<T>((settle, fail) => {
      const id = ++seq
      const onAbort = (): void => {
        clearTimeout(waiter.timer)
        pending.delete(id)
        fail(abortError())
      }
      const resolve = (v: T): void => { signal?.removeEventListener('abort', onAbort); settle(v) }
      const reject = (e: Error): void => { signal?.removeEventListener('abort', onAbort); fail(e) }
      const expire = (): ReturnType<typeof setTimeout> =>
        setTimeout(() => {
          pending.delete(id)
          reject(hostStopped(`Lumopolis host call "${fn}" timed out`))
        }, callTimeoutMs)
      const waiter: Waiter = { resolve: resolve as (v: unknown) => void, reject, timer: expire() }
      if (key !== undefined) {
        waiter.key = key
        waiter.rearm = () => {
          clearTimeout(waiter.timer)
          waiter.timer = expire()
        }
      }
      pending.set(id, waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        tr.postMessage({ kind: 'call', id, fn, args })
      } catch (err) {
        clearTimeout(waiter.timer)
        pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** The world's key for `root`. `opened`: a person compiling or opening the world (re-added, or opened in the pane),
   *  which takes a removed world back so it labels again. A read (an agent's world tool, Ask) never does. */
  const keyOf = (root: string, opened = false): string => {
    const key = typeof root === 'string' ? graphKeyForRoot(root) : ''
    if (!key) throw shownError('Lumopolis needs a project folder')
    roots.set(key, root)
    if (opened && removed.delete(key)) tellRemoved()
    return key
  }

  /** The project's linked design, or null (no planFor, none linked, or the lookup failed). */
  const planOf = async (key: string): Promise<WorldDoc | null> => {
    if (!opts.planFor) return null
    try {
      return (await opts.planFor(key)) ?? null
    } catch {
      return null
    }
  }

  /** The linked plan stamp a world carries; a doc with no layers (never one the host saves) carries none. */
  const carried = (doc: WorldDoc): string => (doc.layers ? linkedPlanStamp(doc) : '')

  /** Per project: the compiles in flight (whenCompiled waits for them). */
  const inFlight = new Map<string, Set<Promise<unknown>>>()
  /** Per project: the commit of the compile in flight, so the host's snapshot for it can draw a first map from the
   *  listing (snapshotFromFiles) while it reads the files. */
  const compilingHead = new Map<string, WorldHead>()

  const compileRun = async (root: string, key: string, relayout: boolean, linked?: WorldDoc | null): Promise<WorldDoc> => {
    const head = await headOf(root)
    compilingHead.set(key, head)
    try {
      const snap = await snapshotOf(root)
      const plan = linked === undefined ? await planOf(key) : linked
      const extra = { ...(relayout ? { relayout: true } : {}), ...(plan ? { plan } : {}) }
      const doc = await call<WorldDoc>('compile', Object.keys(extra).length > 0 ? [key, snap, head, extra] : [key, snap, head], key)
      known.add(key)
      return doc
    } finally {
      if (compilingHead.get(key) === head) compilingHead.delete(key)
    }
  }

  const compileWith = (root: string, relayout: boolean, linked?: WorldDoc | null, background = false): Promise<WorldDoc> => {
    let key: string
    try {
      key = keyOf(root, true)
    } catch (e) {
      return Promise.reject(e)
    }
    const run = compileRun(root, key, relayout, linked)
    const runs = inFlight.get(key) ?? new Set<Promise<unknown>>()
    inFlight.set(key, runs)
    runs.add(run)
    const done = (): void => {
      runs.delete(run)
      if (runs.size === 0 && inFlight.get(key) === runs) inFlight.delete(key)
    }
    // A compile that ended without a world (the host failed it, stopped, or the call ran out) is pushed with its
    // error, so a pane showing the first map from the listing, or one opened while it ran, hears how it ended (I2).
    // A background refresh is not: its world is stored, so it drew no first map and no pane waits on it (m5).
    const failed = (e: unknown): void => {
      done()
      if (!background) emit(updatedSubs, { root, projectKey: key, error: e instanceof Error ? e.message : String(e) })
    }
    run.then(done, failed)
    return run
  }

  /**
   * A stored world compiled at an older commit than the project's HEAD is recompiled in the background
   * (the same compile world:compile runs: it saves, and the host's `updated` push refreshes the pane).
   * Uncommitted edits alone never count (the watcher covers those), and no HEAD (not a repository, or
   * the lookup failed) means no refresh. Failures are logged, never thrown: the caller already has its doc.
   * A refresh that failed is not tried again for the same HEAD until REFRESH_BACKOFF_MS has passed (a
   * repository whose compile keeps failing would otherwise snapshot and compile on every get); a new
   * commit tries at once. A linked design saved since the world was compiled (or linked, or unlinked)
   * counts as stale too, with the same backoff; so does a refresh whose world still lacks the plan
   * (an overlay that did not validate), which would otherwise recompile on every get.
   */
  const refreshIfStale = (root: string, key: string, doc: WorldDoc): void => {
    if (refreshing.has(key)) return
    refreshing.add(key)
    let tried = ''
    void (async () => {
      const { head } = await headOf(root)
      const plan = await planOf(key)
      const stamp = planStamp(plan)
      const headStale = head !== '' && head !== doc.sourceRevision.head
      if (!headStale && stamp === carried(doc)) return
      const token = `${head}\n${stamp}`
      const failed = refreshFailed.get(key)
      if (failed && failed.head === token && Date.now() - failed.at < REFRESH_BACKOFF_MS) return
      tried = token
      const fresh = await compileWith(root, false, plan, true)
      if (carried(fresh) === stamp) refreshFailed.delete(key)
      else refreshFailed.set(key, { head: token, at: Date.now() })
    })()
      .catch((e: unknown) => {
        if (tried) refreshFailed.set(key, { head: tried, at: Date.now() })
        console.warn('[world] background refresh failed:', e)
      })
      .finally(() => refreshing.delete(key))
  }

  return {
    /** Compiles (or recompiles) the world for `root`, keeping stored positions, and returns it. */
    compile: (root: string): Promise<WorldDoc> => compileWith(root, false),
    /** Compiles with a fresh layout: stored positions are ignored. */
    relayout: (root: string): Promise<WorldDoc> => compileWith(root, true),
    /** The stored world for `root`, or null when none was compiled yet. Returned at once; one from an
     *  older commit is also refreshed in the background (refreshIfStale) unless `opts.refresh` is false. */
    async get(root: string, opts: WorldGetOptions = {}): Promise<WorldDoc | null> {
      // The pane's get is a person opening the world; Ask's (no refresh) only reads it.
      const key = keyOf(root, opts.refresh !== false)
      const doc = await call<WorldDoc | null>('get', opts.provisional === true ? [key, { provisional: true }] : [key], undefined, opts.signal)
      // A first map drawn from the listing: the compile that drew it is still running, so nothing is refreshed.
      if (doc && doc.provisional !== true) {
        known.add(key)
        if (opts.refresh !== false) refreshIfStale(root, key, doc)
      }
      return doc
    },
    /** A filtered view of the stored world (ids and/or text, default limit 20) with the cited evidence. */
    async read(root: string, q: WorldQuery, opts: { signal?: AbortSignal } = {}): Promise<WorldReadResult> {
      return call<WorldReadResult>('read', [keyOf(root), q ?? {}], undefined, opts.signal)
    },
    /** The same filtered view of a stored design world by its key, or null when none is stored. */
    async readDesign(key: string, q: WorldQuery): Promise<WorldReadResult | null> {
      if (!(await hasStoredWorld(key))) return null
      return call<WorldReadResult>('read', [key, q ?? {}])
    },
    /**
     * Stores a person's claim on a building or line of the world `key` (a project key or a design:<id> key
     * this run knows or has stored) and answers the doc with it merged in. An unknown world or part rejects.
     */
    async annotate(key: string, itemId: string, claim: Claim): Promise<WorldDoc> {
      if (typeof key !== 'string' || key === '') throw new Error('No world with that key.')
      if (!known.has(key)) {
        const stored = await Promise.resolve()
          .then(() => hasStoredWorld(key))
          .catch(() => false)
        if (stored !== true) throw new Error('No world with that key.')
      }
      return call<WorldDoc>('annotate', [key, itemId, claim])
    },
    /**
     * Whether a world exists for `root`: compiled or loaded this run, or stored on disk. Never starts
     * the world process and never loads the doc (a file-existence check), so the memory primer and the
     * gateway can ask it cheaply. A folder with no key, or a check that fails, is false.
     */
    async hasWorld(root: string): Promise<boolean> {
      const key = typeof root === 'string' ? graphKeyForRoot(root) : ''
      if (!key) return false
      if (known.has(key)) return true
      try {
        return (await hasStoredWorld(key)) === true
      } catch {
        return false
      }
    },
    /**
     * Files under `root` changed (paths relative to it). Fire and forget. Only a project that already
     * has a world is refreshed: a watcher never makes the first one. An empty list (the watcher lost
     * track) counts every indexed file as changed; the label cache keeps unchanged parts free.
     * A watcher event never starts the world process either: with no host running (nobody asked for
     * a world since launch, or the host exited) it does nothing, and the next compile catches up.
     */
    notifyChanged(root: string, files: string[]): void {
      void (async () => {
        if (disposed || !current) return
        const key = typeof root === 'string' ? graphKeyForRoot(root) : ''
        if (!key) return
        if (!known.has(key)) {
          if (!(await hasStoredWorld(key))) return
          known.add(key)
        }
        roots.set(key, root)
        // One wait, not three: git is the slow one, and the snapshot and the plan need nothing from it.
        const [snap, head, plan] = await Promise.all([snapshotOf(root), headOf(root), planOf(key)])
        const rel = normaliseFiles(files)
        await call('notifyChanged', [key, snap, head, rel.length > 0 ? rel : snap.files, ...(plan ? [plan] : [])])
      })().catch(() => undefined)
    },
    onProgress(cb: (e: WorldProgressEvent) => void): () => void {
      progressSubs.add(cb)
      return () => {
        progressSubs.delete(cb)
      }
    },
    onUpdated(cb: (e: WorldUpdatedEvent) => void): () => void {
      updatedSubs.add(cb)
      return () => {
        updatedSubs.delete(cb)
      }
    },
    /**
     * The world settings changed: tell a running host so its next compile or watcher recompile
     * honours them. Never starts a host (one that starts later reads the settings in its init).
     */
    applySettings(): void {
      // Labelling turned off: no waiting call may start, and a running one is answered null now.
      if (labelling() === false) cancelLlm(() => true)
      const tr = current
      if (!tr) return
      try {
        tr.postMessage({ kind: 'settings', labelling: labelling() !== false, ...labellerOf() })
      } catch {
        // the host is going away; the next one reads the setting in its init
      }
    },
    /**
     * Shallow-clones a git source into userData (progress arrives on onProgress as `clone:<hash>`, root '').
     * `access` is how the person chose to sign in; a token travels only as this call's argument.
     */
    clone: (url: string, ref?: string, access?: RepoAccess): Promise<CloneSourceResult> =>
      hiddenFrom(call<CloneSourceResult>('cloneSource', argsOf(url, ref, access)), tokenOf(access)),
    /**
     * Brings an opened repository up to date in the background: `login` is how it was opened (from the
     * registry), `access` a sign-in the person just gave. No progress is posted.
     */
    updateSource: (url: string, ref?: string, login?: RepoLogin, access?: RepoAccess): Promise<UpdateSourceResult> =>
      hiddenFrom(call<UpdateSourceResult>('updateSource', argsOf(url, ref, login, access)), tokenOf(access)),
    /** Cancels a running clone of the same url and ref; true when there was one. */
    cancelClone: (url: string, ref?: string): Promise<boolean> => call('cancelClone', ref === undefined ? [url] : [url, ref]),
    /**
     * A structure-only snapshot of `root` (its git-listed source files and their imports) made in the world
     * process, for a folder main has not indexed yet, so reading and parsing a whole repository never runs
     * on the main thread. A cloned repository is read confined to its folder.
     */
    snapshotFromFiles: (root: string): Promise<GraphSnapshot> => {
      const key = keyOf(root)
      const head = compilingHead.get(key)
      // For a compile in flight: the host may draw a first map from the listing, and its progress keeps this call alive.
      return head === undefined ? call('snapshotFromFiles', [root]) : call('snapshotFromFiles', [root, { projectKey: key, head }], key)
    },
    /**
     * Resolves once no compile of `root`'s world is running (at once when none is), whatever they ended with. Main's
     * code graph waits on it, so its reads never compete with the world's first map (WP4a Ruling R3).
     */
    whenCompiled: async (root: string): Promise<boolean> => {
      const key = graphKeyForRoot(root)
      const runs = key ? inFlight.get(key) : undefined
      if (!runs) return false
      await Promise.allSettled([...runs])
      return true
    },
    /** The world with this key (graphKeyForRoot, the registry key) was removed: its labelling calls still waiting for a
     *  slot never start, running ones are answered null, and none it asks later starts a CLI until the world is asked
     *  for again. The host is told, so its label run for the world stops asking. */
    cancelLabelling(projectKey: string): void {
      removed.add(projectKey)
      cancelLlm((c) => c.projectKey === projectKey)
      tellRemoved()
    },
    /** Stops the host (app quit). Calls after this reject. */
    dispose(): void {
      disposed = true
      const tr = current
      if (!tr) return
      reset(tr, shownError('Lumopolis host is shut down'))
      try {
        tr.kill()
      } catch {
        // already gone
      }
    },
    /** The running host's pid, if one is up (diagnostics). */
    get pid(): number | undefined {
      return current?.pid
    }
  }
}

export type WorldClient = ReturnType<typeof createWorldClient>

/** The bundled host entry, emitted next to the main `index.js` (an electron-vite input). ESM, so `import.meta.url`. */
export function resolveWorldHostPath(): string {
  return fileURLToPath(new URL('./worldHost.js', import.meta.url))
}

/**
 * Forks the real utilityProcess (a stand-in in tests).
 * GOTCHA (asymmetric): the CHILD reads `e.data`; here, in the PARENT, `child.on('message', m => …)`
 * receives the payload DIRECTLY.
 */
export function createWorldHostTransport(hostPath: string = resolveWorldHostPath()): WorldHostTransport {
  const child = utilityProcess.fork(hostPath, [], { serviceName: 'termpolis-lumopolis' })
  return {
    // A message the child cannot take (a closed port, a value that does not clone) fails with fixed text:
    // Electron's own error can quote the message, and a clone call's arguments may carry a token.
    postMessage: (msg) => {
      try {
        child.postMessage(msg)
      } catch {
        throw shownError('Lumopolis host could not take that request')
      }
    },
    onMessage: (cb) => {
      child.on('message', (m: WorldHostResponse) => cb(m))
    },
    onExit: (cb) => {
      child.on('exit', (code: number) => cb(code))
    },
    kill: () => killUtility(child),
    get pid() {
      return child.pid
    }
  }
}
