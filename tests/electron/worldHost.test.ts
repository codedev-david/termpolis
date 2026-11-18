import { execFileSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  captureExec,
  gitCandidates,
  gitListFiles,
  LIST_TIMEOUT_MS,
  MAX_LIST_BYTES,
  MAX_SNAPSHOT_FILE_CHARS,
  snapshotFromFiles,
  type CaptureFn,
  type CaptureResult
} from '../../src/main/world/fileSnapshot'
import type { StageCache } from '../../src/main/world/stageCache'
import { MAX_DETECT_FILE_CHARS } from '../../src/main/world/detectors'
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
  cleanEvidence,
  createWorldHost,
  excerptOf,
  filterWorld,
  globFiles,
  readCapped,
  MAX_SOURCE_READ_BYTES,
  type ReadHandle,
  serializeError,
  startWorldHost,
  type GlobFn,
  type ParentPortLike,
  type WorldHostDeps,
  type WorldHostRequest,
  type WorldHostResponse
} from '../../src/main/world/worldHost'
import { cloneKey, safetyFlags } from '../../src/main/world/gitSource'
import type { AnnotationStore } from '../../src/main/world/annotations'
import { createWorldStore, type WorldStore } from '../../src/main/world/worldStore'
import type { Building, Claim, District, WorldDoc, WorldEdge } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { emptyDesignDoc } from '../../src/shared/world/designPatch'

const claim = (text: string, refs: string[] = []): Claim => ({
  text,
  state: 'observed',
  evidence: refs.map((ref) => ({ kind: 'file', ref }))
})

