// A rebuild of a project's code graph fills a new graph aside and swaps it in once it is whole (codeGraph.ts,
// buildCodeGraphImpl). A sweep is held by sweepPause while someone types, so it can take minutes; meanwhile the MCP
// code tools read the graph, and a rebuild that cleared it first would answer them from a part of the project.
//
// Counted here, on a sweep held at its first pause: what a reader sees while it is held (the last whole graph on a
// rebuild, the files read so far on a first build), and that an edit indexed meanwhile (indexFileContent, and the
// watcher's reindexPaths) is still in the graph after the swap. And that one project's full builds run one after
// another, and a watcher batch never runs over a build's read (codeGraph.ts, buildQueue and graphLock): it goes
// through while the build lists or at one of the build's yield boundaries.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  activeProjectKey, buildCodeGraph, codeCallers, graphKeyForRoot, reindexRepoGraph, codeGraphStats, codeGraphSweepCounters, codeSymbols, fileSymbols,
  graphSweeping, indexFileContent, initCodeGraph, persistCodeGraph, reindexPaths, _codeGraphBuildsForTests,
  _codeGraphImportsForTests, _resetCodeGraphForTests, _setCodeGraphTimeoutsForTests,
} from '../../src/main/codeGraph'

const KEY = 'aside'
const files = (n: number, tag = 'f'): string[] => Array.from({ length: n }, (_, i) => `/repo/src/${tag}${i}.ts`)
const src = (file: string, version: string): string => {
  const base = file.slice(file.lastIndexOf('/') + 1, -3)
  return `export function ${base}_${version}() { return 1 }\n`
}

/** A pause that holds the sweep at its first boundary until released; later boundaries pass. */
function heldPause(): { pause: () => Promise<void>; reached: Promise<void>; release: () => void } {
  let release!: () => void
  let reachedResolve!: () => void
  const reached = new Promise<void>((r) => { reachedResolve = r })
  const gate = new Promise<void>((r) => { release = r })
  let first = true
  return {
    pause: async () => {
      if (!first) return
      first = false
      reachedResolve()
      await gate
    },
    reached,
    release,
  }
}

const build = (list: string[], version: string, pause?: () => Promise<void>) =>
  buildCodeGraph({ listFiles: async () => list, readFile: async (f) => src(f, version), ...(pause ? { pause } : {}) }, KEY)

/** A promise held until opened, and one that resolves once something has started waiting on it. */
interface Gate<T> { wait: () => Promise<T>; started: Promise<void>; open: (v: T) => void }
function gate<T>(): Gate<T> {
  let open!: (v: T) => void
  let startedResolve!: () => void
  const started = new Promise<void>((r) => { startedResolve = r })
  const p = new Promise<T>((res) => { open = res })
  return { wait: () => { startedResolve(); return p }, started, open }
}

/** What a read of a deleted file rejects with (fs sets the code; the batch tells a gone file by it). */
const enoent = (): Error => Object.assign(new Error('gone'), { code: 'ENOENT' })

const settle = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

beforeEach(() => { _resetCodeGraphForTests() })
afterEach(() => { vi.restoreAllMocks() })

