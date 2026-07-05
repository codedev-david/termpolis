// F12 / F13 / F22 / F34 / F35 — anti-re-derivation contract (anticipate/pool), delete-twin,
// HNSW build-vs-reload race, and per-install device identity.
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
  memoryDelete,
  memoryLessons,
  getSyncStatus,
  reloadMemoryFromSync,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string
beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-tail-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-tail-sync-'))
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

describe('F13: memory_pool draws from the full lesson set, not the newest rows', () => {
  it('finds a lesson buried under hundreds of newer message chunks', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'always run migrations before seeding', memoryType: 'procedural', ts: 1000 })
    for (let i = 0; i < 250; i++) await memoryWrite({ agentId: 'a', kind: 'message', content: `bulk message ${i}`, ts: 2000 + i })
    const lessons = memoryLessons(200)
    expect(lessons.some((l) => l.content.includes('migrations before seeding'))).toBe(true)
  })
})

describe('F12: memory_anticipate over-fetches before filtering to lessons', () => {
  it('surfaces a procedural lesson that ranks below the naive top-5', async () => {
    initSwarmMemory(userDir)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'fix ELIFECYCLE by clearing the node_modules cache', memoryType: 'procedural' })
    for (let i = 0; i < 12; i++) await memoryWrite({ agentId: 'a', kind: 'message', content: `npm run build ELIFECYCLE error log line ${i}` })
    // The handler fetches limit*8 then filters+slices; replicate that here.
    const overFetched = (await memorySearch({ query: 'npm run build ELIFECYCLE', limit: 40 }))
      .filter((h) => h.memoryType === 'procedural' || (h.importance ?? 0) >= 0.6)
      .slice(0, 5)
    expect(overFetched.some((h) => h.content.includes('clearing the node_modules'))).toBe(true)
  })
})

describe('F22: deleting de-duplicated content kills the twin', () => {
  it('a deleted memory does not resurface via its content-hash twin', async () => {
    initSwarmMemory(userDir, { syncDir })
    dropShard('a.jsonl', [{ id: 'idA', ts: 1, agentId: 'x', kind: 'fact', content: 'the same fact twice', hash: 'twinhash' }])
    dropShard('b.jsonl', [{ id: 'idB', ts: 2, agentId: 'x', kind: 'fact', content: 'the same fact twice', hash: 'twinhash' }])
    reloadMemoryFromSync()
    expect(memoryList().filter((e) => e.content === 'the same fact twice')).toHaveLength(1) // deduped to one
    const survivor = memoryList().find((e) => e.content === 'the same fact twice')!
    memoryDelete(survivor.id)
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'the same fact twice')).toBe(false) // twin stays dead
  })
})

describe('F34: a reload during an HNSW build does not corrupt search', () => {
  it('aborts the in-flight build and still serves correct results', async () => {
    _setHnswThresholdForTests(3)
    _setHnswYieldMsForTests(0) // force the async, yielded build path
    let k = 0
    const oneHot = (): number[] => { const v = new Array(384).fill(0); v[k++ % 384] = 1; return v }
    _setEmbedFnForTests(async () => oneHot())
    initSwarmMemory(userDir, { syncDir })
    _setEmbedFnForTests(async () => oneHot())
    for (let i = 0; i < 6; i++) await memoryWrite({ agentId: 'a', kind: 'note', content: `distinct entry number ${i}` })
    const searching = memorySearch({ query: 'distinct entry' }) // kicks a background build
    reloadMemoryFromSync() // swaps the store under the build → it must abort, not persist a mis-wired graph
    await _whenHnswSettledForTests()
    await searching
    const res = await memorySearch({ query: 'distinct entry' })
    expect(res.length).toBeGreaterThan(0) // no crash, results still served
  })
})

describe('F35: device identity is per-install, not per-file', () => {
  it('regenerates the id when the device-id file was restored onto another machine (fp mismatch)', () => {
    fs.writeFileSync(path.join(userDir, 'device-id'), JSON.stringify({ id: 'clonedid00000000', fp: 'a-different-machine-fingerprint' }))
    initSwarmMemory(userDir, { syncDir })
    const id = getSyncStatus().deviceId
    expect(id).not.toBe('clonedid00000000')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('adopts the id on the same machine across relaunches', () => {
    initSwarmMemory(userDir, { syncDir })
    const id1 = getSyncStatus().deviceId
    _resetForTests(); _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir, { syncDir })
    expect(getSyncStatus().deviceId).toBe(id1)
  })

  it('upgrades a legacy bare-string device-id and keeps it', () => {
    fs.writeFileSync(path.join(userDir, 'device-id'), 'legacybare000000')
    initSwarmMemory(userDir, { syncDir })
    expect(getSyncStatus().deviceId).toBe('legacybare000000')
  })
})