function doc(projectKey = 'k1', over: Partial<WorldDoc> = {}): WorldDoc {
  const district: District = { id: 'd-core', name: 'Core', subtitle: 'the middle', hue: 1, members: ['b-api', 'b-db'], nameState: 'observed' }
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
    members: ['src/api.ts'],
    claims: [],
    nameState: 'observed'
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
    twoWay: false,
    claims: []
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

  it('readCapped is a bounded read: never more than the file size + 1 bytes, short reads joined, handle always closed', async () => {
    const text = 'héllo wörld' // multi-byte UTF-8
    const bytes = Buffer.from(text, 'utf8')
    const asked: number[] = []
    let closed = 0
    const fake = (over: Partial<ReadHandle> = {}, size = bytes.length, data = bytes): ReadHandle => {
      let pos = 0
      return {
        stat: async () => ({ isFile: () => true, size }),
        read: async (buf, offset, length) => {
          asked.push(length)
          const n = Math.min(4, length, data.length - pos) // at most 4 bytes per call: short reads
          data.copy(buf, offset, pos, pos + n)
          pos += n
          return { bytesRead: n }
        },
        close: async () => {
          closed++
        },
        ...over
      }
    }
    expect(await readCapped('/f', 100, async () => fake())).toBe(text)
    expect(Math.max(...asked)).toBeLessThanOrEqual(bytes.length + 1)
    expect(closed).toBe(1)

    // Bigger than the cap by its size: nothing is read at all.
    asked.length = 0
    expect(await readCapped('/f', bytes.length - 1, async () => fake())).toBeNull()
    expect(asked).toEqual([])
    expect(closed).toBe(2)

    // The file grew after stat: more bytes than it claimed means it is changing, so it reads as absent,
    // and the read still stops at size + 1.
    asked.length = 0
    expect(await readCapped('/f', 100, async () => fake({}, 3))).toBeNull()
    expect(asked.reduce((a, b) => a + b, 0)).toBe(4)
    expect(closed).toBe(3)

    // Not a file, a failing read and a failing close all read as absent; the handle is still closed.
    expect(await readCapped('/f', 100, async () => fake({ stat: async () => ({ isFile: () => false, size: 1 }) }))).toBeNull()
    expect(closed).toBe(4)
    expect(await readCapped('/f', 100, async () => fake({ read: async () => Promise.reject(new Error('EIO')) }))).toBeNull()
    expect(closed).toBe(5)
    const failingClose = fake({ close: async () => Promise.reject(new Error('EBADF')) })
    expect(await readCapped('/f', 100, async () => failingClose)).toBe(text)
    expect(await readCapped('/f', 100, async () => Promise.reject(new Error('ENOENT')))).toBeNull()
    // An empty file is an empty string.
    expect(await readCapped('/f', 100, async () => fake({}, 0, Buffer.alloc(0)))).toBe('')
  })

  it('source files are read through a reader capped near the detector limit; test reports keep the 16 MB one', async () => {
    expect(MAX_SOURCE_READ_BYTES).toBe(MAX_DETECT_FILE_CHARS + 64 * 1024)
    const big = join(dir, 'big.ts')
    await writeFile(big, 'x'.repeat(MAX_SOURCE_READ_BYTES + 1))
    await writeFile(join(dir, 'small.ts'), 'a\nb')
    let got: CompileDeps | null = null
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      got = deps
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(dir), HEAD] })
    const deps = got as unknown as CompileDeps
    expect(await (deps.readSource as (p: string) => Promise<string | null>)(big)).toBeNull()
    expect((await deps.readFile(big))?.length).toBe(MAX_SOURCE_READ_BYTES + 1)
    // Excerpts for labelling are source too.
    expect(await deps.label.excerpt('big.ts')).toBe('')
    expect(await deps.label.excerpt('small.ts')).toBe('a\nb')
  })

  it('an injected readSource serves source and excerpts; readFile still serves reports', async () => {
    let got: CompileDeps | null = null
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      got = deps
      return doc(input.projectKey)
    })
    const readSource = vi.fn(async () => 'src')
    const readFile = vi.fn(async () => 'report')
    const h = harness({ compile, readSource, readFile })
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap('/repo'), HEAD] })
    const deps = got as unknown as CompileDeps
    expect(deps.readSource).toBe(readSource)
    expect(deps.readFile).toBe(readFile)
    expect(await deps.label.excerpt('src/a.ts')).toBe('src')
    expect(readSource).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('a cloned repository is read only inside itself: a path that leaves the clone reads as null', async () => {
    const clone = join(dir, 'world', 'repos', 'abc')
    await mkdir(join(clone, 'src'), { recursive: true })
    await writeFile(join(clone, 'src', 'a.ts'), 'inside')
    await writeFile(join(dir, 'world', 'repos', 'outside.ts'), 'outside')
    await writeFile(join(dir, 'plain.ts'), 'plain')
    const seen: CompileDeps[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      seen.push(deps)
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.send({ kind: 'init', userDataPath: dir, labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(clone), HEAD] })
    const cloned = seen[0]
    expect(await cloned.readSource(join(clone, 'src', 'a.ts'))).toBe('inside')
    expect(await cloned.readFile(join(clone, 'src', 'a.ts'))).toBe('inside')
    expect(await cloned.label.excerpt('src/a.ts')).toBe('inside')
    expect(await cloned.readSource(join(clone, '..', 'outside.ts'))).toBeNull()
    expect(await cloned.readFile(join(clone, '..', 'outside.ts'))).toBeNull()
    expect(await cloned.readSource(join(clone, 'src', 'missing.ts'))).toBeNull()
    // A folder that is not a clone keeps the plain reader.
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k2', snap(dir), HEAD] })
    expect(await seen[1].readSource(join(dir, 'world', 'repos', 'outside.ts'))).toBe('outside')
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
    let pass = 0
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      // The first pass labels from the cache only: a miss answers null and asks main nothing.
      if (pass++ === 0) {
        expect(await (deps.label.llm as (p: string) => Promise<string | null>)('first')).toBeNull()
        return doc(input.projectKey)
      }
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
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap('/repo/'), HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
    // The model round trip runs in the follow-up the RPC did not wait for.
    await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'llm')).toBe(true))
    const ask1 = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
    expect(ask1).toMatchObject({ kind: 'llm', projectKey: 'k1', prompt: 'describe it' })
    await h.send({ kind: 'llm-result', id: 999, text: 'stray' }) // unknown id: ignored
    await h.send({ kind: 'llm-result', id: ask1.id, text: '{"name":"x"}' })
    await vi.waitFor(() => expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(2))
    const ask2 = h.out.filter((m) => m.kind === 'llm')[1] as Extract<WorldHostResponse, { kind: 'llm' }>
    await h.send({ kind: 'llm-result', id: ask2.id, text: 5 as unknown as string })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(answers).toEqual(['{"name":"x"}', null])
    expect(excerpts).toEqual(['one\ntwo\nthree', ''])
    expect(readFile).toHaveBeenCalledWith('/repo/src/a.ts')
  })

  it('labelling asks main for context through context / context-result, and a bad or missing answer is no evidence', async () => {
    const got: unknown[] = []
    let pass = 0
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      if (pass++ === 0) {
        await (deps.label.llm as (p: string) => Promise<string | null>)('first')
        return doc(input.projectKey)
      }
      const ctx = deps.label.context as (m: string[]) => Promise<unknown>
      got.push(await ctx(['a.ts']))
      got.push(await ctx(['b.ts']))
      return doc(input.projectKey)
    })
    const h = harness({ compile, contextTimeoutMs: 400 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'context')).toBe(true))
    const ask1 = h.out.find((m) => m.kind === 'context') as Extract<WorldHostResponse, { kind: 'context' }>
    expect(ask1).toMatchObject({ kind: 'context', projectKey: 'k1', members: ['a.ts'] })
    await h.send({ kind: 'context-result', id: 999, evidence: [] }) // unknown id: ignored
    const good = { kind: 'commit', ref: 'abc1234', excerpt: 'subject' }
    await h.send({
      kind: 'context-result',
      id: ask1.id,
      evidence: [good, null, { kind: 'trace', ref: 'x', excerpt: 'y' }, { kind: 'file', ref: 1, excerpt: 'y' }, { kind: 'file', ref: 'f' }, { ...good, extra: 1 }] as never
    })
    // the second request is never answered: it times out as no evidence
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(got).toEqual([[good, good], []])
  })

  it('cleanEvidence keeps whole file, commit and memory items and at most 11', () => {
    expect(cleanEvidence('x')).toEqual([])
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'memory', ref: `m${i}`, excerpt: 't' }))
    expect(cleanEvidence(many)).toHaveLength(11)
  })

  it('a compile with labelling off offers no context hook', async () => {
    let seen: CompileDeps['label'] | null = null
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      seen = deps.label
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect((seen as CompileDeps['label'] | null)?.context).toBeUndefined()
  })

  it('an unanswered labelling request times out as null', async () => {
    const answers: (string | null)[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      answers.push(await (deps.label.llm as (p: string) => Promise<string | null>)('p'))
      return doc(input.projectKey)
    })
    const h = harness({ compile, llmTimeoutMs: 5 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
    // The follow-up asked main once, heard nothing, and kept the code-derived labels.
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1)
    expect(answers).toEqual([null, null])
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

  it('a settings message switches labelling for the next compile and the next watcher recompile', async () => {
    const asked: string[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      if (deps.label.llm) {
        asked.push(input.projectKey)
        void deps.label.llm('describe')
      }
      return doc(input.projectKey)
    })
    const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 5 }, memStore({ k1: doc() }))
    await h.send({ kind: 'settings', labelling: false }) // before init: ignored, nothing to switch
    await h.init(true)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    // The cache-only first pass, then the labelled follow-up that asks main once.
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2))
    expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1)
    // Off mid-session: the next compile and a watcher recompile make zero model requests.
    await h.send({ kind: 'settings', labelling: false })
    await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(3))
    await h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k1', snap(), HEAD] })
    await tick()
    expect(compile).toHaveBeenCalledTimes(4)
    expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1)
    expect(asked).toEqual(['k1', 'k1'])
    // And back on; a non-boolean counts as on (only a literal false turns it off).
    await h.send({ kind: 'settings', labelling: 'yes' as unknown as boolean })
    await h.send({ kind: 'call', id: 4, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(2))
  })

  describe('save before labelling', () => {
    type Llm = (p: string) => Promise<string | null>

    it('with labelling on, compile returns the code-labelled world before any model call finishes', async () => {
      let pass = 0
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        const n = ++pass
        // The first pass asks the label cache only; the follow-up waits on the model.
        const text = await (deps.label.llm as Llm)(`describe ${n}`)
        return doc(input.projectKey, { generatedAt: n, glossary: text ? { Label: text } : {} })
      })
      const h = harness({ compile, llmTimeoutMs: 60_000 })
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      expect(h.results()).toEqual([{ kind: 'result', id: 1, ok: true, result: doc('k1', { generatedAt: 1, glossary: {} }) }])
      expect(h.store.saves).toEqual([doc('k1', { generatedAt: 1, glossary: {} })])
      // The model question is still open: the RPC did not wait for it.
      await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'llm')).toBe(true))
      const ask = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
      expect(ask.prompt).toBe('describe 2')
      expect(h.store.saves).toHaveLength(1)
      await h.send({ kind: 'llm-result', id: ask.id, text: 'labelled' })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      expect(h.store.saves[1].glossary).toEqual({ Label: 'labelled' })
    })

    it('the labelled follow-up saves and posts updated after the first save', async () => {
      const inputs: CompileInput[] = []
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        inputs.push(input)
        await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey, { generatedAt: inputs.length })
      })
      const h = harness({ compile, llmTimeoutMs: 60_000 }, memStore({ k1: doc('k1', { generatedAt: 0 }) }))
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'llm')).toBe(true))
      const ask = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
      await h.send({ kind: 'llm-result', id: ask.id, text: '{}' })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      expect(h.store.saves.map((d) => d.generatedAt)).toEqual([1, 2])
      expect(h.store.docs.get('k1')?.generatedAt).toBe(2)
      // The follow-up builds on the world it just saved, with the same snapshot and head.
      expect(inputs[1]).toEqual({ snap: snap(), projectKey: 'k1', head: HEAD, previous: doc('k1', { generatedAt: 1 }) })
      expect(h.out.map((m) => m.kind).filter((k) => k !== 'ready')).toEqual(['updated', 'result', 'llm', 'updated'])
    })

    it('with labelling off, compile runs once and asks no model', async () => {
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        expect(deps.label.llm).toBeNull()
        return doc(input.projectKey)
      })
      const h = harness({ compile })
      await h.init(false)
      await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      await new Promise((r) => setTimeout(r, 20))
      expect(compile).toHaveBeenCalledTimes(1)
      expect(h.store.saves).toHaveLength(1)
      expect(h.out.filter((m) => m.kind === 'updated')).toHaveLength(1)
      expect(h.out.some((m) => m.kind === 'llm')).toBe(false)
    })

    it('a failing labelled follow-up is logged and leaves the first world saved', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let pass = 0
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        await (deps.label.llm as Llm)('describe')
        if (++pass === 2) throw new Error('model reply broke the compile')
        return doc(input.projectKey)
      })
      const h = harness({ compile, llmTimeoutMs: 5 })
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      expect(h.last()).toEqual({ kind: 'result', id: 1, ok: true, result: doc('k1') })
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1))
      expect(error.mock.calls[0][0]).toContain('[world host] labelled follow-up failed')
      expect(String(error.mock.calls[0][1])).toContain('model reply broke the compile')
      expect(h.store.saves).toEqual([doc('k1')])
      expect(h.store.docs.get('k1')).toEqual(doc('k1'))
      expect(h.out.filter((m) => m.kind === 'updated')).toHaveLength(1)
      // The queue goes on: the next compile runs.
      await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
      expect(h.last()).toMatchObject({ id: 2, ok: true })
    })

    it("the follow-up keeps the first world's positions", async () => {
      const seen: CompileInput[] = []
      const store = memStore()
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        seen.push(input)
        const world = await compileWorld(input, deps)
        if (seen.length > 1) return world
        // Pin the first world's places somewhere no fresh layout would put them.
        const pinned = Object.fromEntries(Object.keys(world.layout.positions).map((id) => [id, [999, 0, 999] as [number, number, number]]))
        return { ...world, layout: { ...world.layout, positions: pinned } }
      })
      const h = harness({ compile, llmTimeoutMs: 5, contextTimeoutMs: 5 }, store)
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      await vi.waitFor(() => expect(store.saves).toHaveLength(2))
      const [first, labelled] = store.saves
      expect(Object.keys(first.layout.positions).length).toBeGreaterThan(0)
      expect(seen[1].previous).toEqual(first)
      expect(labelled.layout.positions).toEqual(first.layout.positions)
    })

    it('a world served whole from the label cache needs no follow-up, and one queued before labelling went off asks no model', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>((r) => (release = r))
      let miss = false
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        if (miss) await (deps.label.llm as Llm)('describe')
        if (input.head.head === 'slow') await gate
        return doc(input.projectKey)
      })
      const h = harness({ compile, llmTimeoutMs: 5 })
      await h.init(true)
      // Every part came from the cache (the first pass asked nothing): one compile is enough.
      await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      await new Promise((r) => setTimeout(r, 20))
      expect(compile).toHaveBeenCalledTimes(1)
      // A miss queues a follow-up, but labelling is turned off before it runs.
      miss = true
      const done = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), { head: 'slow', dirty: false }] })
      await tick()
      await h.send({ kind: 'settings', labelling: false })
      release()
      await done
      await new Promise((r) => setTimeout(r, 20))
      expect(compile).toHaveBeenCalledTimes(2)
      expect(h.out.some((m) => m.kind === 'llm')).toBe(false)
    })
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

  it('a valid linked design rides into compile, its labelled follow-up and the watcher recompile; an invalid one is dropped', async () => {
    const plan = emptyDesignDoc('design:p', 4)
    expect(validateWorld(plan)).toMatchObject({ ok: true })
    const inputs: CompileInput[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      inputs.push(input)
      if (deps.label.llm) await deps.label.llm('describe')
      return doc(input.projectKey, { generatedAt: inputs.length })
    })
    const h = harness({ compile, debounceMs: 5, llmTimeoutMs: 1 }, memStore({ k1: doc() }))
    await h.init(true)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD, { plan }] })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(inputs.map((i) => i.plan)).toEqual([plan, plan])
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD, { relayout: true, plan: { not: 'a world' } }] })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(4))
    expect(inputs.slice(2).map((i) => 'plan' in i)).toEqual([false, false])
    await h.send({ kind: 'call', id: 3, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts'], plan] })
    await vi.waitFor(() => expect(inputs).toHaveLength(5))
    expect(inputs[4].plan).toEqual(plan)
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(5))
    await h.send({ kind: 'call', id: 4, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
    await vi.waitFor(() => expect(inputs).toHaveLength(6))
    expect('plan' in inputs[5]).toBe(false)
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

describe('createWorldHost cloneSource / cancelClone', () => {
  const URL1 = 'https://github.com/a/b.git'
  const call = (send: ReturnType<typeof harness>['send'], id: number, fn: string, args: unknown[]) =>
    send({ kind: 'call', id, fn, args })
  const progress = (out: WorldHostResponse[]) => out.filter((m) => m.kind === 'progress')

  it('clones with the init userData as base, posts clone:<hash> progress 0 then 100, returns the result', async () => {
    const seen: { url: string; ref: string | undefined; baseDir: string; signal?: AbortSignal; isWindows: boolean }[] = []
    const h = harness({
      cloneRepo: async (url, ref, d) => {
        seen.push({ url, ref, baseDir: d.baseDir, signal: d.signal, isWindows: d.isWindows })
        return { ok: true, root: '/r' }
      }
    })
    await h.init()
    await call(h.send, 1, 'cloneSource', [URL1, 'main'])
    expect(h.last()).toMatchObject({ id: 1, ok: true, result: { ok: true, root: '/r' } })
    expect(seen[0]).toMatchObject({ url: URL1, ref: 'main', baseDir: '/ud', isWindows: process.platform === 'win32' })
    const key = `clone:${cloneKey(URL1, 'main')}`
    expect(progress(h.out)).toEqual([
      { kind: 'progress', projectKey: key, stage: 'cloning', pct: 0 },
      { kind: 'progress', projectKey: key, stage: 'cloning', pct: 100 }
    ])
  })

  it('a failed clone posts no 100, and a rejection becomes an error result', async () => {
    let n = 0
    const h = harness({
      cloneRepo: async () => {
        if (++n === 2) throw new Error('boom')
        return { ok: false, error: 'nope' }
      }
    })
    await h.init()
    await call(h.send, 1, 'cloneSource', [URL1])
    expect(h.last()).toMatchObject({ ok: true, result: { ok: false, error: 'nope' } })
    await call(h.send, 2, 'cloneSource', [URL1, ''])
    expect(h.last()).toMatchObject({ ok: false, error: { message: 'boom' } })
    expect(progress(h.out).map((m) => (m as { pct: number }).pct)).toEqual([0, 0])
  })

  it('a second cloneSource for the same hash joins the running one; cancelClone aborts it', async () => {
    let starts = 0
    let signal: AbortSignal | undefined
    let release: (r: { ok: false; error: string }) => void = () => undefined
    const h = harness({
      cloneRepo: (_u, _r, d) => {
        starts++
        signal = d.signal
        return new Promise((resolve) => {
          release = resolve
        })
      }
    })
    await h.init()
    const a = call(h.send, 1, 'cloneSource', [URL1])
    const b = call(h.send, 2, 'cloneSource', [URL1])
    await tick()
    expect(starts).toBe(1)
    expect(progress(h.out)).toHaveLength(1)
    await call(h.send, 3, 'cancelClone', [URL1])
    expect(h.last()).toMatchObject({ id: 3, ok: true, result: true })
    expect(signal?.aborted).toBe(true)
    release({ ok: false, error: 'Cancelled' })
    await Promise.all([a, b])
    expect(h.results().filter((m) => (m as { id: number }).id < 3)).toHaveLength(2)
    // finished: nothing to cancel, and the same url can be cloned again
    await call(h.send, 4, 'cancelClone', [URL1])
    expect(h.last()).toMatchObject({ id: 4, result: false })
    await call(h.send, 5, 'cancelClone', [42, 7])
    expect(h.last()).toMatchObject({ id: 5, result: false })
    await call(h.send, 6, 'cancelClone', [URL1, 'main'])
    expect(h.last()).toMatchObject({ id: 6, result: false })
  })

  it('without an injected cloneRepo, the real one refuses a hostile url before any git runs', async () => {
    const h = harness()
    await h.init()
    await call(h.send, 1, 'cloneSource', ['--upload-pack=x'])
    expect(h.last()).toMatchObject({ ok: true, result: { ok: false, error: expect.stringContaining('git URL') } })
    await call(h.send, 2, 'cloneSource', [123])
    expect(h.last()).toMatchObject({ result: { ok: false } })
  })

  it('cloneDeps override the real deps', async () => {
    const execFile = vi.fn(async () => ({ code: 0, stderr: '' }))
    const h = harness({ cloneDeps: {
        execFile,
        dirSize: async () => 1,
        rm: async () => undefined,
        exists: async () => false,
        listDir: async () => [],
        mark: async () => undefined,
        rename: async () => undefined
      } })
    await h.init()
    await call(h.send, 1, 'cloneSource', [URL1])
    expect(h.last()).toMatchObject({ result: { ok: true } })
    expect(execFile).toHaveBeenCalled()
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

describe('annotate', () => {
  const person = (text: string): Claim => ({ text, state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] })
  function memAnnotations(): AnnotationStore & { added: Array<[string, string, Claim]> } {
    const byKey = new Map<string, Record<string, Claim[]>>()
    const added: Array<[string, string, Claim]> = []
    return {
      added,
      list: async (k) => ({ ...(byKey.get(k) ?? {}) }),
      add: async (k, id, c) => {
        added.push([k, id, c])
        const cur = byKey.get(k) ?? {}
        byKey.set(k, { ...cur, [id]: [...(cur[id] ?? []), c] })
      }
    }
  }

  it('stores the claim, merges it into the saved world and answers that world', async () => {
    const ann = memAnnotations()
    const h = harness({ createAnnotations: () => ann }, memStore({ k1: doc() }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'annotate', args: ['k1', 'b-api', person('Front door')] })
    const saved = h.store.docs.get('k1') as WorldDoc
    expect(saved.buildings.find((b) => b.id === 'b-api')?.claims).toEqual([person('Front door')])
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: true, result: saved })
    expect(saved.generatedAt).toBeGreaterThan(doc().generatedAt) // a new generation, so an open pane reloads it
    // An edge is annotated the same way, and a second claim on the building joins the first.
    await h.send({ kind: 'call', id: 2, fn: 'annotate', args: ['k1', 'e-1', person('Reads rows')] })
    await h.send({ kind: 'call', id: 3, fn: 'annotate', args: ['k1', 'b-api', person('Second')] })
    const again = h.store.docs.get('k1') as WorldDoc
    expect(again.edges[0].claims).toEqual([person('Reads rows')])
    expect(again.buildings[0].claims.map((c) => c.text)).toEqual(['Front door', 'Second'])
    expect(ann.added).toHaveLength(3)
  })

  it('rejects an unknown part, an unknown world and a non-string id with "No part with that id."', async () => {
    const ann = memAnnotations()
    const h = harness({ createAnnotations: () => ann }, memStore({ k1: doc() }))
    await h.init()
    for (const [i, args] of [['k1', 'nope', person('x')], ['gone', 'b-api', person('x')], ['k1', 7, person('x')]].entries()) {
      await h.send({ kind: 'call', id: i + 1, fn: 'annotate', args })
      expect(h.last()).toMatchObject({ id: i + 1, ok: false, error: { message: 'No part with that id.' } })
    }
    expect(ann.added).toEqual([])
  })

  it('a compile merges what was annotated, by item id', async () => {
    const ann = memAnnotations()
    await ann.add('k1', 'b-api', person('Kept across compiles'))
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => compileWorld(input, deps))
    const h = harness({ compile, createAnnotations: () => ann })
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(compile).toHaveBeenCalled()
    const deps = compile.mock.calls[0][1]
    expect(await (deps.annotations as () => Promise<unknown>)()).toEqual({ 'b-api': [person('Kept across compiles')] })
  })
})

describe('filterWorld cards and plan', () => {
  const linked = (): WorldDoc => {
    const d = doc()
    d.layers.plan = [
      { id: 'design:n1', title: 'Linked design', summary: [], buildings: [], edges: [], removes: ['b-db'], reconcile: { matched: { auth: 'b-api' }, missing: ['mail'], extra: ['b-db'], changed: ['b-api'], planAt: 5 } },
      { id: 'p2', title: 'Sketch', summary: [], buildings: [{ ...d.buildings[0], id: 'sk1' }], edges: [] }
    ]
    return d
  }

  it('returns nothing extra unless asked, and empty results for no world', () => {
    expect(filterWorld(doc(), {})).not.toHaveProperty('cards')
    expect(filterWorld(doc(), {})).not.toHaveProperty('plan')
    expect(filterWorld(doc(), { cards: false, plan: false })).not.toHaveProperty('plan')
    expect(filterWorld(null, { cards: true, plan: true })).toEqual({ items: [], evidence: [], cards: {}, plan: { proposals: [] } })
  })

  it('cards: a plain-text card per building and line, none for a district', () => {
    const r = filterWorld(doc(), { cards: true })
    expect(Object.keys(r.cards as object).sort()).toEqual(['b-api', 'b-db', 'e-1'])
    expect(r.cards?.['b-api']).toContain('[')
    expect(filterWorld(doc(), { cards: true, ids: ['d-core'] }).cards).toEqual({})
  })

  it('plan: each proposal with missing, changed, extra and removes', () => {
    const r = filterWorld(linked(), { plan: true })
    expect(r.plan?.proposals).toEqual([
      { id: 'design:n1', title: 'Linked design', missing: ['mail'], changed: ['b-api'], extra: ['b-db'], removes: ['b-db'], planAt: 5 },
      { id: 'p2', title: 'Sketch', missing: ['sk1'], changed: [], extra: [], removes: [] }
    ])
    expect(r).not.toHaveProperty('cards')
  })
})

// ── Task 14: the host snapshot of an unindexed folder, and the staged compile ─────────────────────

/** A memStore that also keeps stage caches, like the real store. */
function stagedStore(initial: Record<string, WorldDoc> = {}) {
  const base = memStore(initial)
  const stages = new Map<string, StageCache>()
  return Object.assign(base, {
    stages,
    loadStages: async (k: string) => stages.get(k) ?? null,
    saveStages: async (k: string, c: StageCache) => void stages.set(k, c)
  })
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('fileSnapshot', () => {
  it('snapshotFromFiles in the host returns files and imports for a fixture folder', async () => {
    const repo = join(dir, 'fixture')
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(join(repo, 'src', 'a.ts'), "import { b } from './b'\nexport const a = b\n")
    await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
    await writeFile(join(repo, 'README.md'), '# fixture\n')
    await writeFile(join(repo, 'package-lock.json'), '{}\n')
    await writeFile(join(repo, 'src', 'untracked.ts'), 'export const u = 1\n')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['add', 'src/a.ts', 'src/b.ts', 'README.md', 'package-lock.json'], { cwd: repo })
    const h = harness()
    await h.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'snapshotFromFiles', args: [repo + '/'] })
    const r = h.last()
    expect(r).toMatchObject({ kind: 'result', id: 1, ok: true })
    expect((r as { result: GraphSnapshot }).result).toEqual({
      root: repo.replace(/\\/g, '/'),
      files: ['src/a.ts', 'src/b.ts'],
      symbols: [],
      callEdges: [],
      fileImports: { 'src/a.ts': ['./b'], 'src/b.ts': [] }
    })
    // Not a string, or empty: refused.
    await h.send({ kind: 'call', id: 2, fn: 'snapshotFromFiles', args: [42] })
    expect(h.last()).toMatchObject({ id: 2, ok: false, error: { message: 'worldHost: root required' } })
    await h.send({ kind: 'call', id: 3, fn: 'snapshotFromFiles', args: [''] })
    expect(h.last()).toMatchObject({ id: 3, ok: false })
  })

  it('a symlink or junction inside a clone that points outside it is not followed; a plain folder follows it', async () => {
    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'evil.ts'), "import { x } from './x'\nexport const evil = x\n")
    const make = async (root: string): Promise<void> => {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
      symlinkSync(outside, join(root, 'link'), 'junction')
    }
    const clone = join(dir, 'world', 'repos', 'abc')
    const plain = join(dir, 'plain')
    await make(clone)
    await make(plain)
    const listFiles = vi.fn(async () => ['src/a.ts', 'link/evil.ts'])
    const h = harness({ listFiles })
    await h.send({ kind: 'init', userDataPath: dir, labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'snapshotFromFiles', args: [clone] })
    expect((h.last() as { result: GraphSnapshot }).result.files).toEqual(['src/a.ts'])
    expect(listFiles).toHaveBeenCalledWith(clone)
    await h.send({ kind: 'call', id: 2, fn: 'snapshotFromFiles', args: [plain] })
    expect((h.last() as { result: GraphSnapshot }).result.files).toEqual(['link/evil.ts', 'src/a.ts'])
  })

  it('snapshotFromFiles keeps only safe, indexable, readable source files, once each', async () => {
    const texts: Record<string, string | null> = {
      '/r/src/a.ts': "import x from './b'\n",
      '/r/src/b.ts': 'export const b = 1\n',
      '/r/src/empty.ts': '',
      '/r/src/null.ts': null,
      '/r/src/big.ts': 'x'.repeat(MAX_SNAPSHOT_FILE_CHARS + 1)
    }
    const read = vi.fn(async (p: string) => {
      if (p.endsWith('throws.ts')) throw new Error('unreadable')
      return texts[p] ?? null
    })
    const listed = [
      'src/a.ts',
      'src/a.ts',
      'src\\a.ts',
      'src/b.ts',
      '../up.ts',
      '/abs.ts',
      'C:/drive.ts',
      'src//gap.ts',
      './dot.ts',
      '',
      'README.md',
      '.env',
      'src/empty.ts',
      'src/null.ts',
      'src/big.ts',
      'src/throws.ts'
    ]
    const got = await snapshotFromFiles('\\r\\', { read, listFiles: async () => listed })
    expect(got).toEqual({ root: '/r', files: ['src/a.ts', 'src/b.ts'], symbols: [], callEdges: [], fileImports: { 'src/a.ts': ['./b'], 'src/b.ts': [] } })
    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(['/r/src/a.ts', '/r/src/b.ts', '/r/src/big.ts', '/r/src/empty.ts', '/r/src/null.ts', '/r/src/throws.ts'])
    // A listing that fails lists nothing.
    const failing = await snapshotFromFiles('/r', {
      read,
      listFiles: async () => {
        throw new Error('no git')
      }
    })
    expect(failing.files).toEqual([])
  })

  it('gitListFiles runs git with the clone safety flags, falls back past a missing git, and lists nothing on failure', async () => {
    const calls: { cmd: string; args: string[]; opts: { timeout: number; maxBytes: number } }[] = []
    const answers: CaptureResult[] = [
      { code: 1, stdout: '', missing: true },
      { code: 0, stdout: 'src/a.ts\0src/b c.ts\0', missing: false }
    ]
    const exec: CaptureFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return answers.shift() as CaptureResult
    }
    expect(await gitListFiles('/r', exec, false)).toEqual(['src/a.ts', 'src/b c.ts'])
    expect(calls.map((c) => c.cmd)).toEqual(['git', '/usr/bin/git'])
    expect(calls[0].args).toEqual([...safetyFlags(false), '-c', 'core.fsmonitor=false', '-C', '/r', 'ls-files', '-z'])
    expect(calls[0].opts).toEqual({ timeout: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES })
    expect(await gitListFiles('/r', async () => ({ code: 128, stdout: 'x', missing: false }), true)).toEqual([])
    expect(await gitListFiles('/r', async () => ({ code: 1, stdout: '', missing: true }), true)).toEqual([])
    expect(gitCandidates(true)).toEqual(['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'])
    expect(gitCandidates(false)).toEqual(['git', '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/bin/git'])
    expect(gitCandidates()).toEqual(gitCandidates(process.platform === 'win32'))
  })

  it('captureExec collects stdout, drops the git path variables, and fails on a timeout, too much output or a missing program', async () => {
    const node = process.execPath
    const opts = { timeout: 20_000, maxBytes: 1024 }
    vi.stubEnv('GIT_DIR', '/somewhere')
    try {
      expect(await captureExec(node, ['-e', 'process.stdout.write(String(process.env.GIT_DIR) + "," + process.env.GIT_TERMINAL_PROMPT)'], opts)).toEqual({
        code: 0,
        stdout: 'undefined,0',
        missing: false
      })
    } finally {
      vi.unstubAllEnvs()
    }
    expect(await captureExec(node, ['-e', 'process.exit(3)'], opts)).toEqual({ code: 3, stdout: '', missing: false })
    expect(await captureExec(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 50, maxBytes: 1024 })).toEqual({ code: 1, stdout: '', missing: false })
    expect(await captureExec(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeout: 20_000, maxBytes: 10 })).toEqual({ code: 1, stdout: '', missing: false })
    expect(await captureExec(join(dir, 'no-such-program'), [], opts)).toEqual({ code: 1, stdout: '', missing: true })
  })
})

