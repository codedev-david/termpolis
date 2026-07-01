import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

// P4 integration: a typed memory's `importance` gives it a capped ranking boost,
// so a high-importance lesson outranks an equally-relevant low-importance one.
describe('Mneme P4 — learned utility boosts high-importance memories in search', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-p4-'))
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false) // keyword mode: equal-structure content → equal base relevance
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('ranks a high-importance lesson above an equally-relevant low-importance one', async () => {
    // Same length + same single query-term → equal keyword relevance; importance decides.
    const hi = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'widget fix alpha', memoryType: 'procedural', importance: 0.9 })
    const lo = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'widget fix beta', importance: 0.1 })

    const res = await memorySearch({ query: 'widget', limit: 5 })
    const ids = res.map((r) => r.id)
    expect(ids).toContain(hi.id)
    expect(ids).toContain(lo.id)
    expect(res[0].id).toBe(hi.id) // higher importance wins on equal relevance
  })

  it('does not disturb ranking when no importance is set (backward compatible)', async () => {
    const a = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'alpha topic note about caching' })
    await memoryWrite({ agentId: 'm', kind: 'fact', content: 'unrelated content entirely' })
    const res = await memorySearch({ query: 'caching topic', limit: 5 })
    expect(res[0].id).toBe(a.id) // the relevant one still wins; no importance field in play
  })
})
