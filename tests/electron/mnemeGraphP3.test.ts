import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryLink,
  memoryGraphQuery,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

// P3 integration into the live graph query: causal/solution edges outrank generic
// links, and memories a later one supersedes are dropped from results.
describe('Mneme P3 — causal ranking + supersession in memoryGraphQuery', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-p3-'))
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('ranks a causal (solves) edge above a generic (relates-to) edge and drops superseded nodes', async () => {
    const a = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'seed problem with the widget loader' })
    const b = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'the fix that solved the widget loader' })
    const c = await memoryWrite({ agentId: 'm', kind: 'note', content: 'a loosely related widget note' })
    const d = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'an old widget fix that was replaced' })

    memoryLink({ from: a.id, to: b.id, relation: 'solves', weight: 0.9 })
    memoryLink({ from: a.id, to: c.id, relation: 'relates-to', weight: 0.9 })
    memoryLink({ from: a.id, to: d.id, relation: 'relates-to', weight: 0.9 })
    memoryLink({ from: d.id, to: a.id, relation: 'superseded-by', weight: 0.5 }) // d is superseded

    const res = await memoryGraphQuery({ id: a.id })
    const ids = res.map((r) => r.id)

    expect(ids).toContain(b.id)
    expect(ids).toContain(c.id)
    expect(ids).not.toContain(d.id) // superseded → filtered out
    // causal 'solves' beats generic 'relates-to'
    expect(res.findIndex((r) => r.id === b.id)).toBeLessThan(res.findIndex((r) => r.id === c.id))
  })
})
