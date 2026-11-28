import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDesignPrompt, createDesigner, DESIGN_AGENT_FAILED, DESIGN_CHANGED, DESIGN_EMPTY, DESIGN_NOT_FOUND, DESIGN_OPEN_FAILED, DESIGN_REPLACED,
  DESIGN_KEY_RE, DESIGN_NEEDS_PERSON, DESIGN_NOTHING_APPLIED, DESIGN_SAVE_FAILED, DesignFailure, layoutPlacer
} from '../../src/main/world/designer'
import { applyDesignPatch, emptyDesignDoc, type DesignOp } from '../../src/shared/world/designPatch'
import type { Claim, WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { districtRadius } from '../../src/main/world/layout'
import { createSourceRegistry, type SourceRegistry } from '../../src/main/world/sources'
import { createAnnotationStore, NO_PART, withAnnotations, type AnnotationStore } from '../../src/main/world/annotations'
import { createWorldStore, WORLD_SAVED_BY_NEWER, type WorldStore } from '../../src/main/world/worldStore'
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

function setup(exec: (req: ExecRequest) => Promise<ExecResult>, over: { agent?: () => 'claude' | 'codex' | 'gemini'; runEnv?: () => Promise<{ env: Record<string, string>; baseUrl?: string }>; store?: WorldStore; registry?: SourceRegistry; designsDir?: string; timeoutMs?: number; now?: () => number; annotations?: Pick<AnnotationStore, 'add' | 'list'> } = {}) {
  const execFn = vi.fn(exec)
  const execDeps = { deliver: vi.fn() }
  const store = over.store ?? createWorldStore(dir)
  const registry = over.registry ?? createSourceRegistry(dir, { exists: async () => true, now: () => 7 })
  const annotations = over.annotations ?? createAnnotationStore(dir)
  let n = 0
  const designer = createDesigner({
    exec: execFn as never, execDeps: execDeps as never, store, registry,
    agent: over.agent ?? (() => 'claude'), runEnv: over.runEnv ?? (async () => ({ env: {} })),
    designsDir: over.designsDir ?? join(dir, 'world', 'designs'), newId: () => `id${++n}`,
    timeoutMs: over.timeoutMs, now: over.now, annotations
  })
  return { designer, execFn, execDeps, store, registry, annotations }
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

  it('refuses an agent removing a district that still has buildings, applying none of that change; an empty district goes (DSN 2026-11-28)', async () => {
    expect(DESIGN_NEEDS_PERSON).toBe(
      "Removing a district that has buildings needs the person's OK, so Lumopolis didn't make this change. Ask them to make it in the Change the design box."
    )
    const { designer, store, registry } = setup(noAgent, { now: () => 80 })
    const before = await stored(store)
    // The other edits in the same change are not applied either, and nothing waits on a pane.
    expect(await failure(designer.propose({ key: 'design:id1' }, [
      { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }, { op: 'remove', id: 'core' }
    ]))).toBe(DESIGN_NEEDS_PERSON)
    expect(await store.load('design:id1')).toEqual(before)
    // A district with nothing in it is removed as before.
    expect(await designer.propose({ key: 'design:id1' }, [{ op: 'addDistrict', id: 'spare', name: 'Spare' }])).toEqual({ key: 'design:id1', applied: 1, skipped: 0 })
    expect(await designer.propose({ key: 'design:id1' }, [{ op: 'remove', id: 'spare' }])).toEqual({ key: 'design:id1', applied: 1, skipped: 0 })
    const after = (await store.load('design:id1')) as WorldDoc
    expect(after.districts.map((d) => d.id)).toEqual(['core'])
    expect(after.buildings.map((b) => b.id)).toEqual(['api', 'db'])
    // A new design whose ops fill a district and then remove it makes no design and records nothing.
    expect(await failure(designer.propose({ linkRoot: '/srv/app' }, [...DRAFT_OPS, { op: 'remove', id: 'core' }]))).toBe(DESIGN_NEEDS_PERSON)
    expect(await store.load('design:id2')).toBeNull()
    expect(await registry.get('design:id2')).toBeNull()
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

describe('buildDesignPrompt on a big design (D7)', () => {
  it('fits the lines in a few passes, not one pass per line dropped', () => {
    const doc = emptyDesignDoc('design:big', 1)
    doc.districts.push({ id: 'core', name: 'Core', subtitle: '', hue: 0, members: [], nameState: 'observed' })
    for (let i = 0; i < 3000; i++) {
      doc.buildings.push({
        id: `b${i}`, districtId: 'core', name: `Building ${i}`, techLabel: '', process: '', floors: [], stack: [],
        how: [{ text: 'x'.repeat(100), state: 'proposed', evidence: [] }], why: [], status: 'proposed', members: [], claims: [], nameState: 'observed'
      })
    }
    // Every pass joins the shown lines once; dropping one line per pass made thousands of passes over thousands of lines.
    const join = vi.spyOn(Array.prototype, 'join')
    let prompt: string
    let joins: number
    try {
      prompt = buildDesignPrompt(doc, 'Add a cache', '')
    } finally {
      // A join over many lines is one pass over the shown parts; the short joins build each part's own line.
      joins = join.mock.contexts.filter((list) => (list as unknown[]).length > 100).length
      join.mockRestore()
    }
    expect(joins).toBeLessThan(30)
    expect(prompt.length).toBeLessThanOrEqual(12_000)
    const shown = prompt.split('\n').filter((l) => l.startsWith('{"building"')).length
    expect(prompt).toContain(`(${3000 - shown} more parts not shown)`)
    expect(shown).toBeGreaterThan(0)
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

  /** The real store, with load calls held until the test lets each one go. */
  const gatedStore = () => {
    const real = createWorldStore(dir)
    const gates: Array<() => void> = []
    const store: WorldStore = { ...real, load: vi.fn(async (key: string) => { await new Promise<void>((r) => gates.push(r)); return real.load(key) }) }
    return { real, store, gates, save: vi.spyOn(real, 'save') }
  }

  it('a refine cancelled while its design is still being opened never runs and never saves (U3)', async () => {
    const g = gatedStore()
    await stored(g.real)
    const { designer, execFn } = setup(async () => okRes(reply('ok', DRAFT_OPS)), { store: g.store })
    g.save.mockClear()
    const p = designer.refine('design:id1', 'add a cache', '')
    await vi.waitFor(() => expect(g.gates).toHaveLength(1))
    expect(designer.cancel('design:id1')).toBe(false) // nothing runs yet, and the cancel still counts
    g.gates[0]()
    expect(await failure(p)).toBe(DESIGN_REPLACED)
    expect(execFn).not.toHaveBeenCalled()
    expect(g.save).not.toHaveBeenCalled()
  })

  it('a refine cancelled after its agent answered but before the save never saves (U3)', async () => {
    const g = gatedStore()
    await stored(g.real)
    const { designer, execFn } = setup(async () => okRes(reply('ok', [{ op: 'addBuilding', id: 'cache', districtId: 'core', name: 'Cache' }])), { store: g.store })
    g.save.mockClear()
    const p = designer.refine('design:id1', 'add a cache', '')
    await vi.waitFor(() => expect(g.gates).toHaveLength(1))
    g.gates[0]()
    await vi.waitFor(() => expect(g.gates).toHaveLength(2)) // the run is over: the save's own load waits
    expect(execFn).toHaveBeenCalledTimes(1)
    designer.cancel('design:id1')
    g.gates[1]()
    expect(await failure(p)).toBe(DESIGN_REPLACED)
    expect(g.save).not.toHaveBeenCalled()
    expect((await g.real.load('design:id1'))?.buildings.some((b) => b.id === 'cache')).toBe(false)
  })

  it('an older refine still opening its design gives way to a newer one for the same design (U3)', async () => {
    const g = gatedStore()
    await stored(g.real)
    const { designer, execFn } = setup(async () => okRes(reply('ok', [{ op: 'addBuilding', id: 'cache', districtId: 'core', name: 'Cache' }])), { store: g.store })
    const older = designer.refine('design:id1', 'old', '')
    await vi.waitFor(() => expect(g.gates).toHaveLength(1))
    const newer = designer.refine('design:id1', 'new', '')
    await vi.waitFor(() => expect(g.gates).toHaveLength(2))
    g.gates[0]()
    expect(await failure(older)).toBe(DESIGN_REPLACED)
    g.gates[1]()
    await vi.waitFor(() => expect(g.gates).toHaveLength(3))
    g.gates[2]()
    expect((await newer).applied).toBe(1)
    expect(execFn).toHaveBeenCalledTimes(1)
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

/** An agent that waits for `release()` before answering with `ops`; `running` settles once it has started. */
function heldAgent(ops: unknown) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => { release = r })
  let started: () => void = () => undefined
  const running = new Promise<void>((r) => { started = r })
  const exec = async (): Promise<ExecResult> => {
    started()
    await gate
    return okRes(reply('Done.', ops))
  }
  return { exec, running, release: () => release() }
}

const person = (text: string) => ({ text, state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'confirmed in Lumopolis' }] })
const personClaims = (doc: WorldDoc, id: string) =>
  [...doc.buildings, ...doc.edges].find((p) => p.id === id)!.claims.filter((c) => c.evidence.some((e) => e.kind === 'person'))
const noRun = async (): Promise<ExecResult> => { throw new Error('no agent run') }

describe('design annotations are written by the designer, under the design lock (D1)', () => {
  /** The real store, with a slow load: a writer outside the lock would read the copy another writer is replacing. */
  const slowStore = (): WorldStore => {
    const real = createWorldStore(dir)
    return { ...real, load: async (k) => { const d = await real.load(k); await new Promise((r) => setTimeout(r, 15)); return d } }
  }

  it('an annotation saved while a propose saves keeps both: the confirm and the new building', async () => {
    const store = slowStore()
    const { designer } = setup(noRun, { store })
    await stored(store)
    const [doc] = await Promise.all([
      designer.annotate('design:id1', 'api', person('Takes orders.')),
      designer.propose({ key: 'design:id1' }, [{ op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }])
    ])
    expect(personClaims(doc, 'api')).toEqual([person('Takes orders.')])
    const saved = (await store.load('design:id1')) as WorldDoc
    expect(saved.buildings.map((b) => b.id)).toEqual(['api', 'db', 'mail'])
    expect(personClaims(saved, 'api')).toEqual([person('Takes orders.')])
  })

  it("an annotation made while a refine's agent runs, then the refine's save, keeps both", async () => {
    const agent = heldAgent([{ op: 'rename', id: 'db', name: 'Orders DB' }])
    const { designer, store } = setup(agent.exec)
    await stored(store)
    const refining = designer.refine('design:id1', 'Rename the database', '')
    await agent.running
    const annotated = await designer.annotate('design:id1', 'e-api--db', person('Writes each order.'))
    expect(personClaims(annotated, 'e-api--db')).toEqual([person('Writes each order.')])
    agent.release()
    expect((await refining).applied).toBe(1)
    const saved = (await store.load('design:id1')) as WorldDoc
    expect(saved.buildings.find((b) => b.id === 'db')!.name).toBe('Orders DB')
    expect(personClaims(saved, 'e-api--db')).toEqual([person('Writes each order.')])
  })

  it('returns a newer generation, even when the clock is behind the saved one', async () => {
    const { designer, store } = setup(noRun, { now: () => 0 })
    const before = await stored(store)
    const doc = await designer.annotate('design:id1', 'api', person('Takes orders.'))
    expect(doc.generatedAt).toBe(before.generatedAt + 1)
    expect(((await store.load('design:id1')) as WorldDoc).generatedAt).toBe(before.generatedAt + 1)
    const later = setup(noRun, { now: () => 5000 })
    expect((await later.designer.annotate('design:id1', 'db', person('Holds orders.'))).generatedAt).toBe(5000)
  })

  it('refuses a key that is not a stored design, a part it does not have, and a design it cannot open, writing nothing', async () => {
    const add = vi.fn(async () => undefined)
    const { designer, store } = setup(noRun, { annotations: { add, list: async () => ({}) } })
    await stored(store)
    for (const key of ['design:missing', 'design:..', 'C:/repo']) expect(await failure(designer.annotate(key, 'api', person('x')))).toBe(DESIGN_NOT_FOUND)
    expect(await failure(designer.annotate('design:id1', 'nope', person('x')))).toBe(NO_PART)
    const broken = setup(noRun, { store: { ...createWorldStore(dir), load: async () => { throw new Error('EPERM') } }, annotations: { add, list: async () => ({}) } })
    expect(await failure(broken.designer.annotate('design:id1', 'api', person('x')))).toBe(DESIGN_OPEN_FAILED)
    expect(add).not.toHaveBeenCalled()
  })

  it('a failed annotation write or design save is a friendly error', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const noAdd = setup(noRun, { annotations: { add: async () => { throw new Error('EIO') }, list: async () => ({}) } })
    expect(await failure(noAdd.designer.annotate('design:id1', 'api', person('x')))).toBe(DESIGN_SAVE_FAILED)
    const noSave = setup(noRun, { store: { ...real, save: async () => { throw new Error('ENOSPC') } } })
    expect(await failure(noSave.designer.annotate('design:id1', 'api', person('x')))).toBe(DESIGN_SAVE_FAILED)
    // A note that is not well formed is refused before the design is saved, so nothing is written.
    const save = vi.fn(real.save)
    const bad = setup(noRun, { store: { ...real, save } })
    expect(await failure(bad.designer.annotate('design:id1', 'api', { text: 'x', state: 'verified', evidence: [] }))).toBe(DESIGN_SAVE_FAILED)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('a refine never overwrites a change made to the parts it names after its agent read them (D2)', () => {
  it.each<[string, DesignOp[], DesignOp[]]>([
    ['a rename of the building it describes', [{ op: 'rename', id: 'api', name: 'Checkout API' }], [{ op: 'describe', id: 'api', does: 'Takes payments.' }]],
    ['a building added to the district it removes', [{ op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }], [{ op: 'remove', id: 'core' }]],
    ['a line added to the building it removes', [{ op: 'addEdge', from: 'db', to: 'api', label: 'replies' }], [{ op: 'remove', id: 'api' }]],
    ['a district added that it moves a building into', [{ op: 'addDistrict', id: 'edge', name: 'Edge' }], [{ op: 'move', id: 'api', districtId: 'edge' }]],
    ['a building removed that it draws a line from', [{ op: 'remove', id: 'db' }], [{ op: 'addEdge', from: 'db', to: 'api', label: 'replies' }]],
    // DSN Round 1, item 3: what goes with a removed district, service names, and the lines between the parts it names.
    ['a rename of a building in the district it removes', [{ op: 'rename', id: 'api', name: 'Checkout API' }], [{ op: 'remove', id: 'core' }]],
    ['a line added between buildings of the district it removes', [{ op: 'addEdge', from: 'db', to: 'api', label: 'replies' }], [{ op: 'remove', id: 'core' }]],
    ['service names set on a building of the district it removes', [{ op: 'setRuntimeNames', id: 'api', names: ['orders-api'] }], [{ op: 'remove', id: 'core' }]],
    ['service names set on the building it removes', [{ op: 'setRuntimeNames', id: 'api', names: ['orders-api'] }], [{ op: 'remove', id: 'api' }]],
    ['service names set on the building it sets them on', [{ op: 'setRuntimeNames', id: 'api', names: ['other'] }], [{ op: 'setRuntimeNames', id: 'api', names: ['agent'] }]],
    ['the line it adds, made meanwhile', [{ op: 'addEdge', from: 'db', to: 'api', label: 'Other' }], [{ op: 'rename', id: 'db', name: 'Should not apply' }, { op: 'addEdge', from: 'db', to: 'api', label: 'Agent' }]],
    ['a line added between two buildings it renames', [{ op: 'addEdge', from: 'db', to: 'api', label: 'replies' }], [{ op: 'rename', id: 'api', name: 'A' }, { op: 'rename', id: 'db', name: 'B' }]]
  ])('%s: the refine applies nothing and asks for a try again', async (_label, meanwhile, ops) => {
    const agent = heldAgent(ops)
    const { designer, store } = setup(agent.exec)
    await stored(store)
    const refining = failure(designer.refine('design:id1', 'Change it', ''))
    await agent.running
    expect((await designer.propose({ key: 'design:id1' }, meanwhile)).applied).toBe(1)
    const afterPropose = await store.load('design:id1')
    agent.release()
    expect(await refining).toBe(DESIGN_CHANGED)
    expect(await store.load('design:id1')).toEqual(afterPropose)
  })

  it('a confirm or service names added meanwhile to a part it names are not a change to that part', async () => {
    const agent = heldAgent([{ op: 'describe', id: 'api', does: 'Takes payments.' }])
    const { designer, store } = setup(agent.exec)
    await stored(store)
    const refining = designer.refine('design:id1', 'Describe it', '')
    await agent.running
    await designer.annotate('design:id1', 'api', person('Takes orders.'))
    await designer.propose({ key: 'design:id1' }, [{ op: 'setRuntimeNames', id: 'api', names: ['orders-api'] }])
    agent.release()
    expect((await refining).applied).toBe(1)
    const saved = (await store.load('design:id1')) as WorldDoc
    expect(saved.buildings.find((b) => b.id === 'api')!.how.map((c) => c.text)).toEqual(['Takes payments.'])
    expect(personClaims(saved, 'api')).toEqual([person('Takes orders.')])
    expect(saved.runtimeNames?.api).toEqual(['orders-api'])
  })

  it('a line it removes is compared without its notes: a confirm on it meanwhile, then the remove applies', async () => {
    const agent = heldAgent([{ op: 'remove', id: 'e-api--db' }])
    const { designer, store } = setup(agent.exec)
    await stored(store)
    const refining = designer.refine('design:id1', 'Drop the line', '')
    await agent.running
    await designer.annotate('design:id1', 'e-api--db', person('Writes each order.'))
    agent.release()
    expect((await refining).applied).toBe(1)
    expect(((await store.load('design:id1')) as WorldDoc).edges).toEqual([])
  })
})

describe('a refine that removes a district with buildings in it waits for a yes (D3)', () => {
  const removeCore: DesignOp[] = [{ op: 'remove', id: 'core' }]

  it('saves nothing and names the district and its buildings; confirm then saves the change', async () => {
    const { designer, store, execFn } = setup(async () => okRes(reply('Removed Core.', removeCore)), { now: () => 90 })
    const before = await stored(store)
    const res = await designer.refine('design:id1', 'Remove the core', 'earlier')
    expect(res.confirm).toEqual({ removals: [{ id: 'core', name: 'Core', buildings: 2 }], id: expect.any(String) })
    // Nothing was made yet (DSN Round 1, item 11).
    expect(res.applied).toBe(0)
    expect(res.doc).toEqual(before)
    expect(res.text).toBe('Removed Core.')
    expect(res.tokens).toBeGreaterThan(0)
    expect(await store.load('design:id1')).toEqual(before)
    const done = await designer.confirm('design:id1', res.confirm!.id)
    expect(done.confirm).toBeUndefined()
    expect(done.applied).toBe(1)
    expect(done.skipped).toBe(0)
    expect(done.tokens).toBe(0) // the run was counted when the refine answered
    expect(done.text).toBe('Removed Core.')
    expect(done.summary).toBe(res.summary)
    expect(done.doc.districts).toEqual([])
    expect(done.doc.generatedAt).toBe(90)
    expect(await store.load('design:id1')).toEqual(done.doc)
    expect(execFn).toHaveBeenCalledTimes(1)
    expect(await failure(designer.confirm('design:id1', res.confirm!.id))).toBe(DESIGN_REPLACED) // nothing is waiting any more
  })

  it('an empty district is removed without asking', async () => {
    const { designer, store } = setup(async () => okRes(reply('ok', [{ op: 'remove', id: 'spare' }])))
    await store.save(applyDesignPatch(emptyDesignDoc('design:id1', 1), [...DRAFT_OPS, { op: 'addDistrict', id: 'spare', name: 'Spare' }], layoutPlacer).doc)
    const res = await designer.refine('design:id1', 'Drop the spare district', '')
    expect(res.confirm).toBeUndefined()
    expect(((await store.load('design:id1')) as WorldDoc).districts.map((d) => d.id)).toEqual(['core'])
  })

  it('a cancel or a newer refine drops the change waiting for a yes', async () => {
    const { designer, store } = setup(async (req) => okRes(reply('ok', req.task.includes('Remove the core') ? removeCore : [{ op: 'rename', id: 'api', name: 'Checkout API' }])))
    const before = await stored(store)
    const first = (await designer.refine('design:id1', 'Remove the core', '')).confirm!
    designer.cancel('design:id1')
    expect(await failure(designer.confirm('design:id1', first.id))).toBe(DESIGN_REPLACED)
    expect(await store.load('design:id1')).toEqual(before)
    const second = (await designer.refine('design:id1', 'Remove the core', '')).confirm!
    expect((await designer.refine('design:id1', 'Rename the API', '')).applied).toBe(1)
    expect(await failure(designer.confirm('design:id1', second.id))).toBe(DESIGN_REPLACED)
    expect(((await store.load('design:id1')) as WorldDoc).districts.map((d) => d.id)).toEqual(['core'])
  })

  it('a yes after the district changed applies nothing and asks for a try again', async () => {
    const { designer, store } = setup(async () => okRes(reply('ok', removeCore)))
    await stored(store)
    const res = await designer.refine('design:id1', 'Remove the core', '')
    await designer.propose({ key: 'design:id1' }, [{ op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }])
    expect(await failure(designer.confirm('design:id1', res.confirm!.id))).toBe(DESIGN_CHANGED)
    expect(((await store.load('design:id1')) as WorldDoc).buildings.map((b) => b.id)).toEqual(['api', 'db', 'mail'])
  })

  it('a yes carries the id of the change it answers: a stale id, or none, is refused and applies nothing (DSN Round 1, item 2)', async () => {
    const { designer, store } = setup(async (req) => okRes(reply('ok', [{ op: 'remove', id: req.task.includes('First') ? 'core' : 'other' }])))
    await stored(store)
    await designer.propose({ key: 'design:id1' }, [{ op: 'addDistrict', id: 'other', name: 'Other' }, { op: 'addBuilding', id: 'worker', districtId: 'other', name: 'Worker' }])
    const first = (await designer.refine('design:id1', 'First', '')).confirm!
    const second = (await designer.refine('design:id1', 'Second', '')).confirm!
    expect(first.removals.map((r) => r.id)).toEqual(['core'])
    expect(second.removals.map((r) => r.id)).toEqual(['other'])
    expect(second.id).not.toBe(first.id)
    const before = await store.load('design:id1')
    // The stale yes for Core never removes Other, and the question that is up still waits for its own answer.
    for (const stale of [first.id, '', undefined]) expect(await failure(designer.confirm('design:id1', stale as string))).toBe(DESIGN_REPLACED)
    expect(await store.load('design:id1')).toEqual(before)
    const done = await designer.confirm('design:id1', second.id)
    expect(done.applied).toBe(1)
    expect(done.doc.districts.map((d) => d.id)).toEqual(['core'])
  })
})

describe("a change that takes a district's buildings out first and then removes it counts the buildings it had before the change (DSN Round 1, item 1)", () => {
  const emptyThenRemove: DesignOp[] = [{ op: 'remove', id: 'api' }, { op: 'remove', id: 'db' }, { op: 'remove', id: 'core' }]

  it('a refine holds it for a yes, naming both buildings, and saves nothing', async () => {
    const { designer, store } = setup(async () => okRes(reply('ok', emptyThenRemove)))
    const before = await stored(store)
    const res = await designer.refine('design:id1', 'Remove the core', '')
    expect(res.confirm?.removals).toEqual([{ id: 'core', name: 'Core', buildings: 2 }])
    expect(await store.load('design:id1')).toEqual(before)
  })

  it("an agent's world_propose is refused, applying none of it", async () => {
    const { designer, store } = setup(async () => { throw new Error('propose never runs the agent') })
    const before = await stored(store)
    expect(await failure(designer.propose({ key: 'design:id1' }, emptyThenRemove))).toBe(DESIGN_NEEDS_PERSON)
    expect(await store.load('design:id1')).toEqual(before)
  })
})

describe('a design saved by a newer Termpolis is never changed here (WP3)', () => {
  /** The real store, whose loads mark the design as a newer version's while `newer` is set. */
  const newerStore = (newer: boolean) => {
    const real = createWorldStore(dir)
    const state = { newer }
    const store: WorldStore = { ...real, load: async (k) => { const d = await real.load(k); return d && state.newer ? { ...d, savedByNewer: true } : d } }
    return { real, store, state, save: vi.spyOn(real, 'save') }
  }

  it('refine, propose and annotate refuse it with the B7 note, run no agent and write nothing', async () => {
    const n = newerStore(true)
    const add = vi.fn(async () => undefined)
    const { designer, execFn } = setup(async () => okRes(reply('ok', [{ op: 'rename', id: 'api', name: 'X' }])), { store: n.store, annotations: { add, list: async () => ({}) } })
    await stored(n.real)
    n.save.mockClear()
    expect(await failure(designer.refine('design:id1', 'Rename it', ''))).toBe(WORLD_SAVED_BY_NEWER)
    expect(await failure(designer.propose({ key: 'design:id1' }, [{ op: 'rename', id: 'api', name: 'X' }]))).toBe(WORLD_SAVED_BY_NEWER)
    expect(await failure(designer.annotate('design:id1', 'api', person('x')))).toBe(WORLD_SAVED_BY_NEWER)
    expect(execFn).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(n.save).not.toHaveBeenCalled()
  })

  it('a design a newer Termpolis saved while the agent ran, or while a removal waited for a yes, is left as it is', async () => {
    const n = newerStore(false)
    const agent = heldAgent([{ op: 'rename', id: 'api', name: 'X' }])
    const { designer } = setup(agent.exec, { store: n.store })
    await stored(n.real)
    n.save.mockClear()
    const refining = failure(designer.refine('design:id1', 'Rename it', ''))
    await agent.running
    n.state.newer = true
    agent.release()
    expect(await refining).toBe(WORLD_SAVED_BY_NEWER)
    n.state.newer = false
    const waiting = setup(async () => okRes(reply('ok', [{ op: 'remove', id: 'core' }])), { store: n.store })
    const held = (await waiting.designer.refine('design:id1', 'Remove the core', '')).confirm!
    n.state.newer = true
    expect(await failure(waiting.designer.confirm('design:id1', held.id))).toBe(WORLD_SAVED_BY_NEWER)
    expect(n.save).not.toHaveBeenCalled()
  })

  it("a newer version's design written after the last load and before the save is not written over (DSN Round 1, item 4)", async () => {
    const real = createWorldStore(dir)
    const file = join(dir, 'world', 'design_id1.json')
    // Another Termpolis, a newer one, saves the design between this one's last load and its write.
    const store: WorldStore = { ...real, save: async (doc) => { await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), version: 99 })); await real.save(doc) } }
    const { designer } = setup(async () => okRes(reply('ok', [{ op: 'rename', id: 'api', name: 'X' }])), { store })
    await stored(real)
    expect(await failure(designer.refine('design:id1', 'Rename it', ''))).toBe(WORLD_SAVED_BY_NEWER)
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(99)
  })
})

describe('an agent\'s note on a design shows once, however often the design is saved (DSN R2, F1)', () => {
  const agentNote = (text: string): Claim => ({ text, state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] })
  const count = (doc: WorldDoc, id: string, text: string): number =>
    [...doc.buildings, ...doc.edges].find((p) => p.id === id)!.claims.filter((c) => c.text === text).length

  it('an agent note stays one through a second annotate and three proposes, on the card and in the file', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(real, annotations)
    const { designer } = setup(noRun, { store, annotations })
    const answered = await designer.annotate('design:id1', 'api', agentNote('Calls the bank.'))
    expect(count(answered, 'api', 'Calls the bank.')).toBe(1)
    expect(count((await store.load('design:id1')) as WorldDoc, 'api', 'Calls the bank.')).toBe(1)
    await designer.annotate('design:id1', 'db', agentNote('Holds the orders.'))
    await designer.annotate('design:id1', 'api', person('Takes orders.'))
    for (const name of ['Store', 'Ledger', 'Vault']) await designer.propose({ key: 'design:id1' }, [{ op: 'rename', id: 'db', name }])
    const doc = (await store.load('design:id1')) as WorldDoc
    expect(count(doc, 'api', 'Calls the bank.')).toBe(1)
    expect(count(doc, 'db', 'Holds the orders.')).toBe(1)
    expect(personClaims(doc, 'api')).toEqual([person('Takes orders.')])
    const file = JSON.parse(await readFile(join(dir, 'world', 'design_id1.json'), 'utf8')) as WorldDoc
    expect(count(file, 'api', 'Calls the bank.')).toBe(1)
    expect(count(file, 'db', 'Holds the orders.')).toBe(1)
  })
})

describe('a note is stored only once the design it goes on is saved (DSN Round 1, item 9)', () => {
  const note = person('Takes orders.')

  it('a design save that fails stores no note, so the note is not there on the next load', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    const { designer } = setup(noRun, { store: withAnnotations({ ...real, save: async () => { throw new Error('ENOSPC') } }, annotations), annotations })
    expect(await failure(designer.annotate('design:id1', 'api', note))).toBe(DESIGN_SAVE_FAILED)
    expect(await annotations.list('design:id1')).toEqual({})
    expect(personClaims((await withAnnotations(real, annotations).load('design:id1')) as WorldDoc, 'api')).toEqual([])
  })

  it('a design a newer Termpolis saved just before the write stores no note, and the next load shows neither the note nor the change', async () => {
    const real = createWorldStore(dir)
    const first = await stored(real)
    const file = join(dir, 'world', 'design_id1.json')
    const annotations = createAnnotationStore(dir)
    const racing: WorldStore = { ...real, save: async (doc) => { await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), version: 99 })); await real.save(doc) } }
    const { designer } = setup(noRun, { store: withAnnotations(racing, annotations), annotations })
    expect(await failure(designer.annotate('design:id1', 'api', note))).toBe(WORLD_SAVED_BY_NEWER)
    expect(await annotations.list('design:id1')).toEqual({})
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(99)
    // DSN R2, F2: the store keeps no copy of the refused design, so a later load in this session shows the newer file.
    const again = (await withAnnotations(real, annotations).load('design:id1')) as WorldDoc
    expect(again.savedByNewer).toBe(true)
    expect(again.generatedAt).toBe(first.generatedAt)
    expect(personClaims(again, 'api')).toEqual([])
  })

  it('a note stored after the save is answered on its part even when the list read back fails', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    const { designer } = setup(noRun, { store: real, annotations: { add: annotations.add, list: async () => { throw new Error('EIO') } } })
    const doc = await designer.annotate('design:id1', 'api', note)
    expect(personClaims(doc, 'api')).toEqual([note])
    expect(personClaims(doc, 'db')).toEqual([])
    expect((await annotations.list('design:id1')).api).toEqual([note])
  })
})

