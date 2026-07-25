import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { TriggerSupervisor } from '../../src/main/workflow/triggers'
import { workflowsDir, globalWorkflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import type { Workflow, WorkflowTriggerType } from '../../src/renderer/src/types'

// ---------------------------------------------------------------------------
// v1.32.1 — a GLOBAL workflow is one definition armed in every project the app
// is watching. The supervisor is where that fans out, and the fan-out is the
// part that can quietly go wrong in both directions: arm nowhere (the feature
// silently does nothing) or arm once against the wrong directory (a nightly
// job that touches whichever repo happened to be first). Both are pinned here.
//
// The state that makes a trigger fire — last sha, lastFiredAt — stays PER
// PROJECT, so the same nightly cron fires once per repo you have open.
// ---------------------------------------------------------------------------

const USER_DATA = join('/userdata')
const ALPHA = join('/repos/alpha')
const BETA = join('/repos/beta')
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const MIN = 60_000

// ── fakes ───────────────────────────────────────────────────────────────────

function makeFs() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const addDirs = (p: string) => {
    let d = dirname(p)
    while (d && d !== dirname(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    mkdirSync: (p: string) => {
      dirs.add(p)
      addDirs(p)
    },
    readdirSync: (d: string) => [...files.keys()].filter(k => dirname(k) === d).map(k => k.slice(d.length + 1)),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error(dirs.has(p) ? `EISDIR: ${p}` : `ENOENT: ${p}`)
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
  }
}

function wf(id: string, type: WorkflowTriggerType, config: Record<string, string> = {}): Workflow {
  return { id, name: `wf-${id}`, version: 1, trigger: { type, config }, steps: [] } as Workflow
}

/** Put a workflow in a project's own store. */
function installProject(fs: FakeFs, cwd: string, w: Workflow): void {
  fs.put(join(workflowsDir(cwd), `${w.id}.yml`), serializeWorkflow(w))
}

/** Put a workflow in the global (userData) store. */
function installGlobal(fs: FakeFs, w: Workflow): void {
  fs.put(join(globalWorkflowsDir(USER_DATA), `${w.id}.yml`), serializeWorkflow(w))
}

function installRepo(fs: FakeFs, cwd: string, branch = 'main', sha = SHA_A): void {
  const gitDir = join(cwd, '.git')
  fs.mkdir(gitDir)
  fs.put(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
  fs.put(join(gitDir, 'refs', 'heads', branch), `${sha}\n`)
}

function harness(opts: { globalDir?: string | undefined; trusted?: (cwd: string) => boolean; fireResult?: () => unknown } = {}) {
  const fs = makeFs()
  const timers = makeTimers()
  const fires: { cwd: string; id: string; reason: string; scope?: string }[] = []
  const logs: string[] = []
  const watchers: { dir: string; listener: (e: string, f: string | null) => void; closed: boolean }[] = []
  const state = { now: 1_000_000 }
  const sup = new TriggerSupervisor({
    fs: fs as never,
    readBytes: (p: string) => Buffer.from(fs.readFileSync(p)),
    watch: (dir, listener) => {
      const w = { dir, listener, closed: false }
      watchers.push(w)
      return { close() { w.closed = true } }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => state.now,
    isTrusted: (cwd: string) => (opts.trusted ? opts.trusted(cwd) : true),
    fire: (cwd, id, reason, scope) => {
      fires.push({ cwd, id, reason, scope })
      return opts.fireResult?.()
    },
    globalDir: 'globalDir' in opts ? opts.globalDir : USER_DATA,
    log: (m: string) => logs.push(m),
    tickMs: 15_000,
  })
  return { sup, fs, timers, fires, logs, watchers, state }
}

// ── arming ──────────────────────────────────────────────────────────────────

describe('global workflows arm in every watched project', () => {
  it('arms a global workflow in a project that has no workflows of its own', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    expect(h.sup.armedCount).toBe(1)
  })

  it('arms the SAME definition once per watched project', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    // One workflow, two projects → two arms, not one.
    expect(h.sup.armedCount).toBe(2)
  })

  it('fires once per project, each run standing in its OWN cwd', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.cwd).sort()).toEqual([ALPHA, BETA].sort())
    // Never the global store itself — the definition is shared, the run is not.
    expect(h.fires.some(f => f.cwd === USER_DATA)).toBe(false)
  })

  it('tells the run which store the definition came from', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([expect.objectContaining({ id: 'g', cwd: ALPHA, scope: 'global' })])
  })

  it('a project workflow still reports the project scope', () => {
    const h = harness()
    installProject(h.fs, ALPHA, wf('p', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([expect.objectContaining({ id: 'p', scope: 'project' })])
  })

  it('arms global and project workflows side by side in the same project', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    installProject(h.fs, ALPHA, wf('p', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    expect(h.sup.armedCount).toBe(2)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.id).sort()).toEqual(['g', 'p'])
  })

  it('with no globalDir wired, global workflows are simply not armed', () => {
    const h = harness({ globalDir: undefined })
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    installProject(h.fs, ALPHA, wf('p', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    expect(h.sup.armedCount).toBe(1)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.id)).toEqual(['p'])
  })

  it('an empty global store is not an error — the project still arms', () => {
    const h = harness()
    installProject(h.fs, ALPHA, wf('p', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    expect(h.sup.armedCount).toBe(1)
    expect(h.logs.join('\n')).not.toContain('global')
  })

  it('a manual global workflow arms nothing, exactly like a manual project one', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'manual'))
    h.sup.watchProject(ALPHA)
    expect(h.sup.armedCount).toBe(0)
  })

  it('an invalid global workflow file is skipped without taking the project down', () => {
    const h = harness()
    h.fs.put(join(globalWorkflowsDir(USER_DATA), 'broken.yml'), 'steps: [ this is not: valid: yaml')
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    installProject(h.fs, ALPHA, wf('p', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    expect(h.sup.armedCount).toBe(2)
  })
})

