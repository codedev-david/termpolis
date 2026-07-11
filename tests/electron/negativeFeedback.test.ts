// WP-C — close the learning loop. Before this, memory_feedback(helpful=false) was a hard no-op and
// learnedUtility clamped useCount to >=0, so a memory that kept getting marked unhelpful could never
// be demoted or suppressed — a positive-only, half-open loop. These tests pin the closed loop:
// negative feedback (a) demotes ranking, (b) is a CRDT-safe delta that survives reload, and (c) a
// strongly-downvoted memory is suppressed from recall (recoverable, not deleted).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryFeedback,
  memorySearch,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { learnedUtility } from '../../src/main/mnemeRetrieval'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('learnedUtility — negative feedback penalty (WP-C)', () => {
  it('demotes a net-negative useCount below the no-feedback baseline, capped, never below zero base', () => {
    const now = 0
    const base = { id: 'x', relevance: 0.5, importance: 0, useCount: 0 }
    const down = { ...base, useCount: -5 }
    const up = { ...base, useCount: 5 }
    // negative < baseline < positive
    expect(learnedUtility(down, now)).toBeLessThan(learnedUtility(base, now))
    expect(learnedUtility(base, now)).toBeLessThan(learnedUtility(up, now))
    // relevance-gate contract preserved: zero relevance ⇒ zero utility even when downvoted
    expect(learnedUtility({ ...down, relevance: 0 }, now)).toBe(0)
    // penalty is capped — a huge negative never drives utility to/below zero
    expect(learnedUtility({ ...base, useCount: -100 }, now)).toBeGreaterThan(0)
  })
})

describe('memoryFeedback — negative signal (WP-C)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-'))
    _resetForTests()
    _setEmbeddingsAvailable(false) // deterministic keyword/BM25 path, no model needed
    initSwarmMemory(tmp)
  })
  afterEach(() => {
    _resetForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('helpful=false decrements the usage counter (was a no-op) and the negative delta survives reload', async () => {
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the deploy script lives in the release folder' })
    memoryFeedback({ id: e.id, helpful: false })
    memoryFeedback({ id: e.id, helpful: false })
    const r = memoryFeedback({ id: e.id, helpful: false })
    expect(r.used).toBe(-3)
    // survives reload via CRDT delta replay
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp)
    const r2 = memoryFeedback({ id: e.id, helpful: true }) // +1 onto the replayed -3 → -2
    expect(r2.used).toBe(-2)
  })

  it('suppresses a strongly-downvoted memory from recall, while a downvote or two does not', async () => {
    const good = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha bravo charlie delta echo' })
    const mild = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha bravo charlie delta golf' })
    const bad = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha bravo charlie delta foxtrot' })
    memoryFeedback({ id: mild.id, helpful: false }) // -1: still recallable
    for (let i = 0; i < 5; i++) memoryFeedback({ id: bad.id, helpful: false }) // -5: suppressed

    const ids = (await memorySearch({ query: 'alpha bravo charlie delta', limit: 10 })).map((h) => h.id)
    expect(ids).toContain(good.id)
    expect(ids).toContain(mild.id) // a light downvote does NOT remove it
    expect(ids).not.toContain(bad.id) // strong negative → suppressed (recoverable, not deleted)
  })
})
