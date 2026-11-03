// TriggerSupervisor.tick() and the learning signals' poll look at where HEAD points, every 15 s per open repository.
// They read it with synchronous file calls on the main thread (four or five per repository per tick, each one measured
// at 8-56 ms p50 and up to 1.5 s p99 on a busy Windows laptop). They read it on the thread pool now. These run the
// REAL modules on a REAL temporary repository and COUNT: synchronous calls and spawns made from src/main during a tick
// (zero), commits noticed (one per commit), ticks that overlap (none).
// IMPORT ORDER: the counters first (they patch fs and child_process before the modules under test load).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TriggerSupervisor } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import { startLearningSignals, stopLearningSignals } from '../../src/main/learningSignals'
import { nodeAsyncFs } from '../../src/main/gitRefs'
import { offMainFiles } from '../../src/main/offMainFiles'
import type { Workflow } from '../../src/renderer/src/types'

const SHA = (c: string): string => c.repeat(40)

let root: string
const ref = (): string => path.join(root, '.git', 'refs', 'heads', 'main')
const commit = (c: string): void => fs.writeFileSync(ref(), SHA(c) + '\n')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trig-async-'))
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  commit('a')
})
afterEach(async () => {
  stopLearningSignals()
  await offMainFiles.idle()
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})
afterAll(() => { uninstall() })

function supervisor() {
  const fired: string[] = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const wf = { id: 'on-commit', name: 'on commit', version: 1, trigger: { type: 'gitCommit', config: {} }, steps: [] } as unknown as Workflow
  fs.mkdirSync(workflowsDir(root), { recursive: true })
  fs.writeFileSync(path.join(workflowsDir(root), 'on-commit.yml'), serializeWorkflow(wf))
  const sup = new TriggerSupervisor({
    fs: fs as never,
    fsAsync: nodeAsyncFs,
    watch: () => ({ close() { /* none */ } }),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t },
    clearTimer: (t) => { (t as { live: boolean }).live = false },
    now: () => Date.now(),
    isTrusted: () => true,
    fire: (_cwd, id, why) => { fired.push(`${id}: ${why}`); return undefined },
    tickMs: 15_000,
  })
  return { sup, fired, timers }
}

describe('the trigger supervisor tick reads git on the thread pool', () => {
  it('a commit is noticed once, and 50 quiet ticks make no synchronous call and no spawn (counted)', async () => {
    const { sup, fired } = supervisor()
    sup.watchProject(root) // arming reads the workflows (a user action / start-up): outside the counted window
    await sup.tick() // seeds the position silently
    expect(fired).toEqual([])
    arm()
    for (let i = 0; i < 50; i++) await sup.tick()
    expect(describeCounts(disarm())).toBe('')
    expect(fired).toEqual([])
    commit('b')
    await sup.tick()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatch(/on-commit: commit on refs\/heads\/main/)
    await sup.tick() // the same position again is not a second commit
    expect(fired).toHaveLength(1)
  })

  it('a branch switch adopts the new position silently (it is not a commit)', async () => {
    const { sup, fired } = supervisor()
    sup.watchProject(root)
    await sup.tick()
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'other'), SHA('c') + '\n')
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n')
    await sup.tick()
    expect(fired).toEqual([])
  })

  it('the scheduled tick re-arms only once a pass has finished: two passes never overlap', async () => {
    const { sup, timers } = supervisor()
    sup.start()
    expect(timers.filter((t) => t.live)).toHaveLength(1)
    const first = timers[0]
    first.live = false
    first.fn() // the timer fires: a pass starts and is reading on the pool
    expect(timers.filter((t) => t.live)).toHaveLength(0) // not re-armed yet
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(timers.filter((t) => t.live)).toHaveLength(1) // re-armed after the pass
    sup.stop()
  })

  it('a project closed while its refs were being read does not fire', async () => {
    const { sup, fired } = supervisor()
    sup.watchProject(root)
    await sup.tick()
    commit('d')
    const pass = sup.tick()
    sup.unwatchProject(root)
    await pass
    expect(fired).toEqual([])
  })

  it('a workflow still waiting its turn in a pass is skipped when its project was closed during the one before it', async () => {
    const { sup, fired } = supervisor()
    const second = { id: 'on-commit-2', name: 'second', version: 1, trigger: { type: 'gitCommit', config: {} }, steps: [] } as unknown as Workflow
    fs.writeFileSync(path.join(workflowsDir(root), 'on-commit-2.yml'), serializeWorkflow(second))
    sup.watchProject(root)
    await sup.tick() // seeds both
    commit('h')
    const pass = sup.tick()
    sup.unwatchProject(root) // closed while the first workflow's refs were being read
    await pass
    expect(fired).toEqual([]) // neither fired, and the second was not even looked at
  })

  it('persists its state on the thread pool when the app gives it an async fs', async () => {
    const { sup } = supervisor()
    sup.watchProject(root)
    await sup.tick()
    commit('e')
    arm()
    await sup.tick() // fires, marks the state dirty, flushes it
    expect(describeCounts(disarm())).toBe('')
    await offMainFiles.idle()
    const state = JSON.parse(fs.readFileSync(path.join(workflowsDir(root), '.triggers.json'), 'utf8'))
    expect(state['on-commit'].sha).toBe(SHA('e'))
  })
})

