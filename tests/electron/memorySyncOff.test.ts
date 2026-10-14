// Decision 5 — turning cross-machine sync OFF must never write the local brain file.
//
// v1 "snapshotted" the merged union OVER swarm-memory.jsonl on the way out (F3 then made that
// snapshot carry usage counts and abort on a failed write). But the file it replaced is this
// computer's own log, encrypted under the DEVICE key — and the snapshot was written under whatever key
// sync happened to be using, or in plaintext. Turning sync off now simply reopens the local log as it
// was left; memories written while syncing stay in the folder's shard, where nothing removes them.
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
const localFile = (): string => path.join(userDir, 'swarm-memory.jsonl')

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

describe('Decision 5: sync-off leaves the local brain file exactly as it was', () => {
  it('the local log is byte-identical after a sync session, and its memories (and usage) are back', async () => {
    // A local brain with history, including a reinforcement.
    initSwarmMemory(userDir)
    const local = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a local memory from before sync' })
    memoryFeedback({ id: local.id, helpful: true })
    const before = fs.readFileSync(localFile())

    // A sync session that writes and reinforces things of its own...
    setSyncDir(syncDir)
    expect(getSyncStatus().syncing).toBe(true)
    const synced = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'written while syncing' })
    memoryFeedback({ id: synced.id, helpful: true })

    // ...and off again: the local file was never written.
    setSyncDir(null)
    expect(getSyncStatus().syncing).toBe(false)
    expect(fs.readFileSync(localFile()).equals(before)).toBe(true)
    expect(memoryList().map((e) => e.content)).toEqual(['a local memory from before sync'])
    // The local usage count is the local log's own (1), not a snapshot's: +1 now reads 2.
    expect(memoryFeedback({ id: local.id, helpful: true }).used).toBe(2)
    // What was written while syncing is still in the folder.
    const shard = fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl')) as string
    expect(fs.readFileSync(path.join(syncDir, shard), 'utf8')).toContain('written while syncing')
  })

  it('a local file that cannot be written does not matter any more — nothing is written to it', async () => {
    // F3 aborted the switch when its snapshot failed. With no snapshot there is nothing to fail: a
    // blocked temp path beside the local file is simply irrelevant to turning sync off.
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'synced-content-must-survive' })
    fs.mkdirSync(localFile() + '.tmp')
    expect(setSyncDir(null).syncing).toBe(false)
    expect(fs.existsSync(localFile() + '.tmp')).toBe(true)
    fs.rmSync(localFile() + '.tmp', { recursive: true, force: true })
  })

  it('turning sync off when it is already off is a no-op: no re-init, no write', async () => {
    initSwarmMemory(userDir)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'untouched' })
    const before = fs.readFileSync(localFile())
    const mtime = fs.statSync(localFile()).mtimeMs
    expect(setSyncDir(null)).toMatchObject({ syncing: false, count: 1 })
    expect(fs.readFileSync(localFile()).equals(before)).toBe(true)
    expect(fs.statSync(localFile()).mtimeMs).toBe(mtime)
    expect(fs.existsSync(path.join(userDir, 'memory-sync.json'))).toBe(false) // not even the config
  })
})
