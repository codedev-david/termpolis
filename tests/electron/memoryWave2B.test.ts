// Wave 2 batch B — a cleared / consolidation-forgotten / evicted memory must not silently
// repopulate from the on-disk transcripts (memoryHasHash is the anti-re-ingest guard).
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
  memoryHasHash,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
} from '../../src/main/swarmMemory'

let userDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-w2b-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('memory-clear-undone-by-reingest', () => {
  it('clear remembers the cleared content hashes so re-ingest skips them', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'a conversation chunk', hash: 'chunkhash1' })
    expect(memoryHasHash('chunkhash1')).toBe(true)
    memoryClear()
    expect(memoryHasHash('chunkhash1')).toBe(true) // still "known" → the indexer won't re-ingest & repopulate
  })
})

describe('consolidation-forget-resurrected', () => {
  it('a deleted (sleep-forgotten) content hash is not re-ingested', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    const w = await memoryWrite({ agentId: 'a', kind: 'message', content: 'a cold chunk to forget', hash: 'coldhash1' })
    memoryDelete(w.id)
    expect(memoryHasHash('coldhash1')).toBe(true) // content-tombstone counts as known → no resurrection flap
  })
})

describe('eviction-reingest-dup', () => {
  it('an evicted hash stays known so it does not re-ingest and thrash the window', async () => {
    initSwarmMemory(userDir)
    _setMaxEntriesForTests(2)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'oldest', hash: 'e1' })
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'mid', hash: 'e2' })
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'newest', hash: 'e3' }) // evicts e1
    expect(memoryHasHash('e1')).toBe(true)
  })
})
