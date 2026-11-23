// WP4a: the first map of a big project. The host draws a first map from the listing while the snapshot reads the
// files, the compile after it reads no file again, its progress only rises, and a first map nobody finished is dropped.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import { NO_GIT_MESSAGE } from '../../src/main/world/gitSource'
import type { StageCache } from '../../src/main/world/stageCache'
import { createWorldHost, PRESCAN_TTL_MS, type WorldHostDeps, type WorldHostRequest, type WorldHostResponse } from '../../src/main/world/worldHost'
import type { WorldDoc } from '../../src/shared/world/types'

const HEAD = { head: 'h1', dirty: false }
const TEXTS: Record<string, string> = {
  'src/app/main.ts': "import { util } from '../lib/util'\nexport const main = util\n",
  'src/app/view.ts': "import { main } from './main'\nexport const view = main\n",
  'src/lib/util.ts': 'export const util = 1\n',
  'src/lib/more.ts': "import { util } from './util'\nexport const more = util\n"
}
const FILES = Object.keys(TEXTS).sort()
const relOf = (p: string): string => p.replace(/\\/g, '/').replace(/^\/r\d*\//, '')

type Progress = Extract<WorldHostResponse, { kind: 'progress' }>

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-first-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** A deferred: a promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

function setup(over: WorldHostDeps = {}) {
  const out: WorldHostResponse[] = []
  const docs = new Map<string, WorldDoc>()
  const stages = new Map<string, StageCache>()
  const state = { clock: 1000, readGate: null as Promise<void> | null, loadHook: null as null | ((k: string) => Promise<void> | void), saveFails: false }
  const store = {
    // The world is looked up first, then the hook may hold the answer back (a store read that is slow to return).
    load: async (k: string) => {
      const found = docs.get(k) ?? null
      await state.loadHook?.(k)
      return found
    },
    save: async (d: WorldDoc) => {
      if (state.saveFails) throw new Error('disk full')
      docs.set(d.projectKey, d)
    },
    labelCache: { get: async () => null, set: async () => undefined },
    loadStages: async (k: string) => stages.get(k) ?? null,
    saveStages: async (k: string, c: StageCache) => void stages.set(k, c)
  }
  const readSource = vi.fn(async (p: string) => {
    if (state.readGate) await state.readGate
    return Object.hasOwn(TEXTS, relOf(p)) ? TEXTS[relOf(p)] : null
  })
  const host = createWorldHost((m) => out.push(m), {
    createStore: () => store,
    runsTimeoutMs: 5,
    readSource,
    glob: async () => [],
    listFiles: async () => FILES,
    provisionalMinFiles: 3,
    now: () => state.clock,
    ...over
  })
  let id = 0
  const call = async <T,>(fn: string, ...args: unknown[]): Promise<T> => {
    const me = ++id
    await host.handle({ kind: 'call', id: me, fn, args } as WorldHostRequest)
    const r = out.find((m) => m.kind === 'result' && m.id === me) as { ok: boolean; result?: T; error?: { message: string } }
    if (!r.ok) throw new Error(r.error?.message)
    return r.result as T
  }
  const progress = (key = 'k1'): Progress[] => out.filter((m): m is Progress => m.kind === 'progress' && m.projectKey === key)
  const updated = (key = 'k1'): number => out.filter((m) => m.kind === 'updated' && m.projectKey === key).length
  const init = () => host.handle({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
  return { out, docs, state, readSource, host, call, progress, updated, init }
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}

const early = (head: unknown = HEAD, projectKey: unknown = 'k1') => ({ projectKey, head })

describe('the first map of a big project (WP4a)', () => {
  it('a big listing is drawn before any file is read; the full world replaces it from the same positions, each file read once', async () => {
    const h = setup()
    await h.init()
    const reads = gate()
    h.state.readGate = reads.wait
    const snapshot = h.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => h.updated() === 1)
    // Drawn while every read still waits: a first map from the paths alone.
    expect(h.updated()).toBe(1)
    const first = await h.call<WorldDoc>('get', 'k1')
    expect(first.provisional).toBe(true)
    expect(first.sourceRevision).toEqual(HEAD)
    expect(first.buildings.flatMap((b) => b.members).sort()).toEqual(FILES)
    expect(first.edges).toEqual([])
    reads.open()
    const snap = await snapshot
    expect(snap.fileImports['src/app/view.ts']).toEqual(['./main'])
    expect(h.readSource).toHaveBeenCalledTimes(FILES.length)
    // The compile after it scans the text the snapshot read: no file is read a second time.
    const doc = await h.call<WorldDoc>('compile', 'k1', snap, HEAD)
    expect(h.readSource).toHaveBeenCalledTimes(FILES.length)
    expect(doc).not.toHaveProperty('provisional')
    expect(doc.edges.length).toBeGreaterThan(0)
    // Every district the first map drew stays where it was drawn (its buildings may regroup once imports are known),
    // and a building of the same id keeps its place too.
    expect(doc.districts.map((d) => d.id)).toEqual(first.districts.map((d) => d.id))
    for (const d of first.districts) expect(doc.layout.positions[d.id]).toEqual(first.layout.positions[d.id])
    for (const b of first.buildings) if (Object.hasOwn(doc.layout.positions, b.id)) expect(doc.layout.positions[b.id]).toEqual(first.layout.positions[b.id])
    expect(await h.call<WorldDoc>('get', 'k1')).toEqual(doc)
    // Progress across the snapshot and the compile only rises, from the listing to the end.
    const pcts = h.progress().map((p) => p.pct)
    expect(h.progress()[0]).toMatchObject({ stage: 'structure', pct: 0 })
    expect(pcts).toContain(40)
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1])
  })

  it('nothing is drawn for a small listing, a world already stored, or a snapshot made for no project (which reports nothing)', async () => {
    const small = setup({ provisionalMinFiles: undefined })
    await small.init()
    await small.call('snapshotFromFiles', '/r', early())
    expect(small.updated()).toBe(0)
    expect(small.progress().length).toBeGreaterThan(0)

    const stored = setup()
    await stored.init()
    const snap = await stored.call<GraphSnapshot>('snapshotFromFiles', '/r')
    const doc = await stored.call<WorldDoc>('compile', 'k1', snap, HEAD)
    const before = stored.updated()
    await stored.call('snapshotFromFiles', '/r', early())
    await new Promise((r) => setTimeout(r, 20))
    expect(stored.updated()).toBe(before)
    expect(await stored.call('get', 'k1')).toEqual(doc)

    const none = setup()
    await none.init()
    await none.call('snapshotFromFiles', '/r')
    await none.call('snapshotFromFiles', '/r', early(HEAD, ''))
    await none.call('snapshotFromFiles', '/r', early(HEAD, 7))
    await new Promise((r) => setTimeout(r, 20))
    expect(none.out.filter((m) => m.kind === 'progress' || m.kind === 'updated')).toEqual([])
  })

  it('a first map without a usable commit says none; one made after its run ended is never drawn; a failure only warns', async () => {
    const h = setup()
    await h.init()
    await h.call('snapshotFromFiles', '/r', early('junk'))
    await until(() => h.updated() === 1)
    expect((await h.call<WorldDoc>('get', 'k1')).sourceRevision).toEqual({ head: '', dirty: false })

    // The first map's own store read waits while the run's compile saves a world: then nothing is drawn.
    const late = setup()
    await late.init()
    const held = gate()
    let holding = true
    late.state.loadHook = () => (holding ? ((holding = false), held.wait) : undefined)
    const snap = await late.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    const doc = await late.call<WorldDoc>('compile', 'k1', snap, HEAD)
    const saved = late.updated()
    held.open()
    await new Promise((r) => setTimeout(r, 20))
    expect(late.updated()).toBe(saved)
    expect(await late.call('get', 'k1')).toEqual(doc)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = setup()
    await broken.init()
    let failing = true
    broken.state.loadHook = () => {
      if (failing) {
        failing = false
        throw new Error('store gone')
      }
    }
    await broken.call('snapshotFromFiles', '/r', early())
    await until(() => warn.mock.calls.length > 0)
    expect(warn).toHaveBeenCalledWith('[world] first map from the listing failed:', expect.any(Error))
    expect(broken.updated()).toBe(0)
  })

  it('a failed snapshot ends its run; a compile with no fresh snapshot starts its progress from 0 and reads the files itself', async () => {
    const h = setup({ listFiles: async () => Promise.reject(new Error(NO_GIT_MESSAGE)) })
    await h.init()
    await expect(h.call('snapshotFromFiles', '/r', early())).rejects.toThrow()
    await expect(h.call('snapshotFromFiles', '/r')).rejects.toThrow()
    expect(h.progress().map((p) => p.pct)).toEqual([0])

    const g = setup()
    await g.init()
    const snap = await g.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    expect(Math.max(...g.progress().map((p) => p.pct))).toBe(40)
    // The compile comes too late for the snapshot's scans: it reads every file, and its progress starts again.
    g.state.clock += PRESCAN_TTL_MS + 1
    const at = g.progress().length
    await g.call('compile', 'k1', snap, HEAD)
    expect(g.readSource).toHaveBeenCalledTimes(FILES.length * 2)
    expect(g.progress()[at].pct).toBeLessThan(40)
  })

  it('a big listing moves the bar only when a read moves the percentage', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`)
    const h = setup({ listFiles: async () => many, provisionalMinFiles: 1000 })
    await h.init()
    await h.call('snapshotFromFiles', '/r', early())
    const boundaries = h.progress().filter((p) => p.stage === 'boundaries').map((p) => p.pct)
    expect(boundaries).toEqual(Array.from({ length: 36 }, (_, i) => i + 5))
    expect(h.updated()).toBe(0)
  })

  it('a folder whose snapshot no compile took keeps its scans for a while: then they go, and only the last few folders are kept', async () => {
    const h = setup()
    await h.init()
    const snapOf = (root: string) => h.call<GraphSnapshot>('snapshotFromFiles', root)
    // Swept: /r0's scans are older than PRESCAN_TTL_MS when /r1 is snapshotted.
    const r0 = await snapOf('/r0')
    h.state.clock += PRESCAN_TTL_MS + 1
    await snapOf('/r1')
    h.readSource.mockClear()
    await h.call('compile', 'k0', r0, HEAD)
    expect(h.readSource).toHaveBeenCalledTimes(FILES.length)
    // Evicted: five folders, the first one's scans make room for the fifth.
    const r2 = await snapOf('/r2')
    for (const root of ['/r3', '/r4', '/r5', '/r6']) await snapOf(root)
    h.readSource.mockClear()
    await h.call('compile', 'k2', r2, HEAD)
    expect(h.readSource).toHaveBeenCalledTimes(FILES.length)
    // A kept one is used, whatever its root's trailing slash.
    const r6 = await snapOf('/r6/')
    h.readSource.mockClear()
    await h.call('compile', 'k6', r6, HEAD)
    expect(h.readSource).not.toHaveBeenCalled()
  })

  it('a first map is served while its compile runs, however long; one whose compile never came is dropped; a failed compile drops it', async () => {
    const globs = gate()
    let holdGlob = false
    const h = setup({ glob: async () => (holdGlob ? (await globs.wait, []) : []) })
    await h.init()
    const snap = await h.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => h.updated() === 1)
    holdGlob = true
    const compiling = h.call<WorldDoc>('compile', 'k1', snap, HEAD)
    await new Promise((r) => setTimeout(r, 20))
    h.state.clock += PRESCAN_TTL_MS * 10
    expect((await h.call<WorldDoc>('get', 'k1')).provisional).toBe(true)
    globs.open()
    expect(await compiling).not.toHaveProperty('provisional')

    const lost = setup()
    await lost.init()
    await lost.call('snapshotFromFiles', '/r', early())
    await until(() => lost.updated() === 1)
    expect((await lost.call<WorldDoc>('get', 'k1')).provisional).toBe(true)
    lost.state.clock += PRESCAN_TTL_MS + 1
    expect(await lost.call('get', 'k1')).toBeNull()
    expect(await lost.call('get', 'k1')).toBeNull()

    const failed = setup()
    await failed.init()
    const s = await failed.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => failed.updated() === 1)
    failed.state.saveFails = true
    await expect(failed.call('compile', 'k1', s, HEAD)).rejects.toThrow('disk full')
    expect(await failed.call('get', 'k1')).toBeNull()
  })

  it('integration: a 3,000-file folder on disk is drawn before its files are read, and well inside the budgets', async () => {
    const root = join(dir, 'mid')
    const FOLDERS = 30
    const PER = 100
    for (let d = 0; d < FOLDERS; d++) {
      await mkdir(join(root, 'src', `d${d}`), { recursive: true })
      await Promise.all(
        Array.from({ length: PER }, (_, i) =>
          writeFile(join(root, 'src', `d${d}`, `f${i}.ts`), `import { v } from '../d${(d + 1) % FOLDERS}/f${i}'
export const v = ${i}
`)
        )
      )
    }
    // The host's own readers and folder walk: nothing stubbed but the store and the test-report glob.
    const h = setup({ readSource: undefined, listFiles: undefined, provisionalMinFiles: undefined })
    await h.init()
    const t0 = Date.now()
    let firstAt = 0
    let snapAt = 0
    void until(() => h.updated() > 0).then(() => (firstAt = Date.now() - t0))
    const snap = await h.call<GraphSnapshot>('snapshotFromFiles', root, early())
    snapAt = Date.now() - t0
    await until(() => firstAt > 0)
    const first = await h.call<WorldDoc>('get', 'k1')
    expect(first.provisional).toBe(true)
    expect(first.buildings.flatMap((b) => b.members)).toHaveLength(FOLDERS * PER)
    const doc = await h.call<WorldDoc>('compile', 'k1', snap, HEAD)
    const doneAt = Date.now() - t0
    expect(doc).not.toHaveProperty('provisional')
    expect(doc.edges.length).toBeGreaterThan(0)
    // Generous CI budgets (the huge e2e rows hold the real targets): a first map inside 15 s, the whole world inside 60.
    expect(firstAt).toBeLessThan(15_000)
    expect(doneAt).toBeLessThan(60_000)
    expect(firstAt).toBeLessThanOrEqual(doneAt)
    console.log(`[wp4a] 3,000 files: first map ${firstAt} ms, files read ${snapAt} ms, full world ${doneAt} ms`)
  }, 120_000)
})