describe('a code-graph rebuild is filled aside and swapped in whole', () => {
  it('while a rebuild is held, a reader sees the last whole graph; after it, the new one', async () => {
    const list = files(40)
    await build(list, 'v1')
    expect(codeGraphStats(KEY).files).toBe(40)
    const held = heldPause()
    const running = build(list, 'v2', held.pause)
    await held.reached
    expect(graphSweeping(KEY)).toBe(true)
    // The old graph, whole: not the 15 files the held sweep has read.
    expect(codeGraphStats(KEY).files).toBe(40)
    expect(codeSymbols('_v1', 100, KEY)).toHaveLength(40)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(0)
    held.release()
    const stats = await running
    expect(stats.files).toBe(40)
    expect(codeSymbols('_v1', 100, KEY)).toHaveLength(0)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(40)
    expect(graphSweeping(KEY)).toBe(false)
  })

  it('a first build (no graph yet) fills the live graph: a reader sees the files read so far', async () => {
    const held = heldPause()
    const running = build(files(40), 'v1', held.pause)
    await held.reached
    expect(codeGraphStats(KEY).files).toBe(15)
    held.release()
    expect((await running).files).toBe(40)
  })

  it('an edit indexed while a rebuild is held (indexFileContent) is still in the graph after the swap', async () => {
    const list = files(40)
    await build(list, 'v1')
    const held = heldPause()
    const running = build(list, 'v2', held.pause)
    await held.reached
    indexFileContent('/repo/src/new.ts', 'export function gamma() { return 2 }\n', KEY)
    expect(codeSymbols('gamma', 10, KEY)).toHaveLength(1) // live at once
    held.release()
    await running
    expect(codeSymbols('gamma', 10, KEY)).toHaveLength(1) // and kept by the swap
    expect(codeGraphStats(KEY).files).toBe(41)
  })

  it("a change the watcher re-indexes while a rebuild is held (reindexPaths) is kept, a deleted file stays gone", async () => {
    const list = files(40)
    await build(list, 'v1')
    const held = heldPause()
    // The rebuild's reader still returns the file it listed: the swap must keep what the watcher saw instead.
    const running = build(list, 'v2', held.pause)
    await held.reached
    const edited = '/repo/src/extra.ts'
    expect(await reindexPaths([edited], async () => 'export function delta() { return 3 }\n', KEY)).toBeGreaterThan(0)
    // f3 was read by the held sweep already; the watcher sees it deleted.
    await reindexPaths([list[3]], async () => { throw enoent() }, KEY)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
    held.release()
    await running
    expect(codeSymbols('delta', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
  })

  it('a file the watcher finds emptied while a rebuild is held leaves both graphs, and stays out after the swap', async () => {
    const list = files(40)
    await build(list, 'v1')
    const held = heldPause()
    const running = build(list, 'v2', held.pause)
    await held.reached
    expect(await reindexPaths([list[2]], async () => '', KEY)).toBe(0)
    expect(codeSymbols('f2_', 10, KEY)).toHaveLength(0)
    held.release()
    await running
    expect(codeSymbols('f2_', 10, KEY)).toHaveLength(0)
  })

  it('a second rebuild asked for while one is held waits its turn, and the graph ends whole with every edit made meanwhile', async () => {
    const list = files(40)
    await build(list, 'v1')
    const a = heldPause()
    const b = heldPause()
    const ra = build(list, 'v2', a.pause)
    let bListed = false
    // b lists when its turn comes, after the edit: the file the edit made is in its listing.
    const both = '/repo/src/both.ts'
    const bothSrc = 'export function epsilon() { return 4 }\n'
    const rb = buildCodeGraph({
      listFiles: async () => { bListed = true; return [...list, both] },
      readFile: async (f) => (f === both ? bothSrc : src(f, 'v3')),
      pause: b.pause,
    }, KEY)
    await a.reached
    await settle(20)
    expect(bListed).toBe(false) // it has not started
    indexFileContent(both, bothSrc, KEY)
    a.release()
    await ra
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(40)
    expect(codeSymbols('epsilon', 10, KEY)).toHaveLength(1)
    await b.reached
    expect(graphSweeping(KEY)).toBe(true) // b runs now
    b.release()
    await rb
    expect(codeSymbols('_v3', 100, KEY)).toHaveLength(40)
    expect(codeSymbols('epsilon', 10, KEY)).toHaveLength(1)
    // Nothing is left building aside: a later edit is written once, to the live graph.
    indexFileContent('/repo/src/after.ts', 'export function zeta() { return 5 }\n', KEY)
    expect(codeSymbols('zeta', 10, KEY)).toHaveLength(1)
  })

  it('nothing is left building once the rebuilds are done: a later edit is written once, to the live graph', async () => {
    const list = files(20)
    await build(list, 'v1')
    await build(list, 'v2')
    expect(_codeGraphBuildsForTests(KEY)).toBe(0)
    indexFileContent('/repo/src/after.ts', 'export function theta() { return 7 }\n', KEY)
    expect(fileSymbols('/repo/src/after.ts')).toHaveLength(1)
  })

  it('a rebuild whose listing fails or comes back empty keeps the graph as it was (nothing is set aside)', async () => {
    const list = files(20)
    await build(list, 'v1')
    await buildCodeGraph({ listFiles: async () => { throw new Error('git gone') }, readFile: async () => '' }, KEY)
    await buildCodeGraph({ listFiles: async () => [], readFile: async () => '' }, KEY)
    expect(codeSymbols('_v1', 100, KEY)).toHaveLength(20)
    indexFileContent('/repo/src/later.ts', 'export function eta() { return 6 }\n', KEY)
    expect(codeGraphStats(KEY).files).toBe(21)
  })
})


describe('a build waiting on a read of a file an edit changes meanwhile leaves the edit as it is', () => {
  // The build's read of f30 is held. The watcher re-indexes f30 (or finds it deleted) meanwhile, and then the read
  // comes back with what the file held before the edit.
  const F = '/repo/src/f30.ts'
  const heldRead = (version: string, f30: Gate<string>) =>
    (f: string): Promise<string> => (f === F ? f30.wait() : Promise.resolve(src(f, version)))

  it("a rebuild: the watcher's newer edit of the file waits for the read, and survives it and the swap", async () => {
    const list = files(40)
    await build(list, 'v1')
    const f30 = gate<string>()
    const running = buildCodeGraph({ listFiles: async () => list, readFile: heldRead('v2', f30) }, KEY)
    await f30.started
    const pass = reindexPaths([F], async () => src(F, 'v9'), KEY)
    await settle(20)
    expect(codeSymbols('f30_v9', 10, KEY)).toHaveLength(0) // held behind the build's read
    f30.open(src(F, 'v2'))
    await pass
    expect(codeSymbols('f30_v9', 10, KEY)).toHaveLength(1) // live once the build reached its next boundary
    await running
    expect(codeSymbols('f30_v9', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f30_v2', 10, KEY)).toHaveLength(0)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(39)
  })

  it('a rebuild: a file the watcher found deleted is not brought back by the stale read', async () => {
    const list = files(40)
    await build(list, 'v1')
    const f30 = gate<string>()
    const running = buildCodeGraph({ listFiles: async () => list, readFile: heldRead('v2', f30) }, KEY)
    await f30.started
    const pass = reindexPaths([F], async () => { throw enoent() }, KEY)
    f30.open(src(F, 'v2'))
    await Promise.all([pass, running])
    expect(codeSymbols('f30_', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(39)
  })

  it('a rebuild: the same before its first yield boundary, where the build has held the project since its listing', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F5 = list[5]
    const f5 = gate<string>()
    const running = buildCodeGraph({ listFiles: async () => list, readFile: (f) => (f === F5 ? f5.wait() : Promise.resolve(src(f, 'v2'))) }, KEY)
    await f5.started
    const pass = reindexPaths([F5], async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }, KEY)
    await settle(20)
    f5.open(src(F5, 'v2')) // read before the delete
    await Promise.all([pass, running])
    expect(codeSymbols('f5_', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(39)
  })

  it('a file edited before the build reaches it is not read by the build at all', async () => {
    const list = files(40)
    await build(list, 'v1')
    const held = heldPause()
    const reads: string[] = []
    const running = buildCodeGraph({
      listFiles: async () => list,
      readFile: async (f) => { reads.push(f); return src(f, 'v2') },
      pause: held.pause,
    }, KEY)
    await held.reached // 15 files read; f30 is still ahead
    await reindexPaths([F], async () => src(F, 'v9'), KEY)
    held.release()
    await running
    expect(reads).toHaveLength(39)
    expect(reads).not.toContain(F)
    expect(codeSymbols('f30_v9', 10, KEY)).toHaveLength(1)
  })

  it("a first build: an edit made while it waits on that file's read is kept", async () => {
    const f30 = gate<string>()
    const running = buildCodeGraph({ listFiles: async () => files(40), readFile: heldRead('v1', f30) }, KEY)
    await f30.started
    indexFileContent(F, src(F, 'v9'), KEY)
    f30.open(src(F, 'v1'))
    await running
    expect(codeSymbols('f30_v9', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f30_v1', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(40)
  })
})

describe("one project's full builds run one after another, in the order asked for", () => {
  it('a rebuild asked for later, whose listing comes back first, still ends live: an older listing never lands over it', async () => {
    const list = files(40)
    await build(list, 'v1')
    const listing = gate<string[]>()
    const ra = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => src(f, 'v2') }, KEY)
    await listing.started
    const rb = build(list, 'v3')
    await Promise.race([rb, settle(200)])
    listing.open(list)
    await Promise.all([ra, rb])
    expect(codeSymbols('_v3', 100, KEY)).toHaveLength(40)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(0)
  })

  it('of three first builds asked for together, the first starts; the two after it are one build, which lists once the first has finished, with the last one asked for', async () => {
    const listed: string[] = []
    const finished: string[] = []
    const one = (tag: string) =>
      buildCodeGraph({ listFiles: async () => { listed.push(`${tag}:${finished.join('')}`); return files(40, tag) }, readFile: async (f) => src(f, 'v1') }, KEY)
    const [a, b, c] = [one('a'), one('b'), one('c')]
    void a.then(() => { finished.push('a') })
    expect(b).toBe(c) // one build: both callers await the same result
    await Promise.all([a, b, c])
    expect(listed).toEqual(['a:', 'c:a'])
    expect(codeGraphStats(KEY).files).toBe(40)
    expect(codeSymbols('', 100, KEY).every((s) => s.name.startsWith('c'))).toBe(true)
    expect(_codeGraphBuildsForTests(KEY)).toBe(0)
  })

  it('an empty listing asked for while a first build (no symbol read yet) is held does not wipe what that build reads', async () => {
    const list = [...Array.from({ length: 20 }, (_, i) => `/repo/doc${i}.md`), ...files(40)]
    const held = heldPause()
    const ra = build(list, 'v1', held.pause)
    await held.reached
    expect(codeGraphStats(KEY).files).toBe(0) // nothing indexed yet: twenty docs, no code
    const rb = buildCodeGraph({ listFiles: async () => [], readFile: async () => '' }, KEY)
    held.release()
    await Promise.all([ra, rb])
    expect(codeGraphStats(KEY).files).toBe(40)
  })

  it('an empty listing keeps a graph that holds only an import entry (no symbol): the same test a rebuild goes aside on', async () => {
    const only = '/repo/src/only.ts'
    await reindexPaths([only], async () => "import { x } from './x'\n", KEY)
    expect(codeGraphStats(KEY).files).toBe(0)
    expect(_codeGraphImportsForTests(KEY, only)).toBeDefined()
    await buildCodeGraph({ listFiles: async () => [], readFile: async () => '' }, KEY)
    expect(_codeGraphImportsForTests(KEY, only)).toBeDefined()
  })
})

describe('a watcher batch and a full build of a project never run over each other', () => {
  it('a file the watcher indexes while a rebuild is still listing survives the swap', async () => {
    const list = files(40)
    await build(list, 'v1')
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => src(f, 'v2') }, KEY)
    await listing.started
    // The batch goes through at once: the build lets the project go while it lists.
    await reindexPaths(['/repo/src/created.ts'], async () => 'export function createdFn() { return 1 }\n', KEY)
    expect(codeSymbols('createdFn', 10, KEY)).toHaveLength(1)
    listing.open(list) // listed before the file was made
    await rb
    expect(codeSymbols('createdFn', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(40)
  })

  it('a file the watcher indexes while a first build is still listing is kept, and not read again', async () => {
    const listing = gate<string[]>()
    const reads: string[] = []
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => { reads.push(f); return src(f, 'v1') } }, KEY)
    await listing.started
    await reindexPaths(['/repo/src/f3.ts'], async (f) => src(f, 'v9'), KEY)
    listing.open(files(20))
    await rb
    expect(codeSymbols('f3_v9', 10, KEY)).toHaveLength(1)
    expect(reads).toHaveLength(19)
    expect(codeGraphStats(KEY).files).toBe(20)
  })

  it('a full build that publishes while a batch waits on a read cannot have a deleted file brought back by that batch', async () => {
    const list = files(40)
    await build(list, 'v1')
    const A = list[0]
    const B = list[1]
    const b = gate<string>()
    // The batch has read A (it still exists) and waits on B. A is deleted; a full build lists the project without it.
    const pass = reindexPaths([A, B], (f) => (f === B ? b.wait() : Promise.resolve(src(f, 'v2'))), KEY)
    await b.started
    const rb = build(list.slice(1), 'v3')
    await Promise.race([rb, settle(200)])
    b.open(src(B, 'v2'))
    await Promise.all([pass, rb])
    expect(codeSymbols('f0_', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(39)
  })

  it('a rebuild asked for while a batch waits on its read starts after the batch, and keeps what the batch made', async () => {
    const list = files(40)
    await build(list, 'v1')
    const created = '/repo/src/created.ts'
    const body = 'export function createdFn() { return 1 }\n'
    const g = gate<string>()
    const pass = reindexPaths([created], () => g.wait(), KEY)
    await g.started
    let listedAfterBatch: boolean | null = null
    const held = heldPause()
    const rb = buildCodeGraph({
      listFiles: async () => { listedAfterBatch = codeSymbols('createdFn', 10, KEY).length === 1; return [...list, created] },
      readFile: async (f) => (f === created ? body : src(f, 'v2')),
      pause: held.pause,
    }, KEY)
    await settle(20)
    expect(listedAfterBatch).toBe(null) // not started
    g.open(body)
    await pass
    await held.reached
    expect(listedAfterBatch).toBe(true)
    held.release()
    await rb
    expect(codeSymbols('createdFn', 10, KEY)).toHaveLength(1)
  })

  it('a read that fails in a batch while a rebuild is held removes the file, and the rebuild reads it again itself', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[30] // ahead of the held build
    const held = heldPause()
    const rb = build(list, 'v2', held.pause)
    await held.reached
    await reindexPaths([F], async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }, KEY)
    expect(codeSymbols('f30_', 10, KEY)).toHaveLength(0)
    held.release()
    await rb
    expect(codeSymbols('f30_v2', 10, KEY)).toHaveLength(1)
    expect(codeGraphStats(KEY).files).toBe(40)
  })
})

describe("the watcher's re-index of a batch is applied in one step", () => {
  it('while it waits on a read, the files of the batch still hold what they held before it', async () => {
    const list = files(20)
    await build(list, 'v1')
    const g = gate<string>()
    const running = reindexPaths([list[1], list[2]], (f) => (f === list[2] ? g.wait() : Promise.resolve(src(f, 'v2'))), KEY)
    await g.started
    expect(codeSymbols('f1_v1', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f2_v1', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f1_v2', 10, KEY)).toHaveLength(0)
    g.open(src(list[2], 'v2'))
    expect(await running).toBe(2)
    expect(codeSymbols('_v2', 10, KEY)).toHaveLength(2)
    expect(codeSymbols('f1_v1', 10, KEY)).toHaveLength(0)
  })
})

describe("the watcher's batch through the text extractor (a language with no grammar)", () => {
  it("a Kotlin file's calls are kept for the edges, and an empty one leaves nothing", async () => {
    const kt = '/repo/src/a.kt'
    const empty = '/repo/src/b.kt'
    const body = 'fun ktAlpha() { ktBeta() }\nfun ktBeta() { }\n'
    const n = await reindexPaths([kt, empty], async (f) => (f === kt ? body : ''), KEY)
    expect(n).toBe(2)
    expect(codeCallers('ktBeta', KEY).map((s) => s.name)).toEqual(['ktAlpha'])
    expect(fileSymbols(empty)).toEqual([])
  })
})

describe('persisting a graph: calls for one project run one after another', () => {
  let d = ''
  const names = (): string[] => (existsSync(d) ? readdirSync(d) : [])
  beforeEach(() => { d = mkdtempSync(join(tmpdir(), 'cg-persist-')); initCodeGraph(d) })
  afterEach(() => { _resetCodeGraphForTests(); rmSync(d, { recursive: true, force: true }) })

  it('a first build whose listing fails writes nothing: a graph file the load skipped (unreadable) is left as it was', async () => {
    const key = '0123456789abcdef'
    const kept = join(d, `code-graph-${key}.json`)
    writeFileSync(kept, '{ not json')
    initCodeGraph(d) // skips it: the project's live graph is empty, so the next build of it is a first build
    await buildCodeGraph({ listFiles: async () => { throw new Error('git is not on PATH') }, readFile: async () => '' }, key)
    expect(names()).toEqual([`code-graph-${key}.json`])
    expect(readFileSync(kept, 'utf8')).toBe('{ not json')
  })

  it('an older write that is slow does not land over a newer one', async () => {
    indexFileContent('/repo/src/one.ts', 'export function one() { return 1 }\n', KEY)
    const real = fs.promises.writeFile.bind(fs.promises)
    const slow = gate<void>()
    let calls = 0
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
      if (++calls === 1) await slow.wait()
      return real(...args)
    })
    const p1 = persistCodeGraph(KEY)
    await settle()
    indexFileContent('/repo/src/two.ts', 'export function two() { return 2 }\n', KEY)
    const p2 = persistCodeGraph(KEY)
    await settle()
    // The newer write waits for the older one: it has not started. (Without the wait it writes the same temp file at
    // once, and which rename lands last is down to the disk, so the check after it alone can pass by luck.)
    expect(calls).toBe(1)
    slow.open()
    await Promise.all([p1, p2])
    expect(calls).toBe(2)
    const saved = names().filter((f) => f.startsWith('code-graph'))
    expect(saved).toHaveLength(1)
    const graph = JSON.parse(readFileSync(join(d, saved[0]), 'utf8')) as { symbols: { name: string }[] }
    expect(graph.symbols.map((s) => s.name).sort()).toEqual(['one', 'two'])
  })

  it('a rename that fails leaves no temp file behind', async () => {
    indexFileContent('/repo/src/one.ts', 'export function one() { return 1 }\n', KEY)
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('EPERM'))
    await persistCodeGraph(KEY)
    expect(names()).toEqual([])
  })

  it('a write that rejects does not hold the later persists of the project', async () => {
    initCodeGraph(42 as unknown as string) // path.join throws on it, outside writeGraphFile's own try
    indexFileContent('/repo/src/one.ts', 'export function one() { return 1 }\n', KEY)
    await expect(persistCodeGraph(KEY)).rejects.toThrow()
    initCodeGraph(d)
    indexFileContent('/repo/src/two.ts', 'export function two() { return 2 }\n', KEY)
    await persistCodeGraph(KEY)
    expect(names().filter((f) => f.startsWith('code-graph'))).toHaveLength(1)
  })

  it('a temp file that cannot be removed either is left, and the call still resolves', async () => {
    indexFileContent('/repo/src/one.ts', 'export function one() { return 1 }\n', KEY)
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('EPERM'))
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('EBUSY'))
    await expect(persistCodeGraph(KEY)).resolves.toBeUndefined()
    expect(names().some((f) => f.endsWith('.tmp'))).toBe(true)
  })
})

