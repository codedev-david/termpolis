import { execFileSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import {
  captureExec,
  gitListFiles,
  insideGitRepo,
  listSourceFiles,
  LIST_TIMEOUT_MS,
  MAX_LIST_BYTES,
  MAX_SNAPSHOT_FILE_CHARS,
  snapshotFromFiles,
  type CaptureFn,
  type CaptureResult
} from '../../src/main/world/fileSnapshot'
import { commonDirArgs, lsFilesArgs, lsSubmoduleArgs, MAP_FILE_CAP, type RepoListing } from '../../src/main/repoFileList'
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
  cleanRuns,
  createWorldHost,
  excerptOf,
  filterWorld,
  globFiles,
  readCapped,
  MAX_SOURCE_READ_BYTES,
  type ReadHandle,
  serializeError,
  outwardError,
  startWorldHost,
  WATCH_RECOMPILE_MS,
  type GlobFn,
  type ParentPortLike,
  type WorldHostDeps,
  type WorldHostRequest,
  type WorldHostResponse
} from '../../src/main/world/worldHost'
import { CANCELLED_MESSAGE, CLONE_MARKER, CLONE_TIMEOUT_MS, cloneKey, NO_GIT_MESSAGE, safetyFlags, TIMEOUT_MESSAGE, type CloneResult, type LoginRun } from '../../src/main/world/gitSource'
import { TOKEN_EMPTY_MESSAGE, TOKEN_FORMAT_MESSAGE, TOKEN_REJECTED_MESSAGE } from '../../src/shared/world/repoAccess'
import type { AnnotationStore } from '../../src/main/world/annotations'
import { createWorldStore, WORLD_READ_FAILED, WORLD_SAVE_FAILED, WORLD_SAVED_BY_NEWER, WorldReadError, type WorldStore } from '../../src/main/world/worldStore'
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
  const host = createWorldHost((m) => out.push(m), { createStore: () => store, runsTimeoutMs: 5, ...deps })
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
  it('keeps a short constant code, and leaves out any other code (F-R11, I2)', () => {
    expect(serializeError(new WorldReadError())).toEqual({ message: WORLD_READ_FAILED, name: 'WorldReadError', code: 'WORLD_READ_FAILED' })
    expect(serializeError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toEqual({ message: 'x', name: 'Error', code: 'ENOENT' })
    for (const code of ['C:\\Users\\me\\world.json', 'lower', '', 'A'.repeat(65), 7]) {
      expect(serializeError(Object.assign(new Error('x'), { code }))).toEqual({ message: 'x', name: 'Error' })
    }
  })

  it('a WorldReadError thrown in the host reaches the caller with its name, message and code, and no path (I2)', async () => {
    const store = memStore()
    store.load = async () => { throw new WorldReadError() }
    const h = harness({}, store)
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'read', args: ['k1', {}] })
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: false, error: { message: WORLD_READ_FAILED, name: 'WorldReadError', code: 'WORLD_READ_FAILED' } })
  })

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
    expect(await deps.label.excerpt('src/a.ts')).toBe('src')
    expect(readSource).toHaveBeenCalledWith('/repo/src/a.ts')
    expect(readFile).not.toHaveBeenCalled()
    // The compile reads through them (a person's stop cuts them, WP4b F-R6, worldCompileCancel.test.ts).
    expect(await (deps.readSource as (p: string) => Promise<string | null>)('/repo/src/b.ts')).toBe('src')
    expect(await deps.readFile('/repo/report.xml')).toBe('report')
    expect(readFile).toHaveBeenCalledWith('/repo/report.xml')
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

  it('globFiles stops its walk once the signal is aborted: every later entry is excluded and no later match is kept (fix round 2, R2)', async () => {
    const stop = new AbortController()
    const walk: GlobFn = async function* (_p, o) {
      expect(o.exclude('src/a')).toBe(false)
      yield 'one.xml'
      stop.abort()
      expect(o.exclude('src/b')).toBe(true)
      yield 'two.xml'
    }
    expect(await globFiles('/r', ['*.xml'], walk, stop.signal)).toEqual([join('/r', 'one.xml')])
    // Aborted before it starts: no walk at all.
    const unused = vi.fn(walk)
    expect(await globFiles('/r', ['*.xml'], unused, stop.signal)).toEqual([])
    expect(unused).not.toHaveBeenCalled()
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

  it('matches names in other scripts, emoji names whole, and a decomposed name typed composed (and back)', () => {
    const named = (names: string[]) =>
      doc('k', { districts: names.map((name, i) => ({ id: `d${i}`, name, subtitle: '', hue: 0, members: [] })) })
    const nfd = 'café orders' // é stored as e + U+0301, as macOS file names arrive
    const w = named(['שלום', nfd, '数据库', '\u{1F680}', 'Plain'])
    const hits = (text: string) => filterWorld(w, { text }).items.map((i) => i.id)
    expect(hits('שלום')).toEqual(['d0'])
    expect(hits('café')).toEqual(['d1'])
    expect(hits('CAFÉ ORDERS')).toEqual(['d1'])
    expect(hits('数据库')).toEqual(['d2'])
    expect(hits('\u{1F680}')).toEqual(['d3'])
    expect(hits('plain')).toEqual(['d4'])
    // Composed in the world, decomposed in the query: the same match.
    expect(filterWorld(named(['café']), { text: 'café' }).items.map((i) => i.id)).toEqual(['d0'])
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

  describe('a file-system error never leaves the host with its paths (WP3 round 2)', () => {
    const fsError = (): NodeJS.ErrnoException =>
      Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\Users\\someone\\world\\k1.json.tmp' -> 'C:\\Users\\someone\\world\\k1.json'"), {
        code: 'EPERM', errno: -4048, syscall: 'rename', path: 'C:\\Users\\someone\\world\\k1.json.tmp'
      })
    const fixed = { message: WORLD_SAVE_FAILED, name: 'WorldSaveError', code: 'WORLD_SAVE_FAILED' }

    it('a save the disk refuses answers the fixed, coded error; the raw one goes to the log only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const raw = fsError()
        const store = { ...memStore(), save: async () => { throw raw } }
        const h = harness({ compile: async (input: CompileInput) => doc(input.projectKey) }, store)
        await h.init()
        await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
        const res = h.out.find((m) => m.kind === 'result')
        expect(res).toEqual({ kind: 'result', id: 1, ok: false, error: fixed })
        expect(JSON.stringify(h.out)).not.toContain('someone')
        expect(warn).toHaveBeenCalledWith('[world host] a file operation failed:', raw)
      } finally {
        warn.mockRestore()
      }
    })

    it('so does an init whose store cannot be made', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const h = harness({ createStore: () => { throw fsError() } })
        await h.init()
        expect(h.out[0]).toEqual({ kind: 'init-error', error: fixed })
      } finally {
        warn.mockRestore()
      }
    })

    it('anything that is not a file-system error goes out as serializeError writes it', () => {
      expect(outwardError(new WorldReadError())).toEqual(serializeError(new WorldReadError()))
      expect(outwardError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toEqual({ message: 'x', name: 'Error', code: 'ENOENT' })
      expect(outwardError('plain')).toEqual({ message: 'plain', name: 'Error' })
    })
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
    // The next layout round tells the window this is a Re-layout, not a watched change (round 2 N4).
    expect(seen[0].previous).toEqual({ ...stored, layout: { seed: 77, positions: {}, round: 1 } })
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
    expect(seen[2].previous?.layout).toEqual({ seed: 7, positions: {}, round: 1 })
    expect(Object.values(res.result.layout.positions).some((p) => p[0] === 999)).toBe(false)
    expect(res.result.layout.seed).toBe(7)
    expect(res.result.layout.round).toBe(1)
    // A plain compile carries the round; the next Re-layout is round 2.
    await h.send({ kind: 'call', id: 4, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(store.docs.get('k1')?.layout.round).toBe(1)
    await h.send({ kind: 'call', id: 5, fn: 'compile', args: ['k1', snap(), HEAD, { relayout: true }] })
    expect(store.docs.get('k1')?.layout.round).toBe(2)
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

  it('cleanRuns keeps whole runs, stamps the source and caps the count', () => {
    expect(cleanRuns('x', 'ci')).toEqual([])
    const good = { file: 'a.test.ts', passed: true, at: 3 }
    expect(cleanRuns([good, null, { ...good, file: 1 }, { ...good, passed: 'yes' }, { ...good, at: NaN }, { ...good, source: 'file' }], 'ci')).toEqual([
      { ...good, source: 'ci' },
      { ...good, source: 'ci' }
    ])
    expect(cleanRuns(Array.from({ length: 6000 }, () => good), 'transcript')).toHaveLength(5000)
  })

  it('a compile asks main for transcript FILES and reads them itself, and for CI runs; no answer in time is not known (null), and is not kept', async () => {
    const file = join(dir, 'session.jsonl')
    await writeFile(
      file,
      JSON.stringify({
        timestamp: '2026-11-02T10:00:00.000Z',
        message: { content: [{ type: 'tool_result', content: ' FAIL t.test.ts\n Tests  1 failed (1)' }] }
      })
    )
    const got: unknown[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      got.push(await deps.transcriptRuns?.(), await deps.ciRuns?.())
      return doc(input.projectKey)
    })
    const h = harness({ compile, runsTimeoutMs: 300 })
    await h.init(false)
    const call = h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'runs')).toBe(true))
    const ask = h.out.find((m) => m.kind === 'runs') as Extract<WorldHostResponse, { kind: 'runs' }>
    expect(ask).toMatchObject({ kind: 'runs', projectKey: 'k1', source: 'transcript' })
    await h.send({ kind: 'runs-result', id: 999, runs: [] }) // unknown id: ignored
    // main sends file names (and a hostile non-jsonl path, which the host drops); the host reads and parses them
    await h.send({ kind: 'runs-result', id: ask.id, runs: [], files: [file, '/etc/hosts'] })
    // the CI request is never answered: it times out as not known, which is not the same as no runs (fix round 3, N2)
    await call
    expect(got).toEqual([[{ file: 't.test.ts', passed: false, at: Date.parse('2026-11-02T10:00:00.000Z'), source: 'transcript' }], null])
    expect(h.out.filter((m) => m.kind === 'runs').map((m) => (m as { source: string }).source)).toEqual(['transcript', 'ci'])
    // The next compile takes the transcript runs from the cache (no new ask), and a CI answer that comes is cleaned.
    got.length = 0
    const again = h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.out.filter((m) => m.kind === 'runs')).toHaveLength(3))
    const ci = h.out.filter((m) => m.kind === 'runs')[2] as Extract<WorldHostResponse, { kind: 'runs' }>
    expect(ci.source).toBe('ci')
    await h.send({ kind: 'runs-result', id: ci.id, runs: [{ file: 'c.test.ts', passed: true, at: 3 }, { file: 7 }] as never, head: HEAD.head })
    await again
    expect(got).toEqual([[{ file: 't.test.ts', passed: false, at: Date.parse('2026-11-02T10:00:00.000Z'), source: 'transcript' }], [{ file: 'c.test.ts', passed: true, at: 3, source: 'ci' }]])
    // A transcript ask main does not answer in time is not known either, and is not cached: the next compile asks again.
    const quiet = harness({ compile, runsTimeoutMs: 20 })
    await quiet.init(false)
    got.length = 0
    await quiet.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await quiet.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(got).toEqual([null, null, null, null])
    expect(quiet.out.filter((m) => m.kind === 'runs' && (m as { source: string }).source === 'transcript')).toHaveLength(2)
  })

  it('a cloned repository gets no runs from main', async () => {
    const clone = join(dir, 'world', 'repos', 'abc')
    await mkdir(clone, { recursive: true })
    const seen: CompileDeps[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      seen.push(deps)
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.send({ kind: 'init', userDataPath: dir, labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(clone), HEAD] })
    expect(seen[0].transcriptRuns).toBeUndefined()
    expect(seen[0].ciRuns).toBeUndefined()
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

  it('an unanswered labelling request times out as null (the queue limit, when main never starts it)', async () => {
    const answers: (string | null)[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      answers.push(await (deps.label.llm as (p: string) => Promise<string | null>)('p'))
      return doc(input.projectKey)
    })
    const h = harness({ compile, llmTimeoutMs: 5, llmQueueTimeoutMs: 5 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: true })
    // The follow-up asked main once, heard nothing, and kept the code-derived labels.
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1)
    expect(answers).toEqual([null, null])
  })

  it('a labelling request waiting for a slot in main is not timed: its limit starts on llm-started, and the label run is told then (caveat 4)', async () => {
    vi.useFakeTimers()
    const marks: string[] = []
    let answer: Promise<string | null> = Promise.resolve(null)
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      if (deps.label.llm) answer = deps.label.llm('p', () => marks.push(`started ${Date.now()}`))
      return doc(input.projectKey)
    })
    const h = harness({ compile, llmTimeoutMs: 1000, llmQueueTimeoutMs: 60_000 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    const asks = (): Extract<WorldHostResponse, { kind: 'llm' }>[] => h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
    await vi.waitFor(() => expect(asks()).toHaveLength(1))
    const t0 = Date.now()
    let text: string | null | undefined
    void answer.then((t) => { text = t })
    // Five call limits pass while main has it waiting behind other worlds' calls: nothing times it out.
    await vi.advanceTimersByTimeAsync(5000)
    expect(text).toBeUndefined()
    expect(marks).toEqual([])
    await h.send({ kind: 'llm-started', id: 4242 }) // unknown id: ignored
    await h.send({ kind: 'llm-started', id: asks()[0].id })
    await h.send({ kind: 'llm-started', id: asks()[0].id }) // told twice: still one start
    expect(marks).toEqual([`started ${t0 + 5000}`])
    await vi.advanceTimersByTimeAsync(999)
    expect(text).toBeUndefined()
    // Its own limit, counted from the start: answered null, and main is told to drop it.
    await vi.advanceTimersByTimeAsync(1)
    expect(text).toBeNull()
    expect(h.out).toContainEqual({ kind: 'llm-cancel', id: asks()[0].id })
    expect(marks).toHaveLength(1)
  })

  it('a labelling request main never starts gives up after the queue limit, tells main, and counts as starting as it is answered (caveat 4)', async () => {
    vi.useFakeTimers()
    const marks: number[] = []
    let askedAt = 0
    let answer: Promise<string | null> = Promise.resolve(null)
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      askedAt = Date.now()
      if (deps.label.llm) answer = deps.label.llm('p', () => marks.push(Date.now()))
      return doc(input.projectKey)
    })
    const h = harness({ compile, llmTimeoutMs: 1000, llmQueueTimeoutMs: 60_000 })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'llm')).toBe(true))
    const ask = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
    let text: string | null | undefined
    void answer.then((t) => { text = t })
    // (waiting for the ask moved the fake clock: the limit counts from when it was asked)
    await vi.advanceTimersByTimeAsync(askedAt + 59_999 - Date.now())
    expect(text).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(text).toBeNull()
    expect(h.out).toContainEqual({ kind: 'llm-cancel', id: ask.id })
    // It reached no model: its start is the moment it was answered, so the label run times it as nothing.
    expect(marks).toEqual([askedAt + 60_000])
    // A late answer for it is dropped.
    await h.send({ kind: 'llm-result', id: ask.id, text: 'late' })
    expect(text).toBeNull()
  })

  it('a request answered without llm-started (refused in main) counts as starting as it is answered', async () => {
    const marks: string[] = []
    let answer: Promise<string | null> = Promise.resolve(null)
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      if (deps.label.llm) answer = deps.label.llm('p', () => marks.push('started'))
      return doc(input.projectKey)
    })
    const h = harness({ compile })
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'llm')).toBe(true))
    const ask = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
    expect(marks).toEqual([])
    await h.send({ kind: 'llm-result', id: ask.id, text: null })
    expect(await answer).toBeNull()
    expect(marks).toEqual(['started'])
    expect(h.out.some((m) => m.kind === 'llm-cancel')).toBe(false)
  })

  it('a world main says was removed: its label run asks nothing more, saves nothing, and starts no new run until main takes it back (caveat 4, round 1)', async () => {
    const seen: boolean[] = []
    // Which compiles could be stopped: only the label run's, which asks main's model. A cache-only compile of a removed
    // world still takes its labels from the cache (round 2: the pass checks the stop before it reads any excerpt).
    const stoppable: boolean[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      stoppable.push(typeof deps.label.stopped === 'function')
      seen.push(deps.label.stopped?.() === true)
      if (deps.label.llm) await deps.label.llm('p')
      seen.push(deps.label.stopped?.() === true)
      return doc(input.projectKey)
    })
    let ended = 0
    const h = harness({ compile, onLabelRunEnd: () => void ended++ })
    await h.init()
    const asks = () => h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(asks()).toHaveLength(1))
    // A second trigger while the run asks marks it to run once more.
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    // The world is removed (bad entries in the list are ignored), then its call comes back.
    await h.send({ kind: 'labelling-stopped', keys: ['k1', 7 as unknown as string] })
    await h.send({ kind: 'llm-result', id: asks()[0].id, text: null })
    // The run ends (it would not while a marked run's ask waited for an answer).
    await vi.waitFor(() => expect(ended).toBe(1))
    expect(seen.slice(-1)).toEqual([true])
    // Neither the labelled world is saved nor the marked run made: one ask in all.
    expect(h.store.saves).toHaveLength(2)
    expect(asks()).toHaveLength(1)
    // A compile of it while removed labels from the cache only and starts no run. A run it started would have asked
    // before the compile answers (labelLater starts it, and it asks, inside the compile's turn in the queue).
    await h.send({ kind: 'call', id: 3, fn: 'compile', args: ['k1', snap(), HEAD] })
    expect(h.last()).toMatchObject({ id: 3, ok: true })
    expect(h.store.saves).toHaveLength(3)
    expect(asks()).toHaveLength(1)
    expect(ended).toBe(1)
    // Main takes it back (asked for again; a list of another shape counts as none removed): it labels again.
    await h.send({ kind: 'labelling-stopped', keys: 'k1' as unknown as string[] })
    await h.send({ kind: 'call', id: 4, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(asks()).toHaveLength(2))
    expect(seen.slice(-1)).toEqual([false])
    // compile 1 (cache only), its label run, compiles 2, 3 and 4 (cache only), compile 4's label run.
    expect(stoppable).toEqual([false, true, false, false, false, true])
  })

  it('a label pass stopped by a removal and taken back before its save is not saved: the stored world is compiled again from the label cache (caveat 4, round 3)', async () => {
    type Marked = WorldDoc & { mark?: string }
    const marked = (k: string, mark: string): WorldDoc => ({ ...doc(k), mark }) as Marked
    let release: () => void = () => undefined
    const later = new Promise<void>((r) => (release = r))
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      // A cache-only pass takes every label the cache holds.
      if (typeof deps.label.stopped !== 'function') {
        if (deps.label.llm) await deps.label.llm('p')
        return marked(input.projectKey, 'cached')
      }
      // The label run's pass: its call is cut short by the removal, and its next batch sees the stop, so the batches
      // left come back blank, cached or not. Then its later stages run while the world is taken back.
      await deps.label.llm?.('p')
      expect(deps.label.stopped()).toBe(true)
      await later
      return marked(input.projectKey, 'blank')
    })
    let ended = 0
    const h = harness({ compile, onLabelRunEnd: () => void ended++ })
    await h.init()
    const asks = () => h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    await vi.waitFor(() => expect(asks()).toHaveLength(1))
    await h.send({ kind: 'labelling-stopped', keys: ['k1'] })
    await h.send({ kind: 'llm-result', id: asks()[0].id, text: null })
    await vi.waitFor(() => expect(compile.mock.results).toHaveLength(2))
    // A person opens it again (the pane's get) before the pass reaches its save.
    await h.send({ kind: 'labelling-stopped', keys: [] })
    release()
    await vi.waitFor(() => expect(ended).toBe(1))
    const marks = h.store.saves.map((d) => (d as Marked).mark)
    expect(marks).not.toContain('blank')
    expect(marks).toEqual(['cached', 'cached'])
    expect(asks()).toHaveLength(1)
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

  it('a watcher recompile starts 100 ms after the change: the code watcher already paced it (round 3 D)', async () => {
    expect(WATCH_RECOMPILE_MS).toBe(100)
    const compile = vi.fn(async (input: CompileInput) => doc(input.projectKey))
    const h = harness({ compile }, memStore({ k1: doc() }))
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 }) // the timeout bounds it
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
    const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 5, llmQueueTimeoutMs: 5 }, memStore({ k1: doc() }))
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

  it('the labeller init and settings name reaches labelling as heldBy; settings without one, or a non-string, clears it (review I1)', async () => {
    const heldBy: (string | undefined)[] = []
    const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
      heldBy.push(deps.label.heldBy?.())
      return doc(input.projectKey)
    })
    const h = harness({ compile }, memStore({ k1: doc() }))
    await h.send({ kind: 'init', userDataPath: '/ud', labelling: false, labeller: 'codex/gpt-5-mini' })
    const run = async (id: number): Promise<string | undefined> => {
      const before = compile.mock.calls.length
      await h.send({ kind: 'call', id, fn: 'compile', args: ['k1', snap(), HEAD] })
      await vi.waitFor(() => expect(compile.mock.calls.length).toBeGreaterThan(before))
      return heldBy[heldBy.length - 1]
    }
    expect(await run(1)).toBe('codex/gpt-5-mini')
    await h.send({ kind: 'settings', labelling: false, labeller: 'claude/haiku' })
    expect(await run(2)).toBe('claude/haiku')
    // Read live, by each batch: a run's deps follow a switch made while it runs (re-review N1).
    const running = (compile.mock.calls[1][1] as CompileDeps).label
    await h.send({ kind: 'settings', labelling: false, labeller: 'gemini/flash' })
    expect(running.heldBy?.()).toBe('gemini/flash')
    await h.send({ kind: 'settings', labelling: false })
    expect(await run(3)).toBeUndefined()
    expect(running.heldBy?.()).toBeUndefined()
    await h.send({ kind: 'settings', labelling: false, labeller: 7 as unknown as string })
    expect(await run(4)).toBeUndefined()
    // An init without one names none.
    await h.send({ kind: 'init', userDataPath: '/ud', labelling: false, labeller: '' })
    expect(await run(5)).toBeUndefined()
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
      const h = harness({ compile, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 })
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
      const h = harness({ compile, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc('k1', { generatedAt: 0 }) }))
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
      expect(h.out.map((m) => m.kind).filter((k) => k !== 'ready')).toEqual(['updated', 'llm', 'result', 'updated'])
    })

    it('a watcher recompile saves and posts updated before the model answers; the labels follow (film bug 8)', async () => {
      const inputs: CompileInput[] = []
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        inputs.push(input)
        const text = await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey, { generatedAt: inputs.length, glossary: text ? { Label: text } : {} })
      })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc('k1', { generatedAt: 0 }) }))
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      // The structural update is saved and pushed while the model question is still open.
      await vi.waitFor(() => expect(h.out.some((m) => m.kind === 'llm')).toBe(true))
      expect(h.store.saves).toEqual([doc('k1', { generatedAt: 1, glossary: {} })])
      expect(h.out.filter((m) => m.kind === 'updated')).toHaveLength(1)
      const ask = h.out.find((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>
      await h.send({ kind: 'llm-result', id: ask.id, text: 'labelled' })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      expect(h.store.saves[1].glossary).toEqual({ Label: 'labelled' })
      expect(h.out.filter((m) => m.kind === 'updated')).toHaveLength(2)
      // The labelled pass re-labels the changed files' buildings on top of the world just saved.
      expect(inputs[1]).toEqual({ snap: snap(), projectKey: 'k1', head: HEAD, previous: doc('k1', { generatedAt: 1, glossary: {} }), changed: ['src/a.ts'] })
    })

    it('a change while the model answers still saves at once; the late labels merge into the newer world', async () => {
      const inputs: CompileInput[] = []
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        inputs.push(input)
        const text = await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey, { generatedAt: inputs.length, glossary: text ? { Label: text } : {} })
      })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc('k1', { generatedAt: 0 }) }))
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      await vi.waitFor(() => expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1))
      // A second change while the first change's model call is open: saved and pushed without waiting for it.
      await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap('/new'), HEAD, ['src/b.ts']] })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      expect(h.store.saves.map((d) => d.generatedAt)).toEqual([1, 3])
      const [ask1] = h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
      await h.send({ kind: 'llm-result', id: ask1.id, text: 'late' })
      // The first model reply came back after a newer world was saved: that world is compiled again from the
      // label cache (no model asked) for the first change's files, and its result saved, not the stale one.
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(3))
      expect(inputs[3]).toEqual({ snap: snap('/new'), projectKey: 'k1', head: HEAD, previous: doc('k1', { generatedAt: 3, glossary: {} }), changed: ['src/a.ts'] })
      expect(h.store.saves[2]).toEqual(doc('k1', { generatedAt: 4, glossary: {} }))
      // Then the second change's labelling, which waited for the first run: one more run, for its files.
      await vi.waitFor(() => expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(2))
      expect(inputs[4]).toEqual({ snap: snap('/new'), projectKey: 'k1', head: HEAD, previous: doc('k1', { generatedAt: 4, glossary: {} }), changed: ['src/b.ts'] })
    })

    it('one labelling run per project at a time: triggers while it runs coalesce into one more run after it (fix wave I1)', async () => {
      const inputs: CompileInput[] = []
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        inputs.push(input)
        const text = await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey, { generatedAt: inputs.length, glossary: text ? { Label: text } : {} })
      })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc('k1', { generatedAt: 0 }) }))
      await h.init(true)
      const asks = (): Extract<WorldHostResponse, { kind: 'llm' }>[] => h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      await vi.waitFor(() => expect(asks()).toHaveLength(1))
      // Two more changes while the first run asks the model: each saved at once, neither starts a run.
      await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/c.ts']] })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      await h.send({ kind: 'call', id: 3, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/b.ts']] })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(3))
      await tick()
      expect(asks()).toHaveLength(1)
      await h.send({ kind: 'llm-result', id: asks()[0].id, text: 'one' })
      // The first run merges, then exactly one more run covers both later changes' files.
      await vi.waitFor(() => expect(asks()).toHaveLength(2))
      expect(inputs.at(-1)?.changed).toEqual(['src/b.ts', 'src/c.ts'])
      await h.send({ kind: 'llm-result', id: asks()[1].id, text: 'two' })
      await vi.waitFor(() => expect(h.store.saves.at(-1)?.glossary).toEqual({ Label: 'two' }))
      await tick()
      expect(asks()).toHaveLength(2)

      // A full compile while a run asks: the one rerun is a full pass (no `changed`), not two runs.
      await h.send({ kind: 'call', id: 4, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/d.ts']] })
      await vi.waitFor(() => expect(asks()).toHaveLength(3))
      await h.send({ kind: 'call', id: 5, fn: 'compile', args: ['k1', snap(), HEAD] })
      await h.send({ kind: 'call', id: 6, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/e.ts']] })
      await vi.waitFor(() => expect(h.results().some((r) => r.id === 5)).toBe(true))
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(inputs.length))
      await tick()
      expect(asks()).toHaveLength(3)
      await h.send({ kind: 'llm-result', id: asks()[2].id, text: 'three' })
      await vi.waitFor(() => expect(asks()).toHaveLength(4))
      expect(inputs.at(-1)?.changed).toBeUndefined()
      await h.send({ kind: 'llm-result', id: asks()[3].id, text: 'four' })
      await vi.waitFor(() => expect(h.store.saves.at(-1)?.glossary).toEqual({ Label: 'four' }))
      await tick()
      expect(asks()).toHaveLength(4)
    })

    it('a failure while the rerun is set up is logged and frees the project: the next trigger labels again (round 2 N1)', async () => {
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        const text = await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey, { glossary: text ? { Label: text } : {} })
      })
      const store = memStore({ k1: doc() })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, store)
      await h.init(true)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const asks = (): Extract<WorldHostResponse, { kind: 'llm' }>[] => h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      await vi.waitFor(() => expect(asks()).toHaveLength(1))
      await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/b.ts']] })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      // The stored world cannot be read when the rerun starts.
      const load = store.load
      store.load = async () => { throw new Error('disk gone') }
      await h.send({ kind: 'llm-result', id: asks()[0].id, text: 'one' })
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('[world host] labelling rerun failed:', expect.any(Error)))
      store.load = load
      await tick()
      expect(asks()).toHaveLength(1)
      // The project is free again: a later change starts a run that asks the model.
      await h.send({ kind: 'call', id: 3, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/c.ts']] })
      await vi.waitFor(() => expect(asks()).toHaveLength(2))
      await h.send({ kind: 'llm-result', id: asks()[1].id, text: 'two' })
      await vi.waitFor(() => expect(h.store.saves.at(-1)?.glossary).toEqual({ Label: 'two' }))
      errors.mockRestore()
    })

    it('labelling turned off while a run asks the model saves nothing more and runs no more (fix wave M3)', async () => {
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        const text = await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey, { glossary: text ? { Label: text } : {} })
      })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc() }))
      await h.init(true)
      const asks = (): Extract<WorldHostResponse, { kind: 'llm' }>[] => h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      await vi.waitFor(() => expect(asks()).toHaveLength(1))
      await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/b.ts']] })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      await h.send({ kind: 'settings', labelling: false })
      await h.send({ kind: 'llm-result', id: asks()[0].id, text: 'late' })
      await tick()
      await tick()
      expect(h.store.saves).toHaveLength(2)
      expect(h.out.filter((m) => m.kind === 'updated')).toHaveLength(2)
      expect(asks()).toHaveLength(1)
    })

    it('late labels for a world deleted meanwhile are dropped', async () => {
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        await (deps.label.llm as Llm)('describe')
        return doc(input.projectKey)
      })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc() }))
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      await vi.waitFor(() => expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1))
      await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/b.ts']] })
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
      h.store.docs.delete('k1')
      const [ask1] = h.out.filter((m) => m.kind === 'llm') as Extract<WorldHostResponse, { kind: 'llm' }>[]
      await h.send({ kind: 'llm-result', id: ask1.id, text: 'late' })
      await tick()
      await tick()
      // Neither the late merge nor the second change's waiting run compiles a deleted world.
      expect(compile).toHaveBeenCalledTimes(3)
      expect(h.out.filter((m) => m.kind === 'llm')).toHaveLength(1)
      expect(h.store.saves).toHaveLength(2)
      expect(h.store.docs.has('k1')).toBe(false)
    })

    it('labelling turned off while the cache-only pass runs asks no model afterwards', async () => {
      let release = (): void => undefined
      const gate = new Promise<void>((r) => (release = r))
      const compile = vi.fn(async (input: CompileInput, deps: CompileDeps) => {
        await (deps.label.llm as Llm)('describe')
        await gate
        return doc(input.projectKey)
      })
      const h = harness({ compile, debounceMs: 1, llmTimeoutMs: 60_000, llmQueueTimeoutMs: 60_000 }, memStore({ k1: doc() }))
      await h.init(true)
      await h.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1))
      await h.send({ kind: 'settings', labelling: false })
      release()
      await vi.waitFor(() => expect(h.store.saves).toHaveLength(1))
      await tick()
      expect(compile).toHaveBeenCalledTimes(1)
      expect(h.out.some((m) => m.kind === 'llm')).toBe(false)
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
      const h = harness({ compile, llmTimeoutMs: 5, llmQueueTimeoutMs: 5 })
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
      const h = harness({ compile, llmTimeoutMs: 5, llmQueueTimeoutMs: 5, contextTimeoutMs: 5 }, store)
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
      const h = harness({ compile, llmTimeoutMs: 5, llmQueueTimeoutMs: 5 })
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
    const h = harness({ compile, debounceMs: 5, llmTimeoutMs: 1, llmQueueTimeoutMs: 1 }, memStore({ k1: doc() }))
    await h.init(true)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD, { plan }] })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(2))
    expect(inputs.map((i) => i.plan)).toEqual([plan, plan])
    await h.send({ kind: 'call', id: 2, fn: 'compile', args: ['k1', snap(), HEAD, { relayout: true, plan: { not: 'a world' } }] })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(4))
    expect(inputs.slice(2).map((i) => 'plan' in i)).toEqual([false, false])
    await h.send({ kind: 'call', id: 3, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts'], plan] })
    // The watcher pass and its labelled follow-up both carry the design.
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(6))
    expect(inputs.slice(4).map((i) => i.plan)).toEqual([plan, plan])
    await h.send({ kind: 'call', id: 4, fn: 'notifyChanged', args: ['k1', snap(), HEAD, ['src/a.ts']] })
    await vi.waitFor(() => expect(h.store.saves).toHaveLength(8))
    expect('plan' in inputs[6]).toBe(false)
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
    const host = createWorldHost((m) => out.push(m), { runsTimeoutMs: 5 })
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

  it('a corrupt stored world that cannot be moved aside refuses the compile with WORLD_READ_FAILED and keeps its bytes (round 2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ud = join(dir, 'ud')
      await mkdir(join(ud, 'world'), { recursive: true })
      const stored = join(ud, 'world', 'k1.json')
      await writeFile(stored, '{"version":1,"districts":[')
      const compile = vi.fn(async (input: CompileInput) => doc(input.projectKey))
      const out: WorldHostResponse[] = []
      const host = createWorldHost((m) => out.push(m), {
        compile,
        runsTimeoutMs: 5,
        createStore: (d) => createWorldStore(d, { sleep: async () => undefined, rename: async () => { throw Object.assign(new Error('refused'), { code: 'EPERM' }) } })
      })
      await host.handle({ kind: 'init', userDataPath: ud, labelling: false })
      await host.handle({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
      expect(out.find((m) => m.kind === 'result')).toEqual({ kind: 'result', id: 1, ok: false, error: { message: WORLD_READ_FAILED, name: 'WorldReadError', code: 'WORLD_READ_FAILED' } })
      expect(await readFile(stored, 'utf8')).toBe('{"version":1,"districts":[')
      expect(out.some((m) => m.kind === 'updated')).toBe(false)
    } finally {
      warn.mockRestore()
    }
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
    // a git new enough to read the login settings from the environment
    const execFile = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stderr: '', stdout: args.includes('--version') ? 'git version 2.47.1' : '' }))
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

  describe('access, sign-in and background updates', () => {
    const VALUE = 'neutral-value-1'
    // A token run stats the askpass file at the start of its run, on the libuv pool, so one timer turn is
    // not always enough under load: each tick here also lets two stats of that file go through.
    const tick = async (): Promise<void> => {
      for (let i = 0; i < 2; i++) {
        await stat(join(dir, 'askpass.sh')).catch(() => undefined)
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    type Seen = { url: string; ref: string | undefined; run: LoginRun | undefined; askpassPath: string | undefined }
    const recording = (result: CloneResult = { ok: true, root: '/r', changed: true }) => {
      const seen: Seen[] = []
      const h = harness({
        cloneRepo: async (url, ref, d, run) => {
          seen.push({ url, ref, run, askpassPath: d.askpassPath })
          return result
        }
      })
      return { h, seen }
    }
    /** Init with a real askpass file, as a token run needs. */
    const initWithAskpass = async (h: ReturnType<typeof harness>): Promise<string> => {
      const p = join(dir, 'askpass.sh')
      await writeFile(p, '#!/bin/sh\n')
      await h.send({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: p })
      return p
    }
    /** A cloneRepo that records each run and waits until the test releases it. */
    const pending = (extra: WorldHostDeps = {}) => {
      const runs: (LoginRun | undefined)[] = []
      const timeouts: (number | undefined)[] = []
      const releases: ((r: CloneResult | Error) => void)[] = []
      const h = harness({
        ...extra,
        cloneRepo: (_u, _r, d, run) => {
          runs.push(run)
          timeouts.push(d.timeoutMs)
          return new Promise<CloneResult>((resolve, reject) => {
            releases.push((r) => (r instanceof Error ? reject(r) : resolve(r)))
          })
        }
      })
      return { h, runs, timeouts, releases }
    }

    it('maps each access to the right run', async () => {
      const { h, seen } = recording()
      await initWithAskpass(h)
      await call(h.send, 1, 'cloneSource', [URL1])
      expect(h.last()).toEqual({ kind: 'result', id: 1, ok: true, result: { ok: true, root: '/r' } })
      await call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await call(h.send, 3, 'cloneSource', [URL1, 'main', { mode: 'token', value: `  ${VALUE} \n` }])
      // anything that is not a known access is a run with no login
      await call(h.send, 4, 'cloneSource', [URL1, undefined, { mode: 'other' }])
      await call(h.send, 5, 'cloneSource', [URL1, undefined, null])
      expect(seen.map((s) => s.run)).toEqual([
        { mode: 'none' },
        { mode: 'machine', interactive: true },
        { mode: 'token', value: VALUE },
        { mode: 'none' },
        { mode: 'none' }
      ])
      expect(seen[2].ref).toBe('main')
      // the clone result never carries `changed` back to the renderer
      for (const r of h.results()) expect(r).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
      for (const r of h.results()) expect((r as { result: object }).result).not.toHaveProperty('changed')
    })

    it('the askpass path from init reaches the clone deps; without one (or not text) it is absent', async () => {
      const { h, seen } = recording()
      await h.send({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: '/res/git-askpass/askpass.sh' })
      await call(h.send, 1, 'cloneSource', [URL1])
      await h.send({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: 7 as unknown as string })
      await call(h.send, 2, 'cloneSource', [URL1])
      await h.init()
      await call(h.send, 3, 'cloneSource', [URL1])
      expect(seen.map((s) => s.askpassPath)).toEqual(['/res/git-askpass/askpass.sh', undefined, undefined])
    })

    it('a refused token never reaches git', async () => {
      const { h, seen } = recording()
      await h.init()
      await call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: '   ' }])
      expect(h.last()).toMatchObject({ ok: true, result: { ok: false, error: TOKEN_EMPTY_MESSAGE } })
      await call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'token', value: 'two words' }])
      expect(h.last()).toMatchObject({ ok: true, result: { ok: false, error: TOKEN_FORMAT_MESSAGE } })
      await call(h.send, 3, 'updateSource', [URL1, undefined, 'token', { mode: 'token', value: 7 }])
      expect(h.last()).toMatchObject({ ok: true, result: { ok: false, error: TOKEN_EMPTY_MESSAGE } })
      expect(seen).toEqual([])
      expect(progress(h.out)).toEqual([])
    })

    it('updateSource for login machine without access runs interactive:false', async () => {
      const { h, seen } = recording({ ok: true, root: '/r', changed: false })
      await initWithAskpass(h)
      await call(h.send, 1, 'updateSource', [URL1, 'main', 'machine'])
      expect(h.last()).toEqual({ kind: 'result', id: 1, ok: true, result: { ok: true, changed: false } })
      await call(h.send, 2, 'updateSource', [URL1])
      await call(h.send, 3, 'updateSource', [URL1, undefined, 'machine', { mode: 'machine' }])
      await call(h.send, 4, 'updateSource', [URL1, undefined, 'token', { mode: 'token', value: VALUE }])
      await call(h.send, 5, 'updateSource', [URL1, undefined, 'other'])
      expect(seen.map((s) => [s.ref, s.run])).toEqual([
        ['main', { mode: 'machine', interactive: false }],
        [undefined, { mode: 'none' }],
        [undefined, { mode: 'machine', interactive: true }],
        [undefined, { mode: 'token', value: VALUE }],
        [undefined, { mode: 'none' }]
      ])
    })

    it('updateSource for a token entry throws before git runs unless the access is a token', async () => {
      const { h, seen } = recording()
      await initWithAskpass(h)
      const shapes: unknown[][] = [[], [undefined], [null], [{ mode: 'other' }], [{ mode: 'machine' }], ['token']]
      let id = 0
      for (const extra of shapes) {
        await call(h.send, ++id, 'updateSource', [URL1, undefined, 'token', ...extra])
        expect(h.last()).toMatchObject({ id, ok: false, error: { message: 'token update needs a token' } })
      }
      expect(seen).toEqual([])
      expect(progress(h.out)).toEqual([])
      // with a token access it runs
      await call(h.send, ++id, 'updateSource', [URL1, undefined, 'token', { mode: 'token', value: VALUE }])
      expect(seen.map((s) => s.run)).toEqual([{ mode: 'token', value: VALUE }])
    })

    it('a token run whose askpass is missing is refused before git runs, with one plain log line', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { h, seen } = recording()
      // no askpass at all
      await h.init()
      await call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      expect(h.last()).toMatchObject({ id: 1, ok: true, result: { ok: false, error: TOKEN_REJECTED_MESSAGE } })
      // an askpass path that is not there, or is a folder
      await h.send({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: join(dir, 'gone.sh') })
      await call(h.send, 2, 'updateSource', [URL1, undefined, 'token', { mode: 'token', value: VALUE }])
      expect(h.last()).toMatchObject({ id: 2, ok: true, result: { ok: false, error: TOKEN_REJECTED_MESSAGE } })
      await h.send({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: dir })
      await call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      expect(h.last()).toMatchObject({ id: 3, ok: true, result: { ok: false, error: TOKEN_REJECTED_MESSAGE } })
      expect(seen).toEqual([])
      expect(warn).toHaveBeenCalledTimes(3)
      for (const c of warn.mock.calls) {
        expect(c).toHaveLength(1)
        expect(String(c[0])).not.toContain(VALUE)
      }
      // a run without a token never needs it
      await call(h.send, 4, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      expect(seen).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(3)
    })

    it('an askpass given in cloneDeps is the one checked', async () => {
      const p = join(dir, 'dep-askpass.sh')
      await writeFile(p, '#!/bin/sh\n')
      const seen: (string | undefined)[] = []
      const h = harness({
        cloneDeps: { askpassPath: p },
        cloneRepo: async (_u, _r, d) => {
          seen.push(d.askpassPath)
          return { ok: true, root: '/r', changed: true }
        }
      })
      await h.init()
      await call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      expect(h.last()).toMatchObject({ id: 1, ok: true, result: { ok: true, root: '/r' } })
      expect(seen).toEqual([p])
    })

    it('a token request during a running machine run waits for it, then git sees the token run', async () => {
      const { h, runs, releases } = pending()
      await initWithAskpass(h)
      const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      expect(runs).toEqual([{ mode: 'machine', interactive: false }])
      releases[0]({ ok: false, error: 'needs sign-in', needsLogin: { host: 'github.com', helper: true } })
      await a
      for (let i = 0; i < 5 && runs.length < 2; i++) await tick()
      expect(runs).toEqual([{ mode: 'machine', interactive: false }, { mode: 'token', value: VALUE }])
      releases[1]({ ok: true, root: '/r', changed: true })
      await b
      expect(h.results().find((m) => (m as { id: number }).id === 2)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
    })

    it('an interactive sign-in during a background update is a second, interactive run, even if the first fails', async () => {
      const { h, runs, releases } = pending()
      await h.init()
      const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await tick()
      expect(runs).toHaveLength(1)
      releases[0](new Error('boom'))
      await a
      for (let i = 0; i < 5 && runs.length < 2; i++) await tick()
      expect(runs).toEqual([{ mode: 'machine', interactive: false }, { mode: 'machine', interactive: true }])
      releases[1]({ ok: true, root: '/r', changed: true })
      await b
      const key = `clone:${cloneKey(URL1, undefined)}`
      // only the open posted progress
      expect(progress(h.out)).toEqual([
        { kind: 'progress', projectKey: key, stage: 'cloning', pct: 0 },
        { kind: 'progress', projectKey: key, stage: 'cloning', pct: 100 }
      ])
    })

    const resultOf = (h: ReturnType<typeof harness>, id: number) => h.results().find((m) => (m as { id: number }).id === id)
    const settle = async () => {
      for (let i = 0; i < 5; i++) await tick()
    }

    for (const [label, access] of [
      ['an interactive sign-in', { mode: 'machine' }],
      ['a token run', { mode: 'token', value: VALUE }]
    ] as const) {
      it(`cancelling while ${label} waits behind another run: git never sees it`, async () => {
        const { h, runs, releases } = pending()
        await initWithAskpass(h)
        const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
        await tick()
        const b = call(h.send, 2, 'cloneSource', [URL1, undefined, access])
        await tick()
        await call(h.send, 3, 'cancelClone', [URL1])
        expect(resultOf(h, 3)).toMatchObject({ ok: true, result: true })
        releases[0]({ ok: false, error: CANCELLED_MESSAGE })
        await Promise.all([a, b])
        await settle()
        expect(runs).toEqual([{ mode: 'machine', interactive: false }])
        expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
        // nothing is left waiting or running
        await call(h.send, 4, 'cancelClone', [URL1])
        expect(resultOf(h, 4)).toMatchObject({ ok: true, result: false })
      })
    }

    // The askpass check is part of the registered run: a cancel that lands while it is still being looked
    // for finds the run, and the clone then stops before git is even looked up.
    for (const fn of ['cloneSource', 'updateSource'] as const) {
      it(`a cancel while a token ${fn} checks for the askpass returns Cancelled, and git never starts`, async () => {
        const execFile = vi.fn(async () => ({ code: 0, stderr: '', stdout: 'git version 2.47.1' }))
        const gitBin = vi.fn(async () => '/usr/bin/git')
        const h = harness({ cloneDeps: { execFile, gitBin } })
        await initWithAskpass(h)
        const access = { mode: 'token', value: VALUE }
        const a = call(h.send, 1, fn, fn === 'cloneSource' ? [URL1, undefined, access] : [URL1, undefined, 'token', access])
        // no await between the two: the cancel lands while the askpass file is still being looked at
        await call(h.send, 2, 'cancelClone', [URL1])
        expect(resultOf(h, 2)).toMatchObject({ ok: true, result: true })
        await a
        expect(resultOf(h, 1)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
        expect(gitBin).not.toHaveBeenCalled()
        expect(execFile).not.toHaveBeenCalled()
        // nothing is left running
        await call(h.send, 3, 'cancelClone', [URL1])
        expect(resultOf(h, 3)).toMatchObject({ ok: true, result: false })
      })
    }

    // A cancel that lands while a missing askpass is still being looked for is a cancel, not a refused token.
    it('a cancel during the askpass check of a token run whose askpass is missing returns Cancelled', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const execFile = vi.fn(async () => ({ code: 0, stderr: '', stdout: 'git version 2.47.1' }))
      const gitBin = vi.fn(async () => '/usr/bin/git')
      const h = harness({ cloneDeps: { execFile, gitBin } })
      await h.send({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: join(dir, 'no-askpass-here.sh') })
      const a = call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      // no await between the two: the cancel lands while the stat of the missing file is still pending
      await call(h.send, 2, 'cancelClone', [URL1])
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: true })
      await a
      expect(resultOf(h, 1)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
      expect(gitBin).not.toHaveBeenCalled()
      expect(execFile).not.toHaveBeenCalled()
      // with no cancel, the same missing askpass is a refused token
      await call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: { ok: false, error: TOKEN_REJECTED_MESSAGE } })
    })

    it('a token run whose askpass is missing is still refused inside the run, so it waits its turn like any other', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { h, runs, releases } = pending()
      await h.init()
      const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      // the refused token run is queued behind the machine run, where a cancel can reach it
      await call(h.send, 3, 'cancelClone', [URL1])
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: true })
      releases[0]({ ok: true, root: '/r', changed: false })
      await Promise.all([a, b])
      expect(runs).toEqual([{ mode: 'machine', interactive: false }])
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
    })

    it('an update of the saved URL, without the user, reaches the folder the URL with the user was cloned into', async () => {
      let root = ''
      const fetchDirs: string[] = []
      const execFile = vi.fn(async (_c: string, args: string[]) => {
        if (args.includes('fetch')) fetchDirs.push(args[args.indexOf('--git-dir') + 1])
        return { code: 0, stderr: '', stdout: args.includes('--version') ? 'git version 2.47.1' : '' }
      })
      const h = harness({
        cloneDeps: {
          execFile,
          gitBin: async () => '/usr/bin/git',
          realpath: async (p) => p,
          dirSize: async () => 1,
          rm: async () => undefined,
          exists: async (p) => root !== '' && p === join(root, '.git', CLONE_MARKER),
          listDir: async () => [],
          mark: async () => undefined,
          rename: async (_from, to) => void (root = to)
        }
      })
      await h.init()
      await call(h.send, 1, 'cloneSource', ['https://me@github.com/a/b.git', undefined, { mode: 'machine' }])
      expect(root).not.toBe('')
      expect(resultOf(h, 1)).toMatchObject({ ok: true, result: { ok: true, root } })
      // the sources registry saved the URL without the user, and the update passes that
      await call(h.send, 2, 'updateSource', [URL1, undefined, 'machine'])
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: true, changed: true } })
      expect(fetchDirs).toEqual([join(root, '.git')])
      expect(execFile.mock.calls.filter((c) => c[1].includes('clone'))).toHaveLength(1)
    })

    it('a cancel of the saved URL reaches the running clone of the URL with the user', async () => {
      const { h, runs, releases } = pending()
      await h.init()
      const a = call(h.send, 1, 'cloneSource', ['https://me@github.com/a/b.git', undefined, { mode: 'machine' }])
      await tick()
      expect(runs).toHaveLength(1)
      await call(h.send, 2, 'cancelClone', [URL1])
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: true })
      releases[0]({ ok: false, error: CANCELLED_MESSAGE })
      await a
      // and its progress is posted under the folder's one key
      expect(progress(h.out)[0]).toMatchObject({ projectKey: `clone:${cloneKey(URL1)}` })
    })

    it('a request queued after a cancel still runs normally', async () => {
      const { h, runs, releases } = pending()
      await initWithAskpass(h)
      const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await tick()
      await call(h.send, 3, 'cancelClone', [URL1])
      const c = call(h.send, 4, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      releases[0]({ ok: false, error: CANCELLED_MESSAGE })
      await Promise.all([a, b])
      await settle()
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
      expect(runs).toEqual([{ mode: 'machine', interactive: false }, { mode: 'token', value: VALUE }])
      releases[1]({ ok: true, root: '/r', changed: true })
      await c
      expect(resultOf(h, 4)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
    })

    it('a call that waited a whole run time answers the timeout copy and never starts git', async () => {
      let clock = 1_000
      const { h, runs, releases } = pending({ now: () => clock })
      await h.init()
      const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      const c = call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await tick()
      clock += CLONE_TIMEOUT_MS
      releases[0]({ ok: true, root: '/r', changed: false })
      await Promise.all([a, b, c])
      await settle()
      expect(runs).toHaveLength(1)
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: false, error: TIMEOUT_MESSAGE } })
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: { ok: false, error: TIMEOUT_MESSAGE } })
      // one ms short of it still runs
      const d = call(h.send, 4, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const e = call(h.send, 5, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await tick()
      clock += CLONE_TIMEOUT_MS - 1
      releases[1]({ ok: true, root: '/r', changed: false })
      await d
      await settle()
      expect(runs).toHaveLength(3)
      releases[2]({ ok: true, root: '/r', changed: true })
      await e
      expect(resultOf(h, 5)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
    })

    it('a queued run gets only the time its wait left; a fresh run gets the full time', async () => {
      let clock = 1_000
      const { h, runs, timeouts, releases } = pending({ now: () => clock })
      await initWithAskpass(h)
      const a = call(h.send, 1, 'updateSource', [URL1, undefined, 'machine'])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      clock += 60_000
      releases[0]({ ok: true, root: '/r', changed: false })
      await a
      await settle()
      expect(runs).toEqual([{ mode: 'machine', interactive: false }, { mode: 'token', value: VALUE }])
      expect(timeouts).toEqual([CLONE_TIMEOUT_MS, CLONE_TIMEOUT_MS - 60_000])
      releases[1]({ ok: true, root: '/r', changed: true })
      await b
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
    })

    it('waits add up across re-queues: token, machine, token times out with no git of its own', async () => {
      let clock = 1_000
      const { h, runs, timeouts, releases } = pending({ now: () => clock })
      await initWithAskpass(h)
      const a = call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      const c = call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: 'neutral-value-2' }])
      await tick()
      // A takes 200 s; B starts, C queues again behind B
      clock += 200_000
      releases[0]({ ok: true, root: '/r', changed: true })
      await a
      await settle()
      expect(runs).toEqual([{ mode: 'token', value: VALUE }, { mode: 'machine', interactive: true }])
      expect(timeouts).toEqual([CLONE_TIMEOUT_MS, CLONE_TIMEOUT_MS - 200_000])
      // B takes 100 s: C has now waited the whole run time and never starts git
      clock += 100_000
      releases[1]({ ok: true, root: '/r', changed: true })
      await Promise.all([b, c])
      await settle()
      expect(runs).toHaveLength(2)
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: { ok: false, error: TIMEOUT_MESSAGE } })
      // nothing is left waiting or running
      await call(h.send, 4, 'cancelClone', [URL1])
      expect(resultOf(h, 4)).toMatchObject({ ok: true, result: false })
    })

    it('a call that re-queued still runs with the rest of its time when the waits stay short', async () => {
      let clock = 1_000
      const { h, runs, timeouts, releases } = pending({ now: () => clock })
      await initWithAskpass(h)
      const a = call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      const c = call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: 'neutral-value-2' }])
      await tick()
      clock += 10_000
      releases[0]({ ok: true, root: '/r', changed: true })
      await a
      await settle()
      clock += 20_000
      releases[1]({ ok: true, root: '/r', changed: true })
      await b
      await settle()
      expect(runs).toEqual([
        { mode: 'token', value: VALUE },
        { mode: 'machine', interactive: true },
        { mode: 'token', value: 'neutral-value-2' }
      ])
      expect(timeouts).toEqual([CLONE_TIMEOUT_MS, CLONE_TIMEOUT_MS - 10_000, CLONE_TIMEOUT_MS - 30_000])
      releases[2]({ ok: true, root: '/r', changed: true })
      await c
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
    })

    it('a cancel in the first wait stops every waiter, the one that would have re-queued included', async () => {
      const { h, runs, releases } = pending()
      await initWithAskpass(h)
      const a = call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      const c = call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: 'neutral-value-2' }])
      await tick()
      await call(h.send, 4, 'cancelClone', [URL1])
      expect(resultOf(h, 4)).toMatchObject({ ok: true, result: true })
      releases[0]({ ok: false, error: CANCELLED_MESSAGE })
      await Promise.all([a, b, c])
      await settle()
      expect(runs).toEqual([{ mode: 'token', value: VALUE }])
      expect(resultOf(h, 2)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
    })

    it('a cancel while a re-queued call waits a second time stops it too', async () => {
      const { h, runs, releases } = pending()
      await initWithAskpass(h)
      const a = call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      const b = call(h.send, 2, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      const c = call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: 'neutral-value-2' }])
      await tick()
      releases[0]({ ok: true, root: '/r', changed: true })
      await a
      await settle()
      expect(runs).toHaveLength(2)
      // C is now queued behind B
      await call(h.send, 4, 'cancelClone', [URL1])
      expect(resultOf(h, 4)).toMatchObject({ ok: true, result: true })
      releases[1]({ ok: false, error: CANCELLED_MESSAGE })
      await Promise.all([b, c])
      await settle()
      expect(runs).toHaveLength(2)
      expect(resultOf(h, 3)).toMatchObject({ ok: true, result: { ok: false, error: CANCELLED_MESSAGE } })
      // a fresh call afterwards runs normally
      const d = call(h.send, 5, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await tick()
      expect(runs).toHaveLength(3)
      releases[2]({ ok: true, root: '/r', changed: true })
      await d
      expect(resultOf(h, 5)).toMatchObject({ ok: true, result: { ok: true, root: '/r' } })
    })

    it('an identical request still joins; an open joining a silent run turns its progress on', async () => {
      const { h, runs, releases } = pending()
      await initWithAskpass(h)
      const a = call(h.send, 1, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      const b = call(h.send, 2, 'updateSource', [URL1, undefined, 'token', { mode: 'token', value: ` ${VALUE} ` }])
      await tick()
      expect(runs).toHaveLength(1)
      releases[0]({ ok: true, root: '/r', changed: true })
      await Promise.all([a, b])
      // a different token is a different run
      const c = call(h.send, 3, 'cloneSource', [URL1, undefined, { mode: 'token', value: VALUE }])
      await tick()
      const d = call(h.send, 4, 'cloneSource', [URL1, undefined, { mode: 'token', value: 'neutral-value-2' }])
      await tick()
      expect(runs).toHaveLength(2)
      releases[1]({ ok: true, root: '/r', changed: false })
      await c
      for (let i = 0; i < 5 && runs.length < 3; i++) await tick()
      expect(runs[2]).toEqual({ mode: 'token', value: 'neutral-value-2' })
      releases[2]({ ok: true, root: '/r', changed: false })
      await d
      // a silent background run joined by the same open: progress is turned on once, then 100
      h.out.length = 0
      const e = call(h.send, 5, 'updateSource', [URL1, undefined, 'machine', { mode: 'machine' }])
      await tick()
      expect(progress(h.out)).toEqual([])
      const f = call(h.send, 6, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      const g = call(h.send, 7, 'cloneSource', [URL1, undefined, { mode: 'machine' }])
      await tick()
      expect(runs).toHaveLength(4)
      releases[3]({ ok: true, root: '/r', changed: true })
      await Promise.all([e, f, g])
      expect(progress(h.out).map((m) => (m as { pct: number }).pct)).toEqual([0, 100])
      expect(h.results().map((m) => (m as { id: number }).id).sort()).toEqual([5, 6, 7])
    })

    it('a failure that needs a sign-in passes through cloneSource and updateSource with its needsLogin', async () => {
      const failed: CloneResult = { ok: false, error: 'needs sign-in', needsLogin: { host: 'github.com', helper: true } }
      const { h } = recording(failed)
      await h.init()
      await call(h.send, 1, 'cloneSource', [URL1])
      expect(h.last()).toMatchObject({ ok: true, result: failed })
      await call(h.send, 2, 'updateSource', [URL1, undefined, 'machine'])
      expect(h.last()).toMatchObject({ ok: true, result: failed })
    })
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
      },
      copyRenamed: async (k, renames) => {
        const cur = byKey.get(k) ?? {}
        const next: Record<string, Claim[]> = { ...cur }
        for (const [id, cs] of Object.entries(cur)) if (renames[id]) next[renames[id]] = [...(next[renames[id]] ?? []), ...cs]
        byKey.set(k, next)
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

  it('refuses to annotate a world a newer Termpolis saved, adding and saving nothing (M6)', async () => {
    const ann = memAnnotations()
    const h = harness({ createAnnotations: () => ann }, memStore({ k1: { ...doc(), savedByNewer: true } }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'annotate', args: ['k1', 'b-api', person('x')] })
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: false, error: { message: WORLD_SAVED_BY_NEWER, name: 'WorldSavedByNewerError', code: 'WORLD_SAVED_BY_NEWER' } })
    expect(ann.added).toEqual([])
    expect(h.store.saves).toEqual([])
  })

  it("leaves a design's annotations to main's designer, which writes the design under its lock: it adds and saves nothing (DSN D1)", async () => {
    const ann = memAnnotations()
    const h = harness({ createAnnotations: () => ann }, memStore({ 'design:d1': { ...doc(), projectKey: 'design:d1' } }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'annotate', args: ['design:d1', 'b-api', person('x')] })
    expect(h.last()).toMatchObject({ id: 1, ok: false, error: { message: 'No world with that key.' } })
    expect(ann.added).toEqual([])
    expect(h.store.saves).toEqual([])
  })

  it('a design a newer Termpolis saved is refused with the B7 words, not "No world with that key." (DSN Round 1, item 10)', async () => {
    const ann = memAnnotations()
    // DSN R2, F5: only the design file's version is read, never the design through the store.
    const store = memStore({ 'design:d1': { ...doc(), projectKey: 'design:d1' } })
    const loads = vi.spyOn(store, 'load')
    const h = harness({ createAnnotations: () => ann }, store)
    await h.send({ kind: 'init', userDataPath: dir, labelling: false })
    await mkdir(join(dir, 'world', 'design_d4.json'), { recursive: true })
    await writeFile(join(dir, 'world', 'design_d1.json'), JSON.stringify({ ...doc(), projectKey: 'design:d1', version: 99 }))
    await writeFile(join(dir, 'world', 'design_d2.json'), JSON.stringify({ ...doc(), projectKey: 'design:d2' }))
    await writeFile(join(dir, 'world', 'design_d3.json'), '{ not json')
    await h.send({ kind: 'call', id: 1, fn: 'annotate', args: ['design:d1', 'b-api', person('x')] })
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: false, error: { message: WORLD_SAVED_BY_NEWER, name: 'WorldSavedByNewerError', code: 'WORLD_SAVED_BY_NEWER' } })
    // Missing, one of this version's, not parsing, or not readable (a folder): the design is not the host's to annotate.
    for (const [id, key] of [[2, 'design:gone'], [3, 'design:d2'], [4, 'design:d3'], [5, 'design:d4']] as const) {
      await h.send({ kind: 'call', id, fn: 'annotate', args: [key, 'b-api', person('x')] })
      expect(h.last()).toEqual({ kind: 'result', id, ok: false, error: { message: 'No world with that key.', name: 'Error' } })
    }
    expect(loads).not.toHaveBeenCalled()
    expect(ann.added).toEqual([])
    expect(h.store.saves).toEqual([])
  })

  it('a design file held for a moment by another program is read again for its version, so it still gives the B7 words (DSN R3-5)', async () => {
    const tries: string[] = []
    const readWorldText = async (f: string): Promise<string> => {
      tries.push(f)
      if (tries.length === 1) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return readFile(f, 'utf8')
    }
    const h = harness({ createAnnotations: () => memAnnotations(), readWorldText } as never, memStore({}))
    await h.send({ kind: 'init', userDataPath: dir, labelling: false })
    await mkdir(join(dir, 'world'), { recursive: true })
    await writeFile(join(dir, 'world', 'design_d1.json'), JSON.stringify({ ...doc(), projectKey: 'design:d1', version: 99 }))
    await h.send({ kind: 'call', id: 1, fn: 'annotate', args: ['design:d1', 'b-api', person('x')] })
    expect(h.last()).toEqual({ kind: 'result', id: 1, ok: false, error: { message: WORLD_SAVED_BY_NEWER, name: 'WorldSavedByNewerError', code: 'WORLD_SAVED_BY_NEWER' } })
    expect(tries).toEqual([join(dir, 'world', 'design_d1.json'), join(dir, 'world', 'design_d1.json')])
  })

  it("never compiles a design: a design is main's designer's to write (DSN Round 1, item 5)", async () => {
    const plan = { ...doc(), projectKey: 'design:d1' }
    const h = harness({}, memStore({ 'design:d1': plan }))
    await h.init()
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['design:d1', snap('/repo'), HEAD] })
    expect(h.last()).toMatchObject({ id: 1, ok: false, error: { message: 'worldHost: a design is written by its designer' } })
    await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['design:d1', snap(), HEAD, ['src/a.ts']] })
    expect(h.last()).toMatchObject({ id: 2, ok: false, error: { message: 'worldHost: a design is written by its designer' } })
    await new Promise((r) => setTimeout(r, 30))
    expect(h.store.saves).toEqual([])
    expect(h.store.docs.get('design:d1')).toBe(plan)
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

  // WP5 (G14): a compile that renames a part copies its saved annotations, in this project's store only (fix I2: copied).
  it('a compile copies the annotations of a renamed part to its new id', async () => {
    const ann = memAnnotations()
    await ann.add('k1', 'b-old', person('Follows the rename'))
    await ann.add('k2', 'b-old', person('Another project'))
    const compile = vi.fn(async (input: CompileInput) => doc(input.projectKey))
    const h = harness({ compile, createAnnotations: () => ann })
    await h.init(false)
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', snap(), HEAD] })
    const deps = compile.mock.calls[0][1] as CompileDeps
    await deps.copyAnnotations?.({ 'b-old': 'b-new' })
    expect(await ann.list('k1')).toEqual({ 'b-old': [person('Follows the rename')], 'b-new': [person('Follows the rename')] })
    expect(await ann.list('k2')).toEqual({ 'b-old': [person('Another project')] })
  })
})

