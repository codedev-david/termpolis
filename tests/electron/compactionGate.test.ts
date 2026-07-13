// compactSelfShard's gate — moved IN FRONT of the work.
//
// David: "the whole app freezes up for 2-3 seconds and says not responding, then goes back."
//
// It was compaction. Every 30 minutes (index.ts: setInterval 30 * 60 * 1000) compactSelfShard ran,
// and did ALL of this synchronously on the main thread — the same thread that pumps every PTY and
// serves all IPC, which is why the WHOLE app died rather than one terminal:
//
//     readFileSync (450 MB)            792 ms
//     split into lines                  56 ms
//     DECRYPT + JSON.parse x 107,288  1592 ms   <- classifyShardLine()
//     RE-ENCRYPT x 107,288            1835 ms   <- emit()
//     join into one 443 MB string      120 ms
//     ------------------------------------
//                                     4.4 SECONDS
//
// ...and THEN it asked "was there enough dead weight to bother?" — to which the answer is almost
// always no. So it burned 4.4 seconds every 30 minutes to produce nothing at all.
//
// The gate only ever needed an ESTIMATE, and an estimate is free: we know how many lines our own
// shard has (we wrote them) and which of our entries are still live (they are in memory).
//
// THE SAFETY PROPERTY, and why this is not merely a speed hack: the estimate is biased toward saying
// YES. It under-counts the surviving lines, so it can only ever OVER-state dead weight — meaning it
// may send us off to do work that turns out to be unnecessary, but it can NEVER skip a compaction
// that was genuinely needed. A wrong guess costs time; it cannot cost correctness.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// swarmMemory does `import * as fs from 'fs'` — and an ESM namespace is frozen, so vi.spyOn throws.
// Mock the module it actually imports, and COUNT reads of our shard: "it never even read the file"
// is the entire claim under test. Everything else delegates to the real fs, because this suite
// writes real stores to a real temp dir.
const shardReads = { count: 0 }
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    default: real,
    readFileSync: (p: never, ...rest: never[]) => {
      if (String(p).includes('swarm-memory.jsonl')) shardReads.count++
      return (real.readFileSync as (...a: never[]) => unknown)(p, ...rest)
    },
  }
})

import {
  initSwarmMemory,
  memoryWrite,
  memoryDelete,
  memoryFeedback,
  memoryList,
  compactSelfShard,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _compactionMayBeWorthwhileForTests,
  _ownShardStateForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => dir }, safeStorage: undefined }))

let dir: string
const shardPath = () => join(dir, 'swarm-memory.jsonl')
const shardLines = () => readFileSync(shardPath(), 'utf8').split('\n').filter((l) => l.trim()).length
const write = (content: string) => memoryWrite({ agentId: 'a', kind: 'fact', content })

beforeEach(() => {
  _resetForTests()
  dir = mkdtempSync(join(tmpdir(), 'cg-'))
  _setEmbedFnForTests(async () => null) // the gate is about LINES, not vectors
  _setEmbeddingsAvailable(false)
  initSwarmMemory(dir)
  shardReads.count = 0
})

afterEach(() => {
  _setEmbedFnForTests(null)
  _resetForTests()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the gate answers from memory, and never touches the disk to say no', () => {
  it('tracks our own shard: one line per append, starting from zero', async () => {
    expect(_ownShardStateForTests()).toEqual({ lines: 0, addIds: 0 })
    await write('alpha')
    await write('beta')
    expect(_ownShardStateForTests().lines).toBe(2)
    expect(shardLines()).toBe(2) // and it agrees with what is actually on disk
  })

  // THE WHOLE POINT. A mostly-live shard must be declined WITHOUT reading, decrypting or parsing it.
  it('declines a mostly-live shard WITHOUT a single read of the file', async () => {
    for (let i = 0; i < 250; i++) await write(`entry ${i}`) // over COMPACT_MIN_LINES (200)
    expect(_ownShardStateForTests().lines).toBe(250)

    shardReads.count = 0
    const res = compactSelfShard()

    expect(res.compacted).toBe(false)
    // Not "it read the file and decided no" — it never read the file at all. That IS the 4.4 seconds.
    expect(shardReads.count).toBe(0)
  })

  it('a shard below the minimum line count is declined, and still reads nothing', async () => {
    await write('one')
    await write('two')
    shardReads.count = 0
    const res = compactSelfShard()
    expect(res.compacted).toBe(false)
    expect(res.before).toBe(2)
    expect(res.after).toBe(2)
    expect(shardReads.count).toBe(0)
  })

  it('the estimate says NO for a healthy store — the case that was costing 4.4s', async () => {
    for (let i = 0; i < 250; i++) await write(`live ${i}`)
    expect(_compactionMayBeWorthwhileForTests()).toBe(false)
  })
})