// The Codex re-review of b8ecec16 (sweepfollow-codex-r3.md) and the Opus round 2 (sweepfollow-review.md, R2-M1,
// R2-m2, R2-m3; probes P5, P8 to P10). Most of these fail on b8ecec16; the rest guard the code that fixed them (the
// commit message says which).
const busy = (): Error => Object.assign(new Error('busy'), { code: 'EBUSY' })

describe('the project asked for last is the one the queries that name none answer from', () => {
  it("an older project's build waiting its turn, which finishes after a newer project's, does not take it back", async () => {
    const listing = gate<string[]>()
    const ra = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => src(f, 'a1') }, 'pa')
    await listing.started
    const ra2 = buildCodeGraph({ listFiles: async () => files(3, 'a'), readFile: async (f) => src(f, 'a2') }, 'pa')
    await buildCodeGraph({ listFiles: async () => files(3, 'b'), readFile: async (f) => src(f, 'b1') }, 'pb')
    expect(activeProjectKey()).toBe('pb')
    listing.open(files(3, 'a'))
    await Promise.all([ra, ra2])
    expect(activeProjectKey()).toBe('pb')
    expect(codeSymbols('b0_b1')).toHaveLength(1)
    expect(codeSymbols('a0_')).toHaveLength(0)
  })

  it('a request that joins a waiting build takes it back too: it is the last one asked for', async () => {
    const listing = gate<string[]>()
    const ra = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => src(f, 'a1') }, 'pa')
    await listing.started
    const ra2 = buildCodeGraph({ listFiles: async () => files(3, 'a'), readFile: async (f) => src(f, 'a2') }, 'pa')
    await buildCodeGraph({ listFiles: async () => files(3, 'b'), readFile: async (f) => src(f, 'b1') }, 'pb')
    const ra3 = buildCodeGraph({ listFiles: async () => files(3, 'a'), readFile: async (f) => src(f, 'a3') }, 'pa')
    expect(ra3).toBe(ra2)
    expect(activeProjectKey()).toBe('pa')
    listing.open(files(3, 'a'))
    await Promise.all([ra, ra2])
    expect(codeSymbols('a0_a3')).toHaveLength(1)
  })
})

