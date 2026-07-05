// F1 / F10 / F23 — clear-epoch, tombstone durability, and clock-skew hardening.
// The audit found that (F1) an unbounded clearedBefore epoch from a mis-clocked or
// corrupt peer permanently wipes the whole brain everywhere; (F10) deletes/clears
// live only in the originating shard, so losing/lagging that shard resurrects
// everything; (F23) scoping clear by wall-clock ts makes it both under-delete
// (stale survives) and over-delete (fresh local writes vanish) under normal skew.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryClear,
  reloadMemoryFromSync,
  _resetForTests,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

let userDir: string
let syncDir: string

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cd-user-'))
  syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cd-sync-'))
  _resetForTests()
  _setEmbedFnForTests(async () => null)
})
afterEach(() => {
  _resetForTests()
  for (const d of [userDir, syncDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const dropShard = (name: string, lines: object[]): void =>
  fs.writeFileSync(path.join(syncDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

describe('F1: a poison clearedBefore epoch cannot wipe the brain', () => {
  it('rejects an absurd far-future clearedBefore from a peer shard', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'keep me safe' })
    // A dead-CMOS / corrupt peer emits a year-2100 clear epoch.
    dropShard('evil.jsonl', [{ clearedBefore: 4102444800000 }])
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'keep me safe')).toBe(true)
  })

  it('still honors a legitimate recent clearedBefore', async () => {
    initSwarmMemory(userDir, { syncDir })
    // an entry that predates a legit clear
    dropShard('peer.jsonl', [{ id: 'old1', ts: 1000, agentId: 'x', kind: 'fact', content: 'ancient', hash: 'h1' }])
    dropShard('clear.jsonl', [{ clearedBefore: Date.now() }])
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'ancient')).toBe(false)
  })
})

const wipeSyncFolder = (): void => { for (const f of fs.readdirSync(syncDir)) fs.rmSync(path.join(syncDir, f), { recursive: true, force: true }) }

describe('F10: deletes/clears are durable against losing the originating shard', () => {
  it('cleared content stays cleared when the clear-bearing shard is gone and a peer re-supplies it', async () => {
    initSwarmMemory(userDir, { syncDir })
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'purge me', ts: 1000 })
    memoryClear()
    expect(memoryList().some((e) => e.content === 'purge me')).toBe(false)
    // The shard that recorded the clear is decommissioned/removed, then a peer that
    // still had the entry syncs it back. Only a device-local floor can suppress it now.
    wipeSyncFolder()
    dropShard('peer.jsonl', [{ id: w.id, ts: 1000, agentId: 'a', kind: 'fact', content: 'purge me', hash: w.hash }])
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'purge me')).toBe(false)
  })

  it('a delete survives losing the deleter shard + a full re-init (device-local floor)', async () => {
    initSwarmMemory(userDir, { syncDir })
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'delete durably', ts: 2000 })
    const { memoryDelete } = await import('../../src/main/swarmMemory')
    memoryDelete(w.id)
    // Lose the deleter's shard (which held the tombstone); a peer still carries the entry.
    wipeSyncFolder()
    dropShard('peer.jsonl', [{ id: w.id, ts: 2000, agentId: 'a', kind: 'fact', content: 'delete durably', hash: w.hash }])
    _setEmbedFnForTests(async () => null)
    initSwarmMemory(userDir, { syncDir }) // fresh process simulation
    expect(memoryList().some((e) => e.content === 'delete durably')).toBe(false)
  })
})

describe('F23: clear is skew-proof (no under-delete, no over-delete)', () => {
  it('over-delete: a future peer clear epoch does not wipe this device\'s own newer writes', async () => {
    initSwarmMemory(userDir, { syncDir })
    // A peer issued a clear at a wall-clock AHEAD of this (slow) device, within tolerance.
    const futureEpoch = Date.now() + 60_000
    dropShard('peer.jsonl', [{ clearedBefore: futureEpoch }])
    // This device writes genuinely NEW content whose ts is below the peer's epoch (slow clock).
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'my fresh work', ts: Date.now() - 1000 })
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.content === 'my fresh work')).toBe(true)
  })

  it('under-delete: clear removes a known peer entry by identity even with a future ts', async () => {
    initSwarmMemory(userDir, { syncDir })
    // A fast-clock peer entry (future ts) already synced in.
    dropShard('peer.jsonl', [{ id: 'pf', ts: Date.now() + 120_000, agentId: 'x', kind: 'fact', content: 'fast-clock peer fact', hash: 'hpf' }])
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.id === 'pf')).toBe(true)
    memoryClear() // identity clear: tombstones all currently-known live ids, incl. pf
    reloadMemoryFromSync()
    expect(memoryList().some((e) => e.id === 'pf')).toBe(false)
  })

  it('still drops prior entries and keeps newer writes (original contract)', async () => {
    initSwarmMemory(userDir, { syncDir })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'old' })
    memoryClear()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'new' })
    reloadMemoryFromSync()
    const contents = memoryList().map((e) => e.content)
    expect(contents).toContain('new')
    expect(contents).not.toContain('old')
  })
})