// ── per-project state ───────────────────────────────────────────────────────

describe('global trigger state stays per project', () => {
  it('a global gitCommit fires only for the repo that actually committed', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'gitCommit'))
    installRepo(h.fs, ALPHA)
    installRepo(h.fs, BETA)
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.sup.tick()
    expect(h.fires).toEqual([])

    // Only alpha moves.
    h.fs.put(join(ALPHA, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.sup.tick()
    expect(h.fires.map(f => f.cwd)).toEqual([ALPHA])
  })

  it('each project keeps its own last-seen sha, so beta fires later on its own commit', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'gitCommit'))
    installRepo(h.fs, ALPHA)
    installRepo(h.fs, BETA)
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.fs.put(join(ALPHA, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.sup.tick()
    h.fs.put(join(BETA, '.git', 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.sup.tick()
    expect(h.fires.map(f => f.cwd)).toEqual([ALPHA, BETA])
  })

  it('the trigger state file lives in each PROJECT, never in the global store', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '0 2 * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    expect(h.fs.files.has(join(workflowsDir(ALPHA), '.triggers.json'))).toBe(true)
    expect(h.fs.files.has(join(workflowsDir(BETA), '.triggers.json'))).toBe(true)
    expect(h.fs.files.has(join(globalWorkflowsDir(USER_DATA), '.triggers.json'))).toBe(false)
  })

  it('an in-flight run in one project does not block the same workflow in another', () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const h = harness({ fireResult: () => gate })
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.length).toBe(2)
    release()
  })

  it('untrusting one project holds only that project — the other still fires', () => {
    const h = harness({ trusted: (cwd) => cwd !== BETA })
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.cwd)).toEqual([ALPHA])
    expect(h.logs.join('\n')).toContain('not a trusted workspace')
  })
})

// ── save / delete fan-out ───────────────────────────────────────────────────

describe('rearmAll — saving a global workflow reaches every project', () => {
  it('picks up a newly saved global workflow in projects already being watched', () => {
    const h = harness()
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    expect(h.sup.armedCount).toBe(0)

    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.rearmAll()
    expect(h.sup.armedCount).toBe(2)
  })

  it('disarms everywhere when the global workflow is deleted', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    expect(h.sup.armedCount).toBe(2)

    h.fs.rmSync(join(globalWorkflowsDir(USER_DATA), 'g.yml'))
    h.sup.rearmAll()
    expect(h.sup.armedCount).toBe(0)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires).toEqual([])
  })

  it('rearmAll with nothing watched is a no-op, not a throw', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    expect(() => h.sup.rearmAll()).not.toThrow()
    expect(h.sup.armedCount).toBe(0)
  })

  it('a project opened AFTER the save arms the global workflow on first watch', () => {
    const h = harness()
    h.sup.watchProject(ALPHA)
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.rearmAll()
    h.sup.watchProject(BETA)
    expect(h.sup.armedCount).toBe(2)
  })

  it('unwatching a project stops its copy firing but leaves the others armed', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'schedule', { cron: '* * * * *' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.sup.unwatchProject(BETA)
    expect(h.sup.armedCount).toBe(1)
    h.state.now += MIN
    h.sup.tick()
    expect(h.fires.map(f => f.cwd)).toEqual([ALPHA])
  })
})

// ── fileWatch ───────────────────────────────────────────────────────────────

describe('global fileWatch', () => {
  it('watches each project directory, never the global store', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'fileWatch', { debounceMs: '500' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    expect(h.watchers.map(w => w.dir).sort()).toEqual([ALPHA, BETA].sort())
  })

  it('a change in alpha fires alpha only', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'fileWatch', { debounceMs: '500' }))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    const alpha = h.watchers.find(w => w.dir === ALPHA)!
    alpha.listener('change', 'src/index.ts')
    h.timers.flush()
    expect(h.fires.map(f => f.cwd)).toEqual([ALPHA])
    expect(h.fires[0].scope).toBe('global')
  })

  it('deleting the global fileWatch closes every project watcher', () => {
    const h = harness()
    installGlobal(h.fs, wf('g', 'fileWatch'))
    h.sup.watchProject(ALPHA)
    h.sup.watchProject(BETA)
    h.fs.rmSync(join(globalWorkflowsDir(USER_DATA), 'g.yml'))
    h.sup.rearmAll()
    expect(h.watchers.every(w => w.closed)).toBe(true)
  })
})