describe('builds of a project asked for while one runs are one build', () => {
  it("one listing, with the last request's deps, and every caller gets the same result", async () => {
    const list = files(20)
    await build(list, 'v1')
    const held = heldPause()
    const ra = build(list, 'v2', held.pause)
    await held.reached
    const listed: string[] = []
    const ask = (tag: string) => buildCodeGraph({ listFiles: async () => { listed.push(tag); return list }, readFile: async (f) => src(f, tag) }, KEY)
    const asked = ['v3', 'v4', 'v5'].map(ask)
    expect(new Set(asked).size).toBe(1)
    held.release()
    await ra
    const stats = await asked[0]
    expect(stats.files).toBe(20)
    expect(listed).toEqual(['v5'])
    expect(codeSymbols('_v5', 100, KEY)).toHaveLength(20)
    expect(codeSymbols('_v3', 100, KEY)).toHaveLength(0)
    expect(graphSweeping(KEY)).toBe(false)
    expect(_codeGraphBuildsForTests(KEY)).toBe(0)
  })

  it('a request made once the waiting build has started waits for one of its own, which lists after it', async () => {
    const list = files(20)
    await build(list, 'v1')
    const held = heldPause()
    const ra = build(list, 'v2', held.pause)
    await held.reached
    const listing = gate<string[]>()
    const listed: string[] = []
    const rb = buildCodeGraph({ listFiles: () => { listed.push('v3'); return listing.wait() }, readFile: async (f) => src(f, 'v3') }, KEY)
    held.release()
    await ra
    await listing.started
    const rc = buildCodeGraph({ listFiles: async () => { listed.push('v4'); return list }, readFile: async (f) => src(f, 'v4') }, KEY)
    expect(rc).not.toBe(rb)
    expect(graphSweeping(KEY)).toBe(true)
    listing.open(list)
    await Promise.all([rb, rc])
    expect(listed).toEqual(['v3', 'v4'])
    expect(codeSymbols('_v4', 100, KEY)).toHaveLength(20)
    expect(graphSweeping(KEY)).toBe(false)
  })
  it('a request made while the first build has started, and one waits, joins the waiting one: the first build does not drop it', async () => {
    const list = files(20)
    const listed: string[] = []
    const ask = (tag: string, pause?: () => Promise<void>) => buildCodeGraph({ listFiles: async () => { listed.push(tag); return list }, readFile: async (f) => src(f, tag), ...(pause ? { pause } : {}) }, KEY)
    const held = heldPause()
    const ra = ask('v1', held.pause)
    const rb = ask('v2')
    await settle(1) // the first build has started (it has its turn), and the second still waits for it
    const rc = ask('v3')
    expect(rc).toBe(rb)
    await held.reached
    held.release()
    await Promise.all([ra, rb, rc])
    expect(listed).toEqual(['v1', 'v3'])
    expect(codeSymbols('_v3', 100, KEY)).toHaveLength(20)
  })
})

