// mnemeSupersede: which newer memory replaces which older one. Pure: the cosine is handed in.
import { describe, it, expect } from 'vitest'
import {
  isSupersedable,
  supersedeReason,
  planSupersessions,
  RESTATE_COS,
  CONTRADICT_COS,
  EXPLICIT_COS,
  type SupersedeEntry,
} from '../../src/main/mnemeSupersede'
import { CANDIDATE_TAG } from '../../src/main/lessonSubstance'

let n = 0
const mem = (content: string, ts: number, over: Partial<SupersedeEntry> = {}): SupersedeEntry =>
  ({ id: `m${++n}`, ts, kind: 'decision', content, projectKey: 'p', ...over })

describe('isSupersedable', () => {
  it('takes agent-written decisions, facts and notes, and distilled lessons', () => {
    expect(isSupersedable(mem('x', 1))).toBe(true)
    expect(isSupersedable(mem('x', 1, { kind: 'fact' }))).toBe(true)
    expect(isSupersedable(mem('x', 1, { kind: 'note' }))).toBe(true)
    expect(isSupersedable(mem('x', 1, { memoryType: 'semantic', source: 'reflect' }))).toBe(true)
    expect(isSupersedable(mem('x', 1, { memoryType: 'procedural', source: 'reflect' }))).toBe(true)
  })

  it('leaves transcripts, ingested notes, code, entity stubs, summaries and held-back candidates alone', () => {
    expect(isSupersedable(mem('x', 1, { kind: 'message' }))).toBe(false)
    expect(isSupersedable(mem('x', 1, { kind: 'result' }))).toBe(false)
    expect(isSupersedable(mem('x', 1, { source: 'claude-notes:abc' }))).toBe(false)
    expect(isSupersedable(mem('x', 1, { memoryType: 'entity' }))).toBe(false)
    expect(isSupersedable(mem('x', 1, { memoryType: 'summary' }))).toBe(false)
    expect(isSupersedable(mem('x', 1, { memoryType: 'episodic' }))).toBe(false)
    expect(isSupersedable(mem('x', 1, { memoryType: 'semantic', tags: [CANDIDATE_TAG] }))).toBe(false)
  })
})

describe('supersedeReason', () => {
  const older = mem('Use Postgres for the session store database', 1000)

  it('restated: nearly the same text about the same subject', () => {
    const newer = mem('Use Postgres for the session store database layer', 2000)
    expect(supersedeReason(newer, older, RESTATE_COS)).toBe('restated')
    expect(supersedeReason(newer, older, RESTATE_COS - 0.01)).toBeNull()
  })

  it('restated never joins two facts that pin different versions, but does when they share one', () => {
    const a = mem('Release v1.54 shipped the model switcher feature', 1000)
    expect(supersedeReason(mem('Release v1.55 shipped the model switcher feature', 2000), a, 0.99)).toBeNull()
    expect(supersedeReason(mem('Release 1.54 shipped the model switcher feature today', 2000), a, 0.99)).toBe('restated')
    // Only one side pins a version: no guard.
    expect(supersedeReason(mem('Release shipped the model switcher feature', 2000), a, 0.99)).toBe('restated')
  })

  it('contradicts: the texts differ only by negation, and exactly one side is negated', () => {
    const neg = mem('Do not use Postgres for the session store database', 2000)
    expect(supersedeReason(neg, older, CONTRADICT_COS)).toBe('contradicts')
    expect(supersedeReason(neg, older, CONTRADICT_COS - 0.01)).toBeNull()
    expect(supersedeReason(mem("Don't use Postgres for the session store database", 2000), older, 0.9)).toBe('contradicts')
    expect(supersedeReason(mem('Always run migrations before seeding', 2000), mem('Never run migrations before seeding', 1000), 0.9)).toBe('contradicts')
  })

  it('contradicts never fires on a changed verb or object, on both sides negated, or on identical text', () => {
    // From the review: "after" and "without" are different statements, not one negating the other.
    expect(supersedeReason(mem('The signing step runs without the Defender scan gate', 2000), mem('The signing step runs after the Defender scan gate', 1000), 0.9)).toBeNull()
    expect(supersedeReason(mem('Never use Postgres for the cache', 2000), mem('Do not use Postgres for the cache', 1000), 0.9)).toBeNull()
    expect(supersedeReason(mem('Do not use Postgres here', 2000), mem('Do not use Postgres here', 1000), 0.9)).toBeNull()
  })

  it('two memories carrying different numbers are two records, for every reason', () => {
    // Tickets, dates and PR numbers, not only dotted versions (measured cosines 0.94-0.996 on bge).
    expect(supersedeReason(mem('Ticket 68672: VPN drops every hour on the office wifi', 2000), mem('Ticket 68671: VPN drops every hour on the office wifi', 1000), 0.996)).toBeNull()
    expect(supersedeReason(mem('Incident 2026-11-02: EDR alert on the build agent', 2000), mem('Incident 2026-10-09: EDR alert on the build agent', 1000), 0.996)).toBeNull()
    expect(supersedeReason(mem('Electron 43 does not crash on macOS 13 when the window opens', 2000), mem('Electron 43 crashes on macOS 12 when the window opens', 1000), 0.95)).toBeNull()
    expect(supersedeReason(mem('v1.55: the proxy is not enabled by default', 2000), mem('v1.54: the proxy is enabled by default', 1000), 0.95)).toBeNull()
    expect(supersedeReason(mem('PR #36 now uses the new signing step', 2000), mem('PR 34 used the old signing step', 1000), 0.95)).toBeNull()
    // The same numbers on both sides do not block, and neither does a number on one side only.
    expect(supersedeReason(mem('Ticket 68671: do not restart the VPN service', 2000), mem('Ticket 68671: restart the VPN service', 1000), 0.9)).toBe('contradicts')
    expect(supersedeReason(mem('Two counts: 3 and 4 differ', 2000), mem('Two counts: 3 differ', 1000), 0.99)).toBeNull()
  })

  it('explicit: the newer one says it replaces something and is close', () => {
    expect(supersedeReason(mem('Session store now uses Redis', 2000), older, EXPLICIT_COS)).toBe('explicit')
    expect(supersedeReason(mem('Session store now uses Redis', 2000), older, EXPLICIT_COS - 0.01)).toBeNull()
    expect(supersedeReason(mem('Session store runs on Redis', 2000), older, 0.9)).toBeNull() // no marker
  })

  it('never across projects, never older-over-newer, never itself, never with an ineligible side', () => {
    const newer = mem('Use Postgres for the session store database layer', 2000)
    expect(supersedeReason({ ...newer, projectKey: 'q' }, older, 1)).toBeNull()
    expect(supersedeReason(older, newer, 1)).toBeNull()
    expect(supersedeReason({ ...newer, ts: older.ts }, older, 1)).toBeNull()
    expect(supersedeReason(older, older, 1)).toBeNull()
    expect(supersedeReason({ ...newer, kind: 'message' }, older, 1)).toBeNull()
    expect(supersedeReason(newer, { ...older, source: 'transcript:x' }, 1)).toBeNull()
    // A memory with no project never takes part: unscoped writes from every repo would share one group.
    expect(supersedeReason({ ...newer, projectKey: undefined }, { ...older, projectKey: undefined }, 1)).toBeNull()
    expect(supersedeReason({ ...newer, projectKey: '' }, { ...older, projectKey: '' }, 1)).toBeNull()
  })
})

