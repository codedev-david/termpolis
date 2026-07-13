// The code-graph sweep must NEVER starve the main thread.
//
// Termpolis pumps every PTY and serves all IPC on the main process's event loop. buildCodeGraph
// walks every source file in a repo, and each iteration `await`s the injected reader and the
// extractor. If BOTH of those resolve synchronously — which is exactly what index.ts did, injecting
// `async (f) => readFileSync(f, 'utf8')`, and what extractFileTS does (a synchronous WASM parse
// behind an async signature) — then every `await` is on an ALREADY-RESOLVED promise and yields only
// a MICROTASK. Node drains the microtask queue to completion before advancing the event loop, so
// the entire sweep runs as one unbroken block: no PTY output, no IPC, and Windows paints
// "(Not Responding)".
//
// Measured on this repo before the fix: 645 files, 2,777 ms of unbroken starvation, ZERO timer
// ticks. Afterwards: same total work, longest stall 92 ms.
//
// So the invariant is not "the sweep is fast" — it is "the sweep is INTERRUPTIBLE". These tests
// assert that with a deliberately synchronous reader (the pathological case), the event loop still
// gets served. A macrotask timer that cannot fire even once is the definition of a frozen app.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initCodeGraph, buildCodeGraph, reindexPaths, _resetCodeGraphForTests } from '../../src/main/codeGraph'
import { extractFileTS } from '../../src/main/codeGraphTreeSitter'

let dir: string
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-yield-'))
  _resetCodeGraphForTests()
  initCodeGraph(dir)
  // Settle the tree-sitter grammar BEFORE measuring. The first extract of a process pays a one-time
  // ASYNC grammar load, which incidentally hands the loop back and would mask the freeze; every
  // extract after it is a pure synchronous WASM parse. Steady state is what ships, and steady state
  // is what froze — so measure that, not the warm-up.
  await extractFileTS(path.join(dir, 'warmup.ts'), 'export function warm() { return 1 }\n')
})
afterEach(() => {
  _resetCodeGraphForTests()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// Enough files that a non-yielding loop is unmistakably starving the loop, few enough to stay fast.
const FILES = Array.from({ length: 200 }, (_, i) => path.join(dir || '.', `src/f${i}.ts`))
const SRC = 'export function alpha() {\n  return beta() + 1\n}\nexport function beta() {\n  return 2\n}\n'

/**
 * Count how many times the EVENT LOOP is actually served while `work` runs.
 *
 * A self-rescheduling setImmediate only runs when the loop reaches its check phase, so this counts
 * real macrotask turns — not timer ticks, which are resolution-dependent and can pass by accident.
 * A loop starved by an unbroken microtask chain yields ZERO turns: that is a frozen app, measured.
 */
async function loopTurnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0
  let running = true
  const pump = (): void => {
    if (!running) return
    turns++
    setImmediate(pump)
  }
  setImmediate(pump)
  try {
    await work()
  } finally {
    running = false
  }
  return turns
}

// buildCodeGraph yields every YIELD_EVERY files, so a 200-file sweep must serve the loop ~12 times.
// Requiring several turns (not just one) stops an incidental async hiccup — e.g. a grammar load in
// the test env — from satisfying the assertion while production, where the grammar is cached and the
// parse is pure sync, still freezes.
const MIN_TURNS = 5

describe('code-graph sweep does not freeze the main thread', () => {
  it('buildCodeGraph yields to the event loop even with a fully synchronous reader', async () => {
    const files = FILES.map((_, i) => path.join(dir, `src/f${i}.ts`))
    // The pathological injection: an async signature wrapping a synchronous read. This is precisely
    // what index.ts shipped, and it makes every `await` a microtask-only yield.
    const syncReader = async (_f: string): Promise<string> => SRC

    const turns = await loopTurnsDuring(() =>
      buildCodeGraph({ listFiles: async () => files, readFile: syncReader }, 'yield-test'),
    )

    // Before the fix this is 0 — the loop physically cannot be served, because the microtask queue
    // never drains. That is the "(Not Responding)" freeze, reproduced deterministically.
    expect(turns).toBeGreaterThanOrEqual(MIN_TURNS)
  })

  it('reindexPaths yields to the event loop even with a fully synchronous reader', async () => {
    const files = FILES.map((_, i) => path.join(dir, `src/f${i}.ts`))
    const syncReader = async (_f: string): Promise<string> => SRC

    const turns = await loopTurnsDuring(() => reindexPaths(files, syncReader, 'yield-test'))

    expect(turns).toBeGreaterThanOrEqual(MIN_TURNS)
  })

  it('still indexes every file correctly while yielding', async () => {
    const files = FILES.slice(0, 20).map((_, i) => path.join(dir, `src/f${i}.ts`))
    const stats = await buildCodeGraph(
      { listFiles: async () => files, readFile: async () => SRC },
      'yield-correctness',
    )
    // Yielding must not cost coverage: 20 files x 2 functions each.
    expect(stats.files).toBe(20)
    expect(stats.symbols).toBe(40)
  })
})
