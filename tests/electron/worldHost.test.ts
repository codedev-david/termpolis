import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import { __setHostPriorityDepsForTests } from '../../src/main/hostPriority'
import { compileWorld, type CompileDeps, type CompileInput } from '../../src/main/world/compile'
import {
  DEFAULT_READ_LIMIT,
  EXCERPT_LINES,
  MAX_GLOB_RESULTS,
  MAX_READ_LIMIT,
  createWorldHost,
  excerptOf,
  filterWorld,
  globFiles,
  readCapped,
  serializeError,
  startWorldHost,
  type GlobFn,
  type ParentPortLike,
  type WorldHostDeps,
  type WorldHostRequest,
  type WorldHostResponse
} from '../../src/main/world/worldHost'
import { createWorldStore, type WorldStore } from '../../src/main/world/worldStore'
import type { Building, Claim, District, WorldDoc, WorldEdge } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'

const claim = (text: string, refs: string[] = []): Claim => ({
  text,
  state: 'observed',
  evidence: refs.map((ref) => ({ kind: 'file', ref }))
})

function doc(projectKey = 'k1', over: Partial<WorldDoc> = {}): WorldDoc {
  const district: District = { id: 'd-core', name: 'Core', subtitle: 'the middle', hue: 1, members: ['b-api', 'b-db'] }
  const api: Building = {
    id: 'b-api',
    districtId: 'd-core',
    name: 'Api Gateway',
    techLabel: 'Express',
    process: 'node',
    floors: [],
    stack: ['TypeScript'],
    how: [claim('routes requests', ['src/api.ts', 'src/shared.ts'])],
    why: [claim('one front door', ['src/api.ts'])],
    status: 'built',
    members: ['src/api.ts']
  }
  const db: Building = { ...api, id: 'b-db', name: 'Store', techLabel: 'SQLite', stack: [], how: [], why: [], members: ['src/db.ts'] }
  const edge: WorldEdge = {
    id: 'e-1',
    from: 'b-api',
    to: 'b-db',
    cargo: 'rows',
    label: 'reads',
    how: [claim('queries rows', ['src/shared.ts', 'src/db.ts'])],
    tech: ['sql'],
    why: [],
    rate: 'often',
    twoWay: false
  }
  return {
    version: 1,
    projectKey,
    generatedAt: 1,
    sourceRevision: { head: 'abc', dirty: false },
    districts: [district],
    buildings: [api, db],
    edges: [edge],
    externals: [],
    glossary: {},
    cargo: {},
    processes: {},
    tours: [],
    layout: { seed: 1, positions: {} },
    runtimeNames: {},
    layers: { plan: [] },
    ...over
  }
}

const snap = (root = '/repo'): GraphSnapshot => ({ root, files: ['src/a.ts'], symbols: [], callEdges: [], fileImports: {} })
const HEAD = { head: 'h1', dirty: false }

function memStore(initial: Record<string, WorldDoc> = {}): WorldStore & { docs: Map<string, WorldDoc>; saves: WorldDoc[] } {
  const docs = new Map(Object.entries(initial))
  const saves: WorldDoc[] = []
  return {
    docs,
    saves,
    load: async (k) => docs.get(k) ?? null,
    save: async (d) => {
      saves.push(d)
      docs.set(d.projectKey, d)
    },
    labelCache: { get: async () => null, set: async () => undefined }
  }
}

/** A host wired to an in-memory store and a recording `post`. */
function harness(deps: WorldHostDeps = {}, store = memStore()) {
  const out: WorldHostResponse[] = []
  const host = createWorldHost((m) => out.push(m), { createStore: () => store, ...deps })
  const send = (m: WorldHostRequest) => host.handle(m)
  const init = (labelling = true) => send({ kind: 'init', userDataPath: '/ud', labelling })
  const results = () => out.filter((m) => m.kind === 'result')
  const last = () => results()[results().length - 1]
  return { out, host, send, init, store, results, last }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-host-'))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __setHostPriorityDepsForTests(null)
  await rm(dir, { recursive: true, force: true })
})

describe('serializeError', () => {
  it('flattens errors, strings and anything else', () => {
    const e = new TypeError('bad')
    expect(serializeError(e)).toEqual({ message: 'bad', name: 'TypeError' })
    const blank = new Error('')
    blank.name = ''
    expect(serializeError(blank)).toEqual({ message: '', name: 'Error' })
    expect(serializeError('plain')).toEqual({ message: 'plain', name: 'Error' })
    expect(serializeError(42)).toEqual({ message: '42', name: 'Error' })
  })
})