describe('the learning signals poll reads git on the thread pool', () => {
  function signals() {
    const emitted: string[] = []
    let tick: (() => void | Promise<void>) | null = null
    startLearningSignals({
      openProjects: () => [root],
      cwdForTerminal: () => root,
      normalizeProject: () => 'proj',
      emit: (e) => { emitted.push(e.kind) },
      subscribe: () => () => { /* none */ },
      fs: { existsSync: fs.existsSync, readFileSync: fs.readFileSync } as never,
      fsAsync: nodeAsyncFs,
      readBytes: (p) => fs.readFileSync(p),
      setInterval: (fn) => { tick = fn; return 0 as never },
      clearInterval: () => { tick = null },
    })
    return { emitted, tick: async () => { await tick?.() } }
  }

  it('a commit made in a terminal is one git-commit signal, and 50 quiet polls cost no synchronous call (counted)', async () => {
    const s = signals()
    await s.tick() // seeds
    arm()
    for (let i = 0; i < 50; i++) await s.tick()
    expect(describeCounts(disarm())).toBe('')
    expect(s.emitted).toEqual([])
    commit('f')
    await s.tick()
    expect(s.emitted).toEqual(['git-commit'])
    await s.tick()
    expect(s.emitted).toEqual(['git-commit'])
  })

  it('a poll whose run ended while it was reading the LAST file (the ref itself) drops its answer too', async () => {
    const emitted: string[] = []
    let tick: (() => void | Promise<void>) | null = null
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let held = false
    const gated = { ...nodeAsyncFs, readText: async (p: string) => {
      if (held && p.endsWith(path.join('refs', 'heads', 'main'))) await gate // the loose ref: the last read of a poll
      return nodeAsyncFs.readText(p)
    } }
    startLearningSignals({
      openProjects: () => [root], cwdForTerminal: () => root, normalizeProject: () => 'proj',
      emit: (e) => { emitted.push(e.kind) }, subscribe: () => () => { /* none */ },
      fs: { existsSync: fs.existsSync, readFileSync: fs.readFileSync } as never, fsAsync: gated,
      readBytes: (p) => fs.readFileSync(p), setInterval: (fn) => { tick = fn; return 0 as never }, clearInterval: () => { tick = null },
    })
    await tick!() // seeds: HEAD at a
    commit('i')
    held = true
    const reading = tick!() // stops at the ref read
    await new Promise<void>((r) => setTimeout(r, 20))
    stopLearningSignals() // the run ends with the poll holding a NEW sha
    release()
    await reading
    expect(emitted).toEqual([]) // the commit it found belongs to a run that is over
  })

  it('polls do not stack: a poll started while one is reading answers with the one in flight', async () => {
    const s = signals()
    const a = s.tick()
    const b = s.tick()
    await Promise.all([a, b])
    expect(s.emitted).toEqual([])
  })

  it('a poll that was reading when the run stopped does not write its answer into the next run', async () => {
    const first = signals()
    await first.tick() // seeded: HEAD at a
    commit('g')
    const reading = first.tick()
    stopLearningSignals() // the run ends while the poll is reading
    const second = signals()
    await reading
    await second.tick() // the new run seeds from the current position, silently
    expect(first.emitted).toEqual([])
    expect(second.emitted).toEqual([])
  })
})
