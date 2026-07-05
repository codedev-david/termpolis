// Next-rung: shard compaction — the riskiest item, so it gets a strict lossless round-trip
// proof plus its safety guards (threshold-gated, aborts on unreadable lines).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryDelete,
  memoryClear,
  memoryFeedback,
  memoryList,
  memoryHasHash,
  compactSelfShard,
  getSyncStatus,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cmp-u-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cmp-s-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

const shardPath = () => path.join(syncDir, `${getSyncStatus().deviceId}.jsonl`)

describe('compactSelfShard', () => {
  it('is a LOSSLESS round-trip — live entries, content, deletions, and usage all survive', async () => {
    initSwarmMemory(userDir, { syncDir })
    _setEmbeddingsAvailable(false)
    const a = await memoryWrite({ agentId: 'x', kind: 'note', content: 'alpha content', hash: 'ha' })
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'bravo content', hash: 'hb' })
    const c = await memoryWrite({ agentId: 'x', kind: 'note', content: 'charlie content', hash: 'hc' })
    memoryFeedback({ id: a.id })
    memoryFeedback({ id: a.id })
    memoryFeedback({ id: a.id }) // usage(a) = 3
    const b = memoryList().find((e) => e.content === 'bravo content')!
    memoryDelete(b.id) // b removed; its add line is now dead weight

    const res = compactSelfShard({ force: true })
    expect(res.compacted).toBe(true)
    expect(res.after).toBeLessThan(res.before) // dead lines dropped

    // live set is exactly {a, c}; b stays deleted (and hash-tombstoned)
    expect(memoryList().map((e) => e.id).sort()).toEqual([a.id, c.id].sort())
    expect(memoryList().find((e) => e.id === a.id)?.content).toBe('alpha content')
    expect(memoryList().some((e) => e.id === b.id)).toBe(false)
    expect(memoryHasHash('hb')).toBe(true) // deletion durable across the rewrite

    // usage survived: the next bump continues from 3 → 4 (not reset)
    expect(memoryFeedback({ id: a.id }).used).toBe(4)
  })

  it('preserves a clear epoch across compaction (pre-clear stays gone, post-clear survives)', async () => {
    initSwarmMemory(userDir, { syncDir })
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'pre-clear', ts: 1000 })
    memoryClear() // writes clearedBefore + clearedIds; drops everything so far
    const keep = await memoryWrite({ agentId: 'x', kind: 'note', content: 'post-clear' })
    const res = compactSelfShard({ force: true })
    expect(res.compacted).toBe(true)
    expect(memoryList().map((e) => e.content)).toEqual(['post-clear']) // clear survived the rewrite
    expect(memoryList().some((e) => e.id === keep.id)).toBe(true)
  })

  it('does not compact a small / mostly-live shard unless forced', async () => {
    initSwarmMemory(userDir, { syncDir })
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'one' })
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'two' })
    const res = compactSelfShard() // below the min-lines / dead-ratio threshold
    expect(res.compacted).toBe(false)
    expect(memoryList()).toHaveLength(2) // untouched
  })

  it('ABORTS (no rewrite) when a shard line is unreadable — never drops unaccounted data', async () => {
    initSwarmMemory(userDir, { syncDir })
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'keep me' })
    fs.appendFileSync(shardPath(), 'this is not valid json {{{\n') // a torn/corrupt line
    const res = compactSelfShard({ force: true })
    expect(res.compacted).toBe(false) // refused to rewrite over the corrupt line
    expect(memoryList().some((e) => e.content === 'keep me')).toBe(true)
  })

  it('is a no-op when cross-machine sync is off (no own shard to compact)', () => {
    initSwarmMemory(userDir) // local-only, no syncDir
    expect(compactSelfShard({ force: true }).compacted).toBe(false)
  })
})