describe('planSupersessions', () => {
  it('draws newer → older edges within a project, newest fresh first, skipping missing vectors', () => {
    const o1 = mem('Use Postgres for the session store database', 1000)
    const o2 = mem('Use Postgres for the session store database here', 1500)
    const nw = mem('Use Postgres for the session store database layer', 2000)
    const other = mem('Use Postgres for the session store database layer', 1200, { projectKey: 'q' })
    const novec = mem('Use Postgres for the session store database again', 500)
    const cos = (a: string, b: string): number | null => (a === novec.id || b === novec.id ? null : 0.99)
    const edges = planSupersessions([o2, nw], [o1, o2, nw, other, novec], cos)
    expect(edges).toEqual([
      { from: nw.id, to: o1.id, reason: 'restated' },
      { from: nw.id, to: o2.id, reason: 'restated' },
      { from: o2.id, to: o1.id, reason: 'restated' },
    ])
  })

  it('stops at max and skips an older memory that is already replaced', () => {
    const o1 = mem('Use Postgres for the session store database', 1000)
    const o2 = mem('Use Postgres for the session store database here', 1500)
    const nw = mem('Use Postgres for the session store database layer', 2000)
    expect(planSupersessions([nw], [o1, o2, nw], () => 0.99, { max: 1 })).toHaveLength(1)
    expect(planSupersessions([nw], [o1, o2, nw], () => 0.99, { alreadySuperseded: (id) => id === o1.id }))
      .toEqual([{ from: nw.id, to: o2.id, reason: 'restated' }])
  })

  it('skips a released pair and any memory without a project', () => {
    const o1 = mem('Use Postgres for the session store database', 1000)
    const o2 = mem('Use Postgres for the session store database here', 1500, { projectKey: undefined })
    const nw = mem('Use Postgres for the session store database layer', 2000)
    expect(planSupersessions([nw], [o1, o2, nw], () => 0.99, { released: (a, b) => a === nw.id && b === o1.id })).toEqual([])
    expect(planSupersessions([{ ...nw, projectKey: undefined }], [o1, o2, nw], () => 0.99)).toEqual([])
  })

  it('ignores ineligible fresh entries and ineligible pool entries', () => {
    const o1 = mem('Use Postgres for the session store database', 1000, { kind: 'message' })
    const nw = mem('Use Postgres for the session store database layer', 2000, { memoryType: 'entity' })
    const ok = mem('Use Postgres for the session store database layer two', 3000)
    expect(planSupersessions([nw, ok], [o1, nw, ok], () => 0.99)).toEqual([])
  })
})
