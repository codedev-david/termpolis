// F3 — turning cross-machine sync OFF must not silently discard the reinforcement
// (usage) learning layer, and its snapshot must be atomic + abort on failure rather
// than dropping the user onto a stale/empty local store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryFeedback,
  setSyncDir,
  getSyncStatus,
  _resetForTests,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-off-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-off-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  vi.restoreAllMocks()
  for (const d of [userDir, syncDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('F3: sync-off preserves the reinforcement learning layer', () => {
  it('carries usage (reinforcement) counts through the sync-off snapshot', async () => {
    initSwarmMemory(userDir, { syncDir })
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'repeatedly-helpful fact' })
    memoryFeedback({ id: w.id, helpful: true })
    memoryFeedback({ id: w.id, helpful: true }) // usage = 2
    setSyncDir(null) // snapshot to local, re-init local-only
    expect(getSyncStatus().syncing).toBe(false)
    expect(memoryList().some((e) => e.content === 'repeatedly-helpful fact')).toBe(true)
    // WP-C: helpful=false now DECREMENTS, so probe with a +1 instead — the two reinforcements
    // survived the snapshot iff a positive feedback now reads 3.
    expect(memoryFeedback({ id: w.id, helpful: true }).used).toBe(3)
  })
})

describe('F3: the sync-off snapshot is atomic and aborts on failure', () => {
  it('leaves sync ON (no data loss) when the snapshot cannot be written', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'synced-content-must-survive' })
    // Block the snapshot's temp path so the atomic write fails.
    const legacy = path.join(userDir, 'swarm-memory.jsonl')
    fs.mkdirSync(legacy + '.tmp')
    expect(() => setSyncDir(null)).toThrow()
    // The switch aborted: still syncing, content intact — the user was NOT dropped onto a stale store.
    expect(getSyncStatus().syncing).toBe(true)
    expect(memoryList().some((e) => e.content === 'synced-content-must-survive')).toBe(true)
    fs.rmSync(legacy + '.tmp', { recursive: true, force: true })
  })
})