describe('a design file leaves out the notes the annotation store holds, so the store decides what shows (DSN R3-2)', () => {
  const agentNote = (text: string): Claim => ({ text, state: 'observed', evidence: [{ kind: 'transcriptStep', ref: 'noted by an agent through world_annotate' }] })
  const names = (list: string): Claim => ({ text: `runtime:${list}`, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })
  const notesOn = (doc: WorldDoc, id: string): string[] =>
    [...doc.buildings, ...doc.edges].find((p) => p.id === id)!.claims.filter((c) => c.evidence.some((e) => e.kind === 'transcriptStep')).map((c) => c.text)
  const designFile = async (): Promise<WorldDoc> => JSON.parse(await readFile(join(dir, 'world', 'design_id1.json'), 'utf8')) as WorldDoc
  const texts = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `Note ${from + i}.`)

  it('21 agent notes on one part show the newest 20, on the card, on a load and in the stored notes; the design file holds none', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(real, annotations)
    const { designer } = setup(noRun, { store, annotations })
    let card = null as WorldDoc | null
    for (const text of texts(1, 21)) card = await designer.annotate('design:id1', 'api', agentNote(text))
    expect(notesOn(card as WorldDoc, 'api')).toEqual(texts(2, 21))
    expect(notesOn((await store.load('design:id1')) as WorldDoc, 'api')).toEqual(texts(2, 21))
    expect((await annotations.list('design:id1')).api.map((c) => c.text)).toEqual(texts(2, 21))
    expect(notesOn(await designFile(), 'api')).toEqual([])
  })

  it('a store write that fails after the design save shows nothing on the next load: neither the note nor the service names', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(real, annotations)
    const { designer } = setup(noRun, { store, annotations: { add: async () => { throw new Error('EIO') }, list: annotations.list } })
    expect(await failure(designer.annotate('design:id1', 'api', agentNote('Calls the bank.')))).toBe(DESIGN_SAVE_FAILED)
    expect(await failure(designer.annotate('design:id1', 'api', names('orders-api')))).toBe(DESIGN_SAVE_FAILED)
    const doc = (await store.load('design:id1')) as WorldDoc
    expect(notesOn(doc, 'api')).toEqual([])
    expect(doc.runtimeNames?.api).toBeUndefined()
    expect(doc.runtimeHandSet).toBeUndefined()
    expect(await annotations.list('design:id1')).toEqual({})
  })

  it('a design file from before, carrying 3 agent notes, 1 of them not in the store, moves that one into the store, and the next save leaves all 3 out', async () => {
    const real = createWorldStore(dir)
    const base = await stored(real)
    const annotations = createAnnotationStore(dir)
    const [a, b, c] = [agentNote('Calls the bank.'), agentNote('Retries twice.'), agentNote('Logs each order.')]
    await annotations.add('design:id1', 'api', a)
    await annotations.add('design:id1', 'api', b)
    await real.save({ ...base, buildings: base.buildings.map((p) => (p.id === 'api' ? { ...p, claims: [a, b, c] } : p)) })
    const store = withAnnotations(real, annotations)
    const { designer } = setup(noRun, { store, annotations })
    expect(notesOn((await store.load('design:id1')) as WorldDoc, 'api')).toEqual(['Calls the bank.', 'Retries twice.', 'Logs each order.'])
    expect((await annotations.list('design:id1')).api).toEqual([a, b, c])
    await designer.propose({ key: 'design:id1' }, [{ op: 'rename', id: 'db', name: 'Ledger' }])
    expect(notesOn(await designFile(), 'api')).toEqual([])
    const again = (await withAnnotations(createWorldStore(dir), createAnnotationStore(dir)).load('design:id1')) as WorldDoc
    expect(notesOn(again, 'api')).toEqual(['Calls the bank.', 'Retries twice.', 'Logs each order.'])
    expect(again.buildings.find((p) => p.id === 'db')!.name).toBe('Ledger')
  })

  it('a design file from before carrying 21 notes on a part, the store the newest 20, shows those 20 and moves nothing', async () => {
    const real = createWorldStore(dir)
    const base = await stored(real)
    const annotations = createAnnotationStore(dir)
    for (const text of texts(2, 21)) await annotations.add('design:id1', 'api', agentNote(text))
    await real.save({ ...base, buildings: base.buildings.map((p) => (p.id === 'api' ? { ...p, claims: texts(1, 21).map(agentNote) } : p)) })
    const store = withAnnotations(real, annotations)
    const doc = (await store.load('design:id1')) as WorldDoc
    expect(notesOn(doc, 'api')).toEqual(texts(2, 21))
    expect((await annotations.list('design:id1')).api.map((c) => c.text)).toEqual(texts(2, 21))
    await store.save(doc)
    expect(notesOn(await designFile(), 'api')).toEqual([])
  })

  it('a note the store dropped past its cap while a design was open is neither written back by its save nor moved back into the store', async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    for (const text of texts(1, 20)) await annotations.add('design:id1', 'api', agentNote(text))
    const store = withAnnotations(real, annotations)
    const open = (await store.load('design:id1')) as WorldDoc
    // An agent's note through the world gateway, while the design is open: the store drops Note 1.
    await annotations.add('design:id1', 'api', agentNote('Note 21.'))
    await store.save({ ...open, generatedAt: open.generatedAt + 1 })
    expect(notesOn(await designFile(), 'api')).toEqual([])
    const fresh = withAnnotations(createWorldStore(dir), createAnnotationStore(dir))
    expect(notesOn((await fresh.load('design:id1')) as WorldDoc, 'api')).toEqual(texts(2, 21))
    expect((await annotations.list('design:id1')).api.map((c) => c.text)).toEqual(texts(2, 21))
  })

  it("a person's note and a part's service names show as before, kept in the store and not in the design file", async () => {
    const real = createWorldStore(dir)
    await stored(real)
    const annotations = createAnnotationStore(dir)
    const store = withAnnotations(real, annotations)
    const { designer } = setup(noRun, { store, annotations })
    await designer.propose({ key: 'design:id1' }, [{ op: 'setRuntimeNames', id: 'db', names: ['orders-db'] }])
    const card = await designer.annotate('design:id1', 'api', person('Takes orders.'))
    expect(personClaims(card, 'api')).toEqual([person('Takes orders.')])
    const named = await designer.annotate('design:id1', 'api', names('orders-api'))
    expect(named.runtimeNames).toEqual({ api: ['orders-api'], db: ['orders-db'] })
    expect(named.runtimeHandSet).toEqual(['api'])
    expect(personClaims(named, 'api')).toEqual([person('Takes orders.')])
    const doc = (await store.load('design:id1')) as WorldDoc
    expect(personClaims(doc, 'api')).toEqual([person('Takes orders.')])
    expect(doc.runtimeNames).toEqual({ api: ['orders-api'], db: ['orders-db'] })
    expect(doc.runtimeHandSet).toEqual(['api'])
    const file = await designFile()
    expect(personClaims(file, 'api')).toEqual([])
    expect(file.runtimeNames).toEqual({ db: ['orders-db'] })
    expect(file.runtimeHandSet).toBeUndefined()
  })
})
