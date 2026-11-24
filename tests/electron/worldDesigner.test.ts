import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDesigner, DESIGN_AGENT_FAILED, DESIGN_EMPTY, DESIGN_NOT_FOUND, DESIGN_OPEN_FAILED, DESIGN_REPLACED,
  DESIGN_KEY_RE, DESIGN_NOTHING_APPLIED, DESIGN_SAVE_FAILED, DesignFailure, layoutPlacer
} from '../../src/main/world/designer'
import { applyDesignPatch, emptyDesignDoc, type DesignOp } from '../../src/shared/world/designPatch'
import type { WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { districtRadius } from '../../src/main/world/layout'
import { createSourceRegistry, type SourceRegistry } from '../../src/main/world/sources'
import { createAnnotationStore, withAnnotations } from '../../src/main/world/annotations'
import { createWorldStore, type WorldStore } from '../../src/main/world/worldStore'
import type { ExecRequest, ExecResult } from '../../src/main/headlessExec'
import { ISOLATION_SETUP_FAILED } from '../../src/main/readOnlyIsolation'

const DRAFT_OPS: DesignOp[] = [
  { op: 'addDistrict', id: 'core', name: 'Core' },
  { op: 'addBuilding', id: 'api', districtId: 'core', name: 'Orders API', does: 'Takes orders.' },
  { op: 'addBuilding', id: 'db', districtId: 'core', name: 'Database' },
  { op: 'addEdge', from: 'api', to: 'db', label: 'stores orders' }
]
const reply = (text: string, ops: unknown): string => `${text}\n\`\`\`design-patch\n${JSON.stringify(ops)}\n\`\`\``
const okRes = (output: string): ExecResult => ({ ok: true, output }) as ExecResult

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-designer-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup(exec: (req: ExecRequest) => Promise<ExecResult>, over: { agent?: () => 'claude' | 'codex' | 'gemini'; runEnv?: () => Promise<{ env: Record<string, string>; baseUrl?: string }>; store?: WorldStore; registry?: SourceRegistry; designsDir?: string; timeoutMs?: number; now?: () => number } = {}) {
  const execFn = vi.fn(exec)
  const execDeps = { deliver: vi.fn() }
  const store = over.store ?? createWorldStore(dir)
  const registry = over.registry ?? createSourceRegistry(dir, { exists: async () => true, now: () => 7 })
  let n = 0
  const designer = createDesigner({
    exec: execFn as never, execDeps: execDeps as never, store, registry,
    agent: over.agent ?? (() => 'claude'), runEnv: over.runEnv ?? (async () => ({ env: {} })),
    designsDir: over.designsDir ?? join(dir, 'world', 'designs'), newId: () => `id${++n}`,
    timeoutMs: over.timeoutMs, now: over.now
  })
  return { designer, execFn, execDeps, store, registry }
}

const failure = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(DesignFailure)
  return (e as Error).message
}

/** A stored design keyed design:id1, made the way draft makes it. */
async function stored(store: WorldStore): Promise<WorldDoc> {
  const doc = applyDesignPatch(emptyDesignDoc('design:id1', 1), DRAFT_OPS, layoutPlacer).doc
  await store.save(doc)
  return doc
}

