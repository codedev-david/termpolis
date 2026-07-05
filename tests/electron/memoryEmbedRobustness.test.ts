// F8 / F18 — the semantic brain must recover from a transient embed hiccup and must
// not permanently split the store into first-class (vector) and second-class
// (keyword-only) memories.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _vectorStoreSizeForTests,
} from '../../src/main/swarmMemory'
import { _setBackendForTests, _resetEmbedderForTests } from '../../src/main/localEmbedder'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-embed-rob-'))
  _resetForTests()
  _resetEmbedderForTests()
  initSwarmMemory(tmpDir)
})
afterEach(() => {
  _resetForTests()
  _resetEmbedderForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('F8: a transient embed failure does not latch embeddings off for the session', () => {
  it('recovers on the next write instead of falling to keyword-only forever', async () => {
    _setEmbedFnForTests(null) // use the REAL embedText path so the availability latch applies
    _setEmbeddingsAvailable(null)
    let calls = 0
    const vec = new Array(384).fill(0)
    vec[2] = 1
    // A loaded backend that hiccups (null) on the FIRST call, then works.
    _setBackendForTests(async (texts: string[]) => texts.map(() => (++calls === 1 ? (null as unknown as number[]) : vec)))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'first write hits the hiccup' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'second write after recovery' })
    // If embeddings had latched off permanently, the store would hold ZERO vectors.
    expect(_vectorStoreSizeForTests()).toBeGreaterThanOrEqual(1)
  })
})

describe('F18: entries written while the embedder was down are backfilled', () => {
  it('embeds a vector-less entry on a later dedup-hit re-write', async () => {
    _setEmbeddingsAvailable(false) // embedder down
    const w1 = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'paraphrasable target about widgets' })
    expect(_vectorStoreSizeForTests()).toBe(0) // stored with no packed vector

    // Embedder recovers.
    const vec = new Array(384).fill(0)
    vec[7] = 1
    _setEmbedFnForTests(async () => vec)
    _setEmbeddingsAvailable(null)

    const w2 = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'paraphrasable target about widgets' })
    expect(w2.id).toBe(w1.id)                  // dedup hit (same content)
    expect(_vectorStoreSizeForTests()).toBe(1) // vector backfilled onto the existing entry
  })
})
