// v1.54.5 (HP-1): the sidebar registers, and lists, the workflows of the ACTIVE terminal's project on every `cd` and
// every tab switch, whether the Workflows panel is open or not. In 1.54.4 each one was a run of synchronous opens on
// main (rearm: list both stores, load the state, seed git, flush; then workflow:list listed both stores again). With
// the app's wiring (listFs / fsAsync) they all go to the thread pool: these counters prove 0 synchronous calls, and the
// kill switch (no async wiring) still behaves as before.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as realFs from 'fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fsp } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TriggerSupervisor } from '../../src/main/workflow/triggers'
import { registerWorkflowIpc } from '../../src/main/workflow/ipc'
import { serializeWorkflow, listWorkflowsAsync, type AsyncListFs } from '../../src/main/workflow/workflowStore'

const SYNC = ['existsSync', 'mkdirSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'rmSync'] as const

function countingSyncFs() {
  const counts: Record<string, number> = {}
  const fs: any = {}
  for (const k of SYNC) fs[k] = (...a: unknown[]) => { counts[k] = (counts[k] ?? 0) + 1; return (realFs as any)[k](...a) }
  return { fs, counts, total: () => Object.values(counts).reduce((a, b) => a + b, 0) }
}

function countingAsyncFs() {
  const counts = { exists: 0, readdir: 0, readText: 0 }
  const fs: AsyncListFs = {
    exists: async (p) => { counts.exists++; try { await fsp.access(p); return true } catch { return false } },
    readdir: async (d) => { counts.readdir++; return fsp.readdir(d) },
    readText: async (p) => { counts.readText++; return fsp.readFile(p, 'utf8') },
  }
  return { fs, counts }
}

const wf = (id: string, trigger: any) => ({
  version: 1, id, name: id, trigger,
  steps: [{ id: 's1', type: 'command', name: 'S1', source: 'inline', command: 'echo hi' }],
})

let root: string
const projects: string[] = []
let userData: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wfcwd-'))
  userData = join(root, 'ud')
  mkdirSync(join(userData, 'workflows'), { recursive: true })
  writeFileSync(join(userData, 'workflows', 'g1.yml'), serializeWorkflow(wf('g1', { type: 'manual', config: {} }) as any))
  for (const name of ['a', 'b']) {
    const proj = join(root, name)
    projects.push(proj)
    mkdirSync(join(proj, '.termpolis', 'workflows'), { recursive: true })
    mkdirSync(join(proj, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(proj, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(proj, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n')
    const trig = [
      { type: 'gitCommit', config: { branch: 'main' } },
      { type: 'gitPush', config: { branch: 'main' } },
      { type: 'fileWatch', config: { paths: 'src' } },
      { type: 'schedule', config: { cron: '*/5 * * * *' } },
      { type: 'manual', config: {} },
    ]
    trig.forEach((t, i) => writeFileSync(join(proj, '.termpolis', 'workflows', `wf${i}.yml`), serializeWorkflow(wf(`wf${i}`, t) as any)))
  }
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function wire(async: boolean) {
  const sync = countingSyncFs()
  const afs = countingAsyncFs()
  let watches = 0
  const sup = new TriggerSupervisor({
    fs: sync.fs,
    fsAsync: async ? { exists: afs.fs.exists, readText: afs.fs.readText, readBytes: (p: string) => fsp.readFile(p) } : undefined,
    listFs: async ? afs.fs : undefined,
    readBytes: (p: string) => { sync.counts.readBytes = (sync.counts.readBytes ?? 0) + 1; return realFs.readFileSync(p) },
    watch: () => { watches++; return { close() {} } },
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 1_000_000,
    isTrusted: () => true,
    globalDir: userData,
    fire: () => undefined,
  })
  const handlers: Record<string, (e: unknown, a: any) => any> = {}
  registerWorkflowIpc({ handle: (ch, fn) => { handlers[ch] = fn } }, () => null, {
    fs: sync.fs,
    fsAsync: async ? afs.fs : undefined,
    engine: { runWorkflow: async () => ({}), cancelRun: () => {} },
    isTrusted: () => true,
    newRunId: () => 'r',
    makeDeps: () => ({}) as any,
    userDataDir: userData,
    onWatchProject: (cwd) => sup.watchProject(cwd),
  })
  // What the sidebar does on every change of the active terminal's cwd.
  const visit = async (cwd: string) => {
    await handlers['workflow:watch-project']({}, { cwd })
    return handlers['workflow:list']({}, { cwd })
  }
  return { sup, sync, afs, visit, watches: () => watches }
}

describe('a cwd change or tab switch costs main no synchronous file call (HP-1)', () => {
  it('first visit: lists both stores and arms the triggers with 0 sync calls', async () => {
    const w = wire(true)
    const res = await w.visit(projects[0])
    await w.sup.whenArmed(projects[0])
    expect(w.sync.total()).toBe(0)
    expect(res.success).toBe(true)
    expect(res.data.map((s: any) => s.id).sort()).toEqual(['g1', 'wf0', 'wf1', 'wf2', 'wf3', 'wf4'])
    // gitCommit, gitPush, fileWatch, schedule armed (manual is not), the git seeds were read, the file watch is up.
    expect(w.sup.armedCount).toBe(4)
    expect(w.watches()).toBe(1)
    w.sup.stop()
  })

  it('10 tab switches between two projects: 0 sync calls, and the arms are folded (not one per switch)', async () => {
    const w = wire(true)
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) pending.push(w.visit(projects[i % 2]))
    await Promise.all(pending)
    await Promise.all(projects.map(p => w.sup.whenArmed(p)))
    expect(w.sync.total()).toBe(0)
    expect(w.sup.armedCount).toBe(8)
    // 10 lists x 2 stores = 20 readdirs; the arms: at most 2 per project (one running, one queued) x 2 stores.
    expect(w.afs.counts.readdir).toBeLessThanOrEqual(20 + 2 * 2 * 2)
    w.sup.stop()
  })

  it('a project unwatched while its arm is reading arms nothing', async () => {
    const w = wire(true)
    w.sup.watchProject(projects[0])
    w.sup.unwatchProject(projects[0])
    await new Promise(r => setTimeout(r, 50))
    await w.sup.whenArmed(projects[0]) // not watched: settles at once
    expect(w.sup.armedCount).toBe(0)
    expect(w.watches()).toBe(0)
    w.sup.stop()
  })

  it('kill switch (no async wiring): the 1.54.4 synchronous reads, same answers', async () => {
    const w = wire(false)
    const res = await w.visit(projects[0])
    expect(res.data.map((s: any) => s.id).sort()).toEqual(['g1', 'wf0', 'wf1', 'wf2', 'wf3', 'wf4'])
    expect(w.sup.armedCount).toBe(4)
    expect(w.sync.total()).toBeGreaterThan(0)
    w.sup.stop()
  })
})

describe('a starting run reads its branch on the thread pool (HP-5)', () => {
  async function runOnce(withAsync: boolean, cwd: string) {
    const sync = countingSyncFs()
    const handlers: Record<string, (e: unknown, a: any) => any> = {}
    let seen: { branch?: string } | undefined
    let resolveRun!: () => void
    const ran = new Promise<void>(r => { resolveRun = r })
    const gitFs = { exists: async (p: string) => { try { await fsp.access(p); return true } catch { return false } }, readText: (p: string) => fsp.readFile(p, 'utf8'), readBytes: (p: string) => fsp.readFile(p) }
    registerWorkflowIpc({ handle: (ch, fn) => { handlers[ch] = fn } }, () => null, {
      fs: sync.fs, gitFsAsync: withAsync ? gitFs : undefined,
      engine: { runWorkflow: async (_wf, d: any) => { seen = { branch: d.scope.project.branch }; resolveRun(); return {} as any }, cancelRun: () => {} },
      isTrusted: () => true, newRunId: () => 'r1', makeDeps: () => ({}) as any, userDataDir: userData,
      appendHistory: () => {},
    })
    const res = await handlers['workflow:run']({}, { cwd, id: 'wf4', scope: 'project' })
    expect(res.success).toBe(true)
    await ran
    return { branch: seen?.branch, sync: sync.total() }
  }

  it('with the async reader: the branch is right and only the definition read is synchronous', async () => {
    const r = await runOnce(true, projects[0])
    expect(r.branch).toBe('main')
    expect(r.sync).toBe(2) // readWorkflow: existsSync + readFileSync
  })

  it('a folder that is not a repository has no branch', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'wfnogit-'))
    try {
      mkdirSync(join(proj, '.termpolis', 'workflows'), { recursive: true })
      writeFileSync(join(proj, '.termpolis', 'workflows', 'wf4.yml'), serializeWorkflow(wf('wf4', { type: 'manual', config: {} }) as any))
      expect((await runOnce(true, proj)).branch).toBeUndefined()
    } finally { rmSync(proj, { recursive: true, force: true }) }
  })

  it('without it (kill switch): the same branch from the synchronous plumbing', async () => {
    const r = await runOnce(false, projects[0])
    expect(r.branch).toBe('main')
    expect(r.sync).toBeGreaterThan(2)
  })
})

describe('the asynchronous arm and list: edges', () => {
  const quiet = () => ({ setTimer: () => 0, clearTimer: () => {}, now: () => 1_000_000, isTrusted: () => true, fire: () => undefined })
  const realAsync = (): AsyncListFs => ({
    exists: async (p) => { try { await fsp.access(p); return true } catch { return false } },
    readdir: (d) => fsp.readdir(d),
    readText: (p) => fsp.readFile(p, 'utf8'),
  })

  it('a stray file, an unsafe name, a broken document and a file gone before its read are all skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfedge-'))
    try {
      writeFileSync(join(dir, 'ok.yml'), serializeWorkflow(wf('ok', { type: 'manual', config: {} }) as any))
      writeFileSync(join(dir, 'notes.txt'), 'x')
      writeFileSync(join(dir, 'bad name.yml'), 'x')
      writeFileSync(join(dir, 'broken.yml'), ': : not a workflow')
      const afs = realAsync()
      const gone: AsyncListFs = { ...afs, readdir: async (d) => [...(await afs.readdir(d)), 'vanished.yml'] }
      expect((await listWorkflowsAsync(dir, gone, 'project')).map(s => s.id)).toEqual(['ok'])
      expect(await listWorkflowsAsync(join(dir, 'missing'), afs)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('workflow:list with no cwd lists only the global store, on the thread pool', async () => {
    const handlers: Record<string, (e: unknown, a: any) => any> = {}
    const sync = countingSyncFs()
    registerWorkflowIpc({ handle: (ch, fn) => { handlers[ch] = fn } }, () => null, {
      fs: sync.fs, fsAsync: realAsync(), engine: { runWorkflow: async () => ({}), cancelRun: () => {} },
      isTrusted: () => true, newRunId: () => 'r', makeDeps: () => ({}) as any, userDataDir: userData,
    })
    const res = await handlers['workflow:list']({}, { cwd: '' })
    expect(res.data.map((s: any) => s.id)).toEqual(['g1'])
    expect(sync.total()).toBe(0)
  })

  it('a listing that fails is logged and arms nothing; a failing global store still arms the project', async () => {
    const logs: string[] = []
    const failing: AsyncListFs = { ...realAsync(), readdir: async () => { throw new Error('EACCES') } }
    const sup = new TriggerSupervisor({ fs: countingSyncFs().fs, listFs: failing, watch: () => ({ close() {} }), log: (m) => logs.push(m), ...quiet() })
    sup.watchProject(projects[0])
    await sup.whenArmed(projects[0])
    expect(sup.armedCount).toBe(0)
    expect(logs.join('\n')).toMatch(/could not list workflows/)
    sup.stop()

    const logs2: string[] = []
    const ok = realAsync()
    const globalFails: AsyncListFs = { ...ok, readdir: async (d) => { if (d.startsWith(userData)) throw new Error('EACCES'); return ok.readdir(d) } }
    const sup2 = new TriggerSupervisor({ fs: countingSyncFs().fs, listFs: globalFails, globalDir: userData, watch: () => ({ close() {} }), log: (m) => logs2.push(m), ...quiet() })
    sup2.watchProject(projects[0])
    await sup2.whenArmed(projects[0])
    expect(sup2.armedCount).toBe(4)
    expect(logs2.join('\n')).toMatch(/could not list global workflows/)
    sup2.stop()
  })

  it('persisted state is read once (a seeded sha is kept, not re-read); a corrupt or non-object state starts clean', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'wfstate-'))
    try {
      mkdirSync(join(proj, '.termpolis', 'workflows'), { recursive: true })
      writeFileSync(join(proj, '.termpolis', 'workflows', 'c.yml'), serializeWorkflow(wf('c', { type: 'gitCommit', config: { branch: 'main' } }) as any))
      writeFileSync(join(proj, '.termpolis', 'workflows', '.triggers.json'), JSON.stringify({ c: { sha: 'b'.repeat(40), ref: 'refs/heads/main' } }))
      const afs = countingAsyncFs()
      const sup = new TriggerSupervisor({ fs: countingSyncFs().fs, listFs: afs.fs, fsAsync: { ...afs.fs, readBytes: (p: string) => fsp.readFile(p) }, watch: () => ({ close() {} }), ...quiet() })
      sup.watchProject(proj)
      await sup.whenArmed(proj)
      expect(sup.armedCount).toBe(1)
      const reads = afs.counts.readText
      sup.watchProject(proj)
      await sup.whenArmed(proj)
      // The second arm re-reads the one workflow, not the state (and no git: the sha is seeded).
      expect(afs.counts.readText - reads).toBe(1)
      sup.stop()

      for (const bad of ['[1,2]', '{not json']) {
        writeFileSync(join(proj, '.termpolis', 'workflows', '.triggers.json'), bad)
        const sup3 = new TriggerSupervisor({ fs: countingSyncFs().fs, listFs: realAsync(), watch: () => ({ close() {} }), ...quiet() })
        sup3.watchProject(proj)
        await sup3.whenArmed(proj)
        expect(sup3.armedCount).toBe(1)
        sup3.stop()
      }
    } finally { rmSync(proj, { recursive: true, force: true }) }
  })

  it('git seeds: a ref that cannot be named or resolved is skipped; a git read that throws is logged, never thrown', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'wfgit-'))
    try {
      mkdirSync(join(proj, '.termpolis', 'workflows'), { recursive: true })
      mkdirSync(join(proj, '.git'), { recursive: true })
      writeFileSync(join(proj, '.git', 'HEAD'), 'b'.repeat(40) + '\n') // detached: a gitPush with no branch has no ref
      writeFileSync(join(proj, '.termpolis', 'workflows', 'p.yml'), serializeWorkflow(wf('p', { type: 'gitPush', config: {} }) as any))
      writeFileSync(join(proj, '.termpolis', 'workflows', 'q.yml'), serializeWorkflow(wf('q', { type: 'gitCommit', config: { branch: 'nope' } }) as any))
      const sup = new TriggerSupervisor({ fs: countingSyncFs().fs, listFs: realAsync(), watch: () => ({ close() {} }), ...quiet() })
      sup.watchProject(proj)
      await sup.whenArmed(proj)
      expect(sup.armedCount).toBe(2)
      sup.stop()

      const logs: string[] = []
      const throwing = { exists: async () => { throw new Error('boom') }, readText: async () => '', readBytes: async () => new Uint8Array() }
      const sup2 = new TriggerSupervisor({ fs: countingSyncFs().fs, listFs: realAsync(), fsAsync: throwing, watch: () => ({ close() {} }), log: (m) => logs.push(m), ...quiet() })
      sup2.watchProject(proj)
      await sup2.whenArmed(proj)
      expect(logs.join('\n')).toMatch(/could not arm/)
      sup2.stop()
    } finally { rmSync(proj, { recursive: true, force: true }) }
  })
})