describe('host file-system deps', () => {
  it('readCapped reads a file and returns null when missing, a folder, too big or unreadable', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    expect(await readCapped(join(dir, 'a.txt'))).toBe('hello')
    expect(await readCapped(join(dir, 'missing.txt'))).toBeNull()
    expect(await readCapped(dir)).toBeNull()
    expect(await readCapped(join(dir, 'a.txt'), 3)).toBeNull()
  })

  it('globFiles returns absolute matches, skips node_modules and .git, and drops ! patterns', async () => {
    await mkdir(join(dir, 'a', 'node_modules', 'x'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'b'), { recursive: true })
    await writeFile(join(dir, 'a', 'junit-1.xml'), '')
    await writeFile(join(dir, 'a', 'node_modules', 'x', 'junit-2.xml'), '')
    await writeFile(join(dir, '.git', 'junit-3.xml'), '')
    await writeFile(join(dir, 'b', 'TEST-x.xml'), '')
    const got = (await globFiles(dir, ['**/junit*.xml', '**/TEST-*.xml', '!**/node_modules/**'])).sort()
    expect(got).toEqual([join(dir, 'a', 'junit-1.xml'), join(dir, 'b', 'TEST-x.xml')].sort())
  })

  it('globFiles gives [] with no glob or no positive pattern, keeps partial results on error, and caps', async () => {
    expect(await globFiles(dir, ['**/*.xml'], undefined)).toEqual([])
    const never: GlobFn = () => {
      throw new Error('should not run')
    }
    expect(await globFiles(dir, ['!**/x'], never)).toEqual([])
    const broken: GlobFn = async function* (_p, o) {
      expect(o.exclude('a/node_modules/b')).toBe(true)
      expect(o.exclude('a\\.git\\b')).toBe(true)
      expect(o.exclude('src/x.xml')).toBe(false)
      yield 'one.xml'
      throw new Error('EACCES')
    }
    expect(await globFiles('/r', ['*.xml'], broken)).toEqual([join('/r', 'one.xml')])
    const endless: GlobFn = async function* () {
      for (let i = 0; ; i++) yield `f${i}.xml`
    }
    expect(await globFiles('/r', ['*.xml'], endless)).toHaveLength(MAX_GLOB_RESULTS)
  })

  it('excerptOf slices about 40 lines around a line, or from the top', () => {
    const text = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join('\r\n')
    const top = excerptOf(text).split('\n')
    expect(top).toHaveLength(EXCERPT_LINES)
    expect(top[0]).toBe('L1')
    expect(excerptOf(text, 50).split('\n')[0]).toBe('L30')
    expect(excerptOf(text, 50).split('\n')).toContain('L50')
    expect(excerptOf(text, 3).split('\n')[0]).toBe('L1')
    expect(excerptOf(text, Number.NaN).split('\n')[0]).toBe('L1')
  })
})

