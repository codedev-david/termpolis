// triggers.ts â€” the automatic side of the Workflow Orchestrator.
//
// The engine itself only ever runs from one entry point (`startRun` in ipc.ts).
// This supervisor is the thing that calls it for you: it watches the projects
// the app has open, arms every workflow whose trigger isn't `manual`, and fires
// them when their condition is met.
//
//   schedule  â€” 5-field cron, evaluated on a ticker; a persisted `lastFiredAt`
//               lets a run that was due while the app was closed catch up at
//               launch instead of being silently dropped.
//   gitCommit â€” polls the local branch sha (post-commit: the commit has already
//               landed when this fires; it is NOT a blocking pre-commit gate).
//   gitPush   â€” polls the remote-tracking sha, which only advances on a push.
//   fileWatch â€” recursive fs.watch on the project, ignore-list + prefix filter
//               + debounce.
//
// Everything external is injected so the whole thing is testable without a
// clock, a filesystem, or a git repo.

import { join } from 'path'
import { readFileSync } from 'fs'
import { forEachBufferLine } from '../fileLines'
import type { Workflow } from '../../renderer/src/types'
import { workflowsDir, listWorkflowsFull, type FsLike } from './workflowStore'
import { parseCron, dueSince, MAX_CATCHUP_MS, type CronFields } from './cron'

export interface WatchHandle {
  close(): void
}

export interface TriggerDeps {
  fs: FsLike
  /** Byte reader for packed-refs. Defaults to node's fs; tests back it with
   *  their fake filesystem so no real repo is needed. */
  readBytes?: (p: string) => Uint8Array
  /** Recursive directory watch. Mirrors fs.watch(dir, {recursive:true}, cb). */
  watch(dir: string, listener: (event: string, filename: string | null) => void): WatchHandle
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  now(): number
  /** Workspace-trust gate â€” an untrusted project never auto-runs anything. */
  isTrusted(cwd: string): boolean
  /** Start a run. Returns a promise when the caller has one, so the supervisor
   *  can hold the in-flight guard until the run actually finishes. */
  fire(cwd: string, workflowId: string, reason: string): unknown
  log?: (msg: string) => void
  tickMs?: number
  defaultDebounceMs?: number
}

/** Dirs whose churn must never fire a fileWatch workflow. `.termpolis` is the
 *  load-bearing one: run history and this supervisor's own state file live
 *  there, so without it a fileWatch workflow retriggers itself forever. */
const IGNORE =
  /(^|[\\/])(node_modules|\.git|\.termpolis|dist|out|build|target|\.venv|Pods|\.next|coverage|\.turbo)([\\/]|$)/i

const DEFAULT_TICK_MS = 15_000
const DEFAULT_DEBOUNCE_MS = 2_000
/** Floor between two automatic runs of the same workflow. Absorbs a burst of
 *  file events and stops a workflow that edits its own project from spinning. */
const MIN_REFIRE_MS = 3_000

const STATE_FILE = '.triggers.json'

interface TriggerState {
  lastFiredAt?: number
  /** Last observed sha for a git trigger. Absent = not yet seeded. */
  sha?: string
  /** Which ref that sha came from. A change of ref NAME is a branch switch, not
   *  a commit â€” we reseed instead of firing. */
  ref?: string
}
type ProjectState = Record<string, TriggerState>

interface Armed {
  workflow: Workflow
  cron?: CronFields
  catchUp: boolean
}

interface Project {
  cwd: string
  armed: Map<string, Armed>
  watcher: WatchHandle | null
  debounceTimer: unknown | null
  state: ProjectState
  stateDirty: boolean
  /** True once we've logged "untrusted, skipping" â€” keeps the log from
   *  repeating every tick for a project the user simply hasn't trusted. */
  warnedUntrusted: boolean
}

// â”€â”€ git plumbing (read-only, no child processes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Resolve the real git dir for a working tree. `.git` is usually a directory
 *  but is a FILE containing `gitdir: <path>` inside a worktree or submodule. */
export function gitDirOf(cwd: string, fs: FsLike): string | null {
  const dotGit = join(cwd, '.git')
  if (!fs.existsSync(dotGit)) return null
  try {
    // A directory read as utf8 throws (EISDIR); that's the common, happy path.
    const text = fs.readFileSync(dotGit, 'utf8')
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    if (!m) return dotGit
    const p = m[1].trim()
    return /^([A-Za-z]:[\\/]|[\\/])/.test(p) ? p : join(cwd, p)
  } catch {
    return dotGit
  }
}

/** The symbolic ref HEAD points at (e.g. `refs/heads/main`), or null when HEAD
 *  is detached or unreadable. */