describe('a file a watcher batch wrote while a build listed is settled against the disk before the build publishes', () => {
  const A = '/repo/src/a.ts'

  it('one read while the build listed and deleted before its listing came back is not published', async () => {
    const list = files(20)
    await build(list, 'v1')
    let aGone = false
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => { if (f === A && aGone) throw enoent(); return src(f, 'v2') } }, KEY)
    await listing.started
    await reindexPaths([A], async () => src(A, 'v9'), KEY)
    expect(codeSymbols('a_v9', 10, KEY)).toHaveLength(1)
    aGone = true
    listing.open(list) // listed after the delete: no a.ts
    await rb
    expect(codeSymbols('a_', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(20)
    // Its delete event, when it comes, leaves it out of the live graph as well.
    await reindexPaths([A], async () => { throw enoent() }, KEY)
    expect(codeSymbols('a_', 10, KEY)).toHaveLength(0)
  })

  it('Codex: a batch that read a.ts and then waits on b.ts while the listing comes back without the deleted a.ts', async () => {
    const list = files(20)
    await build(list, 'v1')
    const B = list[1]
    let aGone = false
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => { if (f === A && aGone) throw enoent(); return src(f, 'v2') } }, KEY)
    await listing.started
    const b = gate<string>()
    const pass = reindexPaths([A, B], (f) => (f === B ? b.wait() : Promise.resolve(src(f, 'v9'))), KEY)
    await b.started
    aGone = true
    listing.open(list)
    await settle(20)
    b.open(src(B, 'v9'))
    await Promise.all([pass, rb])
    expect(codeSymbols('a_', 10, KEY)).toHaveLength(0)
    expect(codeSymbols('f1_v9', 10, KEY)).toHaveLength(1)
  })

  it('Codex, a project of fewer files than one yield boundary: the build holds the project again once it has listed', async () => {
    const list = files(5) // no boundary: the build reads all five and publishes without a yield in between
    await build(list, 'v1')
    const B = list[1]
    let aGone = false
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => { if (f === A && aGone) throw enoent(); return src(f, 'v2') } }, KEY)
    await listing.started
    const b = gate<string>()
    const pass = reindexPaths([A, B], (f) => (f === B ? b.wait() : Promise.resolve(src(f, 'v9'))), KEY)
    await b.started
    aGone = true
    listing.open(list)
    await settle(20)
    b.open(src(B, 'v9'))
    await Promise.all([pass, rb])
    expect(codeSymbols('a_', 10, KEY)).toHaveLength(0)
    expect(codeSymbols('f1_v9', 10, KEY)).toHaveLength(1)
    expect(codeGraphStats(KEY).files).toBe(5)
  })

  it('one the listing does not hold yet (made since it began) is kept, and so is one whose read fails but does not say it is gone', async () => {
    const list = files(20)
    await build(list, 'v1')
    const C = '/repo/src/c.ts'
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => { if (f === C) throw busy(); return src(f, 'v2') } }, KEY)
    await listing.started
    await reindexPaths([A, C], async (f) => src(f, 'v9'), KEY)
    listing.open(list)
    await rb
    expect(codeSymbols('a_v9', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('c_v9', 10, KEY)).toHaveLength(1)
  })

  it('one the listing holds is not read again: the build left it as the batch did', async () => {
    const list = [...files(20), A]
    await build(list, 'v1')
    const reads: string[] = []
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => { reads.push(f); return src(f, 'v2') } }, KEY)
    await listing.started
    await reindexPaths([A], async () => src(A, 'v9'), KEY)
    listing.open(list)
    await rb
    expect(reads).not.toContain(A)
    expect(codeSymbols('a_v9', 10, KEY)).toHaveLength(1)
  })
})

