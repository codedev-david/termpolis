// HP-3 (1.54.5 fixer round 1): the auto code-index (on by default) starts a code-graph sweep the moment the user cd's
// into a repo, which is exactly when they type. The sweep yields between files (codeGraphYield.test.ts), but each
// file's tree-sitter parse is one unbroken block on the main thread, and nothing capped how big that block could be;
// nor did the sweep ask the loop governor whether the main thread was already starved.
//
// What is counted here (never timed): how many files were parsed, how many were left out for size, and how many
// times the sweep asked its pause at a boundary. And, statically, that memory:ingest-code waits on the governor before
// it starts, and that every sweep index.ts starts (buildCodeGraph, and the watcher's reindexWatchedChange) is handed
// sweepPause, which waits for the governor and then for typing quiet.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  buildCodeGraph, codeGraphSweepCounters, maxGraphFileChars, MAX_GRAPH_FILE_CHARS, reindexPaths, reindexWatchedChange,
  _resetCodeGraphForTests,
} from '../../src/main/codeGraph'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

const SRC = 'export function alpha() { return beta() }\nexport function beta() { return 1 }\n'
const BIG = SRC + '// ' + 'x'.repeat(MAX_GRAPH_FILE_CHARS) + '\n'
const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `/repo/src/f${i}.ts`)

let savedCap: string | undefined
beforeEach(() => {
  _resetCodeGraphForTests()
  savedCap = process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
  delete process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
})
afterEach(() => {
  if (savedCap === undefined) delete process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP
  else process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = savedCap
})

describe('HP-3: a file too big to parse in one block is left out of the graph, counted', () => {
  it('two normal files and one past the cap: two parsed, one skipped for size, and the graph holds the two', async () => {
    const list = files(3)
    const stats = await buildCodeGraph({ listFiles: async () => list, readFile: async (f) => (f === list[1] ? BIG : SRC) }, 'cap')
    expect(codeGraphSweepCounters()).toMatchObject({ parsed: 2, skippedLarge: 1 })
    expect(stats.files).toBe(2)
  })

  it('kill switch: TERMPOLIS_CODE_GRAPH_FILE_CAP=0 parses the big file as before', async () => {
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = '0'
    expect(maxGraphFileChars()).toBe(Infinity)
    const list = files(3)
    const stats = await buildCodeGraph({ listFiles: async () => list, readFile: async (f) => (f === list[1] ? BIG : SRC) }, 'cap-off')
    expect(codeGraphSweepCounters()).toMatchObject({ parsed: 3, skippedLarge: 0 })
    expect(stats.files).toBe(3)
  })

  it('the cap can be set in KB, and a value that is not a number keeps the default', () => {
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = '64'
    expect(maxGraphFileChars()).toBe(64 * 1024)
    process.env.TERMPOLIS_CODE_GRAPH_FILE_CAP = 'lots'
    expect(maxGraphFileChars()).toBe(MAX_GRAPH_FILE_CHARS)
  })
})

describe('HP-3: the sweep asks the loop governor at its boundaries', () => {
  it('a 40-file sweep asks at every yield boundary (every 16 files): twice, and waits while told to', async () => {
    const asked: number[] = []
    let parsedWhenAsked = -1
    await buildCodeGraph({
      listFiles: async () => files(40),
      readFile: async () => SRC,
      pause: async () => { asked.push(codeGraphSweepCounters().parsed); parsedWhenAsked = codeGraphSweepCounters().parsed; return true },
    }, 'pause')
    expect(asked).toEqual([15, 31])
    expect(parsedWhenAsked).toBe(31)
    expect(codeGraphSweepCounters()).toMatchObject({ parsed: 40, pauses: 2 })
  })

  it('fails open: a governor that throws does not stop the sweep', async () => {
    const stats = await buildCodeGraph({
      listFiles: async () => files(20),
      readFile: async () => SRC,
      pause: async () => { throw new Error('governor gone') },
    }, 'pause-throws')
    expect(stats.files).toBe(20)
  })

  it('control: with no pause given (the old callers) nothing is asked and every file is parsed', async () => {
    await buildCodeGraph({ listFiles: async () => files(40), readFile: async () => SRC }, 'no-pause')
    expect(codeGraphSweepCounters()).toMatchObject({ parsed: 40, pauses: 0 })
  })
})

describe("the watcher's re-index asks the same pause (reindexPaths, reindexWatchedChange)", () => {
  it('reindexPaths of 40 changed files asks at every yield boundary: twice, and waits while told to', async () => {
    const asked: number[] = []
    let read = 0
    const n = await reindexPaths(files(40), async () => { read++; return SRC }, 'rp-pause', async () => { asked.push(read) })
    expect(asked).toEqual([15, 31])
    expect(n).toBeGreaterThan(0)
    expect(codeGraphSweepCounters()).toMatchObject({ pauses: 2 })
  })

  it('fails open: a pause that throws does not stop the re-index', async () => {
    let read = 0
    await reindexPaths(files(20), async () => { read++; return SRC }, 'rp-throws', async () => { throw new Error('governor gone') })
    expect(read).toBe(20)
  })

  it('control: with no pause given nothing is asked', async () => {
    await reindexPaths(files(40), async () => SRC, 'rp-none')
    expect(codeGraphSweepCounters()).toMatchObject({ pauses: 0 })
  })

  it('reindexWatchedChange hands its pause to the incremental pass', async () => {
    let asked = 0
    const root = '/repo'
    const rel = Array.from({ length: 40 }, (_, i) => `src/w${i}.ts`)
    await reindexWatchedChange(root, rel, async () => SRC, async () => { asked++ })
    expect(asked).toBe(2)
  })

  it('reindexWatchedChange hands its pause to the full re-sweep of an empty change set (reindexRepoGraph)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-watch-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      mkdirSync(join(root, 'src'))
      for (let i = 0; i < 40; i++) writeFileSync(join(root, 'src', `r${i}.ts`), SRC)
      let asked = 0
      await reindexWatchedChange(root, [], async () => '', async () => { asked++ })
      expect(codeGraphSweepCounters().parsed).toBe(40)
      expect(asked).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('HP-3: index.ts waits on the governor before a code ingest and hands it (with the typing gate) to every sweep', () => {
  const index = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
  const handler = (name: string): string => {
    const start = index.indexOf(`ipcMain.handle('${name}'`)
    expect(start).toBeGreaterThan(-1)
    const next = index.indexOf('ipcMain.handle(', start + 10)
    return index.slice(start, next)
  }

  it("memory:ingest-code awaits whenNotShed() before runCodeIngest, and its sweep is given pause: sweepPause (governor, then typing quiet)", () => {
    const h = handler('memory:ingest-code')
    const wait = h.indexOf('await whenNotShed()')
    expect(wait).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(h.indexOf('runCodeIngest('))
    expect(h).toMatch(/buildCodeGraph\(\{[^}]*pause: \(\) => sweepPause\(\)/)
  })

  it('every buildCodeGraph call in index.ts passes sweepPause, which waits for the governor and for typing quiet', () => {
    const calls = index.match(/buildCodeGraph\(\{[^}]*\}/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.filter((c) => !c.includes('pause: () => sweepPause()'))).toEqual([])
    expect(index).toMatch(/import \{ sweepPause \} from '\.\/sweepPause'/)
  })

  it("the file watcher's re-index of a change (reindexWatchedChange) is handed sweepPause too", () => {
    const calls = index.match(/reindexWatchedChange\([^\n]*/g) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/, \(\) => sweepPause\(\)\)$/)
  })
})