describe('filterWorld', () => {
  it('returns nothing for no world', () => {
    expect(filterWorld(null, { text: 'x' })).toEqual({ items: [], evidence: [] })
  })

  it('without a query returns the first items up to the default limit, with deduplicated evidence', () => {
    const r = filterWorld(doc(), undefined)
    expect(r.items.map((i) => i.id)).toEqual(['d-core', 'b-api', 'b-db', 'e-1'])
    expect(r.evidence.map((e) => e.ref)).toEqual(['src/api.ts', 'src/shared.ts', 'src/db.ts'])
    const many = doc('k', { districts: Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, name: '', subtitle: '', hue: 0, members: [] })) })
    expect(filterWorld(many, null).items).toHaveLength(DEFAULT_READ_LIMIT)
  })

  it('filters by ids and by case-insensitive text over names, labels, members, tech and claims', () => {
    expect(filterWorld(doc(), { ids: ['b-db', 'e-1', 7 as unknown as string] }).items.map((i) => i.id)).toEqual(['b-db', 'e-1'])
    expect(filterWorld(doc(), { text: '  GATEWAY ' }).items.map((i) => i.id)).toEqual(['b-api'])
    expect(filterWorld(doc(), { text: 'queries' }).items.map((i) => i.id)).toEqual(['e-1'])
    expect(filterWorld(doc(), { text: 'src/db.ts' }).items.map((i) => i.id)).toEqual(['b-db'])
    expect(filterWorld(doc(), { text: 'typescript' }).items.map((i) => i.id)).toEqual(['b-api'])
    expect(filterWorld(doc(), { text: 'sql' }).items.map((i) => i.id)).toEqual(['b-db', 'e-1'])
    expect(filterWorld(doc(), { text: 'the middle' }).items.map((i) => i.id)).toEqual(['d-core'])
    expect(filterWorld(doc(), { ids: ['b-api', 'b-db'], text: 'store' }).items.map((i) => i.id)).toEqual(['b-db'])
    expect(filterWorld(doc(), { text: '' }).items).toHaveLength(4)
  })

  it('clamps the limit', () => {
    expect(filterWorld(doc(), { limit: 0 }).items).toHaveLength(1)
    expect(filterWorld(doc(), { limit: 2.9 }).items).toHaveLength(2)
    expect(filterWorld(doc(), { limit: Number.POSITIVE_INFINITY }).items).toHaveLength(4)
    const big = doc('k', { districts: Array.from({ length: 300 }, (_, i) => ({ id: `d${i}`, name: '', subtitle: '', hue: 0, members: [] })) })
    expect(filterWorld(big, { limit: 10_000 }).items).toHaveLength(MAX_READ_LIMIT)
  })
})