describe('a file a watcher batch could not read while a build ran is read again before the build publishes', () => {
  it('Codex: one batch indexed it, a later one got EBUSY; the build reads it itself instead of skipping it', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[30] // ahead of the held build
    const held = heldPause()
    const rb = build(list, 'v2', held.pause)
    await held.reached
    await reindexPaths([F], async () => src(F, 'v9'), KEY)
    await reindexPaths([F], async () => { throw busy() }, KEY)
    held.release()
    await rb
    expect(codeSymbols('f30_v2', 10, KEY)).toHaveLength(1)
    expect(codeGraphStats(KEY).files).toBe(40)
  })

  it('Opus P10: one the build had read already is read once more, not left out', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[3] // read before the held boundary
    const held = heldPause()
    const reads: string[] = []
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: async (f) => { reads.push(f); return src(f, 'v2') }, pause: held.pause }, KEY)
    await held.reached
    await reindexPaths([F], async () => { throw busy() }, KEY)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
    held.release()
    await rb
    expect(codeSymbols('f3_v2', 10, KEY)).toHaveLength(1)
    expect(reads.filter((f) => f === F)).toHaveLength(2)
    // The one the build had not reached (f30, say) is read once only: by the build.
    expect(reads.filter((f) => f === list[30])).toHaveLength(1)
  })

  it('one a later batch read after all is not read once more: that read is the newer one, and kept', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[3] // read before the held boundary
    const held = heldPause()
    const reads: string[] = []
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: async (f) => { reads.push(f); return src(f, 'v2') }, pause: held.pause }, KEY)
    await held.reached
    await reindexPaths([F], async () => { throw busy() }, KEY)
    await reindexPaths([F], async () => src(F, 'v9'), KEY)
    held.release()
    await rb
    expect(reads.filter((f) => f === F)).toHaveLength(1)
    expect(codeSymbols('f3_v9', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f3_v2', 10, KEY)).toHaveLength(0)
  })

  it('one the build reached after the failure is read by the build only, not once more', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[30]
    const held = heldPause()
    const reads: string[] = []
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: async (f) => { reads.push(f); return src(f, 'v2') }, pause: held.pause }, KEY)
    await held.reached
    await reindexPaths([F], async () => { throw busy() }, KEY)
    held.release()
    await rb
    expect(reads.filter((f) => f === F)).toHaveLength(1)
    expect(codeSymbols('f30_v2', 10, KEY)).toHaveLength(1)
  })

  it('one still unreadable then stays out; one past the size cap stays out and is counted', async () => {
    const list = files(40)
    await build(list, 'v1')
    const [F, G] = [list[3], list[4]]
    const held = heldPause()
    let late = false
    const rb = buildCodeGraph({
      listFiles: async () => list,
      readFile: async (f) => {
        if (late && f === F) throw busy()
        if (late && f === G) return `${src(G, 'v2')}// ${'x'.repeat(4096)}\n`
        return src(f, 'v2')
      },
      pause: held.pause,
    }, KEY)
    await held.reached
    await reindexPaths([F, G], async () => { throw busy() }, KEY)
    late = true
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = '1' // 1 KB
    const before = codeGraphSweepCounters().skippedLarge
    try {
      held.release()
      await rb
    } finally {
      delete process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
    }
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
    expect(codeSymbols('f4_', 10, KEY)).toHaveLength(0)
    expect(codeGraphSweepCounters().skippedLarge - before).toBe(1)
    expect(codeGraphStats(KEY).files).toBe(38)
  })

  it('one in a language with no grammar is read through the text extractor; an empty one leaves nothing', async () => {
    const list = files(40)
    await build(list, 'v1')
    const kt = '/repo/src/a.kt'
    const empty = '/repo/src/b.kt'
    const body = 'fun ktAlpha() { ktBeta() }\nfun ktBeta() { }\n'
    const held = heldPause()
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: async (f) => (f === kt ? body : f === empty ? '' : src(f, 'v2')), pause: held.pause }, KEY)
    await held.reached
    await reindexPaths([kt, empty], async () => { throw busy() }, KEY)
    held.release()
    await rb
    expect(codeCallers('ktBeta', KEY).map((s) => s.name)).toEqual(['ktAlpha'])
    expect(fileSymbols(empty)).toEqual([])
  })

  it('an edit made while that read is out is newer, and kept', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[3]
    const held = heldPause()
    let late = false
    const again = gate<string>()
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: (f) => (late && f === F ? again.wait() : Promise.resolve(src(f, 'v2'))), pause: held.pause }, KEY)
    await held.reached
    await reindexPaths([F], async () => { throw busy() }, KEY)
    late = true
    held.release()
    await again.started
    indexFileContent(F, src(F, 'v9'), KEY)
    again.open(src(F, 'v2'))
    await rb
    expect(codeSymbols('f3_v9', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f3_v2', 10, KEY)).toHaveLength(0)
  })

  it('a file a batch finds gone is left out without a second read', async () => {
    const list = files(40)
    await build(list, 'v1')
    const F = list[3]
    const held = heldPause()
    const reads: string[] = []
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: async (f) => { reads.push(f); return src(f, 'v2') }, pause: held.pause }, KEY)
    await held.reached
    await reindexPaths([F], async () => { throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' }) }, KEY)
    held.release()
    await rb
    expect(reads.filter((f) => f === F)).toHaveLength(1)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
  })
})

describe('loading the graphs again (initCodeGraph, a brain import) while a batch or a build is under way', () => {
  let d = ''
  beforeEach(() => { d = mkdtempSync(join(tmpdir(), 'cg-init-')) })
  afterEach(() => { rmSync(d, { recursive: true, force: true }) })

  it('Opus P5: a batch waiting on a read writes its file into the graph loaded meanwhile', async () => {
    await build(files(5), 'v1')
    const g = gate<string>()
    const pass = reindexPaths(['/repo/src/created.ts'], () => g.wait(), KEY)
    await g.started
    initCodeGraph(d)
    g.open('export function createdFn() { return 1 }\n')
    await pass
    expect(codeSymbols('createdFn', 10, KEY)).toHaveLength(1)
  })

  it('a first build under way still publishes what it read, and an edit a batch made after the load', async () => {
    const held = heldPause()
    const rb = build(files(40), 'v1', held.pause)
    await held.reached
    initCodeGraph(d)
    await reindexPaths(['/repo/src/nu.ts'], async () => 'export function nu() { return 1 }\n', KEY)
    held.release()
    await rb
    expect(codeGraphStats(KEY).files).toBe(41)
    expect(codeSymbols('nu', 10, KEY)).toHaveLength(1)
  })
})

