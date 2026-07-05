import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// P0 anchor bug: `ts` must be the CONVERSATION time (from the transcript), not the
// ingestion wall-clock. Old re-ingested transcripts were ranking as "most recent"
// because the ingest writer dropped chunk.startTs/endTs and memoryList used
// insertion order. These tests pin the whole chain: ingest → store → list/search.

const mockRecordSwarmError = vi.fn()
vi.mock('../../src/main/telemetry', () => ({
  recordSwarmError: (...args: any[]) => mockRecordSwarmError(...args),
}))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryHasHash,
  memoryLink,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { runConversationIngest } from '../../src/main/conversationIngest'
import { getAllEdges, addMemoryEdge } from '../../src/main/memoryGraph'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-time-test-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false)
  mockRecordSwarmError.mockReset()
})

afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.restoreAllMocks()
})

const OLD_TS = Date.UTC(2020, 2, 15, 10, 0, 0)
const NEW_TS = Date.UTC(2026, 0, 1, 10, 0, 0)

describe('P0: memoryList orders by conversation ts, not insertion order', () => {
  it('returns the newer-conversation entry first even when it was inserted first', async () => {
    // Insert NEW first, then OLD (backdated re-ingest). Insertion order would put OLD last;
    // ts order must put NEW first.
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'newer conversation note', ts: NEW_TS })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'older conversation note', ts: OLD_TS })
    const list = memoryList({ limit: 10 })
    expect(list[0].content).toBe('newer conversation note')
    expect(list[1].content).toBe('older conversation note')
  })
})

describe('P0: runConversationIngest threads conversation time into the store', () => {
  it('passes ts (chunk.endTs) to memory.write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-time-transcript-'))
    try {
      const sub = path.join(dir, 'proj')
      fs.mkdirSync(sub)
      const oldIso = new Date(OLD_TS).toISOString()
      const transcript = [
        JSON.stringify({ sessionId: 's1', cwd: '/repo/foo', type: 'user', timestamp: oldIso, message: { role: 'user', content: 'a question from the past' } }),
        JSON.stringify({ type: 'assistant', timestamp: oldIso, message: { content: [{ type: 'text', text: 'an answer from the past' }] } }),
      ].join('\n')
      fs.writeFileSync(path.join(sub, 'session.jsonl'), transcript)

      const captured: Array<{ ts?: number }> = []
      await runConversationIngest(
        {
          hasHash: () => false,
          write: async (input) => { captured.push(input); return { id: 'e1' } },
        },
        { roots: { claude: dir }, sources: ['claude'] },
      )
      expect(captured.length).toBeGreaterThan(0)
      expect(captured[0].ts).toBe(OLD_TS)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('the fully-ingested entry ranks by its real (old) conversation time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-time-transcript2-'))
    try {
      const sub = path.join(dir, 'proj')
      fs.mkdirSync(sub)
      const oldIso = new Date(OLD_TS).toISOString()
      const transcript = [
        JSON.stringify({ sessionId: 's2', cwd: '/repo/foo', type: 'user', timestamp: oldIso, message: { role: 'user', content: 'ancient context here' } }),
      ].join('\n')
      fs.writeFileSync(path.join(sub, 'session.jsonl'), transcript)

      // A brand-new (present-day) memory written directly.
      await memoryWrite({ agentId: 'a', kind: 'note', content: 'fresh present-day note', ts: NEW_TS })
      // Then re-ingest an OLD transcript (its wall-clock "now" is later, but its ts is old).
      await runConversationIngest(
        { hasHash: memoryHasHash, write: (input) => memoryWrite(input as any), link: memoryLink as any },
        { roots: { claude: dir }, sources: ['claude'] },
      )
      const list = memoryList({ limit: 10 })
      // The fresh note must lead; the old re-ingested transcript must NOT masquerade as newest.
      expect(list[0].content).toBe('fresh present-day note')
      const ingested = list.find((e) => e.content.includes('ancient context here'))
      expect(ingested).toBeTruthy()
      expect(ingested!.ts).toBe(OLD_TS)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })
})

describe('P0 sibling: graph edges carry conversation ts, not ingest time', () => {
  it('addMemoryEdge honors an explicit ts and defaults to now', () => {
    const withTs = addMemoryEdge({ from: 'a', to: 'b', ts: OLD_TS })
    expect(withTs?.ts).toBe(OLD_TS)
    const before = Date.now()
    const noTs = addMemoryEdge({ from: 'c', to: 'd' })
    expect(noTs!.ts).toBeGreaterThanOrEqual(before)
  })

  it('auto-linked edges from a backdated write carry the write ts', async () => {
    // Deterministic identical vectors so the two decisions auto-link.
    const vec = new Array(384).fill(0)
    vec[0] = 1
    _setEmbedFnForTests(async () => vec)
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'we chose approach X for the old task', ts: OLD_TS })
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'we also chose Y for the old task', ts: OLD_TS })
    _setEmbedFnForTests(null)
    const edges = getAllEdges()
    expect(edges.length).toBeGreaterThan(0)
    for (const e of edges) expect(e.ts).toBe(OLD_TS)
  })
})
