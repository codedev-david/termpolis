import { describe, it, expect, afterEach } from 'vitest'
import { detectConflictsNli, makeNliContradicts, setNliScorer, getNliScorer, setNliConflictsEnabled, nliConflictsEnabled, _resetNliForTests } from '../../src/main/nliContradict'
import { sameSubject, heuristicContradicts, type AgentLesson } from '../../src/main/mnemeSociety'

afterEach(() => _resetNliForTests())

const L = (source: string, content: string): AgentLesson => ({ source, content })

describe('sameSubject prefilter', () => {
  it('is broader than the heuristic — same subject WITHOUT a negation flip', () => {
    const a = L('claude', 'Use Postgres for the sync store')
    const b = L('codex', 'Use MySQL for the sync store')
    expect(sameSubject(a, b, 0.5)).toBe(true) // both about the sync store
    expect(heuristicContradicts(a, b)).toBe(false) // no negation word → heuristic can't see it
  })
})

describe('detectConflictsNli', () => {
  const always = L('claude', 'Always run migrations before seeding')
  const never = L('codex', 'Never run migrations before seeding')

  it('defaults to the heuristic when NLI is disabled and no scorer is injected', async () => {
    expect(nliConflictsEnabled()).toBe(false)
    const conflicts = await detectConflictsNli([always, never])
    expect(conflicts).toHaveLength(1) // heuristic catches the negation flip
  })

  it('with an injected scorer, catches a same-subject contradiction the heuristic MISSES', async () => {
    const lessons = [
      L('claude', 'Use Postgres for the sync store'),
      L('codex', 'Use MySQL for the sync store'),
      L('gemini', 'Prefer tabs over spaces for indentation'), // unrelated → prefiltered out
    ]
    expect(await detectConflictsNli(lessons)).toHaveLength(0) // heuristic default finds nothing
    // fake NLI: high contradiction only for the DB pair
    const scorer = async (p: string, h: string) => (/postgres|mysql/i.test(p) && /postgres|mysql/i.test(h) ? 0.9 : 0.05)
    const conflicts = await detectConflictsNli(lessons, { scorer })
    expect(conflicts).toHaveLength(1)
    expect(`${conflicts[0].a.content} ${conflicts[0].b.content}`).toMatch(/postgres/i)
  })

  it('only NLI-confirms same-subject candidate pairs (prefilter bounds the model calls)', async () => {
    const calls: string[] = []
    const scorer = async (p: string, _h: string) => { calls.push(p); return 0.9 }
    const lessons = [
      L('claude', 'Use Postgres for the sync store'),
      L('codex', 'Use MySQL for the sync store'),
      L('gemini', 'Prefer tabs over spaces for indentation'),
    ]
    await detectConflictsNli(lessons, { scorer })
    // only the one same-subject pair is scored (2 calls — both directions), not all 3 pairs
    expect(calls.length).toBe(2)
  })
})

describe('makeNliContradicts', () => {
  it('takes the max over both directions vs the threshold', async () => {
    const asym = async (p: string, _h: string) => (p === 'A' ? 0.8 : 0.0) // only one direction high
    expect(await makeNliContradicts(asym, 0.6)(L('x', 'A'), L('y', 'B'))).toBe(true) // max(0.8,0) ≥ 0.6
    expect(await makeNliContradicts(asym, 0.9)(L('x', 'A'), L('y', 'B'))).toBe(false) // 0.8 < 0.9
  })
})

describe('scorer injection + enable toggle', () => {
  it('getNliScorer returns null by default (no model load attempted)', async () => {
    expect(await getNliScorer()).toBeNull()
  })
  it('returns the injected scorer once set', async () => {
    const s = async () => 0.5
    setNliScorer(s)
    expect(await getNliScorer()).toBe(s)
  })
  it('enable toggle is reflected', () => {
    setNliConflictsEnabled(true)
    expect(nliConflictsEnabled()).toBe(true)
  })
})