describe('a read or a listing that never comes back counts as failed after its time limit', () => {
  const never = (): Promise<never> => new Promise<never>(() => { /* never settles */ })
  afterEach(() => { _setCodeGraphTimeoutsForTests() })

  it('Opus P9: a batch read; a build asked for meanwhile goes on, and reads that file itself', async () => {
    const list = files(5)
    await build(list, 'v1')
    _setCodeGraphTimeoutsForTests({ readMs: 50 })
    const pass = reindexPaths([list[2]], () => never(), KEY)
    const rb = build(list, 'v2')
    await Promise.all([pass, rb])
    expect(codeSymbols('f2_v2', 10, KEY)).toHaveLength(1)
    expect(codeGraphStats(KEY).files).toBe(5)
  })

  it("a build's read: the file keeps the last graph's version, and a batch asked for meanwhile goes through", async () => {
    const list = files(40)
    await build(list, 'v1')
    _setCodeGraphTimeoutsForTests({ readMs: 50 })
    const rb = buildCodeGraph({ listFiles: async () => list, readFile: (f) => (f === list[3] ? never() : Promise.resolve(src(f, 'v2'))) }, KEY)
    await settle(5)
    const pass = reindexPaths(['/repo/src/extra.ts'], async () => 'export function extraFn() { return 1 }\n', KEY)
    await Promise.all([pass, rb])
    expect(codeSymbols('extraFn', 10, KEY)).toHaveLength(1)
    // Read once more before the build publishes, and still not back: not published as gone (Opus R3-m1).
    expect(codeSymbols('f3_v1', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f3_v2', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(41)
  })

  it('Opus P8: a listing keeps the graph as it was, and the build asked for after it runs', async () => {
    const list = files(5)
    await build(list, 'v1')
    _setCodeGraphTimeoutsForTests({ listingMs: 50 })
    const ra = buildCodeGraph({ listFiles: () => never(), readFile: async (f) => src(f, 'v2') }, KEY)
    const rb = build(list, 'v3')
    const [a] = await Promise.all([ra, rb])
    expect(a.files).toBe(5)
    expect(codeSymbols('_v3', 10, KEY)).toHaveLength(5)
  })

  it('a read that comes back in time is used, and its timer is cleared with it', async () => {
    _setCodeGraphTimeoutsForTests({ readMs: 60_000 })
    const set = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    await reindexPaths(['/repo/src/quick.ts', '/repo/src/slow.ts'], async (f) => src(f, 'v1'), KEY)
    expect(codeSymbols('quick_v1', 10, KEY)).toHaveLength(1)
    const timers = set.mock.calls.flatMap((c, i) => (c[1] === 60_000 ? [set.mock.results[i].value] : []))
    expect(timers).toHaveLength(2)
    for (const t of timers) expect(cleared.mock.calls.map((c) => c[0])).toContain(t)
  })
})

describe('a request naming another root does not join the build waiting for its project (Codex r4 M1)', () => {
  it('two spellings of one folder each list, and a request of the same root still joins', async () => {
    const list = files(20)
    await build(list, 'v1')
    const held = heldPause()
    const ra = build(list, 'v2', held.pause)
    await held.reached
    const listed: string[] = []
    const ask = (root: string, tag: string) =>
      buildCodeGraph({ root, listFiles: async () => { listed.push(tag); return list }, readFile: async (f) => src(f, tag) }, KEY)
    const rb = ask('/repo', 'v3')
    const rc = ask('/REPO', 'v4')
    expect(rc).not.toBe(rb)
    const rd = ask('/REPO', 'v5')
    expect(rd).toBe(rc)
    held.release()
    await Promise.all([ra, rb, rc, rd])
    expect(listed).toEqual(['v3', 'v5'])
    expect(codeSymbols('_v5', 100, KEY)).toHaveLength(20)
    expect(graphSweeping(KEY)).toBe(false)
  })

  it('a request naming no root joins one naming none, and not one naming a root', async () => {
    const list = files(20)
    await build(list, 'v1')
    const held = heldPause()
    const ra = build(list, 'v2', held.pause)
    await held.reached
    const rb = build(list, 'v3')
    expect(build(list, 'v4')).toBe(rb)
    const rc = buildCodeGraph({ root: '/repo', listFiles: async () => list, readFile: async (f) => src(f, 'v5') }, KEY)
    expect(rc).not.toBe(rb)
    held.release()
    await Promise.all([ra, rb, rc])
    expect(codeSymbols('_v5', 100, KEY)).toHaveLength(20)
  })

  it("the watcher's full re-sweep of a root names it, and joins a build waiting for that root", async () => {
    const root = '/repo'
    const key = graphKeyForRoot(root)
    const list = files(20)
    const listed: string[] = []
    const source = (tag: string) => ({ listFiles: async () => { listed.push(tag); return list }, readFile: async (f: string) => src(f, tag) })
    await buildCodeGraph({ root, ...source('v1') }, key)
    const held = heldPause()
    const ra = buildCodeGraph({ root, ...source('v2'), pause: held.pause }, key)
    await held.reached
    const rb = buildCodeGraph({ root, ...source('v3') }, key)
    const rc = reindexRepoGraph(root, undefined, source('v4'))
    held.release()
    await Promise.all([ra, rb, rc])
    // One build for both, with the request made last: v3's listing never ran.
    expect(listed).toEqual(['v1', 'v2', 'v4'])
    expect(codeSymbols('_v4', 100, key)).toHaveLength(20)
  })
})

describe('a listing that fails or comes back empty still settles what a batch did meanwhile (Codex r4 LOW)', () => {
  let d = ''
  const B = '/repo/src/b.ts'
  const saved = (): string => readFileSync(join(d, `code-graph-${KEY}.json`), 'utf8')
  beforeEach(() => { d = mkdtempSync(join(tmpdir(), 'cg-guard-')); initCodeGraph(d) })
  afterEach(() => { _resetCodeGraphForTests(); rmSync(d, { recursive: true, force: true }) })

  for (const [how, answer] of [['comes back empty', [] as string[]], ['fails', null]] as const) {
    it(`the listing ${how}: a file the batch read, and that is gone since, leaves the graph and the saved file`, async () => {
      const list = files(5)
      await build(list, 'v1')
      let gone = false
      const listing = gate<string[] | null>()
      const listFiles = async (): Promise<string[]> => { const v = await listing.wait(); if (v === null) throw new Error('git gone'); return v }
      const rb = buildCodeGraph({ listFiles, readFile: async (f) => { if (f === B && gone) throw enoent(); return src(f, 'v2') } }, KEY)
      await listing.started
      await reindexPaths([B], async () => src(B, 'v9'), KEY)
      expect(codeSymbols('b_v9', 10, KEY)).toHaveLength(1)
      expect(saved()).toContain('b_v9')
      gone = true
      listing.open(answer)
      await rb
      expect(codeSymbols('b_', 10, KEY)).toHaveLength(0)
      expect(codeSymbols('_v1', 10, KEY)).toHaveLength(5)
      expect(saved()).not.toContain('b_v9')
    })
  }

  it('one a batch could not read, readable now, goes into the graph and the saved file', async () => {
    const list = files(5)
    await build(list, 'v1')
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => src(f, 'v2') }, KEY)
    await listing.started
    await reindexPaths([B], async () => { throw busy() }, KEY)
    expect(codeSymbols('b_', 10, KEY)).toHaveLength(0)
    listing.open([])
    await rb
    expect(codeSymbols('b_v2', 10, KEY)).toHaveLength(1)
    expect(saved()).toContain('b_v2')
  })

  it('one the batch read that is there still is kept; with nothing to settle, the graph is not written again', async () => {
    const list = files(5)
    await build(list, 'v1')
    const listing = gate<string[]>()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: async (f) => src(f, 'v2') }, KEY)
    await listing.started
    await reindexPaths([B], async () => src(B, 'v9'), KEY)
    const write = vi.spyOn(fs.promises, 'writeFile')
    listing.open([])
    await rb
    expect(codeSymbols('b_v9', 10, KEY)).toHaveLength(1)
    expect(write).not.toHaveBeenCalled()
    await buildCodeGraph({ listFiles: async () => [], readFile: async () => '' }, KEY)
    expect(write).not.toHaveBeenCalled()
  })
})

