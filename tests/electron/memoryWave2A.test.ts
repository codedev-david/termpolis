// Wave 2 batch A — swarmMemory clear/delete/cache/ts hardening.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryClear,
  memoryDelete,
  memoryLink,
  reloadMemoryFromSync,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
} from '../../src/main/swarmMemory'
import { graphStats } from '../../src/main/memoryGraph'

let userDir: string
let syncDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-w2a-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-w2a-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})
const dropShard = (name: string, lines: object[]): void =>
  fs.writeFileSync(path.join(syncDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

describe('searchcache-stale-on-clear-and-reload', () => {
  it('does not serve pre-clear results from the 5-minute search cache', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a cached secret alpha' })
    expect((await memorySearch({ query: 'cached secret alpha' })).length).toBe(1)
    memoryClear()
    expect((await memorySearch({ query: 'cached secret alpha' })).length).toBe(0)
  })
})

describe('clear-doesnt-reset-graph', () => {
  it('memoryClear resets the knowledge graph too', async () => {
    initSwarmMemory(userDir)
    memoryLink({ from: 'a', to: 'b', relation: 'relates-to' })
    expect(graphStats().edges).toBeGreaterThan(0)
    memoryClear()
    expect(graphStats().edges).toBe(0)
  })
})

describe('graph-edges-dangle-after-delete', () => {
  it('deleting a memory prunes its incident graph edges', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    const a = await memoryWrite({ agentId: 'x', kind: 'decision', content: 'decision A' })
    const b = await memoryWrite({ agentId: 'x', kind: 'decision', content: 'decision B' })
    memoryLink({ from: a.id, to: b.id, relation: 'relates-to' })
    expect(graphStats().edges).toBeGreaterThan(0)
    memoryDelete(b.id)
    expect(graphStats().edges).toBe(0)
  })
})

describe('hnsw-stale-graph-after-delete', () => {
  it('memoryDelete invalidates the HNSW graph', async () => {
    _setHnswThresholdForTests(3)
    _setHnswYieldMsForTests(8)
    let k = 0
    const oneHot = (): number[] => { const v = new Array(384).fill(0); v[k++ % 384] = 1; return v }
    _setEmbedFnForTests(async () => oneHot())
    initSwarmMemory(userDir)
    _setEmbedFnForTests(async () => oneHot())
    const ids: string[] = []
    for (let i = 0; i < 5; i++) { const w = await memoryWrite({ agentId: 'a', kind: 'note', content: `distinct entry ${i}` }); ids.push(w.id) }
    await memorySearch({ query: 'distinct entry' })
    await _whenHnswSettledForTests()
    expect(_isHnswReadyForTests()).toBe(true)
    memoryDelete(ids[0])
    expect(_isHnswReadyForTests()).toBe(false)
  })
})

describe('future-dated-ts-immune-to-decay', () => {
  it('clamps a far-future peer entry ts on merge', async () => {
    initSwarmMemory(userDir, { syncDir })
    const future = Date.now() + 10 * 365 * 86_400_000 // 10 years ahead
    dropShard('peer.jsonl', [{ id: 'f1', ts: future, agentId: 'x', kind: 'fact', content: 'far future entry', hash: 'hf1' }])
    reloadMemoryFromSync()
    const e = memoryList().find((x) => x.id === 'f1')
    expect(e).toBeTruthy()
    expect(e!.ts).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000 + 1000) // clamped to ~now + MAX_CLOCK_SKEW
  })
})

describe('diversify-false-no-relevance-floor', () => {
  it('applies the 0.25 relevance floor on the non-diversify path', async () => {
    initSwarmMemory(userDir)
    const q = (): number[] => { const v = new Array(384).fill(0); v[0] = 1; return v }
    const noise = (): number[] => { const v = new Array(384).fill(0); v[0] = 0.05; v[1] = Math.sqrt(1 - 0.0025); return v }
    const strong = (): number[] => { const v = new Array(384).fill(0); v[0] = 0.9; v[1] = Math.sqrt(1 - 0.81); return v }
    _setEmbedFnForTests(async (t: string) => (t.startsWith('QQ') ? q() : t.includes('strong') ? strong() : noise()))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the strong relevant hit' })
    for (let i = 0; i < 6; i++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `some faraway chatter ${i}` })
    const res = await memorySearch({ query: 'QQ find it', limit: 10 }) // non-diversify
    expect(res.length).toBeLessThanOrEqual(3)             // floored, not all 7 returned
    expect(res.some((r) => r.content.includes('strong'))).toBe(true)
  })
})