describe('createWorldHost', () => {
  it('init → ready, and bad messages are ignored', async () => {
    const h = harness()
    await h.host.handle(null)
    await h.host.handle('x' as unknown as WorldHostRequest)
    await h.send({ kind: 'nope' } as unknown as WorldHostRequest)
    expect(h.out).toEqual([])
    await h.init()
    expect(h.out).toEqual([{ kind: 'ready', pid: process.pid }])
  })

  it('init without a userData path, or a store that throws, answers init-error', async () => {
    const h = harness()
    await h.send({ kind: 'init', userDataPath: '', labelling: true })
    expect(h.out[0]).toEqual({ kind: 'init-error', error: { name: 'Error', message: 'worldHost: userDataPath required' } })
    const h2 = harness({
      createStore: () => {
        throw new Error('disk')
      }
    })
    await h2.init()
    expect(h2.out[0]).toEqual({ kind: 'init-error', error: { name: 'Error', message: 'disk' } })
  })

  it('a call before init, or to an unknown fn, gives ok:false', async () => {
    const h = harness()
    await h.send({ kind: 'call', id: 1, fn: 'get', args: ['k1'] })
    expect(h.last()).toMatchObject({ id: 1, ok: false, error: { message: expect.stringMatching(/not initialised/) } })
    await h.init()
    await h.send({ kind: 'call', id: 2, fn: 'dropTables', args: [] })
    expect(h.last()).toMatchObject({ id: 2, ok: false, error: { message: 'worldHost: unknown fn "dropTables"' } })
    await h.send({ kind: 'call', id: 3, fn: 'toString', args: [] })
    expect(h.last()).toMatchObject({ id: 3, ok: false, error: { message: 'worldHost: unknown fn "toString"' } })
  })

  it('get and read round-trip; a missing key fails; non-array args count as none', async () => {
    const h = harness({}, memStore({ k1: doc() }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'get', args: ['k1'] })
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: true, result: doc() })
    await h.send({ kind: 'call', id: 2, fn: 'get', args: ['other'] })
    expect(h.last()).toEqual({ kind: 'result', id: 2, ok: true, result: null })
    await h.send({ kind: 'call', id: 3, fn: 'read', args: ['k1', { text: 'store' }] })
    expect(h.last()).toMatchObject({ id: 3, ok: true, result: { items: [{ id: 'b-db' }], evidence: [] } })
    await h.send({ kind: 'call', id: 4, fn: 'get', args: [''] })
    expect(h.last()).toMatchObject({ id: 4, ok: false, error: { message: 'worldHost: projectKey required' } })
    await h.send({ kind: 'call', id: 5, fn: 'get', args: 'k1' as unknown as unknown[] })
    expect(h.last()).toMatchObject({ id: 5, ok: false, error: { message: 'worldHost: projectKey required' } })
  })

  it('compile pushes progress, loads the previous world, saves and returns the doc', async () => {
    const seen: CompileInput[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      seen.push(input)
      deps.onProgress?.('structure', 0)
      deps.onProgress?.('layout', 100)
      expect(deps.now()).toBe(5)
      return doc(input.projectKey, { generatedAt: 2 })
    })
    const h = harness({ compile, now: () => 5 }, memStore({ k1: doc() }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.out.slice(1)).toEqual([
      { kind: 'progress', projectKey: 'k1', stage: 'structure', pct: 0 },
      { kind: 'progress', projectKey: 'k1', stage: 'layout', pct: 100 },
      // every successful save tells the window, so it re-reads (compile, relayout and the scheduler)
      { kind: 'updated', projectKey: 'k1' },
      { kind: 'result', id: 1, ok: true, result: doc('k1', { generatedAt: 2 }) }
    ])
    expect(seen[0]).toEqual({ snap: snap(), projectKey: 'k1', head: HEAD, previous: doc() })
    expect(h.store.saves).toEqual([doc('k1', { generatedAt: 2 })])
  })

  it('relayout hands compile the stored world with only its positions cleared (seed and everything else kept)', async () => {
    const seen: CompileInput[] = []
    const compile = vi.fn(async (input: CompileInput) => {
      seen.push(input)
      return doc(input.projectKey, { generatedAt: 3 })
    })
    const stored = doc('k1', { glossary: { Store: 'where rows live' }, layout: { seed: 77, positions: { 'd-core': [1, 0, 2], 'b-api': [3, 0, 4] } } })
    const h = harness({ compile }, memStore({ k1: stored }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD, { relayout: true }] })
    expect(seen[0].previous).toEqual({ ...stored, layout: { seed: 77, positions: {} } })
    expect(seen[0].previous?.glossary).toEqual({ Store: 'where rows live' }) // a non-layout field still carries
    expect(seen[0].previous?.buildings).toEqual(stored.buildings)
    expect(stored.layout.positions).toEqual({ 'd-core': [1, 0, 2], 'b-api': [3, 0, 4] }) // the stored doc is not mutated
    expect(h.out.slice(-2)).toEqual([
      { kind: 'updated', projectKey: 'k1' },
      { kind: 'result', id: 1, ok: true, result: doc('k1', { generatedAt: 3 }) }
    ])
    // With nothing stored, a relayout is a first compile.
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k2', snap(), HEAD, { relayout: true }] })
    expect(seen[1].previous).toBeNull()
    expect(h.out.slice(-2)[0]).toEqual({ kind: 'updated', projectKey: 'k2' })
  })

  it('relayout through the real compiler: fresh positions with the same seed, where a plain compile keeps them', async () => {
    const seen: CompileInput[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      seen.push(input)
      return compileWorld(input, deps)
    })
    const store = memStore()
    const h = harness({ compile }, store)
    await h.init(false) // label from code: no model round trip
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    const first = store.docs.get('k1') as WorldDoc
    // Pin every stored position somewhere no layout would put it, under a recognisable seed.
    const pinned = Object.fromEntries(Object.keys(first.layout.positions).map((id) => [id, [999, 0, 999] as [number, number, number]]))
    expect(Object.keys(pinned).length).toBeGreaterThan(0)
    store.docs.set('k1', { ...first, glossary: { Marker: 'kept' }, layout: { seed: 7, positions: pinned } })
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(store.docs.get('k1')?.layout.positions).toEqual(pinned) // a plain compile keeps them
    store.docs.set('k1', { ...first, glossary: { Marker: 'kept' }, layout: { seed: 7, positions: pinned } })
    await h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k1', snap(), HEAD, { relayout: true }] })
    const res = h.last() as { ok: boolean; result: WorldDoc }
    expect(res.ok).toBe(true)
    expect(seen[2].previous?.glossary).toEqual({ Marker: 'kept' }) // a non-layout field still reaches compile
    expect(seen[2].previous?.layout).toEqual({ seed: 7, positions: {} })
    expect(Object.values(res.result.layout.positions).some((p) => p[0] === 999)).toBe(false)
    expect(res.result.layout.seed).toBe(7)
  })

  it('a failed compile pushes no updated', async () => {
    const compile = vi.fn(async () => {
      throw new Error('nope')
    })
    const h = harness({ compile })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.out.some((m) => m.kind === 'updated')).toBe(false)
  })

  it('a failing compile answers ok:false and does not block the next one', async () => {
    let n = 0
    const compile = vi.fn(async (input: CompileInput) => {
      if (n++ === 0) throw new RangeError('boom')
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.init()
    await Promise.all([
      h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] }),
      h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    ])
    expect(h.results()).toEqual([
      { kind: 'result', id: 1, ok: false, error: { name: 'RangeError', message: 'boom' } },
      { kind: 'result', id: 2, ok: true, result: doc('k1') }
    ])
  })

  it('serialises jobs for one project', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const compile = vi.fn(async (input: CompileInput) => {
      order.push(`start ${input.head.head}`)
      if (input.head.head === 'first') await gate
      order.push(`end ${input.head.head}`)
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.init()
    const a = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), { head: 'first', dirty: false }] })
    const b = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), { head: 'second', dirty: false }] })
    await tick()
    expect(order).toEqual(['start first'])
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['start first', 'end first', 'start second', 'end second'])
  })

  it('labelling asks main through llm / llm-result; excerpts come from the snapshot root', async () => {
    const answers: (string | null)[] = []
    const excerpts: string[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      answers.push(await (deps.label.llm as (p: string) => Promise<string | null>)('describe it'))
      answers.push(await (deps.label.llm as (p: string) => Promise<string | null>)('again'))
      expect(deps.label.cache).toBe(store.labelCache)
      excerpts.push(await deps.label.excerpt('src/a.ts', 2))
      excerpts.push(await deps.label.excerpt('src/missing.ts'))
      return doc(input.projectKey)
    })
    const store = memStore()
    const readFile = vi.fn(async (p: string) => (p === '/repo/src/a.ts' ? 'one\ntwo\nthree' : null))
    const h = harness({ compile, readFile }, store)
    await h.init()
    const done = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap('/repo/'), HEAD] })
    await tick()
    const ask1 = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
    expect(ask1).toMatchObject({ kind: 'llm', projectKey: 'k1', prompt: 'describe it' })
    await h.send({ kind: 'llm-result', id: 999, text: 'stray' }) // unknown id: ignored
    await h.send({ kind: 'llm-result', id: ask1.id, text: '{"name":"x"}' })
    await tick()
    const ask2 = h.out.filter((m) => m.kind === 'llm')[1] as Extract<WorldHostResponse, { kind: 'llm' }>
    await h.send({ kind: 'llm-result', id: ask2.id, text: 5 as unknown as string })
    await done
    expect(answers).toEqual(['{"name":"x"}', null])
    expect(excerpts).toEqual(['one\ntwo\nthree', ''])
    expect(readFile).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(h.last()).toMatchObject({ id: 1, ok: true })
  })

  it('an unanswered labelling request times out as null', async () => {
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      expect(await (deps.label.llm as (p: string) => Promise<string | null>)('p')).toBeNull()
      return doc(input.projectKey)
    })
    const h = harness({ compile, llmTimeoutMs: 5 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
  })

  it('labelling off gives the compiler no model', async () => {
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      expect(deps.label.llm).toBeNull()
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
    expect(h.out.some((m) => m.kind === 'llm')).toBe(false)
  })

  it('notifyChanged recompiles a stored world after the debounce with the latest snapshot, then pushes updated', async () => {
    const inputs: CompileInput[] = []
    const compile = vi.fn(async (input: CompileInput) => {
      inputs.push(input)
      return doc(input.projectKey, { generatedAt: 9 })
    })
    const h = harness({ compile, debounceMs: 10 }, memStore({ k1: doc() }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap('/old'), HEAD, ['src/a.ts', 3]] })
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: true, result: true })
    await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap('/new'), { head: 'h2', dirty: true }, ['src/b.ts']] })
    await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'updated')).toBe(true))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ projectKey: 'k1', head: { head: 'h2', dirty: true }, previous: doc(), snap: snap('/new') })
    expect([...(inputs[0].changed ?? [])].sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(h.store.saves).toEqual([doc('k1', { generatedAt: 9 })])
    expect(h.out[h.out.length - 1]).toEqual({ kind: 'updated', projectKey: 'k1' })
  })

  it('notifyChanged never makes a first world, and ignores a non-array file list', async () => {
    const compile = vi.fn(async (input: CompileInput) => doc(input.projectKey))
    const h = harness({ compile, debounceMs: 1 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
    await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k2', snap(), HEAD, 'nope'] })
    await new Promise((r) => setTimeout(r, 30))
    expect(compile).not.toHaveBeenCalled()
    expect(h.out.some((m) => m.kind === 'updated')).toBe(false)
  })

  it('a second init cancels pending watcher recompiles (default debounce)', async () => {
    vi.useFakeTimers()
    const compile = vi.fn(async (input: CompileInput) => doc(input.projectKey))
    const h = harness({ compile }, memStore({ k1: doc() }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
    await h.init()
    await vi.advanceTimersByTimeAsync(5000)
    expect(compile).not.toHaveBeenCalled()
  })

  it('compiles a real world end to end with the default deps (labelling off)', async () => {
    await mkdir(join(dir, 'repo', 'src'), { recursive: true })
    await writeFile(join(dir, 'repo', 'src', 'a.ts'), "import { b } from './b'\nexport const a = b\n")
    await writeFile(join(dir, 'repo', 'src', 'b.ts'), 'export const b = 1\n')
    const root = join(dir, 'repo').replace(/\\/g, '/')
    const s: GraphSnapshot = { root, files: ['src/a.ts', 'src/b.ts'], symbols: [], callEdges: [], fileImports: { 'src/a.ts': ['src/b.ts'] } }
    const out: WorldHostResponse[] = []
    const host = createWorldHost((m) => out.push(m))
    await host.handle({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await host.handle({ kind: 'call', id: 1, fn: 'compile', args: ['real', s, HEAD] })
    const res = out.find((m) => m.kind === 'result') as Extract<WorldHostResponse, { kind: 'result'; ok: true }>
    expect(res.ok).toBe(true)
    const world = res.result as WorldDoc
    expect(validateWorld(world).ok).toBe(true)
    expect(world.projectKey).toBe('real')
    expect(out.some((m) => m.kind === 'progress')).toBe(true)
    expect(await createWorldStore(join(dir, 'ud')).load('real')).toEqual(world)
  })
})

describe('startWorldHost (the child bootstrap)', () => {
  function fakePort(withStart = true) {
    let listener: ((e: { data: WorldHostRequest } | undefined) => void) | null = null
    const posted: WorldHostResponse[] = []
    const port: ParentPortLike & { start?: ReturnType<typeof vi.fn> } = {
      on: (_c, cb) => {
        listener = cb
      },
      postMessage: (m) => posted.push(m),
      ...(withStart ? { start: vi.fn() } : {})
    }
    return { port, posted, deliver: (e: { data: WorldHostRequest } | undefined) => listener?.(e) }
  }

  it('lowers its own priority, serves e.data from the port, and exits on an unhandled rejection', async () => {
    const setPriority = vi.fn()
    __setHostPriorityDepsForTests({ os: { setPriority, constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } } }, env: {} })
    const handlers: Record<string, (...a: unknown[]) => void> = {}
    vi.spyOn(process, 'on').mockImplementation(((ev: string, cb: (...a: unknown[]) => void) => {
      handlers[ev] = cb
      return process
    }) as typeof process.on)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { port, posted, deliver } = fakePort()
    startWorldHost(port, { createStore: () => memStore() })
    expect(setPriority).toHaveBeenCalledWith(0, 10)
    expect(port.start).toHaveBeenCalled()
    deliver(undefined)
    deliver({ data: { kind: 'init', userDataPath: '/ud', labelling: true } })
    await vi.waitFor(() => expect(posted).toEqual([{ kind: 'ready', pid: process.pid }]))
    handlers.unhandledRejection(new Error('lost'))
    expect(err).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('works with a port that has no start()', () => {
    __setHostPriorityDepsForTests({ env: { TERMPOLIS_NO_HOST_PRIORITY: '1' } })
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)
    const { port } = fakePort(false)
    expect(startWorldHost(port).handle).toBeTypeOf('function')
  })

  it('importing the module inside a utilityProcess (parentPort set) starts the host', async () => {
    __setHostPriorityDepsForTests({ env: { TERMPOLIS_NO_HOST_PRIORITY: '1' } })
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)
    const { port, posted, deliver } = fakePort()
    const proc = process as NodeJS.Process & { parentPort?: ParentPortLike }
    proc.parentPort = port
    try {
      vi.resetModules()
      await import('../../src/main/world/worldHost')
      expect(port.start).toHaveBeenCalled()
      deliver({ data: { kind: 'init', userDataPath: '', labelling: true } })
      await vi.waitFor(() => expect(posted[0]?.kind).toBe('init-error'))
    } finally {
      delete proc.parentPort
    }
  })
})
