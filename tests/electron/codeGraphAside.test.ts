// A rebuild of a project's code graph fills a new graph aside and swaps it in once it is whole (codeGraph.ts,
// buildCodeGraphImpl). A sweep is held by sweepPause while someone types, so it can take minutes; meanwhile the MCP
// code tools read the graph, and a rebuild that cleared it first would answer them from a part of the project.
//
// Counted here, on a sweep held at its first pause: what a reader sees while it is held (the last whole graph on a
// rebuild, the files read so far on a first build), and that an edit indexed meanwhile (indexFileContent, and the
// watcher's reindexPaths) is still in the graph after the swap.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildCodeGraph, codeGraphStats, codeSymbols, graphSweeping, indexFileContent, reindexPaths, _resetCodeGraphForTests,
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

beforeEach(() => { _resetCodeGraphForTests() })

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

  it('two rebuilds that overlap both write aside, and the graph ends whole with every edit made meanwhile', async () => {
    const list = files(40)
    await build(list, 'v1')
    const a = heldPause()
    const b = heldPause()
    const ra = build(list, 'v2', a.pause)
    const rb = build(list, 'v3', b.pause)
    await Promise.all([a.reached, b.reached])
    indexFileContent('/repo/src/both.ts', 'export function epsilon() { return 4 }\n', KEY)
    a.release()
    await ra
    expect(graphSweeping(KEY)).toBe(true) // b still runs
    expect(codeSymbols('_v2', 100, KEY)).toHaveLength(40)
    expect(codeSymbols('epsilon', 10, KEY)).toHaveLength(1)
    b.release()
    await rb
    expect(codeSymbols('_v3', 100, KEY)).toHaveLength(40)
    expect(codeSymbols('epsilon', 10, KEY)).toHaveLength(1)
    // Nothing is left building aside: a later edit is written once, to the live graph.
    indexFileContent('/repo/src/after.ts', 'export function zeta() { return 5 }\n', KEY)
    expect(codeSymbols('zeta', 10, KEY)).toHaveLength(1)
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