describe('the gate can never skip a compaction that is genuinely needed', () => {
  // THE SAFETY INVARIANT. If this fails, the shard grows without bound and the fix has traded a
  // freeze for a leak — strictly worse than the bug it replaced.
  //
  // How dead weight actually accumulates, which is not obvious: every USE of a memory appends a
  // `reinforce` line, and compaction folds all of them into ONE. Deletes cannot get you there —
  // each delete appends a tombstone of its own, so the dead ratio asymptotes at 0.5 and never
  // crosses it. Reinforce churn is the real reason a shard rots.
  it('says YES once reinforce churn outweighs the entries, and then really compacts', async () => {
    const ids: string[] = []
    for (let i = 0; i < 100; i++) ids.push((await write(`entry ${i}`)).id)
    expect(_compactionMayBeWorthwhileForTests()).toBe(false) // all live, no churn

    // Use the memories. 250 reinforce lines against 100 entries: most of the shard is now churn.
    for (let r = 0; r < 250; r++) memoryFeedback({ id: ids[r % ids.length], helpful: true })

    expect(_compactionMayBeWorthwhileForTests()).toBe(true) // NOW it is worth it — and it must say so
    const before = shardLines()
    const res = compactSelfShard()
    expect(res.compacted).toBe(true)
    expect(shardLines()).toBeLessThan(before) // the file really did shrink
  })

  it('compaction is LOSSLESS — every survivor is still there, and still readable', async () => {
    const ids: string[] = []
    for (let i = 0; i < 100; i++) ids.push((await write(`entry ${i}`)).id)
    for (const id of ids.slice(0, 20)) memoryDelete(id)
    for (let r = 0; r < 250; r++) memoryFeedback({ id: ids[80 + (r % 20)], helpful: true })

    const liveBefore = memoryList({ limit: 1000 }).map((e) => e.content).sort()
    expect(liveBefore.length).toBe(80) // 100 written, 20 deleted

    expect(compactSelfShard().compacted).toBe(true)

    const liveAfter = memoryList({ limit: 1000 }).map((e) => e.content).sort()
    expect(liveAfter).toEqual(liveBefore) // not one memory lost, not one resurrected
  })

  it('force: true still bypasses the gate entirely', async () => {
    for (let i = 0; i < 250; i++) await write(`live ${i}`)
    expect(_compactionMayBeWorthwhileForTests()).toBe(false)

    shardReads.count = 0
    compactSelfShard({ force: true })
    // Forced, it MUST do the real work — so it must read the file.
    expect(shardReads.count).toBeGreaterThan(0)
  })
})

describe('the counters stay honest across restarts', () => {
  it('a restart RECOUNTS the shard from disk rather than trusting a stale number', async () => {
    for (let i = 0; i < 10; i++) await write(`entry ${i}`)
    expect(_ownShardStateForTests().lines).toBe(10)

    initSwarmMemory(dir) // simulate an app restart against the same store
    expect(_ownShardStateForTests().lines).toBe(10) // recounted from the file, not remembered
    expect(_ownShardStateForTests().addIds).toBe(10)
  })

  it('a FRESH store starts at zero rather than inheriting the last one', async () => {
    for (let i = 0; i < 10; i++) await write(`entry ${i}`)
    const other = mkdtempSync(join(tmpdir(), 'cg2-'))
    try {
      // reloadFrom() does not run when the shard does not exist yet, so the reset has to happen in
      // initSwarmMemory itself — otherwise the gate would be answered from the PREVIOUS store's facts.
      initSwarmMemory(other)
      expect(_ownShardStateForTests()).toEqual({ lines: 0, addIds: 0 })
    } finally {
      try { rmSync(other, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