describe("a build's own read that fails, but does not say the file is gone, is read once more (Opus R3-m1)", () => {
  const F = '/repo/src/f3.ts'
  const failing = (version: string, second: () => Promise<string>) => {
    let n = 0
    return async (f: string): Promise<string> => {
      if (f !== F) return src(f, version)
      if (++n === 1) throw busy()
      return second()
    }
  }

  it('read the second time: the new version is published', async () => {
    const list = files(40)
    await build(list, 'v1')
    await buildCodeGraph({ listFiles: async () => list, readFile: failing('v2', async () => src(F, 'v2')) }, KEY)
    expect(codeSymbols('f3_v2', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f3_v1', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(40)
  })

  it('unreadable the second time too: the last graph keeps its version of it, so the build does not publish 39 of 40', async () => {
    const list = files(40)
    await build(list, 'v1')
    const stats = await buildCodeGraph({ listFiles: async () => list, readFile: failing('v2', async () => { throw busy() }) }, KEY)
    expect(codeSymbols('f3_v1', 10, KEY)).toHaveLength(1)
    expect(codeSymbols('f3_v2', 10, KEY)).toHaveLength(0)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(39)
    expect(stats.files).toBe(40)
  })

  it("kept from the last graph, the file's imports come with its symbols", async () => {
    const list = files(40)
    const withImport = (f: string, v: string): string => `import { y } from './y'\n${src(f, v)}`
    await buildCodeGraph({ listFiles: async () => list, readFile: async (f) => (f === F ? withImport(f, 'v1') : src(f, 'v1')) }, KEY)
    expect(_codeGraphImportsForTests(KEY, F)).toBeDefined()
    await buildCodeGraph({ listFiles: async () => list, readFile: failing('v2', async () => { throw busy() }) }, KEY)
    expect(codeSymbols('f3_v1', 10, KEY)).toHaveLength(1)
    expect(_codeGraphImportsForTests(KEY, F)).toBeDefined()
  })

  it('gone the second time: it stays out', async () => {
    const list = files(40)
    await build(list, 'v1')
    await buildCodeGraph({ listFiles: async () => list, readFile: failing('v2', async () => { throw enoent() }) }, KEY)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
    expect(codeGraphStats(KEY).files).toBe(39)
  })

  it('a read that finds it gone the first time is not read again', async () => {
    const list = files(40)
    await build(list, 'v1')
    const reads: string[] = []
    await buildCodeGraph({ listFiles: async () => list, readFile: async (f) => { reads.push(f); if (f === F) throw enoent(); return src(f, 'v2') } }, KEY)
    expect(reads.filter((f) => f === F)).toHaveLength(1)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
  })

  it('a first build has no last graph to keep it from: still unreadable, it stays out', async () => {
    const list = files(40)
    const stats = await buildCodeGraph({ listFiles: async () => list, readFile: failing('v1', async () => { throw busy() }) }, KEY)
    expect(codeSymbols('f3_', 10, KEY)).toHaveLength(0)
    expect(stats.files).toBe(39)
  })
})

describe('the reads a build settles before it publishes run a few at a time, all within one time limit (Opus R3-m2)', () => {
  afterEach(() => { _setCodeGraphTimeoutsForTests() })

  it('thirty that hang hold the project for one limit, not thirty, and keep what the last graph held', async () => {
    const list = files(40)
    await build(list, 'v1')
    const hang = new Set(list.slice(0, 30))
    const readMs = 200
    _setCodeGraphTimeoutsForTests({ readMs })
    const first = new Set<string>()
    let again = 0
    const t0 = Date.now()
    await buildCodeGraph({
      listFiles: async () => list,
      readFile: (f) => {
        if (!hang.has(f)) return Promise.resolve(src(f, 'v2'))
        if (!first.has(f)) {
          first.add(f)
          return Promise.reject(busy())
        }
        again++
        return new Promise<never>(() => { /* never settles */ })
      },
    }, KEY)
    const took = Date.now() - t0
    // Eight out at once; the other 22 find the time spent and are not read at all.
    expect(again).toBe(8)
    expect(took).toBeLessThan(10 * readMs)
    expect(took).toBeGreaterThanOrEqual(readMs - 20)
    expect(codeSymbols('_v1', 100, KEY)).toHaveLength(30)
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(10)
  })

  it('a batch file not in the listing is checked within the same limit', async () => {
    const list = files(5)
    await build(list, 'v1')
    _setCodeGraphTimeoutsForTests({ readMs: 100 })
    const extra = Array.from({ length: 20 }, (_, i) => `/repo/src/extra${i}.ts`)
    const listing = gate<string[]>()
    let checks = 0
    const t0 = Date.now()
    const rb = buildCodeGraph({ listFiles: () => listing.wait(), readFile: (f) => {
      if (!f.includes('extra')) return Promise.resolve(src(f, 'v2'))
      checks++
      return new Promise<never>(() => { /* never settles */ })
    } }, KEY)
    await listing.started
    await reindexPaths(extra, async (f) => src(f, 'v9'), KEY)
    listing.open(list)
    await rb
    expect(checks).toBe(8)
    expect(Date.now() - t0).toBeLessThan(1000)
    // Not found gone: kept as the batch wrote them.
    expect(codeSymbols('_v9', 100, KEY)).toHaveLength(20)
  })
})
