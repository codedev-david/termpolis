// fileWatch workflow triggers under the storm guard (src/main/workflow/triggers.ts + watchGuard.ts).
// The 100,000-event runs are in watcherFlood.test.ts; these are the single cases, on counters:
// workflow starts, the timer delay asked for, the reason string each start carries.
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { TriggerSupervisor, type TriggerDeps } from '../../src/main/workflow/triggers'
import { workflowsDir, serializeWorkflow } from '../../src/main/workflow/workflowStore'
import type { Workflow } from '../../src/renderer/src/types'

const ROOT = join('/repo')

function makeFs() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const addDirs = (p: string) => {
    let d = dirname(p)
    while (d && d !== dirname(d)) { dirs.add(d); d = dirname(d) }
  }
  return {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    mkdirSync: (p: string) => { dirs.add(p); addDirs(p) },
    readdirSync: (d: string) => [...files.keys()].filter((k) => dirname(k) === d).map((k) => k.slice(d.length + 1)),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error(dirs.has(p) ? 'EISDIR' : `ENOENT: ${p}`)
      return files.get(p)!
    },
    writeFileSync: (p: string, data: string) => { files.set(p, data); addDirs(p) },
    appendFileSync: (p: string, data: string) => { files.set(p, (files.get(p) ?? '') + data); addDirs(p) },
    rmSync: (p: string) => { files.delete(p) },
    put(p: string, c: string) { files.set(p, c); addDirs(p) },
  }
}

function setup(config: Record<string, string> = {}, deps: Partial<TriggerDeps> = {}) {
  const fs = makeFs()
  const wf = { id: 'f', name: 'wf-f', version: 1, trigger: { type: 'fileWatch', config }, steps: [] } as unknown as Workflow
  fs.put(join(workflowsDir(ROOT), 'f.yml'), serializeWorkflow(wf))
  const fires: { reason: string }[] = []
  const delays: number[] = []
  const timers = new Map<number, () => void>()
  let seq = 0
  let listener: (e: string, f: string | null) => void = () => {}
  const closed = { n: 0 }
  const clock = { now: 5_000_000 }
  const sup = new TriggerSupervisor({
    fs: fs as never,
    readBytes: (p: string) => Buffer.from(fs.readFileSync(p)),
    watch: (_dir, l) => { listener = l; return { close() { closed.n++ } } },
    setTimer: (fn, ms) => { const id = ++seq; delays.push(ms); timers.set(id, fn); return id },
    clearTimer: (t) => { timers.delete(t as number) },
    now: () => clock.now,
    isTrusted: () => true,
    fire: (_cwd, _id, reason) => { fires.push({ reason }); return undefined },
    probeNested: async () => false,
    ...deps,
  })
  sup.watchProject(ROOT)
  return {
    sup,
    fires,
    delays,
    closed,
    clock,
    emit: (n: string | null) => listener('change', n),
    flush: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn() },
    get armed() { return timers.size },
    get armedTotal() { return seq },
  }
}

describe('fileWatch trigger storm guard', () => {
  it.each([
    '.termpolis/workflows/.triggers.json', 'Pods/x/y.swift', '.turbo/x', 'node_modules/x/i.js', '.worktrees/wt1/src/a.ts',
    '.Worktrees\\wt1\\src\\a.ts', '.claude/worktrees/x/a.ts', 'dist/a.js', '.git/index',
  ])('ignores %s: nothing is armed and no workflow starts', (name) => {
    const h = setup()
    h.emit(name)
    expect(h.armedTotal).toBe(0)
    h.flush()
    expect(h.fires).toEqual([])
    h.sup.stop()
  })

  it('learns a nested repository from a .git event and stops reacting to what happens inside it', () => {
    const h = setup()
    h.emit('vendor/lib/.git/HEAD')
    h.emit('vendor/lib/src/a.ts')
    expect(h.armedTotal).toBe(0)
    h.emit('src/a.ts')
    h.flush()
    expect(h.fires).toHaveLength(1)
    h.sup.stop()
  })

  it('learns a nested repository from the disk (async probe)', async () => {
    const h = setup({}, { probeNested: async (abs) => abs.replace(/\\/g, '/').endsWith('/vendor/lib') })
    h.emit('vendor/lib/src/first.ts')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    h.flush()
    expect(h.fires).toHaveLength(1)
    h.clock.now += 10_000 // past the refire cooldown, so a start would show
    h.emit('vendor/lib/src/second.ts')
    h.flush()
    expect(h.fires).toHaveLength(1)
    h.sup.stop()
  })

  it('a burst is ONE timer and ONE pass, and the pass sees every file in it', () => {
    const h = setup({ paths: 'src/', debounceMs: '500' })
    h.emit('src/a.ts')
    for (let i = 0; i < 5000; i++) h.emit(`other/f${i % 40}.txt`)
    h.emit('README.md') // the burst ENDS on a file no workflow wants: the old code matched only this one
    expect(h.armedTotal).toBe(1)
    h.flush()
    expect(h.fires).toHaveLength(1)
    expect(h.fires[0].reason).toBe('file change: src/a.ts')
    h.sup.stop()
  })

  it('too many distinct names to remember (over 256) is answered the safe way: the workflow runs', () => {
    const h = setup({ paths: 'docs/' })
    for (let i = 0; i < 300; i++) h.emit(`src/gen/f${i}.ts`) // none of them is under docs/
    h.flush()
    expect(h.fires).toHaveLength(1)
    expect(h.fires[0].reason).toBe('file change: (many files)')
    // The next burst is an ordinary one again: no stuck overflow flag, and a real non-match stays a non-match.
    h.clock.now += 10_000
    h.emit('src/a.ts')
    h.flush()
    expect(h.fires).toHaveLength(1)
    h.sup.stop()
  })

  it('a workflow whose paths nothing matches does not run', () => {
    const h = setup({ paths: 'docs/' })
    h.emit('src/a.ts')
    h.flush()
    expect(h.fires).toEqual([])
    h.sup.stop()
  })

  it('never goes under the shared 2 s window, whatever debounce a workflow asks for', () => {
    const fast = setup({ debounceMs: '500' })
    fast.emit('src/a.ts')
    expect(fast.delays).toEqual([2000])
    fast.sup.stop()

    const none = setup({})
    none.emit('src/a.ts')
    expect(none.delays).toEqual([2000])
    none.sup.stop()

    const slow = setup({ debounceMs: '5000' })
    slow.emit('src/a.ts')
    expect(slow.delays).toEqual([5000]) // a longer one is the user's choice and is kept
    slow.sup.stop()
  })

  it('a caller that injects a SHORTER default debounce (tests) lowers the floor to it', () => {
    const h = setup({}, { defaultDebounceMs: 50 })
    h.emit('src/a.ts')
    expect(h.delays).toEqual([50])
    h.sup.stop()
  })

  it('stopping the project closes the watch, cancels the pending timer, and later events do nothing', () => {
    const h = setup()
    h.emit('src/a.ts')
    expect(h.armed).toBe(1)
    h.sup.unwatchProject(ROOT)
    expect(h.closed.n).toBe(1)
    expect(h.armed).toBe(0)
    h.emit('src/b.ts') // an event already queued by the OS
    expect(h.armed).toBe(0)
    h.flush()
    expect(h.fires).toEqual([])
  })
})