export function headRef(gitDir: string, fs: FsLike): string | null {
  try {
    const head = fs.readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*(.+)$/.exec(head)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Read a file as raw bytes. Injectable so tests can back it with a fake fs. */
export type ReadBytes = (p: string) => Uint8Array
const nodeReadBytes: ReadBytes = (p) => readFileSync(p)

/**
 * Resolve a ref to a sha: loose ref file first, then packed-refs.
 *
 * packed-refs is walked BY BYTES (forEachBufferLine) rather than
 * decoded whole and line-split â€” see the v1.27.4 crash guard in
 * tests/electron/noWholeFileJsonlRead.test.ts. A loose ref is a single 41-byte
 * line, so it stays on the plain string read.
 */
export function resolveRef(gitDir: string, ref: string, fs: FsLike, readBytes: ReadBytes = nodeReadBytes): string | null {
  const loose = join(gitDir, ...ref.split('/'))
  if (fs.existsSync(loose)) {
    try {
      const raw = fs.readFileSync(loose, 'utf8').trim()
      // A loose ref can itself be symbolic (rare, but legal).
      const sym = /^ref:\s*(.+)$/.exec(raw)
      if (sym) return resolveRef(gitDir, sym[1].trim(), fs, readBytes)
      if (/^[0-9a-f]{7,64}$/i.test(raw)) return raw
    } catch {
      /* fall through to packed-refs */
    }
  }
  const packed = join(gitDir, 'packed-refs')
  if (!fs.existsSync(packed)) return null
  try {
    let found: string | null = null
    forEachBufferLine(Buffer.from(readBytes(packed)), (line) => {
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith('^')) return
      const sp = t.indexOf(' ')
      if (sp > 0 && t.slice(sp + 1).trim() === ref) {
        found = t.slice(0, sp)
        return false // stop scanning
      }
    })
    if (found) return found
  } catch {
    /* unreadable packed-refs â€” treat as unresolved */
  }
  return null
}

/** The ref a git trigger should follow, given its config. Returns null when the
 *  project isn't a repo or the ref can't be determined yet (e.g. a remote branch
 *  that has never been pushed). */
export function targetRef(wf: Workflow, gitDir: string, fs: FsLike): string | null {
  const cfg = wf.trigger.config ?? {}
  const branch = (cfg.branch ?? '').trim()
  if (wf.trigger.type === 'gitCommit') {
    return branch ? `refs/heads/${branch}` : headRef(gitDir, fs)
  }
  const remote = (cfg.remote ?? '').trim() || 'origin'
  const short = branch || (headRef(gitDir, fs) ?? '').replace(/^refs\/heads\//, '')
  return short ? `refs/remotes/${remote}/${short}` : null
}

// â”€â”€ supervisor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class TriggerSupervisor {
  private readonly d: TriggerDeps
  private readonly projects = new Map<string, Project>()
  private readonly inFlight = new Set<string>()
  private ticker: unknown = null
  private running = false

  private readonly readBytes: ReadBytes

  constructor(deps: TriggerDeps) {
    this.d = deps
    this.readBytes = deps.readBytes ?? nodeReadBytes
  }

  get tickMs(): number {
    return this.d.tickMs ?? DEFAULT_TICK_MS
  }

  /** Number of workflows currently armed across all watched projects. */
  get armedCount(): number {
    let n = 0
    for (const p of this.projects.values()) n += p.armed.size
    return n
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleTick()
  }

  stop(): void {
    this.running = false
    if (this.ticker !== null) this.d.clearTimer(this.ticker)
    this.ticker = null
    for (const p of this.projects.values()) this.teardown(p)
    this.projects.clear()
  }

  private scheduleTick(): void {
    if (!this.running) return
    this.ticker = this.d.setTimer(() => {
      this.ticker = null
      // A throw here would kill the ticker and silently stop every trigger in
      // the app, so the whole pass is guarded and we always re-arm.
      try {
        this.tick()
      } catch (e) {
        this.log(`tick failed: ${(e as Error)?.message}`)
      }
      this.scheduleTick()
    }, this.tickMs)
  }

  /** Register a project directory. Idempotent â€” re-registering just re-arms. */
  watchProject(cwd: string): void {
    if (!cwd) return
    if (!this.projects.has(cwd)) {
      this.projects.set(cwd, {
        cwd,
        armed: new Map(),
        watcher: null,
        debounceTimer: null,
        state: {},
        stateDirty: false,
        warnedUntrusted: false,
      })
    }
    this.rearm(cwd)
  }

  unwatchProject(cwd: string): void {
    const p = this.projects.get(cwd)
    if (!p) return
    this.teardown(p)
    this.projects.delete(cwd)
  }

  private teardown(p: Project): void {
    try {
      p.watcher?.close()
    } catch {
      /* a watcher that already died is fine */
    }
    p.watcher = null
    if (p.debounceTimer !== null) this.d.clearTimer(p.debounceTimer)
    p.debounceTimer = null
  }

  /** Re-read a project's workflows from disk and arm the non-manual ones. */
  rearm(cwd: string): void {
    const p = this.projects.get(cwd)
    if (!p) return
    let workflows: Workflow[] = []
    try {
      workflows = listWorkflowsFull(workflowsDir(cwd), this.d.fs)
    } catch (e) {
      this.log(`could not list workflows in ${cwd}: ${(e as Error)?.message}`)
      return
    }
    p.state = this.loadState(cwd)
    p.armed.clear()

    for (const wf of workflows) {
      const type = wf.trigger?.type
      if (!type || type === 'manual') continue
      const cfg = wf.trigger.config ?? {}
      if (type === 'schedule') {
        const cron = parseCron(cfg.cron ?? '')
        if (!cron) {
          this.log(`workflow "${wf.name}" has an invalid cron (${JSON.stringify(cfg.cron ?? '')}) â€” not armed`)
          continue
        }
        // Seed on first arm so a cron that matched a minute ago doesn't fire
        // the instant you save the workflow.
        const st = (p.state[wf.id] ??= {})
        if (st.lastFiredAt === undefined) {
          st.lastFiredAt = this.d.now()
          p.stateDirty = true
        }
        p.armed.set(wf.id, { workflow: wf, cron, catchUp: cfg.catchUp !== '0' })
        continue
      }
      if (type === 'gitCommit' || type === 'gitPush') {
        p.armed.set(wf.id, { workflow: wf, catchUp: false })
        this.seedGit(p, wf)
        continue
      }
      if (type === 'fileWatch') {
        p.armed.set(wf.id, { workflow: wf, catchUp: false })
      }
    }

    this.syncWatcher(p)
    this.flushState(p)
  }

  /** Record the current sha for a git trigger without firing. Called on every
   *  arm, so a workflow only ever fires on a transition observed while armed. */
  private seedGit(p: Project, wf: Workflow): void {
    const st = (p.state[wf.id] ??= {})
    if (st.sha !== undefined) return
    const gitDir = gitDirOf(p.cwd, this.d.fs)
    if (!gitDir) return
    const ref = targetRef(wf, gitDir, this.d.fs)
    if (!ref) return
    const sha = resolveRef(gitDir, ref, this.d.fs, this.readBytes)
    if (!sha) return
    st.sha = sha
    st.ref = ref
    p.stateDirty = true
  }

  /** One watcher per project, shared by every fileWatch workflow in it. */
  private syncWatcher(p: Project): void {
    const wants = [...p.armed.values()].some(a => a.workflow.trigger.type === 'fileWatch')
    if (wants && !p.watcher) {
      try {
        p.watcher = this.d.watch(p.cwd, (_ev, filename) => this.onFileEvent(p, filename))
      } catch (e) {
        this.log(`could not watch ${p.cwd}: ${(e as Error)?.message}`)
        p.watcher = null
      }
    } else if (!wants && p.watcher) {
      this.teardown(p)
    }
  }

  private onFileEvent(p: Project, filename: string | null): void {
    if (!filename || IGNORE.test(filename)) return
    if (p.debounceTimer !== null) this.d.clearTimer(p.debounceTimer)
    const debounceMs = Math.max(
      ...[...p.armed.values()]
        .filter(a => a.workflow.trigger.type === 'fileWatch')
        .map(a => Number(a.workflow.trigger.config?.debounceMs) || (this.d.defaultDebounceMs ?? DEFAULT_DEBOUNCE_MS)),
      0,
    )
    p.debounceTimer = this.d.setTimer(() => {
      p.debounceTimer = null
      for (const a of p.armed.values()) {
        if (a.workflow.trigger.type !== 'fileWatch') continue
        if (!this.pathMatches(a.workflow, filename)) continue
        this.fire(p, a.workflow, `file change: ${filename}`)
      }
    }, debounceMs || DEFAULT_DEBOUNCE_MS)
  }

  /** `paths` is a comma-separated list of path prefixes, matched against the
   *  project-relative path with separators normalized. Empty = whole project. */
  private pathMatches(wf: Workflow, filename: string): boolean {
    const raw = (wf.trigger.config?.paths ?? '').trim()
    if (!raw) return true
    const norm = filename.replace(/\\/g, '/')
    return raw
      .split(',')
      .map(s => s.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(Boolean)
      .some(prefix => norm === prefix || norm.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || norm.startsWith(prefix))
  }

  /** One evaluation pass over every armed schedule and git trigger. */
  tick(): void {
    const now = this.d.now()
    for (const p of this.projects.values()) {
      for (const a of p.armed.values()) {
        const type = a.workflow.trigger.type
        if (type === 'schedule') this.checkSchedule(p, a, now)
        else if (type === 'gitCommit' || type === 'gitPush') this.checkGit(p, a)
      }
      this.flushState(p)
    }
  }

  private checkSchedule(p: Project, a: Armed, now: number): void {
    if (!a.cron) return
    const st = (p.state[a.workflow.id] ??= {})
    const last = st.lastFiredAt ?? now
    // Without catch-up we only look back far enough to cover the tick we may
    // have just missed; with it, a run due while the app was closed still fires.
    const lookback = a.catchUp ? MAX_CATCHUP_MS : this.tickMs * 3
    if (!dueSince(a.cron, last, now, lookback)) return
    this.fire(p, a.workflow, `schedule: ${a.workflow.trigger.config?.cron ?? ''}`)
  }

  private checkGit(p: Project, a: Armed): void {
    const wf = a.workflow
    const gitDir = gitDirOf(p.cwd, this.d.fs)
    if (!gitDir) return
    const ref = targetRef(wf, gitDir, this.d.fs)
    if (!ref) return
    const sha = resolveRef(gitDir, ref, this.d.fs, this.readBytes)
    if (!sha) return
    const st = (p.state[wf.id] ??= {})
    // Unseeded, or the ref itself changed (branch switch / checkout): adopt the
    // new position silently. Only movement OF THE SAME ref is a commit/push.
    if (st.sha === undefined || st.ref !== ref) {
      st.sha = sha
      st.ref = ref
      p.stateDirty = true
      return
    }
    if (st.sha === sha) return
    const what = wf.trigger.type === 'gitCommit' ? 'commit' : 'push'
    // Only adopt the new sha once the run actually started. If the workspace is
    // untrusted, a previous run is still going, or we're inside the refire
    // cooldown, the sha stays put and the next tick retries â€” a commit made
    // during a run is deferred, never dropped.
    if (this.fire(p, wf, `${what} on ${ref} â†’ ${sha.slice(0, 8)}`)) {
      st.sha = sha
      st.ref = ref
      p.stateDirty = true
    }
  }

  /**
   * Attempt a run. Returns false when the run was NOT started â€” the caller uses
   * that to leave its trigger state untouched so the same commit/push is retried
   * on the next tick instead of being silently swallowed.
   */
  private fire(p: Project, wf: Workflow, reason: string): boolean {
    const key = `${p.cwd}::${wf.id}`
    if (this.inFlight.has(key)) return false
    if (!this.d.isTrusted(p.cwd)) {
      if (!p.warnedUntrusted) {
        p.warnedUntrusted = true
        this.log(`${p.cwd} is not a trusted workspace â€” automatic runs are held`)
      }
      return false
    }
    p.warnedUntrusted = false
    const now = this.d.now()
    const st = (p.state[wf.id] ??= {})
    if (st.lastFiredAt !== undefined && now - st.lastFiredAt < MIN_REFIRE_MS) return false
    this.inFlight.add(key)
    this.log(`firing "${wf.name}" (${reason})`)
    let result: unknown
    try {
      result = this.d.fire(p.cwd, wf.id, reason)
    } catch (e) {
      this.inFlight.delete(key)
      this.log(`run of "${wf.name}" failed to start: ${(e as Error)?.message}`)
      return false
    }
    st.lastFiredAt = now
    p.stateDirty = true
    this.flushState(p)
    // Hold the guard until the run settles when `fire` gave us a promise;
    // otherwise release immediately and let MIN_REFIRE_MS do the throttling.
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      ;(result as Promise<unknown>).then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key),
      )
    } else {
      this.inFlight.delete(key)
    }
    return true
  }

  // â”€â”€ state persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private stateFile(cwd: string): string {
    return join(workflowsDir(cwd), STATE_FILE)
  }

  private loadState(cwd: string): ProjectState {
    const f = this.stateFile(cwd)
    try {
      if (!this.d.fs.existsSync(f)) return {}
      const parsed = JSON.parse(this.d.fs.readFileSync(f, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ProjectState) : {}
    } catch {
      // A corrupt state file must not wedge triggers â€” start clean. The seeding
      // path then re-adopts current shas without firing.
      return {}
    }
  }

  private flushState(p: Project): void {
    if (!p.stateDirty) return
    p.stateDirty = false
    try {
      const dir = workflowsDir(p.cwd)
      if (!this.d.fs.existsSync(dir)) this.d.fs.mkdirSync(dir, { recursive: true })
      this.d.fs.writeFileSync(this.stateFile(p.cwd), JSON.stringify(p.state, null, 2))
    } catch (e) {
      this.log(`could not persist trigger state for ${p.cwd}: ${(e as Error)?.message}`)
    }
  }

  private log(msg: string): void {
    this.d.log?.(`[workflow-trigger] ${msg}`)
  }
}
