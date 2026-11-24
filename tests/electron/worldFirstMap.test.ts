// WP4a: the first map of a big project. The host draws a first map from the listing while the snapshot reads the
// files, the compile after it reads no file again, its progress only rises, and a first map nobody finished is dropped.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import { firstMap } from '../../src/main/world/compile'
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
  /** The pane's get, which may be answered with a first map (fix round 1, I1: no other get is). */
  const pane = (key = 'k1'): Promise<WorldDoc> => call<WorldDoc>('get', key, { provisional: true })
  /** The errors pushed with `updated` for `key` (a run that ended with no world while its first map was up). */
  const failures = (key = 'k1'): string[] =>
    out.flatMap((m) => (m.kind === 'updated' && m.projectKey === key && typeof m.error === 'string' ? [m.error] : []))
  return { out, docs, state, readSource, host, call, progress, updated, init, pane, failures }
}

/** Waits for `ok`, and fails the test when it never comes, within the first map's own 15 s budget (fix round 1, M11). */
const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`until: still not true after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const early = (head: unknown = HEAD, projectKey: unknown = 'k1') => ({ projectKey, head })
/** What a pane on a first map is told when the run that drew it never compiled (fix round 2, m3). */
const UNFINISHED = 'The map was not finished.'

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
    const first = await h.pane()
    expect(first.provisional).toBe(true)
    expect(first.sourceRevision).toEqual(HEAD)
    // Only the pane is shown a first map: Export's and Ask's get find no world yet (fix round 1, I1).
    expect(await h.call('get', 'k1')).toBeNull()
    expect(await h.call('get', 'k1', { provisional: 'yes' })).toBeNull()
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

  it('a read that runs past PRESCAN_TTL_MS keeps its first map up, says nothing, and the world grows from it (N1)', async () => {
    const h = setup()
    await h.init()
    const reads = gate()
    h.state.readGate = reads.wait
    const snapshot = h.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => h.updated() === 1)
    const first = await h.pane()
    // The reads are still going long after the first map was drawn: every look still gets it, and no error is posted.
    h.state.clock += PRESCAN_TTL_MS * 3
    expect((await h.pane()).provisional).toBe(true)
    expect((await h.pane()).provisional).toBe(true)
    expect(h.failures()).toEqual([])
    reads.open()
    const snap = await snapshot
    // The read has just ended: the map is still up, and the compile that follows keeps its places (layoutFrom).
    expect((await h.pane()).provisional).toBe(true)
    const doc = await h.call<WorldDoc>('compile', 'k1', snap, HEAD)
    for (const d of first.districts) expect(doc.layout.positions[d.id]).toEqual(first.layout.positions[d.id])
    expect(h.failures()).toEqual([])
    // The clock of a read that ended with no compile still runs, for this key only: another key's look leaves it be.
    const other = setup()
    await other.init()
    await other.call('snapshotFromFiles', '/r', early())
    await other.call('snapshotFromFiles', '/r2', early(HEAD, 'k2'))
    await until(() => other.updated() === 1 && other.updated('k2') === 1)
    other.state.clock += PRESCAN_TTL_MS + 1
    expect(await other.pane('k2')).toBeNull()
    expect(other.failures('k2')).toEqual([UNFINISHED])
    expect(other.failures()).toEqual([])
    expect(await other.pane()).toBeNull()
    expect(other.failures()).toEqual([UNFINISHED])
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
    expect((await h.pane()).sourceRevision).toEqual({ head: '', dirty: false })

    // The first map's own store read waits while the run's compile (which stops waiting for it) saves a world: then
    // nothing is drawn.
    const late = setup({ firstMapWaitMs: 5 })
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

  it('a big listing moves the bar only when a read moves the percentage, in twentieths of a point (fix round 3)', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`)
    const h = setup({ listFiles: async () => many, provisionalMinFiles: 1000 })
    await h.init()
    await h.call('snapshotFromFiles', '/r', early())
    const boundaries = h.progress().filter((p) => p.stage === 'boundaries').map((p) => p.pct)
    // 200 reads: every read moves it (0.175 of a point, so a twentieth step or more), and it ends at 40.
    expect(boundaries).toHaveLength(200)
    expect(boundaries[0]).toBe(5.15)
    expect(boundaries[boundaries.length - 1]).toBe(40)
    for (let i = 1; i < boundaries.length; i++) expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1])
    expect(h.updated()).toBe(0)
    // 20,000 reads post 5 at the first read, then 700 times: one every 28 or 29 reads, not one a whole point (571 reads).
    const huge = Array.from({ length: 20_000 }, (_, i) => `src/d${i % 50}/f${i}.ts`)
    const big = setup({ listFiles: async () => huge, provisionalMinFiles: 100_000 })
    await big.init()
    await big.call('snapshotFromFiles', '/big', early())
    const steps = big.progress().filter((p) => p.stage === 'boundaries').map((p) => p.pct)
    expect(steps).toHaveLength(701)
    expect(steps.slice(0, 3)).toEqual([5, 5.05, 5.1])
    expect(steps[steps.length - 1]).toBe(40)
  }, 60_000)

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
    expect((await h.pane()).provisional).toBe(true)
    globs.open()
    expect(await compiling).not.toHaveProperty('provisional')

    const lost = setup()
    await lost.init()
    await lost.call('snapshotFromFiles', '/r', early())
    await until(() => lost.updated() === 1)
    expect((await lost.pane()).provisional).toBe(true)
    lost.state.clock += PRESCAN_TTL_MS + 1
    expect(await lost.pane()).toBeNull()
    expect(await lost.pane()).toBeNull()
    // Every pane still on that map is told it is gone, once (fix round 2, m3).
    expect(lost.failures()).toEqual([UNFINISHED])

    const failed = setup()
    await failed.init()
    const s = await failed.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => failed.updated() === 1)
    failed.state.saveFails = true
    await expect(failed.call('compile', 'k1', s, HEAD)).rejects.toThrow('disk full')
    expect(await failed.pane()).toBeNull()
    // The pane is told the run ended with no world, and why, so it shows the error and Try again (fix round 1, I2).
    expect(failed.failures()).toEqual(['disk full'])
    // A run that fails with no first map up says nothing more than its own rejection.
    const again = await failed.call<GraphSnapshot>('snapshotFromFiles', '/r')
    await expect(failed.call('compile', 'k1', again, HEAD)).rejects.toThrow('disk full')
    expect(failed.failures()).toEqual(['disk full'])
    // A thrown value that is not an Error is said as text.
    const odd = setup()
    await odd.init()
    const o = await odd.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => odd.updated() === 1)
    odd.state.loadHook = () => {
      throw 'store said no'
    }
    await expect(odd.call('compile', 'k1', o, HEAD)).rejects.toThrow()
    expect(odd.failures()).toEqual(['store said no'])
  })

  it('a snapshot that fails after its first map is drawn drops that map and tells the pane why (fix round 1, M2)', async () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`)
    const reads = gate()
    let throwNow = false
    // The first reads wait; once the first map is up the next read throws outright (a read that rejects only reads
    // as absent), which ends the snapshot. Only that one throws: every read after it would succeed, so a pass that
    // did not stop would read the whole listing.
    const order: Array<'read' | 'threw'> = []
    const readSource = vi.fn((p: string): Promise<string | null> => {
      if (throwNow) {
        throwNow = false
        order.push('threw')
        throw new Error('disk gone')
      }
      order.push('read')
      return reads.wait.then(() => (p.endsWith('.ts') ? 'export const x = 1\n' : null))
    })
    const h = setup({ listFiles: async () => many, readSource })
    await h.init()
    const snapshot = h.call('snapshotFromFiles', '/r', early())
    const failed = expect(snapshot).rejects.toThrow('disk gone')
    await until(() => h.updated() === 1)
    expect((await h.pane()).provisional).toBe(true)
    throwNow = true
    reads.open()
    await failed
    expect(await h.pane()).toBeNull()
    expect(h.failures()).toEqual(['disk gone'])
    // No read starts after the first that threw (eachLimit stops, fix round 1 M9; fix round 2, m7): the 32 that waited,
    // the one that threw, and only the other workers' reads already started in the same turn (one each, at most 31).
    // Nothing starts once the pass has stopped, however long it is given.
    const threw = order.indexOf('threw')
    expect(threw).toBeGreaterThanOrEqual(32)
    expect(order.filter((o) => o === 'threw')).toHaveLength(1)
    expect(order.length - threw - 1).toBeLessThanOrEqual(31)
    const stoppedAt = order.length
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toHaveLength(stoppedAt)
    expect(readSource.mock.calls.length).toBeLessThan(many.length)
  })

  it('a second snapshot for a run already going neither lowers its progress nor draws a second first map (fix round 1, M1)', async () => {
    const globs = gate()
    let holdGlob = false
    const h = setup({ glob: async () => (holdGlob ? (await globs.wait, []) : []) })
    await h.init()
    const snap = await h.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    await until(() => h.updated() === 1)
    // Shown and not yet compiled: another snapshot draws nothing new.
    await h.call('snapshotFromFiles', '/r', early())
    await new Promise((r) => setTimeout(r, 20))
    expect(h.updated()).toBe(1)
    holdGlob = true
    const compiling = h.call<WorldDoc>('compile', 'k1', snap, HEAD)
    await new Promise((r) => setTimeout(r, 20))
    const before = Math.max(...h.progress().map((p) => p.pct))
    const at = h.progress().length
    // While the compile runs: the snapshot's own percentages never go below where the run got to.
    await h.call('snapshotFromFiles', '/r', early())
    expect(h.progress().length).toBeGreaterThan(at)
    for (const p of h.progress().slice(at)) expect(p.pct).toBeGreaterThanOrEqual(before)
    globs.open()
    await compiling
    expect(h.updated()).toBe(2)
  })

  it('a compile waits for the first map still being drawn and starts from its positions; one that waits too long starts without it (fix round 1, M4)', async () => {
    const h = setup()
    await h.init()
    // The first map's store read is held, so the snapshot (and the compile's call) finish before the map is drawn.
    const held = gate()
    let holding = true
    h.state.loadHook = () => (holding ? ((holding = false), held.wait) : undefined)
    const snap = await h.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    const compiling = h.call<WorldDoc>('compile', 'k1', snap, HEAD)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.updated()).toBe(0)
    held.open()
    const doc = await compiling
    // The first map was drawn while the compile waited, then replaced.
    expect(h.updated()).toBe(2)
    expect(h.out.find((m) => m.kind === 'updated')).toEqual({ kind: 'updated', projectKey: 'k1' })
    expect(doc).not.toHaveProperty('provisional')

    const slow = setup({ firstMapWaitMs: 5 })
    await slow.init()
    const stuck = gate()
    let hold = true
    slow.state.loadHook = () => (hold ? ((hold = false), stuck.wait) : undefined)
    const s = await slow.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    // The compile gives up waiting and makes the world; the first map, drawn after the run ended, is never shown.
    const got = await slow.call<WorldDoc>('compile', 'k1', s, HEAD)
    expect(got).not.toHaveProperty('provisional')
    stuck.open()
    await new Promise((r) => setTimeout(r, 20))
    expect(slow.updated()).toBe(1)
    expect(await slow.pane()).toEqual(got)
  })

  it('a run whose compile never came stops counting: its progress and first map go once its scans would (fix round 1, M5)', async () => {
    const h = setup()
    await h.init()
    await h.call('snapshotFromFiles', '/r', early())
    await until(() => h.updated() === 1)
    // Inside the time a compile has to come, a later snapshot keeps it.
    await h.call('snapshotFromFiles', '/other')
    expect((await h.pane()).provisional).toBe(true)
    h.state.clock += PRESCAN_TTL_MS + 1
    // Past it, any later snapshot sweeps it: the first map is gone, and a new run starts its progress from 0.
    expect(h.failures()).toEqual([])
    await h.call('snapshotFromFiles', '/other')
    // A pane still on that map is told, so it shows Try again rather than "Still reading" for good (fix round 2, m3).
    expect(h.failures()).toEqual([UNFINISHED])
    expect(h.updated()).toBe(2)
    expect(await h.pane()).toBeNull()
    const at = h.progress().length
    await h.call('snapshotFromFiles', '/r', early())
    expect(h.progress()[at]).toMatchObject({ stage: 'structure', pct: 0 })
    // A fresh first map is drawn for the new run.
    await until(() => h.updated() === 3)
    expect((await h.pane()).provisional).toBe(true)
    // A swept run that drew no first map (its listing too small for one) says nothing.
    const quiet = setup({ provisionalMinFiles: 1000 })
    await quiet.init()
    await quiet.call('snapshotFromFiles', '/r', early())
    quiet.state.clock += PRESCAN_TTL_MS + 1
    await quiet.call('snapshotFromFiles', '/other')
    expect(quiet.updated()).toBe(0)
  })

  it("a watcher's compile never takes the scans a snapshot made for a person's run (fix round 1, M6)", async () => {
    const h = setup({ debounceMs: 1 })
    await h.init()
    const snap0 = await h.call<GraphSnapshot>('snapshotFromFiles', '/r')
    await h.call('compile', 'k1', snap0, HEAD)
    // A person's run snapshots the folder; before its compile, a watched change recompiles.
    const snap = await h.call<GraphSnapshot>('snapshotFromFiles', '/r', early())
    h.readSource.mockClear()
    const saved = h.updated()
    await h.call('notifyChanged', 'k1', snap, HEAD, ['src/lib/util.ts'])
    await until(() => h.updated() > saved)
    // The watcher read for itself...
    expect(h.readSource).toHaveBeenCalled()
    h.readSource.mockClear()
    // ...and the person's compile still finds its own scans: no file read again.
    await h.call('compile', 'k1', snap, HEAD)
    expect(h.readSource).not.toHaveBeenCalled()
    // Scans a snapshot made for no run are a watcher's to take: the compile after it finds none and reads for itself.
    const plain = await h.call<GraphSnapshot>('snapshotFromFiles', '/r')
    const n = h.updated()
    await h.call('notifyChanged', 'k1', plain, HEAD, ['src/lib/util.ts'])
    await until(() => h.updated() > n)
    h.readSource.mockClear()
    await h.call('compile', 'k1', plain, HEAD)
    expect(h.readSource).toHaveBeenCalled()
  })

  it('firstMap: the listing grouped and laid out, named by the code, with the processes its folders run in and nothing read', () => {
    const files = ['src/main/index.ts', 'src/main/ipc.ts', 'src/renderer/app.tsx', 'src/renderer/view.tsx', 'docs/notes.ts']
    const doc = firstMap({ root: '/r', files, fileImports: {}, symbols: [], callEdges: [] } as unknown as GraphSnapshot, 'k1', { head: 'h', dirty: true }, 7)
    expect(doc).toMatchObject({ projectKey: 'k1', generatedAt: 7, sourceRevision: { head: 'h', dirty: true }, provisional: true, edges: [], tours: [] })
    expect(doc.buildings.flatMap((b) => b.members).sort()).toEqual([...files].sort())
    expect(Object.keys(doc.processes).sort()).toEqual(['main', 'renderer'])
    expect(doc.buildings.every((b) => b.status === 'gap' && b.nameState === 'observed')).toBe(true)
    for (const b of doc.buildings) expect(doc.layout.positions[b.id]).toHaveLength(3)
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
    const first = await h.pane()
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
