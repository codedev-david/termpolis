// F5 / F6 / F26 / F27 / F28 — append + init durability.
//  F5  init failure must NOT null memPath for the whole session (silent write-loss);
//      fall back to a writable local store instead.
//  F6  a swallowed append failure must be observable (durable:false) and must not
//      poison the dedup guard (so a retry can actually persist).
//  F26 high-value writes (decision/fact/result) are fsync'd; bulk chunks are not.
//  F27 a torn (newline-less) final line from a crash must not swallow the NEXT write.
//  F28 corrupt shard lines are counted + surfaced, not silently dropped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockRecordSwarmError = vi.fn()
vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: (...a: any[]) => mockRecordSwarmError(...a) }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  getSyncStatus,
  reloadMemoryFromSync,
  _resetForTests,
  _setEmbedFnForTests,
  _fsyncCountForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-dur-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-dur-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
  mockRecordSwarmError.mockReset()
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('F5: init failure falls back to a writable local store', () => {
  it('does not silently discard the whole session when the sync folder is unusable', async () => {
    // The sync path already exists as a FILE, so mkdirSync(recursive) throws → init fails.
    const badSync = path.join(userDir, 'sync-is-a-file')
    fs.writeFileSync(badSync, 'not a directory')
    initSwarmMemory(userDir, { syncDir: badSync })
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'must persist somewhere' })
    expect(w.id).toBeTruthy()
    expect(getSyncStatus().degraded).toBe(true)
    // It actually reached disk: a fresh local init finds it.
    _resetForTests(); _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir)
    expect(memoryList().some((e) => e.content === 'must persist somewhere')).toBe(true)
  })
})

describe('F6: a swallowed append failure is surfaced and retryable', () => {
  it('returns durable:false and does not hash-guard a write that never reached disk', async () => {
    initSwarmMemory(userDir)
    // Real disk-level failure: replace the shard file with a directory so the append throws.
    const p = path.join(userDir, 'swarm-memory.jsonl')
    fs.rmSync(p, { force: true })
    fs.mkdirSync(p)
    const w = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'chose Postgres over Mongo' })
    expect(w.durable).toBe(false)
    // Undo the failure; because the failed write was NOT dedup-guarded, an identical retry persists.
    fs.rmSync(p, { recursive: true, force: true })
    const w2 = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'chose Postgres over Mongo' })
    expect(w2.durable).not.toBe(false)
    _resetForTests(); _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir)
    expect(memoryList().some((e) => e.content === 'chose Postgres over Mongo')).toBe(true)
  })
})

describe('F26: high-value writes are fsync-durable', () => {
  it('fsyncs a decision but not a bulk message chunk', async () => {
    initSwarmMemory(userDir)
    const before = _fsyncCountForTests()
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'durable decision' })
    expect(_fsyncCountForTests()).toBeGreaterThan(before)
    const afterDecision = _fsyncCountForTests()
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'bulk chunk', hash: 'hb' })
    expect(_fsyncCountForTests()).toBe(afterDecision) // bulk chunk not fsync'd
  })
})

describe('F27: a torn final line does not swallow the next good write', () => {
  it('repairs the JSONL frame on init', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'first', ts: 1 })
    // Simulate a crash mid-append: the file ends WITHOUT a newline, mid-record.
    const p = path.join(userDir, 'swarm-memory.jsonl')
    fs.appendFileSync(p, '{"id":"torn","content":"partial')
    _resetForTests(); _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir) // must repair the trailing frame
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'second after crash', ts: 2 })
    _resetForTests(); _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir)
    const contents = memoryList().map((e) => e.content)
    expect(contents).toContain('first')
    expect(contents).toContain('second after crash') // NOT concatenated onto the torn line
  })
})

describe('F28: corrupt shard lines are counted, not silently dropped', () => {
  it('surfaces corruptLinesSkipped and records telemetry', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'good one' })
    // A peer shard with a torn/corrupt line followed by a valid one.
    fs.writeFileSync(
      path.join(syncDir, 'corrupt.jsonl'),
      '{"id":"torn","content":"oops\n{"id":"ok","content":"fine","ts":5,"agentId":"x","kind":"fact","hash":"hok"}\n',
    )
    mockRecordSwarmError.mockReset()
    reloadMemoryFromSync()
    expect(getSyncStatus().corruptLinesSkipped).toBeGreaterThan(0)
    expect(memoryList().some((e) => e.content === 'fine')).toBe(true) // the good line still loads
    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      expect.stringContaining('corrupt'), expect.anything(), expect.anything(),
    )
  })
})
