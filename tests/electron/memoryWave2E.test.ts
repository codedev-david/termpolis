// Wave 2 batch E — HNSW filtered recall. The underrecall/freshness defects only bite on a
// >50k-entry store (past hnswThreshold) or a narrow build-vs-write race, which a unit test
// can't reproduce; this guards that a project-filtered search over a BUILT graph still returns
// its in-scope hits (exercising the new filtered exact-fallback path) and doesn't regress.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  _resetForTests,
  _setEmbedFnForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
} from '../../src/main/swarmMemory'

let userDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-w2e-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('hnsw-filtered-underrecall', () => {
  it('a project-filtered search over a built HNSW graph returns its in-scope hits', async () => {
    _setHnswThresholdForTests(3)
    _setHnswYieldMsForTests(8)
    const vec = new Array(384).fill(0); vec[0] = 1 // all entries + query share a vector (cosine 1)
    _setEmbedFnForTests(async () => vec)
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => vec)
    for (let i = 0; i < 6; i++) await memoryWrite({ agentId: 'a', kind: 'note', content: `an aaa note ${i}`, project: '/repo/aaa' })
    const b1 = await memoryWrite({ agentId: 'a', kind: 'note', content: 'a bbb note one', project: '/repo/bbb' })
    await memorySearch({ query: 'warm the graph' }) // triggers the background build
    await _whenHnswSettledForTests()
    expect(_isHnswReadyForTests()).toBe(true)
    const res = await memorySearch({ query: 'find the bbb note', project: '/repo/bbb', limit: 10 })
    expect(res.some((r) => r.id === b1.id)).toBe(true) // in-scope hit returned (filter-exhaustive fallback)
    expect(res.every((r) => r.project === 'bbb')).toBe(true) // and nothing out of scope leaked in
  })
})