describe('the staged compile in the host', () => {
  const fixture = async (): Promise<GraphSnapshot> => {
    const root = join(dir, 'proj')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b'\nexport const a = b\n")
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1\n')
    return { root: root.replace(/\\/g, '/'), files: ['src/a.ts', 'src/b.ts'], symbols: [], callEdges: [], fileImports: {} }
  }
  const sourceReads = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => String(c[0]).replace(/^.*\/src\//, 'src/'))

  it('stores a stage cache; a watcher recompile reads only the changed file', async () => {
    const s = await fixture()
    const readSource = vi.fn(async (p: string) => readFile(p, 'utf8').catch(() => null))
    const store = stagedStore()
    const h = harness({ readSource, glob: async () => [], debounceMs: 1 }, store)
    await h.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
    expect(sourceReads(readSource).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(Object.keys(store.stages.get('k1')?.files ?? {})).toEqual(['src/a.ts', 'src/b.ts'])
    const before = store.stages.get('k1')?.files['src/a.ts'].hash
    readSource.mockClear()
    await writeFile(join(dir, 'proj', 'src', 'a.ts'), "import { b } from './b'\n\nexport const a = b + 1\n")
    await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', s, HEAD, ['src/a.ts']] })
    await until(() => store.saves.length === 2)
    expect(store.saves).toHaveLength(2)
    expect(sourceReads(readSource)).toEqual(['src/a.ts'])
    expect(store.stages.get('k1')?.files['src/a.ts'].hash).not.toBe(before)
  })

  it('the labelled follow-up reads no source file again: it compiles from the first pass stage cache', async () => {
    const s = await fixture()
    const store = stagedStore()
    const h = harness({ glob: async () => [], llmTimeoutMs: 1, contextTimeoutMs: 1 }, store)
    await h.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: true })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    await until(() => store.saves.length === 2)
    expect(store.saves).toHaveLength(2)
    // The boundary stage reports past 5% only while it reads files: the first pass did, the follow-up did not.
    const scans = h.out.filter((m) => m.kind === 'progress' && m.stage === 'boundaries' && m.pct > 5)
    expect(scans).toHaveLength(1)
    expect(h.out.filter((m) => m.kind === 'progress' && m.stage === 'grouping')).toHaveLength(2)
  })

  it('a store without stage methods still compiles in full', async () => {
    const s = await fixture()
    const h = harness({ glob: async () => [] })
    await h.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
    expect(h.store.saves).toHaveLength(1)
  })
})
