import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onTaskComplete } from '../../src/main/mnemeReflex'
import { distillEpisode } from '../../src/main/mnemeReflect'
import { runConsolidation } from '../../src/main/mnemeConsolidateRun'
import {
  initSwarmMemory,
  memoryWrite,
  memoryList,
  memorySearch,
  memoryDelete,
  consolidationCandidates,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { initCompetence, recordOutcome, assessCompetence, _resetCompetenceForTests } from '../../src/main/mnemeCompetence'

const DAY = 86_400_000

// The whole learning loop holding together, end to end, against the real store:
// reflect several completed tasks -> grounded lessons + competence; a "sleep" pass
// forgets cold noise but keeps the lessons; retrieval still recalls them.
describe('Mneme — full-loop interaction (reflect + consolidate + recall)', () => {
  let tmp: string
  const deps = () => ({
    distill: (ep: Parameters<typeof distillEpisode>[0]) => distillEpisode(ep),
    write: (i: Parameters<typeof memoryWrite>[0]) => memoryWrite(i),
    recordOutcome,
    now: Date.now(),
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-interaction-'))
    _resetForTests()
    _resetCompetenceForTests()
    initSwarmMemory(tmp)
    initCompetence(tmp)
    _setEmbeddingsAvailable(false)
  })
  afterEach(() => {
    _resetForTests()
    _resetCompetenceForTests()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reflects lessons, forgets cold noise, and still recalls the lessons', async () => {
    const episodes = [
      { id: 't1', title: 'handle the timeout', result: 'Error: requests kept failing with ETIMEDOUT. Fixed by adding a retry in client.ts. Tests pass now.' },
      { id: 't2', title: 'fix the model load', result: 'Error: cannot find module bge during load. Fixed by bundling the model in package.json. Tests pass now.' },
      { id: 't3', title: 'stop the crash', result: 'Error: null pointer dereference in the store. Fixed by adding a null guard in store.ts. Tests pass now.' },
    ]
    for (const e of episodes) {
      const res = await onTaskComplete({ id: e.id, status: 'completed', project: 'termpolis', title: e.title, result: e.result }, deps())
      expect(res.fired).toBe(true)
    }

    // Cold orphan transcript noise that the sleep pass should sweep.
    await memoryWrite({ agentId: 'm', kind: 'message', content: 'ancient orphan transcript noise nobody needs', ts: Date.now() - 40 * DAY })

    // Three lessons grounded; competence recorded three times.
    expect(memoryList({ limit: 200 }).filter((m) => m.memoryType === 'procedural').length).toBeGreaterThanOrEqual(3)
    expect(assessCompetence('termpolis').attempts).toBe(3)

    // Sleep.
    const swept = runConsolidation({ candidates: () => consolidationCandidates(500), simOf: () => 0, forget: memoryDelete, now: Date.now() })
    expect(swept.decayedCold).toBeGreaterThan(0)

    // Noise gone; every lesson kept.
    const after = memoryList({ limit: 200 })
    expect(after.some((m) => m.content.includes('ancient orphan'))).toBe(false)
    expect(after.filter((m) => m.memoryType === 'procedural').length).toBeGreaterThanOrEqual(3)

    // And retrieval still recalls a specific lesson by its content.
    const hits = await memorySearch({ query: 'ETIMEDOUT retry client', limit: 5 })
    expect(hits.some((h) => h.memoryType === 'procedural' && h.originEpisode === 't1')).toBe(true)
  })
})
