import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryLink,
  memoryFeedback,
  consolidationCandidates,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

// P2 store integration: the consolidation candidate snapshot correctly carries
// edge-presence + usage so the "sleep" pass can protect curated/connected/used
// memories and only forget cold noise.
describe('Mneme P2 — consolidationCandidates snapshot', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-p2-'))
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('maps entries to candidates with edges, usage, type, importance, and tags', async () => {
    const a = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'alpha lesson', memoryType: 'semantic', importance: 0.8, tags: ['keep'] })
    const b = await memoryWrite({ agentId: 'm', kind: 'note', content: 'beta plain note' })
    memoryLink({ from: a.id, to: b.id, relation: 'relates-to', weight: 0.9 })
    memoryFeedback({ id: a.id, helpful: true })

    const cands = consolidationCandidates(100)
    const ca = cands.find((c) => c.id === a.id)!
    const cb = cands.find((c) => c.id === b.id)!

    expect(ca).toBeDefined()
    expect(cb).toBeDefined()
    expect(ca.hasEdges).toBe(true) // linked → protected from decay
    expect(cb.hasEdges).toBe(true)
    expect(ca.useCount).toBeGreaterThan(0) // reinforced → protected
    expect(ca.memoryType).toBe('semantic')
    expect(ca.importance).toBe(0.8)
    expect(ca.tags).toEqual(['keep'])
  })

  it('respects the limit and returns the oldest entries first', async () => {
    for (let i = 0; i < 5; i++) await memoryWrite({ agentId: 'm', kind: 'note', content: `note ${i}` })
    const cands = consolidationCandidates(3)
    expect(cands).toHaveLength(3)
    expect(cands[0].content).toBe('note 0') // oldest first
  })
})