describe('createDesigner draft', () => {
  it('draft: exec called with write:false, noRemember:true, cwd under designsDir; registry gets kind design', async () => {
    const { designer, execFn, execDeps, registry, store } = setup(async () => okRes(reply('', DRAFT_OPS)))
    const res = await designer.draft('  A shop that takes orders  ')
    const [req, deps] = execFn.mock.calls[0] as [ExecRequest, unknown]
    const cwd = join(dir, 'world', 'designs', 'id1')
    expect(req).toMatchObject({ cwd, write: false, isolated: true, noRemember: true, noPrimer: true, timeoutMs: 90_000 })
    expect(req.signal).toBeInstanceOf(AbortSignal)
    expect(req.agent).toBe('claude')
    expect(req.model).toBeUndefined()
    expect(deps).toBe(execDeps)
    expect((deps as { primer?: unknown }).primer).toBeUndefined()
    expect((await stat(cwd)).isDirectory()).toBe(true)
    expect(req.task).toContain('A shop that takes orders')
    expect(req.task).toContain('There is no design yet')
    expect(req.task).not.toContain('DESIGN DATA (')
    expect(res.key).toBe('design:id1')
    expect(res.text).toBe('')
    expect(res.doc.buildings.map((b) => b.id)).toEqual(['api', 'db'])
    expect(validateWorld(res.doc).ok).toBe(true)
    expect(await store.load('design:id1')).toEqual(res.doc)
    expect((await registry.get('design:id1'))?.source).toEqual({ kind: 'design', id: 'id1', title: 'A shop that takes orders' })
    expect((await registry.get('design:id1'))?.title).toBe('A shop that takes orders')
  })

  it('clips a long description into a short title and keeps the agent text', async () => {
    const { designer, registry } = setup(async () => okRes(reply('A plan.', DRAFT_OPS)))
    const res = await designer.draft('A booking system for dog walkers with payments, reminders and reviews')
    expect(res.text).toBe('A plan.')
    expect((await registry.get(res.key))?.title).toBe('A booking system for dog walkers with p…')
  })

  it('a reply with no usable ops is an error and writes nothing', async () => {
    const { designer, registry, store } = setup(async () => okRes('I would build a shop.'))
    expect(await failure(designer.draft('A shop'))).toBe(DESIGN_EMPTY)
    expect(await store.load('design:id1')).toBeNull()
    expect(await registry.list()).toEqual([])
  })

  it('a run that could not be made safe shows the isolation sentence and writes nothing', async () => {
    const { designer, registry } = setup(async () => ({ ok: false, error: ISOLATION_SETUP_FAILED, output: '' }) as ExecResult)
    expect(await failure(designer.draft('A shop'))).toBe(ISOLATION_SETUP_FAILED)
    expect(await registry.list()).toEqual([])
  })

  it('an agent that fails or throws is a friendly error and writes nothing', async () => {
    const { designer, registry } = setup(async () => ({ ok: false, error: 'exit 1', output: '' }) as ExecResult)
    expect(await failure(designer.draft('A shop'))).toBe(DESIGN_AGENT_FAILED)
    const thrower = setup(async () => {
      throw new Error('boom')
    })
    expect(await failure(thrower.designer.draft('A shop'))).toBe(DESIGN_AGENT_FAILED)
    expect(await registry.list()).toEqual([])
  })

  it('drafts with the settings agent and model, the runEnv env and baseUrl, and without a primer', async () => {
    const runEnv = vi.fn(async () => ({ env: { A: '1' }, baseUrl: 'u' }))
    const { designer, execFn } = setup(async () => okRes(reply('', DRAFT_OPS)), { agent: () => 'codex', runEnv })
    await designer.draft('A shop', undefined, 'gpt-5.5-mini')
    expect(execFn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', model: 'gpt-5.5-mini', env: { A: '1' }, baseUrl: 'u', write: false, isolated: true, noRemember: true, noPrimer: true }),
      expect.anything()
    )
    expect(runEnv).toHaveBeenCalledWith('codex', join(dir, 'world', 'designs', 'id1'))
  })

  it('an unsafe model id is dropped, and a runEnv that throws is absorbed', async () => {
    const { designer, execFn } = setup(async () => okRes(reply('', DRAFT_OPS)), { runEnv: async () => { throw new Error('proxy down') } })
    await designer.draft('A shop', undefined, 'x; rm')
    const req = execFn.mock.calls[0][0] as ExecRequest
    expect('model' in req).toBe(false)
    expect(req.env).toEqual({})
    expect('baseUrl' in req).toBe(false)
  })

  it('a missing agent CLI answers the install message at once; a cancel during runEnv is replaced', async () => {
    const { designer } = setup(async () => ({ ok: false, error: 'spawn codex ENOENT', output: '' }) as ExecResult, { agent: () => 'codex' })
    expect(await failure(designer.draft('A shop'))).toBe("Codex isn't installed. Choose another agent in Settings › Lumopolis.")
    let release!: () => void
    const slow = setup(async () => okRes(reply('', DRAFT_OPS)), { runEnv: () => new Promise((r) => { release = () => r({ env: {} }) }) })
    const p = failure(slow.designer.draft('A shop', 'draft:t1'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(slow.designer.cancel('draft:t1')).toBe(true)
    release()
    expect(await p).toBe(DESIGN_REPLACED)
    expect(slow.execFn).not.toHaveBeenCalled()
  })

  it('refine passes the model too', async () => {
    const s = setup(async () => okRes(reply('ok', [])))
    await stored(s.store)
    await s.designer.refine('design:id1', 'more', '', 'opus')
    expect((s.execFn.mock.calls[0][0] as ExecRequest).model).toBe('opus')
  })

  it('a designs folder that cannot be made is a friendly error, and the agent never runs', async () => {
    await writeFile(join(dir, 'blocker'), 'x')
    const { designer, execFn } = setup(async () => okRes(reply('', DRAFT_OPS)), { designsDir: join(dir, 'blocker', 'designs') })
    expect(await failure(designer.draft('A shop'))).toBe(DESIGN_SAVE_FAILED)
    expect(execFn).not.toHaveBeenCalled()
  })

  it('a failed save is a friendly error', async () => {
    const real = createWorldStore(dir)
    const store: WorldStore = { ...real, save: async () => { throw new Error('EACCES: denied') } }
    const { designer, registry } = setup(async () => okRes(reply('', DRAFT_OPS)), { store })
    expect(await failure(designer.draft('A shop'))).toBe(DESIGN_SAVE_FAILED)
    expect(await registry.list()).toEqual([])
  })

  it('a registry that cannot record the design is a friendly error', async () => {
    const real = createSourceRegistry(dir, { exists: async () => true, now: () => 7 })
    const registry: SourceRegistry = { ...real, upsert: async () => { throw new Error('EPERM') } }
    const { designer } = setup(async () => okRes(reply('', DRAFT_OPS)), { registry })
    expect(await failure(designer.draft('A shop'))).toBe(DESIGN_SAVE_FAILED)
  })

  it('honours a custom timeout and clock', async () => {
    const { designer, execFn } = setup(async () => okRes(reply('', DRAFT_OPS)), { timeoutMs: 5000, now: () => 99 })
    const res = await designer.draft('A shop')
    expect((execFn.mock.calls[0][0] as ExecRequest).timeoutMs).toBe(5000)
    expect(res.doc.generatedAt).toBe(99)
  })
})

describe('createDesigner tokens', () => {
  it('a draft and a refine report the estimated tokens of the agent call', async () => {
    const out = reply('Sketched.', DRAFT_OPS)
    const { designer, execFn } = setup(async () => okRes(out))
    const draft = await designer.draft('A shop')
    const task = (execFn.mock.calls[0][0] as ExecRequest).task
    expect(draft.tokens).toBe(Math.ceil(task.length / 4) + Math.ceil(out.length / 4))
    const refined = await designer.refine(draft.key, 'Add a mailer', '')
    const task2 = (execFn.mock.calls[1][0] as ExecRequest).task
    expect(refined.tokens).toBe(Math.ceil(task2.length / 4) + Math.ceil(out.length / 4))
  })
})

describe('createDesigner refine', () => {
  it('refine applies ops, saves, returns counts', async () => {
    const ops = [
      { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' },
      { op: 'addBuilding', id: 'ghost', districtId: 'nowhere', name: 'Ghost' },
      'not an op'
    ]
    const { designer, execFn, store } = setup(async () => okRes(reply('Added a mailer. It sends receipts.', ops)), { now: () => 50 })
    const before = await stored(store)
    const res = await designer.refine('design:id1', 'Add something that emails receipts', 'Q: earlier\nA: yes.')
    expect(res.applied).toBe(1)
    expect(res.skipped).toBe(2)
    expect(res.text).toBe('Added a mailer. It sends receipts.')
    expect(res.summary).toBe('Q: earlier\nA: yes.\nQ: Add something that emails receipts\nA: Added a mailer.')
    expect(res.doc.generatedAt).toBe(50)
    expect(res.doc.buildings.map((b) => b.id)).toEqual(['api', 'db', 'mail'])
    for (const id of ['core', 'api', 'db']) expect(res.doc.layout.positions[id]).toEqual(before.layout.positions[id])
    expect(await store.load('design:id1')).toEqual(res.doc)
    const req = execFn.mock.calls[0][0] as ExecRequest
    expect(req).toMatchObject({ cwd: join(dir, 'world', 'designs', 'id1'), write: false, isolated: true, noRemember: true, noPrimer: true })
    expect(req.task).toContain('DESIGN DATA')
    expect(req.task).toContain('"id":"api"')
    expect(req.task).toContain('Takes orders.')
    expect(req.task).toContain('e-api--db')
    expect(req.task).toContain('Q: earlier')
    expect(req.task).toContain('Add something that emails receipts')
  })

  it('a reply that changes nothing returns the stored doc and writes nothing', async () => {
    const real = createWorldStore(dir)
    const save = vi.fn(real.save)
    const store: WorldStore = { ...real, save }
    const { designer } = setup(async () => okRes('Nothing to change.'), { store })
    const before = await stored(real)
    const res = await designer.refine('design:id1', 'Looks good', '')
    expect(res).toMatchObject({ applied: 0, skipped: 0, text: 'Nothing to change.', summary: 'Q: Looks good\nA: Nothing to change.' })
    expect(res.doc).toEqual(before)
    expect(save).not.toHaveBeenCalled()
  })

  it('exec failure → friendly error, doc unchanged', async () => {
    const { designer, store } = setup(async () => ({ ok: false, error: 'Timed out after 90000 ms', output: '' }) as ExecResult)
    const before = await stored(store)
    expect(await failure(designer.refine('design:id1', 'Add a cache', ''))).toBe(DESIGN_AGENT_FAILED)
    expect(await store.load('design:id1')).toEqual(before)
  })

  it('an unknown or malformed key is a friendly error and writes nothing', async () => {
    const { designer, execFn, store } = setup(async () => okRes(reply('', DRAFT_OPS)))
    for (const key of ['design:missing', 'design:../x', 'design:..', 'design:', 'C:/repo']) {
      expect(await failure(designer.refine(key, 'Add a cache', ''))).toBe(DESIGN_NOT_FOUND)
    }
    expect(execFn).not.toHaveBeenCalled()
    expect(await store.load('design:missing')).toBeNull()
  })

  it('a store that cannot load is a friendly error', async () => {
    const real = createWorldStore(dir)
    const store: WorldStore = { ...real, load: async () => { throw new Error('EPERM') } }
    const { designer } = setup(async () => okRes(''), { store })
    expect(await failure(designer.refine('design:id1', 'Add a cache', ''))).toBe(DESIGN_OPEN_FAILED)
  })

  it('a failed save during refine is a friendly error', async () => {
    const real = createWorldStore(dir)
    const store: WorldStore = { ...real, save: async () => { throw new Error('ENOSPC') } }
    const { designer } = setup(async () => okRes(reply('', [{ op: 'remove', id: 'db' }])), { store })
    await stored(real)
    expect(await failure(designer.refine('design:id1', 'Drop the database', ''))).toBe(DESIGN_SAVE_FAILED)
  })

  it.each([
    ['rejects', true],
    ['still answers', false]
  ])('a second refine for the same design cancels the first (the cancelled agent %s)', async (_label, rejects) => {
    let calls = 0
    const { designer, execFn, store } = setup((req) => {
      calls++
      if (calls === 1) {
        return new Promise<ExecResult>((res, rej) => req.signal?.addEventListener('abort', () => (rejects ? rej(new Error('aborted')) : res(okRes('late')))))
      }
      return Promise.resolve(okRes(reply('Renamed.', [{ op: 'rename', id: 'api', name: 'Checkout API' }])))
    })
    await stored(store)
    const first = failure(designer.refine('design:id1', 'Add a cache', ''))
    await vi.waitFor(() => expect(execFn).toHaveBeenCalledTimes(1))
    const second = await designer.refine('design:id1', 'Rename the API', '')
    expect(await first).toBe(DESIGN_REPLACED)
    expect((execFn.mock.calls[0][0] as ExecRequest).signal?.aborted).toBe(true)
    expect(second.applied).toBe(1)
    expect((await store.load('design:id1'))?.buildings[0].name).toBe('Checkout API')
  })

  it('keeps the prompt under 12,000 characters for a big design and a long summary, fencing the data', async () => {
    const { designer, execFn, store } = setup(async () => okRes(''))
    const ops: DesignOp[] = [{ op: 'addDistrict', id: 'core', name: 'Core ```' }]
    for (let i = 0; i < 150; i++) ops.push({ op: 'addBuilding', id: `b${i}`, districtId: 'core', name: `Building ${i}`, does: 'x'.repeat(200) })
    await store.save(applyDesignPatch(emptyDesignDoc('design:id1', 1), ops, layoutPlacer).doc)
    await designer.refine('design:id1', 'm'.repeat(4000), 's'.repeat(5000))
    const task = (execFn.mock.calls[0][0] as ExecRequest).task
    expect(task.length).toBeLessThanOrEqual(12_000)
    expect(task).toContain('````')
    expect(task).toContain('m'.repeat(4000))
    expect(task).toContain('s'.repeat(1200))
    expect(task).not.toContain('s'.repeat(1201))
    expect(task).toContain('Allowed changes')
  })
})

describe('createDesigner propose', () => {
  const noAgent = async (): Promise<ExecResult> => { throw new Error('propose never runs the agent') }

  it('by key: applies the ops without the agent, saves only when something applied, and counts the skips', async () => {
    const { designer, execFn, store } = setup(noAgent, { now: () => 60 })
    await stored(store)
    const res = await designer.propose({ key: 'design:id1' }, [
      { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }, { op: 'addBuilding', id: 'x', districtId: 'nowhere', name: 'X' }
    ])
    expect(res).toEqual({ key: 'design:id1', applied: 1, skipped: 1 })
    const saved = (await store.load('design:id1')) as WorldDoc
    expect(saved.generatedAt).toBe(60)
    expect(saved.buildings.map((b) => b.id)).toEqual(['api', 'db', 'mail'])
    expect(validateWorld(saved).ok).toBe(true)
    expect(await designer.propose({ key: 'design:id1' }, [{ op: 'nope' }])).toEqual({ key: 'design:id1', applied: 0, skipped: 1 })
    expect(((await store.load('design:id1')) as WorldDoc).buildings).toHaveLength(3)
    expect(execFn).not.toHaveBeenCalled()
  })

  it('by key: a bad key, a missing design and a read error are friendly failures', async () => {
    const { designer } = setup(noAgent)
    expect(DESIGN_KEY_RE.test('design:../x')).toBe(false)
    expect(await failure(designer.propose({ key: 'design:../x' }, []))).toBe(DESIGN_NOT_FOUND)
    expect(await failure(designer.propose({ key: 'design:none' }, []))).toBe(DESIGN_NOT_FOUND)
    const broken: WorldStore = { ...createWorldStore(dir), load: async () => { throw new Error('EIO') } }
    expect(await failure(setup(noAgent, { store: broken }).designer.propose({ key: 'design:id1' }, []))).toBe(DESIGN_OPEN_FAILED)
  })

  it('by folder: makes a new design linked to that folder and records it; nothing applicable makes nothing', async () => {
    const { designer, store, registry } = setup(noAgent, { now: () => 70 })
    const winRoot = 'C:\\repos\\shop\\'
    const res = await designer.propose({ linkRoot: winRoot }, [...DRAFT_OPS, { op: 'bogus' }])
    expect(res).toEqual({ key: 'design:id1', applied: 4, skipped: 1 })
    expect(((await store.load('design:id1')) as WorldDoc).generatedAt).toBe(70)
    expect((await registry.get('design:id1'))?.source).toEqual({ kind: 'design', id: 'id1', title: 'Plan for shop', linkedRoot: winRoot })
    expect((await designer.propose({ linkRoot: '/' }, DRAFT_OPS)).key).toBe('design:id2')
    expect((await registry.get('design:id2'))?.title).toBe('Plan for /')
    expect(await failure(designer.propose({ linkRoot: '/srv/app' }, [{ op: 'bogus' }]))).toBe(DESIGN_NOTHING_APPLIED)
    expect(await store.load('design:id3')).toBeNull()
  })
})

describe('createDesigner serialized writes', () => {
  const noAgent = async (): Promise<ExecResult> => { throw new Error('propose never runs the agent') }
  const add = (id: string): DesignOp[] => [{ op: 'addBuilding', id, districtId: 'core', name: id }]
  /** The real store, with a slow load: unserialized writers would both read the same stale copy. */
  const slowStore = (): WorldStore => {
    const real = createWorldStore(dir)
    return { ...real, load: async (k) => { const d = await real.load(k); await new Promise((r) => setTimeout(r, 15)); return d } }
  }

  it('two concurrent proposes on one key both persist', async () => {
    const store = slowStore()
    const { designer } = setup(noAgent, { store })
    await stored(store)
    const [a, b] = await Promise.all([designer.propose({ key: 'design:id1' }, add('mail')), designer.propose({ key: 'design:id1' }, add('search'))])
    expect([a.applied, b.applied]).toEqual([1, 1])
    expect(((await store.load('design:id1')) as WorldDoc).buildings.map((x) => x.id)).toEqual(['api', 'db', 'mail', 'search'])
  })

  it("a propose landing during a refine's agent run survives the refine's save", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    let started: () => void = () => undefined
    const running = new Promise<void>((r) => { started = r })
    const { designer, store } = setup(async () => {
      started()
      await gate
      return okRes(reply('Added search.', add('search')))
    })
    await stored(store)
    const refining = designer.refine('design:id1', 'Add search', '')
    await running
    expect(await designer.propose({ key: 'design:id1' }, add('mail'))).toEqual({ key: 'design:id1', applied: 1, skipped: 0 })
    release()
    const res = await refining
    expect(res.applied).toBe(1)
    expect(res.doc.buildings.map((x) => x.id)).toEqual(['api', 'db', 'mail', 'search'])
    expect(await store.load('design:id1')).toEqual(res.doc)
  })

  it('a failed write releases the lock: the next write on that key still runs', async () => {
    const real = createWorldStore(dir)
    let fails = 1
    const store: WorldStore = { ...real, save: async (d) => { if (fails-- > 0) throw new Error('EIO'); await real.save(d) } }
    const { designer } = setup(noAgent, { store })
    await real.save(applyDesignPatch(emptyDesignDoc('design:id1', 1), DRAFT_OPS, layoutPlacer).doc)
    const [first, second] = await Promise.allSettled([designer.propose({ key: 'design:id1' }, add('mail')), designer.propose({ key: 'design:id1' }, add('search'))])
    expect(first.status).toBe('rejected')
    expect((first as PromiseRejectedResult).reason.message).toBe(DESIGN_SAVE_FAILED)
    expect(second).toEqual({ status: 'fulfilled', value: { key: 'design:id1', applied: 1, skipped: 0 } })
    expect(((await real.load('design:id1')) as WorldDoc).buildings.map((x) => x.id)).toEqual(['api', 'db', 'search'])
  })
})

describe('layoutPlacer', () => {
  it('keeps given positions, slots new districts and puts new buildings inside their district', () => {
    const doc = applyDesignPatch(emptyDesignDoc('design:x', 1), [
      { op: 'addDistrict', id: 'a', name: 'A' },
      { op: 'addDistrict', id: 'b', name: 'B' },
      { op: 'addBuilding', id: 'a1', districtId: 'a', name: 'A1' },
      { op: 'addBuilding', id: 'a2', districtId: 'a', name: 'A2' },
      { op: 'addBuilding', id: 'b1', districtId: 'b', name: 'B1' }
    ], layoutPlacer).doc
    const p = doc.layout.positions
    expect(Math.hypot(p.a[0] - p.b[0], p.a[2] - p.b[2])).toBeGreaterThanOrEqual(35)
    for (const [id, d] of [['a1', 'a'], ['a2', 'a'], ['b1', 'b']]) {
      expect(Math.hypot(p[id][0] - p[d][0], p[id][2] - p[d][2])).toBeLessThanOrEqual(districtRadius(2))
    }
    const kept = { ...doc, layout: { seed: doc.layout.seed, positions: { a: p.a, a1: [1, 0, 1] as [number, number, number] } } }
    const out = layoutPlacer(kept)
    expect(out.a).toEqual(p.a)
    expect(out.a1).toEqual([1, 0, 1])
    expect(Object.keys(out).sort()).toEqual(['a', 'a1', 'a2', 'b', 'b1'])
  })
})

describe('createDesigner cancel', () => {
  /** An exec that waits until its request is aborted, then fails the way runHeadless does. */
  const hanging = (req: ExecRequest): Promise<ExecResult> =>
    new Promise((_resolve, reject) => { req.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })

  it('cancel(draftToken) aborts a running draft started with that token; nothing is stored or registered', async () => {
    const { designer, execFn, registry } = setup(hanging)
    const p = designer.draft('a shop', 'draft:t1')
    await vi.waitFor(() => expect(execFn).toHaveBeenCalled())
    expect(designer.cancel('draft:t1')).toBe(true)
    expect(await failure(p)).toBe(DESIGN_REPLACED)
    expect(await registry.list()).toEqual([])
  })

  it('cancel(designKey) aborts a running refine for that design', async () => {
    const { designer, execFn, store } = setup(hanging)
    await stored(store)
    const p = designer.refine('design:id1', 'add a cache', '')
    await vi.waitFor(() => expect(execFn).toHaveBeenCalled())
    expect(designer.cancel('design:id1')).toBe(true)
    expect(await failure(p)).toBe(DESIGN_REPLACED)
  })

  it('cancel of a key with nothing running is false; a draft without a token runs under its design key', async () => {
    const { designer, execFn } = setup(async () => okRes(reply('ok', DRAFT_OPS)))
    expect(designer.cancel('draft:none')).toBe(false)
    const r = await designer.draft('a shop')
    expect(r.key).toBe('design:id1')
    expect(execFn).toHaveBeenCalledTimes(1)
  })
})

describe('design worlds keep their annotations', () => {
  const confirm = { text: 'Takes orders.', state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'confirmed in Lumopolis' }] }

  it('a confirm landing while a refine runs is in the saved design, and a draft keeps one for its key too', async () => {
    const annotations = createAnnotationStore(dir)
    const inner = createWorldStore(dir)
    const store = withAnnotations(inner, annotations)
    const s = setup(async () => {
      await annotations.add('design:id1', 'api', confirm)
      return okRes(reply('ok', [{ op: 'rename', id: 'db', name: 'Orders DB' }]))
    }, { store })
    await stored(store)
    await s.designer.refine('design:id1', 'rename it', '')
    const raw = (await inner.load('design:id1')) as WorldDoc
    const api = raw.buildings.find((b) => b.id === 'api')!
    expect(api.claims.filter((c) => c.evidence.some((e) => e.kind === 'person'))).toEqual([confirm])
    expect(raw.buildings.find((b) => b.id === 'db')!.name).toBe('Orders DB')
  })

  it('reading after an out-of-band save still shows the confirm, once, and passes other keys through', async () => {
    const annotations = createAnnotationStore(dir)
    const inner = createWorldStore(dir)
    const store = withAnnotations(inner, annotations)
    const base = await stored(inner)
    await annotations.add('design:id1', 'api', confirm)
    const once = (await store.load('design:id1')) as WorldDoc
    await inner.save(once)
    const twice = (await store.load('design:id1')) as WorldDoc
    expect(twice.buildings.find((b) => b.id === 'api')!.claims.filter((c) => c.text === confirm.text)).toHaveLength(1)
    expect(await store.load('design:missing')).toBeNull()
    await store.save({ ...base, projectKey: 'C:/proj' })
    expect(((await inner.load('C:/proj')) as WorldDoc).buildings.every((b) => b.claims.length === 0)).toBe(true)
    expect(store.labelCache).toBe(inner.labelCache)
    // The stage cache methods pass straight through.
    expect(store.loadStages).toBe(inner.loadStages)
    expect(store.saveStages).toBe(inner.saveStages)
  })
})