describe('filterWorld: where a test result came from', () => {
  it('world_read keeps where each test result came from in the claim, the evidence list and the plain-text card', () => {
    const d = doc()
    d.buildings[0].claims = [
      { text: 'Its 1 linked tests passed (CI)', state: 'verified', evidence: [{ kind: 'test', ref: 't/api.test.ts', excerpt: 'from CI (gh)' }] }
    ]
    const r = filterWorld(d, { ids: [d.buildings[0].id], cards: true })
    expect(r.evidence).toContainEqual({ kind: 'test', ref: 't/api.test.ts', excerpt: 'from CI (gh)' })
    expect((r.items[0] as WorldDoc['buildings'][number]).claims[0].text).toBe('Its 1 linked tests passed (CI)')
    expect(r.cards?.[d.buildings[0].id]).toContain('evidence: test t/api.test.ts (from CI (gh))')
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
      // An untracked file is listed too: a person sees it in the folder.
      files: ['src/a.ts', 'src/b.ts', 'src/untracked.ts'],
      symbols: [],
      callEdges: [],
      fileImports: { 'src/a.ts': ['./b'], 'src/b.ts': [], 'src/untracked.ts': [] }
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

  it('snapshotFromFiles keeps only safe, indexable, readable source files, once each (one too long to scan stays, with no imports)', async () => {
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
    // An oversized file is a part with no imports, as a file past the read cap is (fix round 1, M8).
    expect(got).toEqual({ root: '/r', files: ['src/a.ts', 'src/b.ts', 'src/big.ts'], symbols: [], callEdges: [], fileImports: { 'src/a.ts': ['./b'], 'src/b.ts': [], 'src/big.ts': [] } })
    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(['/r/src/a.ts', '/r/src/b.ts', '/r/src/big.ts', '/r/src/empty.ts', '/r/src/null.ts', '/r/src/throws.ts'])
    // A listing that fails lists nothing.
    const failing = await snapshotFromFiles('/r', {
      read,
      listFiles: async () => {
        throw new Error('no git')
      }
    })
    expect(failing.files).toEqual([])
    // Except git missing from a repository: that is said, not mapped as an empty world.
    await expect(snapshotFromFiles('/r', { read, listFiles: async () => { throw new Error(NO_GIT_MESSAGE) } })).rejects.toThrow(NO_GIT_MESSAGE)
    // A listing object: a capped one records how many files are mapped; an uncapped one adds nothing.
    const capped = await snapshotFromFiles('/r', { read, listFiles: async () => ({ files: ['src/a.ts', 'src/b.ts', 'README.md'], capped: true, unreadable: [] }) })
    expect(capped).toMatchObject({ files: ['src/a.ts', 'src/b.ts'], filesCapped: 2 })
    expect('unreadable' in capped).toBe(false)
    const whole = await snapshotFromFiles('/r', { read, listFiles: async () => ({ files: ['src/a.ts'], capped: false }) })
    expect('filesCapped' in whole).toBe(false)
    expect('nestedCapped' in whole).toBe(false)
    expect('toolingFolders' in whole).toBe(false)
    // The top-level dot-folders whose source files the world leaves out are counted, each once (review M-1): not a
    // dot-file, a dot-folder deeper down (not tooling), a folder left out anyway (node_modules) or one with no source.
    const tooling = await snapshotFromFiles('/r', {
      read,
      listFiles: async () => [
        'src/a.ts', '.github/actions/x/index.ts', '.github/actions/y/main.ts', '.storybook/preview.tsx', '.eslintrc.cjs',
        'src/.gen/b.ts', '.idea/workspace.xml', '.tools/node_modules/dep/index.js'
      ]
    })
    expect(tooling).toMatchObject({ files: ['src/a.ts'], toolingFolders: 2 })
    // Only the nested repositories were cut: the cap they shared, and no claim that the folder's own files were.
    const nestedCut = await snapshotFromFiles('/r', { read, listFiles: async () => ({ files: ['src/a.ts'], capped: false, nestedCapped: true }) })
    expect(nestedCut).toMatchObject({ files: ['src/a.ts'], nestedCapped: MAP_FILE_CAP })
    expect('filesCapped' in nestedCut).toBe(false)
    // Names the listing could not read pass through, for the world's count.
    const odd = await snapshotFromFiles('/r', { read, listFiles: async () => ({ files: ['src/a.ts'], capped: false, unreadable: ['src/q\uFFFD.ts'] }) })
    expect(odd.unreadable).toEqual(['src/q\uFFFD.ts'])
  })

  it('snapshotFromFiles never reads a file the world leaves out (a dependency, build or cache folder, a bundle)', async () => {
    const read = vi.fn(async () => 'export const x = 1\n')
    const listed = ['src/a.ts', 'vendor/lib/v.ts', 'packages/x/node_modules/dep/index.js', 'build/gen.ts', '.venv/lib/site.py', 'web/app.bundle.js', 'web/app.min.js']
    const got = await snapshotFromFiles('/r', { read, listFiles: async () => listed })
    expect(got.files).toEqual(['src/a.ts'])
    expect(read.mock.calls).toEqual([['/r/src/a.ts']])
  })

  it('listSourceFiles asks git inside a repository, and walks a plain folder or one git refuses', async () => {
    const walked = { files: ['w.ts'], capped: true, unreadable: [] }
    const walk = vi.fn(async () => walked)
    const git = vi.fn(async (): Promise<RepoListing | null> => ({ files: ['g.ts'], unreadable: ['u\uFFFD.ts'], nestedCapped: false, nested: [] }))
    expect(await listSourceFiles('/r', { inRepo: async () => true, git, walk })).toEqual({ files: ['g.ts'], capped: false, unreadable: ['u\uFFFD.ts'] })
    expect(walk).not.toHaveBeenCalled()
    expect(await listSourceFiles('/r', { inRepo: async () => false, git, walk })).toEqual(walked)
    expect(git).toHaveBeenCalledTimes(1)
    git.mockResolvedValueOnce(null)
    expect(await listSourceFiles('/r', { inRepo: async () => true, git, walk })).toEqual(walked)
    // git answered with nothing: the folder is walked, and its files are the world when it has any on disk.
    const none: RepoListing = { files: [], unreadable: [], nestedCapped: false, nested: [] }
    git.mockResolvedValueOnce(none)
    expect(await listSourceFiles('/r', { inRepo: async () => true, git, walk })).toEqual(walked)
    // ...and stays empty when it has none.
    git.mockResolvedValueOnce(none)
    walk.mockResolvedValueOnce({ files: [], capped: false, unreadable: [] })
    expect(await listSourceFiles('/r', { inRepo: async () => true, git, walk })).toEqual({ files: [], capped: false, unreadable: [] })
    // git's listing whose nested repositories were cut says so apart: the folder's own files were all listed.
    git.mockResolvedValueOnce({ files: ['g.ts'], unreadable: [], nestedCapped: true, nested: ['big'] })
    expect(await listSourceFiles('/r', { inRepo: async () => true, git, walk })).toEqual({ files: ['g.ts'], capped: false, unreadable: [], nestedCapped: true })
    // A walk that found only names it cannot read still found files on disk.
    git.mockResolvedValueOnce(none)
    const oddOnly = { files: [], capped: false, unreadable: ['q\uFFFD.ts'] }
    walk.mockResolvedValueOnce(oddOnly)
    expect(await listSourceFiles('/r', { inRepo: async () => true, git, walk })).toBe(oddOnly)
    // The defaults: a real plain folder is walked, keeping only source files the world shows, skipping dependency
    // folders and virtual environments, and leaving out what the folder's own .gitignore names.
    const plain = join(dir, 'plain-walk')
    await mkdir(join(plain, 'src'), { recursive: true })
    await mkdir(join(plain, 'node_modules', 'p'), { recursive: true })
    await mkdir(join(plain, 'env', 'lib'), { recursive: true })
    await mkdir(join(plain, 'generated'), { recursive: true })
    await writeFile(join(plain, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(plain, 'src', 'app.bundle.js'), 'x\n')
    await writeFile(join(plain, 'notes.txt'), 'notes\n')
    await writeFile(join(plain, 'node_modules', 'p', 'i.js'), 'x\n')
    await writeFile(join(plain, 'env', 'pyvenv.cfg'), 'home = /usr/bin\n')
    await writeFile(join(plain, 'env', 'lib', 'site.py'), 'x = 1\n')
    await writeFile(join(plain, 'generated', 'g.ts'), 'export const g = 1\n')
    expect(await listSourceFiles(plain)).toEqual({ files: ['generated/g.ts', 'src/a.ts'], capped: false, unreadable: [] })
    await writeFile(join(plain, '.gitignore'), 'generated/\n')
    expect(await listSourceFiles(plain)).toEqual({ files: ['src/a.ts'], capped: false, unreadable: [] })
  })

  it('insideGitRepo looks for .git in the folder and every folder above it', async () => {
    const seen: string[] = []
    const at = (hit: string | null) => async (p: string): Promise<boolean> => {
      seen.push(p.replace(/\\/g, '/'))
      return hit !== null && p.replace(/\\/g, '/').endsWith(hit)
    }
    expect(await insideGitRepo(join(dir, 'a', 'b'), at('/a/.git'))).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[0].endsWith('/a/b/.git')).toBe(true)
    expect(seen[1].endsWith('/a/.git')).toBe(true)
    seen.length = 0
    expect(await insideGitRepo(join(dir, 'a'), at(null))).toBe(false)
    expect(seen.length).toBeGreaterThan(1)
    // The default checks the disk: a .git file (a worktree or submodule) counts as well as a folder.
    const wt = join(dir, 'wt')
    await mkdir(join(wt, 'src'), { recursive: true })
    await writeFile(join(wt, '.git'), 'gitdir: elsewhere\n')
    expect(await insideGitRepo(join(wt, 'src'))).toBe(true)
  })

  it('gitListFiles runs git by its full path with the clone safety flags, through the shared listing (repoFileList listRepo)', async () => {
    const calls: { cmd: string; args: string[]; opts: { timeout: number; maxBytes: number } }[] = []
    const replies: CaptureResult[] = []
    const exec: CaptureFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return replies.shift() ?? { code: 0, stdout: 'H src/a.ts\0H src/b c.ts\0? src/café.ts\0? src/q\uFFFD.ts\0? node_modules/\0', missing: false }
    }
    const git = async (): Promise<string | null> => '/usr/bin/git'
    const has = (paths: string[]) => async (p: string): Promise<boolean> => paths.includes(p.replace(/\\/g, '/'))
    const top = has(['/r/.git'])
    expect(await gitListFiles('/r', exec, false, git, top)).toEqual({ files: ['src/a.ts', 'src/b c.ts', 'src/café.ts'], unreadable: ['src/q\uFFFD.ts'], nestedCapped: false, nested: [] })
    expect(calls.map((c) => c.cmd)).toEqual(['/usr/bin/git'])
    // The shared builder already starts with the safety flags; the host adds nothing (no doubled flags).
    expect(calls[0].args).toEqual(lsFilesArgs('/r', false))
    expect(calls[0].args.slice(0, 8)).toEqual(safetyFlags(false))
    expect(calls[0].opts).toEqual({ timeout: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES })
    // With submodules, a second listing recurses into them; the gitlink entry for the folder goes.
    calls.length = 0
    replies.push({ code: 0, stdout: 'H libs/shared\0H main.ts\0', missing: false }, { code: 0, stdout: 'libs/shared/u.ts\0main.ts\0', missing: false })
    expect(await gitListFiles('/r', exec, true, git, has(['/r/.gitmodules']))).toEqual({ files: ['libs/shared/u.ts', 'main.ts'], unreadable: [], nestedCapped: false, nested: ['libs/shared'] })
    expect(calls[1].args).toEqual(lsSubmoduleArgs('/r', true))
    expect(calls[1].args.slice(0, 8)).toEqual(safetyFlags(true))
    // A submodule listing that fails leaves the repository's own files.
    replies.push({ code: 0, stdout: 'H libs/shared\0H main.ts\0', missing: false }, { code: 1, stdout: '', missing: false })
    expect((await gitListFiles('/r', exec, true, git, has(['/r/.gitmodules'])))?.files).toEqual(['libs/shared', 'main.ts'])
    // A nested repository that is not a submodule is listed by its own git, as the shared listing does.
    calls.length = 0
    replies.push({ code: 0, stdout: 'H main.ts\0? tools/sdk/\0', missing: false }, { code: 0, stdout: 'H index.ts\0', missing: false })
    expect((await gitListFiles('/r', exec, false, git, has(['/r/.git', '/r/tools/sdk/.git'])))?.files).toEqual(['main.ts', 'tools/sdk/index.ts'])
    expect(calls[1].args).toEqual(lsFilesArgs('/r/tools/sdk', false))
    // A nested repository under a top-level tooling folder holds nothing the world shows, so its git is never run
    // (review M-2); one at the top that is itself such a folder is skipped too.
    calls.length = 0
    replies.push({ code: 0, stdout: 'H main.ts ? .superpowers/wt/ ? .config/ ', missing: false })
    expect((await gitListFiles('/r', exec, false, git, has(['/r/.git', '/r/.superpowers/wt/.git', '/r/.config/.git'])))?.files).toEqual(['main.ts'])
    expect(calls).toHaveLength(1)
    // A nested checkout of this same repository (its .git a file into our own git folder) is never listed; a nested
    // repository git refuses is walked as a plain folder, under the shared cap.
    calls.length = 0
    const byArgs = (args: string[]): CaptureResult => {
      const at = args[args.indexOf('-C') + 1]
      if (args.includes('--git-common-dir')) return { code: 0, stdout: at === '/r/wt' || at === '/r' ? '/r/.git\n' : `${at}/.git\n`, missing: false }
      if (at === '/r') return { code: 0, stdout: 'H main.ts\0? wt/\0? refused/\0', missing: false }
      return { code: 128, stdout: '', missing: false }
    }
    const walkNested = vi.fn(async () => ({ files: ['w.ts'], unreadable: [], capped: false }))
    const execBy: CaptureFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return byArgs(args)
    }
    const hasAll = has(['/r/.git', '/r/wt/.git', '/r/refused/.git'])
    expect(await gitListFiles('/r', execBy, false, git, hasAll, has(['/r/wt/.git']), walkNested)).toEqual({ files: ['main.ts', 'refused/w.ts'], unreadable: [], nestedCapped: false, nested: ['refused'] })
    expect(walkNested).toHaveBeenCalledWith('/r/refused', MAP_FILE_CAP)
    expect(calls.some((c) => c.args.includes('ls-files') && c.args.includes('/r/wt'))).toBe(false)
    expect(calls.map((c) => c.args)).toContainEqual(commonDirArgs('/r/wt', false))
    for (const c of calls) expect(c.args.slice(0, 8)).toEqual(safetyFlags(false))
    // A .git file read as text that points into our own .git/worktrees tells the worktree without starting git.
    calls.length = 0
    const gitdir = async (p: string): Promise<string | null> => (p === '/r/wt/.git' ? 'gitdir: /r/.git/worktrees/wt\n' : null)
    expect((await gitListFiles('/r', execBy, false, git, hasAll, has(['/r/wt/.git']), walkNested, gitdir))?.files).toEqual(['main.ts', 'refused/w.ts'])
    expect(calls.map((c) => c.args)).not.toContainEqual(commonDirArgs('/r/wt', false))
    // With the host's own readers (stat for the .git file, the folder walk for a refused repository), on the real disk:
    // the refused repository is walked under the shared cap, by the walk's rules (its own .gitignore, skipped folders).
    const disk = await mkdtemp(join(tmpdir(), 'git-list-refused-'))
    try {
      const at = (rel: string): string => join(disk, rel)
      await mkdir(at('refused/src'), { recursive: true })
      await mkdir(at('refused/node_modules/p'), { recursive: true })
      await mkdir(at('refused/gen'), { recursive: true })
      await writeFile(at('refused/.git'), 'gitdir: elsewhere\n')
      await writeFile(at('refused/.gitignore'), 'gen/\n')
      await writeFile(at('refused/src/r.ts'), 'x')
      await writeFile(at('refused/node_modules/p/i.js'), 'x')
      await writeFile(at('refused/gen/g.ts'), 'x')
      const real: CaptureFn = async (_cmd, args) => {
        const cwd = args[args.indexOf('-C') + 1]
        if (args.includes('--git-common-dir')) return { code: 0, stdout: `${cwd}/.git\n`, missing: false }
        if (cwd === disk) return { code: 0, stdout: 'H main.ts\0? refused/\0', missing: false }
        return { code: 128, stdout: '', missing: false }
      }
      const onDisk = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false)
      expect(await gitListFiles(disk, real, false, git, onDisk)).toEqual({ files: ['main.ts', 'refused/src/r.ts'], unreadable: [], nestedCapped: false, nested: ['refused'] })
    } finally {
      await rm(disk, { recursive: true, force: true })
    }
    // git ran and refused (not a repository after all, an owner it does not trust): null, so the caller walks.
    expect(await gitListFiles('/r', async () => ({ code: 128, stdout: 'x', missing: false }), true, git, top)).toBeNull()
    // No git: said plainly, on any of its runs.
    await expect(gitListFiles('/r', async () => ({ code: 1, stdout: '', missing: true }), true, git, top)).rejects.toThrow(NO_GIT_MESSAGE)
    replies.push({ code: 0, stdout: 'H main.ts\0', missing: false }, { code: 1, stdout: '', missing: true })
    await expect(gitListFiles('/r', exec, true, git, has(['/r/.gitmodules']))).rejects.toThrow(NO_GIT_MESSAGE)
    calls.length = 0
    await expect(gitListFiles('/r', exec, false, async () => null, top)).rejects.toThrow(NO_GIT_MESSAGE)
    expect(calls).toHaveLength(0)
    // A git inside the folder being listed: nothing starts, nothing is listed.
    for (const bin of ['/r/git', '/r/tools/git.exe']) {
      expect(await gitListFiles('/r', exec, false, async () => bin, top)).toEqual({ files: [], unreadable: [], nestedCapped: false, nested: [] })
      expect(calls).toHaveLength(0)
    }
    // The defaults look git up for this process (never the bare name) and look for .gitmodules on disk.
    const repo = join(dir, 'with-modules')
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, '.gitmodules'), '')
    calls.length = 0
    replies.push({ code: 0, stdout: 'H a.ts\0', missing: false }, { code: 0, stdout: 'a.ts\0', missing: false })
    await gitListFiles(repo, exec)
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.cmd !== 'git' && /[\\/]git(\.exe)?$/i.test(c.cmd))).toBe(true)
    calls.length = 0
    replies.push({ code: 0, stdout: 'H a.ts\0', missing: false }, { code: 1, stdout: '', missing: false })
    await gitListFiles('/nowhere-' + Date.now(), exec)
    // No .gitmodules and no .git there: it asks git for the top (which fails), and lists nothing more.
    expect(calls).toHaveLength(2)
  })

  it('captureExec collects stdout, drops the git path variables, runs with no login, and fails on a timeout, too much output or a missing program', async () => {
    const node = process.execPath
    const opts = { timeout: 20_000, maxBytes: 1024 }
    vi.stubEnv('GIT_DIR', '/somewhere')
    vi.stubEnv('GIT_CONFIG_KEY_7', 'core.askPass')
    try {
      const show = ['GIT_DIR', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_7']
      expect(await captureExec(node, ['-e', `process.stdout.write(${JSON.stringify(show)}.map((k) => String(process.env[k])).join(","))`], opts)).toEqual({
        code: 0,
        stdout: 'undefined,0,never,3,credential.helper,undefined',
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

  it('after a restart the first watcher recompile reads every file, so an edit made behind the host is found', async () => {
    const s = await fixture()
    const store = stagedStore()
    const a = harness({ glob: async () => [] }, store)
    await a.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await a.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    expect(a.last()).toMatchObject({ id: 1, ok: true })
    const before = store.stages.get('k1')?.files['src/b.ts'].hash
    // The app was closed: b.ts changed (a git pull outside Termpolis) and no watcher saw it.
    await writeFile(join(dir, 'proj', 'src', 'b.ts'), "export const b = 2\nspawn('git', ['pull'])\n")
    const readSource = vi.fn(async (q: string) => readFile(q, 'utf8').catch(() => null))
    const b = harness({ readSource, glob: async () => [], debounceMs: 1 }, store)
    await b.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await b.send({ kind: 'call', id: 1, fn: 'notifyChanged', args: ['k1', s, HEAD, ['src/a.ts']] })
    await until(() => store.saves.length === 2)
    expect(sourceReads(readSource).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(store.stages.get('k1')?.files['src/b.ts'].hash).not.toBe(before)
    expect(store.stages.get('k1')?.files['src/b.ts'].boundaries.map((x) => x.key)).toEqual(['git'])
    // Checked now: the next watcher run reads only what it was told about.
    readSource.mockClear()
    await b.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', s, HEAD, ['src/a.ts']] })
    await until(() => store.saves.length === 3)
    expect(sourceReads(readSource)).toEqual(['src/a.ts'])
  })

  it('after a failed watcher run the next one reads every file again, the failed run edits included', async () => {
    const s = await fixture()
    const store = stagedStore()
    let failNext = false
    let attempts = 0
    const save = store.save
    store.save = async (d) => {
      attempts++
      if (failNext) {
        failNext = false
        throw new Error('disk full')
      }
      return save(d)
    }
    const readSource = vi.fn(async (q: string) => readFile(q, 'utf8').catch(() => null))
    const h = harness({ readSource, glob: async () => [], debounceMs: 1 }, store)
    await h.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    const before = store.stages.get('k1')?.files['src/a.ts'].hash
    // A watcher run for an edit of a.ts fails to save: its stages are never kept.
    await writeFile(join(dir, 'proj', 'src', 'a.ts'), "import { b } from './b'\nspawn('git', [])\nexport const a = b\n")
    failNext = true
    readSource.mockClear()
    await h.send({ kind: 'call', id: 2, fn: 'notifyChanged', args: ['k1', s, HEAD, ['src/a.ts']] })
    await until(() => attempts === 2)
    expect(sourceReads(readSource)).toEqual(['src/a.ts'])
    expect(store.stages.get('k1')?.files['src/a.ts'].hash).toBe(before)
    // Meanwhile b.ts changes with no watcher event. The next run, told only about a file that is not
    // there, reads every file, so it keeps both the failed run's a.ts edit and b.ts's.
    await writeFile(join(dir, 'proj', 'src', 'b.ts'), "export const b = 2\nspawn('npm', [])\n")
    readSource.mockClear()
    await h.send({ kind: 'call', id: 3, fn: 'notifyChanged', args: ['k1', s, HEAD, ['src/gone.ts']] })
    await until(() => attempts === 3)
    await until(() => store.stages.get('k1')?.files['src/a.ts'].hash !== before)
    expect(sourceReads(readSource).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(store.stages.get('k1')?.files['src/a.ts'].boundaries.map((x) => x.key)).toEqual(['git'])
    expect(store.stages.get('k1')?.files['src/b.ts'].boundaries.map((x) => x.key)).toEqual(['npm'])
  })

  it('the labelled follow-up reads no source file again: it compiles from the first pass stage cache', async () => {
    const s = await fixture()
    const store = stagedStore()
    const h = harness({ glob: async () => [], llmTimeoutMs: 1, llmQueueTimeoutMs: 1, contextTimeoutMs: 1 }, store)
    await h.send({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: true })
    await h.send({ kind: 'call', id: 1, fn: 'compile', args: ['k1', s, HEAD] })
    await until(() => store.saves.length === 2)
    expect(store.saves).toHaveLength(2)
    // The boundary stage reports past 5% only while it reads files: the first pass did, the follow-up did not.
    const saved = h.out.findIndex((m) => m.kind === 'updated')
    const scans = h.out.map((m, i) => ({ m, i })).filter(({ m }) => m.kind === 'progress' && m.stage === 'boundaries' && m.pct > 5)
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.filter(({ i }) => i > saved)).toEqual([])
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
