import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memoryDelete,
  consolidationCandidates,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { runConsolidation } from '../../src/main/mnemeConsolidateRun'

const DAY = 86_400_000

// End-to-end proof that the consolidation "sleep" ACTUALLY forgets real cold noise
// from the store (previously only the planner + snapshot were tested, because entry
// timestamps couldn't be backdated). Uses the new WriteInput.ts backdate seam.
describe('Mneme P2 — consolidation forgets real cold entries but protects the rest', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-forget-'))
    _resetForTests()
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('forgets an old cold episodic entry, keeps curated / tagged / recent ones', async () => {
    const now = Date.now()
    const cold = await memoryWrite({ agentId: 'm', kind: 'message', content: 'old cold transcript noise nobody needs', ts: now - 30 * DAY })
    const curated = await memoryWrite({ agentId: 'm', kind: 'fact', content: 'a curated durable lesson', memoryType: 'procedural', importance: 0.9, tags: ['keep'], ts: now - 30 * DAY })
    const recent = await memoryWrite({ agentId: 'm', kind: 'message', content: 'fresh transcript line just now', ts: now - 1000 })

    const res = runConsolidation({
      candidates: () => consolidationCandidates(500),
      simOf: () => 0, // decay-only, matching the scheduled pass
      forget: (id) => memoryDelete(id),
      now,
    })

    expect(res.decayedCold).toBeGreaterThan(0)
    const remaining = memoryList({ limit: 50 }).map((m) => m.id)
    expect(remaining).not.toContain(cold.id) // cold + old + untagged + edge-free → forgotten
    expect(remaining).toContain(curated.id) // tagged + high-importance + procedural → protected
    expect(remaining).toContain(recent.id) // < 14d old → protected
  })
})
