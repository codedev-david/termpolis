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
  buildCodeGraph, codeCallers, codeGraphStats, codeSymbols, fileSymbols, graphSweeping, indexFileContent, initCodeGraph,
  persistCodeGraph, reindexPaths, _codeGraphBuildsForTests, _codeGraphImportsForTests, _resetCodeGraphForTests,
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
    await reindexPaths([list[3]], async () => { throw new Error('ENOENT') }, KEY)
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
    const pass = reindexPaths([F], async () => { throw new Error('ENOENT') }, KEY)
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

  it('three first builds asked for together each list only once the one before has finished, and the last stays', async () => {
    const listed: string[] = []
    const finished: string[] = []
    const one = (tag: string) =>
      buildCodeGraph({ listFiles: async () => { listed.push(`${tag}:${finished.join('')}`); return files(40, tag) }, readFile: async (f) => src(f, 'v1') }, KEY)
        .then(() => { finished.push(tag) })
    await Promise.all([one('a'), one('b'), one('c')])
    expect(listed).toEqual(['a:', 'b:a', 'c:ab'])
    expect(codeGraphStats(KEY).files).toBe(40)
    expect(codeSymbols('', 100, KEY).every((s) => s.name.startsWith('c'))).toBe(true)
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
