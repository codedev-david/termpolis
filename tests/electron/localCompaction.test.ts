// Tier-2 — compact the LOCAL store. The audit found compactSelfShard no-op'd without a syncDir, so a
// non-syncing user's swarm-memory.jsonl grows one line per write/edit/delete/reinforce forever. Now
// it compacts the local store down to its live CRDT contribution too — but SAFELY: only when nothing
// has been evicted beyond the 500k hot window (else on-disk overflow would be dropped).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryDelete,
  memoryFeedback,
  memoryList,
  compactSelfShard,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('local store compaction (Tier-2)', () => {
  let tmp: string
  const storeFile = () => path.join(tmp, 'swarm-memory.jsonl')
  const lineCount = () => fs.readFileSync(storeFile(), 'utf8').split('\n').filter((l) => l.trim()).length

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'))
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp) // local-only (no syncDir)
  })
  afterEach(() => {
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('compacts the local log to its live contribution and converges on reload (no sync)', async () => {
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha one keep me' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'bravo two delete me' }).then((b) => memoryDelete(b.id))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'charlie three keep me' })
    memoryFeedback({ id: a.id, helpful: true }) // reinforce deltas → dead lines to coalesce
    memoryFeedback({ id: a.id, helpful: true })

    const before = lineCount() // add,add,delete,add,reinforce,reinforce ...
    const res = compactSelfShard({ force: true })
    expect(res.compacted).toBe(true)
    expect(res.after).toBeLessThan(before) // redundant/dead lines removed
    expect(lineCount()).toBe(res.after)

    // Reload from the compacted file → converges to the exact live set (deleted stays deleted).
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp)
    const contents = memoryList().map((e) => e.content)
    expect(contents).toContain('alpha one keep me')
    expect(contents).toContain('charlie three keep me')
    expect(contents).not.toContain('bravo two delete me') // tombstone preserved through compaction
  })
})
