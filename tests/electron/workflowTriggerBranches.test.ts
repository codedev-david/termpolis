import { describe, it, expect, vi, afterEach } from 'vitest'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { TriggerSupervisor, targetRef, type TriggerDeps } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import type { Workflow, WorkflowTriggerType } from '../../src/renderer/src/types'

// ---------------------------------------------------------------------------
// The ERROR and EDGE side of the trigger supervisor. workflowTriggers.test.ts
// owns the happy paths (a cron that comes due, a sha that moves, a file that
// changes); everything here is a path you only reach when the input is odd:
// a trigger with no config block at all, a detached HEAD, a state file with a
// null timestamp, a debounce the user typed a negative number into, an OS timer
// that lands after stop(), a trigger type this build has never heard of.
//
// Those are exactly the paths that stay unexercised until a user hits them in
// production, which is where a supervisor that throws takes every OTHER trigger
// in the app down with it.
// ---------------------------------------------------------------------------

// `listWorkflowsFull` is the ONLY way workflows reach the supervisor, and it
// validates trigger.type against this build's list before handing anything back.
// That makes "a workflow written by a newer Termpolis" impossible to stage
// through the store, so it is staged here instead. With the override unset the
// real implementation runs, so every other test in this file uses the real store.
const H = vi.hoisted(() => ({ listFullOverride: null as null | (() => unknown[]) }))

vi.mock('../../src/main/workflow/workflowStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflow/workflowStore')>()
  return {
    ...actual,
    listWorkflowsFull: (dir: string, fs: unknown, scope?: unknown) =>
      H.listFullOverride ? H.listFullOverride() : actual.listWorkflowsFull(dir, fs as never, scope as never),
  }
})

const ROOT = join('/repo')
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const MIN = 60_000

// -- fakes (mirrors workflowTriggers.test.ts so the two read the same) --------

function makeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const addDirs = (p: string) => {
    let d = dirname(p)
    while (d && d !== dirname(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  const api = {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    mkdirSync: (p: string) => {
      dirs.add(p)
      addDirs(p)
    },
    readdirSync: (d: string) =>
      [...files.keys()].filter(k => dirname(k) === d).map(k => k.slice(d.length + 1)),
    readFileSync: (p: string) => {
      if (!files.has(p)) {
        // Reading a directory throws EISDIR in Node - gitDirOf relies on that.
        throw new Error(dirs.has(p) ? `EISDIR: illegal operation on a directory, read ${p}` : `ENOENT: ${p}`)
      }
      return files.get(p)!
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
      addDirs(p)
    },
    appendFileSync: (p: string, data: string) => {
      files.set(p, (files.get(p) ?? '') + data)
      addDirs(p)
    },
    rmSync: (p: string) => {
      files.delete(p)
    },
    put(p: string, content: string) {
      files.set(p, content)
      addDirs(p)
    },
    mkdir(p: string) {
      dirs.add(p)
      addDirs(p)
    },
  }
  for (const [p, c] of Object.entries(seed)) api.put(p, c)
  return api
}
type FakeFs = ReturnType<typeof makeFs>

function makeTimers() {
  let seq = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (t: unknown) => {
      timers.delete(t as number)
    },
    flush() {
      for (const [id, t] of [...timers]) {
        timers.delete(id)
        t.fn()
      }
    },
    get pending() {
      return timers.size
    },
    /** ms the single pending timer was armed with. */
    get onlyMs() {
      const all = [...timers.values()]
      expect(all).toHaveLength(1)
      return all[0].ms
    },
    /** The callback of the single pending timer, WITHOUT consuming it. */
    peek() {
      const all = [...timers.values()]
      expect(all).toHaveLength(1)
      return all[0].fn
    },
  }
}

/** A workflow whose trigger has no `config` block at all when `config` is
 *  omitted - `trigger: {type: gitPush}` is a legal, validated workflow file. */
function wf(id: string, type: WorkflowTriggerType, config?: Record<string, string>): Workflow {
  return { id, name: `wf-${id}`, version: 1, trigger: config ? { type, config } : { type }, steps: [] }
}

function install(fs: FakeFs, cwd: string, w: Workflow): void {
  fs.put(join(workflowsDir(cwd), `${w.id}.yml`), serializeWorkflow(w))
}

/** A repo whose HEAD points at `branch` sitting at `sha`. */
function installRepo(fs: FakeFs, cwd: string, branch = 'main', sha = SHA_A): void {
  const gitDir = join(cwd, '.git')
  fs.mkdir(gitDir)
  fs.put(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
  fs.put(join(gitDir, 'refs', 'heads', branch), `${sha}\n`)
}

function harness(opts: { now?: number; deps?: Partial<TriggerDeps> } = {}) {
  const fs = makeFs()
  const timers = makeTimers()
  const fires: { cwd: string; id: string; reason: string }[] = []
  const logs: string[] = []
  const watchers: { dir: string; listener: (e: string, f: string | null) => void; closed: boolean }[] = []
  const state = { now: opts.now ?? 1_000_000 }
  const sup = new TriggerSupervisor({
    fs: fs as never,
    readBytes: (p: string) => Buffer.from(fs.readFileSync(p)),
    watch: (dir, listener) => {
      const w = { dir, listener, closed: false }
      watchers.push(w)
      return {
        close() {
          w.closed = true
        },
      }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => state.now,
    isTrusted: () => true,
    fire: (cwd, id, reason) => {
      fires.push({ cwd, id, reason })
    },
    log: (m: string) => logs.push(m),
    tickMs: 15_000,
    ...opts.deps,
  })
  return { sup, fs, timers, fires, logs, watchers, state }
}

const tmpDirs: string[] = []
function realTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tp-trigger-branches-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  H.listFullOverride = null
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// -- targetRef with no trigger config ----------------------------------------

describe('targetRef on a trigger with no config block', () => {
  it('falls back to HEAD and the default remote when `config` is absent entirely', () => {
    // `config` is optional in the schema, so a hand-written
    // `trigger: {type: gitPush}` reaches here as undefined rather than {}.
    // Every default (origin, HEAD's branch) has to survive that.
    const fs = makeFs()
    installRepo(fs, ROOT, 'main')
    const gd = join(ROOT, '.git')

    expect(wf('a', 'gitPush').trigger.config).toBeUndefined()
    expect(targetRef(wf('a', 'gitCommit'), gd, fs as never)).toBe('refs/heads/main')
    expect(targetRef(wf('a', 'gitPush'), gd, fs as never)).toBe('refs/remotes/origin/main')
  })
})

// -- optional deps ------------------------------------------------------------

describe('optional dependencies', () => {
  it('ticks on the built-in 15s interval when tickMs is not injected', () => {
    const withDefault = harness({ deps: { tickMs: undefined } })
    expect(withDefault.sup.tickMs).toBe(15_000)
    withDefault.sup.start()
    expect(withDefault.timers.onlyMs).toBe(15_000)

    // ...and an injected interval still wins, so the fallback is a fallback.
    const explicit = harness({ deps: { tickMs: 500 } })
    expect(explicit.sup.tickMs).toBe(500)
    explicit.sup.start()
    expect(explicit.timers.onlyMs).toBe(500)
  })

  it('reads packed-refs off the REAL filesystem when no readBytes is injected', () => {
    // Only packed-refs goes through `readBytes`; everything else uses the
    // injected FsLike. Dropping the injection has to leave the supervisor on
    // node's fs rather than on nothing - so this repo is half fake (the
    // workflow store, HEAD) and half real (packed-refs on disk), and the sha it
    // reports can only have come from the real file.
    const root = realTmpRepo()
    const realGitDir = join(root, '.git')
    mkdirSync(realGitDir, { recursive: true })
    const packed = (sha: string) => `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`
    writeFileSync(join(realGitDir, 'packed-refs'), packed(SHA_A))

    const h = harness({ deps: { readBytes: undefined, log: undefined } })
    h.fs.mkdir(realGitDir)
    h.fs.put(join(realGitDir, 'HEAD'), 'ref: refs/heads/main\n')
    h.fs.put(join(realGitDir, 'packed-refs'), 'ignored - the byte reader is the real one')
    // NB: no loose refs/heads/main on the fake disk, so resolution has to fall
    // through to packed-refs.
    install(h.fs, root, wf('p', 'gitCommit'))
    h.sup.watchProject(root)

    const stateFile = join(workflowsDir(root), '.triggers.json')
    expect(JSON.parse(h.fs.files.get(stateFile)!).p.sha).toBe(SHA_A)

    writeFileSync(join(realGitDir, 'packed-refs'), packed(SHA_B))
    h.state.now += MIN
    h.sup.tick()

    expect(h.fires.map(f => f.id)).toEqual(['p'])
    expect(h.fires[0].reason).toContain('refs/heads/main')
    expect(h.fires[0].reason).toContain(SHA_B.slice(0, 8))
  })
})

// -- arming ------------------------------------------------------------------

describe('arming a workflow the supervisor cannot use', () => {
  it('treats a schedule with NO config as an empty cron, and says so instead of arming it', () => {
    // A schedule saved before its cron was filled in has no config key at all.
    // `cfg.cron` is then undefined, and an undefined cron must land on the same
    // "invalid, not armed" path as a malformed one - never on a cron that
    // silently matches everything.
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule'))
    h.sup.watchProject(ROOT)

    expect(h.sup.armedCount).toBe(0)
    expect(h.logs.join('\n')).toContain('invalid cron ("")')

    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
  })

  it('skips a trigger type this build does not recognise', () => {
    // Workflow YAML is a user-editable file that a NEWER Termpolis may also
    // write. An unknown trigger type must be inert - not armed, no watcher, no
    // crash on the way past - so the rest of the project still arms.
    H.listFullOverride = () => [
      { id: 'future', name: 'from a newer build', version: 1, trigger: { type: 'webhook' as unknown as WorkflowTriggerType }, steps: [] },
    ]
    const h = harness()
    h.sup.watchProject(ROOT)

    expect(h.sup.armedCount).toBe(0)
    expect(h.watchers).toEqual([])
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
  })
})

// -- git triggers ------------------------------------------------------------

describe('git trigger on a detached HEAD', () => {
  it('neither seeds nor fires while HEAD is detached, and recovers once a branch is checked out', () => {
    // Mid-rebase / mid-bisect the ref a gitCommit trigger follows does not
    // exist, so both the seed and the tick have to bail before touching state.
    // Bailing must not be permanent: reattaching HEAD has to re-seed silently
    // (the commits made while detached are not "new") and fire only afterwards.
    const h = harness()
    const gitDir = join(ROOT, '.git')
    h.fs.mkdir(gitDir)
    h.fs.put(join(gitDir, 'HEAD'), `${SHA_A}\n`) // detached: a raw sha, no `ref:`
    h.fs.put(join(gitDir, 'refs', 'heads', 'main'), `${SHA_A}\n`)
    install(h.fs, ROOT, wf('c', 'gitCommit'))
    h.sup.watchProject(ROOT)

    // Nothing was resolvable, so nothing was written - an empty seed must not
    // masquerade as "this repo is at sha undefined".
    const stateFile = join(workflowsDir(ROOT), '.triggers.json')
    expect(h.fs.existsSync(stateFile)).toBe(false)
    expect(h.sup.armedCount).toBe(1)

    h.fs.put(join(gitDir, 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])

    // HEAD reattaches: the branch moved while we were blind, so this is a seed.
    h.fs.put(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
    expect(JSON.parse(h.fs.files.get(stateFile)!).c.sha).toBe(SHA_B)

    h.fs.put(join(gitDir, 'refs', 'heads', 'main'), `${SHA_C}\n`)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.id)).toEqual(['c'])
    expect(h.fires[0].reason).toContain(SHA_C.slice(0, 8))
  })
})

// -- schedule state ----------------------------------------------------------

describe('schedule with an unusable persisted timestamp', () => {
  it('reads a null lastFiredAt as "now" so it cannot trigger a phantom catch-up', () => {
    // `.triggers.json` is JSON on disk: a half-written or hand-edited file can
    // hold `lastFiredAt: null`. null is not undefined, so the arm-time seed
    // leaves it alone and it reaches the scheduler as-is. If it were read as 0,
    // an every-minute workflow with catch-up on would think it owed 14 days of
    // missed runs. The sibling workflow with a REAL timestamp proves the
    // no-fire is the null handling and not a dead scheduler.
    const base = 1_700_000_000_000
    const h = harness({ now: base })
    install(h.fs, ROOT, wf('bad', 'schedule', { cron: '* * * * *', catchUp: '1' }))
    install(h.fs, ROOT, wf('good', 'schedule', { cron: '* * * * *', catchUp: '1' }))
    h.fs.put(
      join(workflowsDir(ROOT), '.triggers.json'),
      JSON.stringify({ bad: { lastFiredAt: null }, good: { lastFiredAt: base } }),
    )
    h.sup.watchProject(ROOT)

    h.state.now = base + 60 * MIN // an hour of wall clock the app slept through
    h.sup.tick()

    expect(h.fires.map(f => f.id)).toEqual(['good'])
  })
})

// -- fileWatch ---------------------------------------------------------------

describe('fileWatch debounce edges', () => {
  it('falls back to the 2s default when the configured debounce is negative', () => {
    // debounceMs is a free-text field in the trigger config. A negative value
    // is truthy, so it survives the per-workflow default and only the Math.max
    // floor catches it - which must not then arm a 0ms timer that fires on the
    // very next tick of the event loop for every keystroke.
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch', { debounceMs: '-1' }))
    h.sup.watchProject(ROOT)

    h.watchers[0].listener('change', 'src/app.ts')
    expect(h.timers.onlyMs).toBe(2_000)

    h.timers.flush()
    expect(h.fires.map(f => f.id)).toEqual(['f'])
  })

  it('uses the injected default debounce when the workflow does not set one', () => {
    const h = harness({ deps: { defaultDebounceMs: 50 } })
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)

    h.watchers[0].listener('change', 'src/app.ts')
    expect(h.timers.onlyMs).toBe(50)
  })

  it('fires only the fileWatch workflows when the debounce lands', () => {
    // The debounce callback walks EVERY armed workflow in the project, so a
    // schedule sitting next to a fileWatch is one missing guard away from
    // running on every file save.
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)

    h.watchers[0].listener('change', 'src/app.ts')
    h.timers.flush()

    expect(h.fires.map(f => f.id)).toEqual(['f'])
  })

  it('cancels a debounce that is still in flight when the project is unwatched', () => {
    // Closing a project between the file event and the debounce expiring must
    // not leave a timer holding a run for a project nobody is watching.
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    h.sup.watchProject(ROOT)

    h.watchers[0].listener('change', 'src/app.ts')
    expect(h.timers.pending).toBe(1)

    h.sup.unwatchProject(ROOT)
    expect(h.timers.pending).toBe(0)
    expect(h.watchers[0].closed).toBe(true)

    h.timers.flush()
    expect(h.fires).toEqual([])
  })
})

// -- ticker ------------------------------------------------------------------

describe('ticker lifecycle edges', () => {
  it('does not re-arm itself when its callback lands after stop()', () => {
    // stop() clears the timer, but an OS timer that has already been handed to
    // the event loop still runs. If that late callback re-armed the ticker the
    // supervisor would keep polling for the rest of the session.
    const h = harness()
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)
    h.sup.start()

    const late = h.timers.peek()
    h.sup.stop()
    expect(h.timers.pending).toBe(0)

    h.state.now += MIN
    late()

    expect(h.timers.pending).toBe(0)
    expect(h.fires).toEqual([])
  })

  it('evaluates schedules on a tick but leaves fileWatch workflows to their watcher', () => {
    // fileWatch is event-driven; the ticker walking past it is what stops a
    // watched project from running its workflow every 15 seconds forever.
    const h = harness()
    install(h.fs, ROOT, wf('f', 'fileWatch'))
    install(h.fs, ROOT, wf('s', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ROOT)

    h.state.now += MIN
    h.sup.tick()

    expect(h.fires.map(f => f.id)).toEqual(['s'])
  })
})
