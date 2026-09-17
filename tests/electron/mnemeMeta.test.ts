import { describe, it, expect } from 'vitest'
import {
  confidenceScore,
  updateCompetence,
  assessDomain,
  summarizeCompetence,
  describeCompetence,
  type CompetenceRecord,
} from '../../src/main/mnemeMeta'

// Build a CompetenceRecord with an explicitly-set confidence — the verdict/summary
// functions read the stored `confidence` field and are agnostic to how it was
// derived, so setting it directly keeps those tests independent of the Wilson math.
const rec = (
  domain: string,
  confidence: number,
  attempts: number,
  successes = Math.round(confidence * attempts),
): CompetenceRecord => ({ domain, confidence, attempts, successes, lastTs: 0 })

describe('mnemeMeta — metacognition / self-competence', () => {
  describe('confidenceScore — Wilson lower bound (~95%, z=1.96)', () => {
    it('is 0 when there are no attempts (and guards div-by-zero)', () => {
      expect(confidenceScore(0, 0)).toBe(0)
      expect(confidenceScore(5, 0)).toBe(0) // nonsensical input still short-circuits to 0
      expect(confidenceScore(1, -2)).toBe(0) // defensive: non-positive attempts → 0
    })

    it('is 0 for all failures (phat = 0), for any attempt count', () => {
      expect(confidenceScore(0, 4)).toBeCloseTo(0, 12)
      expect(confidenceScore(0, 25)).toBeCloseTo(0, 12)
    })

    it('is >0 but strictly <1 for all successes — never claims certainty', () => {
      const c1 = confidenceScore(1, 1)
      const c3 = confidenceScore(3, 3)
      const c10 = confidenceScore(10, 10)
      expect(c1).toBeGreaterThan(0)
      expect(c1).toBeLessThan(1)
      expect(c1).toBeCloseTo(1 / (1 + 1.96 * 1.96), 6) // 1/1 → ~0.2065
      expect(c3).toBeGreaterThan(c1) // more clean evidence → higher bound
      expect(c10).toBeGreaterThan(c3)
      expect(c10).toBeLessThan(1)
    })

    it('matches the hand-computed Wilson lower bound for a mixed record (1/4)', () => {
      expect(confidenceScore(1, 4)).toBeCloseTo(0.0456, 3)
    })

    it('is monotonic in successes at a fixed attempt count', () => {
      expect(confidenceScore(2, 4)).toBeGreaterThan(confidenceScore(1, 4))
      expect(confidenceScore(3, 4)).toBeGreaterThan(confidenceScore(2, 4))
      expect(confidenceScore(4, 4)).toBeGreaterThan(confidenceScore(3, 4))
    })

    it('rewards more evidence at the same success rate (a tighter lower bound)', () => {
      // identical 50% rate, growing evidence → strictly rising lower bound
      expect(confidenceScore(5, 10)).toBeGreaterThan(confidenceScore(1, 2))
      expect(confidenceScore(50, 100)).toBeGreaterThan(confidenceScore(5, 10))
    })

    it('stays within [0,1] and is bit-for-bit deterministic', () => {
      const cases: Array<[number, number]> = [[0, 1], [1, 3], [7, 9], [10, 10], [3, 8], [1, 4]]
      for (const [s, a] of cases) {
        const c = confidenceScore(s, a)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
        expect(confidenceScore(s, a)).toBe(c) // same inputs → identical result
      }
    })
  })

  describe('updateCompetence — fold one outcome (immutable)', () => {
    it('creates a fresh record from undefined on a first SUCCESS', () => {
      expect(updateCompetence(undefined, 'rust', true, 10)).toEqual({
        domain: 'rust',
        attempts: 1,
        successes: 1,
        lastTs: 10,
        confidence: confidenceScore(1, 1),
      })
    })

    it('creates a fresh record from undefined on a first FAILURE', () => {
      expect(updateCompetence(undefined, 'rust', false, 10)).toEqual({
        domain: 'rust',
        attempts: 1,
        successes: 0,
        lastTs: 10,
        confidence: confidenceScore(0, 1), // 0
      })
    })

    it('folds a SUCCESS onto an existing record and recomputes confidence', () => {
      const prev = rec('ts', confidenceScore(1, 2), 2, 1)
      const next = updateCompetence(prev, 'ts', true, 200)
      expect(next.attempts).toBe(3)
      expect(next.successes).toBe(2)
      expect(next.lastTs).toBe(200)
      expect(next.confidence).toBeCloseTo(confidenceScore(2, 3), 12)
    })

    it('folds a FAILURE onto an existing record (successes unchanged)', () => {
      const prev = updateCompetence(undefined, 'go', true, 1) // 1/1
      const next = updateCompetence(prev, 'go', false, 2) // → 1/2
      expect(next.attempts).toBe(2)
      expect(next.successes).toBe(1)
      expect(next.lastTs).toBe(2)
      expect(next.confidence).toBeCloseTo(confidenceScore(1, 2), 12)
    })

    it('does not mutate the previous record (append-only discipline)', () => {
      const prev = updateCompetence(undefined, 'py', true, 1)
      const snapshot = { ...prev }
      updateCompetence(prev, 'py', false, 2)
      expect(prev).toEqual(snapshot)
    })

    it('uses the injected `now` as lastTs (never a wall clock)', () => {
      expect(updateCompetence(undefined, 'x', true, 123456789).lastTs).toBe(123456789)
    })
  })

  describe('assessDomain — verdict on how well-founded a domain is', () => {
    it('returns unknown/zero for a domain with no record', () => {
      expect(assessDomain([], 'rust')).toEqual({
        known: false,
        confidence: 0,
        attempts: 0,
        verdict: 'unproven',
      })
      // present-but-different domain still misses
      expect(assessDomain([rec('go', 0.9, 10)], 'rust')).toEqual({
        known: false,
        confidence: 0,
        attempts: 0,
        verdict: 'unproven',
      })
    })

    it('is CONFIDENT once a real track record backs the rate', () => {
      // 20/25: the pessimistic edge of the interval is 0.609 — still comfortably above half.
      expect(assessDomain([rec('ts', 0.8, 25)], 'ts')).toEqual({
        known: true,
        confidence: 0.8,
        attempts: 25,
        verdict: 'confident',
      })
    })

    it('does NOT call a short promising streak a track record', () => {
      // 4/5 and 2/3 look good and prove nothing: the interval still reaches well below half, so
      // the honest answer is "not yet known", not "confident". Before v1.47 both read CONFIDENT
      // off five and three attempts respectively.
      expect(assessDomain([rec('ts', 0.8, 5)], 'ts').verdict).toBe('unproven')
      expect(assessDomain([rec('ts', 0.7, 3)], 'ts').verdict).toBe('unproven')
    })

    it('is CAUTION with enough attempts but a low bound (<0.5)', () => {
      expect(assessDomain([rec('rust', 0.2, 5)], 'rust')).toMatchObject({
        known: true,
        verdict: 'caution',
      })
    })

    it('is UNPROVEN with too few attempts, even at high confidence', () => {
      // confidence≥0.7 is true but attempts<3 fails the first clause; attempts<3
      // also fails the caution clause → unproven.
      expect(assessDomain([rec('go', 0.9, 2)], 'go').verdict).toBe('unproven')
    })

    it('is UNPROVEN in the middling band (0.5 ≤ confidence < 0.7) with enough attempts', () => {
      expect(assessDomain([rec('sql', 0.6, 5)], 'sql').verdict).toBe('unproven')
      // 0.5 is NOT caution (strict <0.5) and NOT confident (<0.7) → unproven boundary
      expect(assessDomain([rec('sql', 0.5, 5)], 'sql').verdict).toBe('unproven')
    })

    it('finds the right record when several domains are present', () => {
      const records = [rec('a', 0.1, 4), rec('b', 0.85, 9), rec('c', 0.6, 5)]
      expect(assessDomain(records, 'b').verdict).toBe('confident')
      expect(assessDomain(records, 'a').verdict).toBe('caution')
      expect(assessDomain(records, 'c').verdict).toBe('unproven')
    })
  })

  describe('summarizeCompetence — weakest-first primer digest', () => {
    it('returns "" for empty input', () => {
      expect(summarizeCompetence([])).toBe('')
    })

    it('returns "" when every domain is already competent (nothing to warn about)', () => {
      expect(summarizeCompetence([rec('ts', 0.85, 22, 20), rec('go', 0.72, 12, 11)])).toBe('')
    })

    it('formats one warning line per weak domain', () => {
      expect(summarizeCompetence([rec('rust', 0.05, 4, 1)])).toBe(
        '⚠ low competence in rust (1/4 succeeded)',
      )
    })

    it('orders weakest first: confidence ascending, then attempts descending on a tie', () => {
      const out = summarizeCompetence([
        rec('sql', 0.3, 4, 1), // same confidence as docker, fewer attempts → later
        rec('rust', 0.1, 3, 0), // lowest confidence → first
        rec('docker', 0.3, 8, 2), // tie on confidence, more attempts → before sql
      ])
      expect(out.split('\n')).toEqual([
        '⚠ low competence in rust (0/3 succeeded)',
        '⚠ low competence in docker (2/8 succeeded)',
        '⚠ low competence in sql (1/4 succeeded)',
      ])
    })

    it('excludes competent domains (confidence ≥ 0.5) from the list', () => {
      const out = summarizeCompetence([
        rec('typescript', 0.9, 22, 20), // strong → excluded
        rec('rust', 0.1, 4, 0), // weak → kept
      ])
      expect(out).toBe('⚠ low competence in rust (0/4 succeeded)')
    })

    it('never warns off a thin record — a 1/1 domain is too new to call weak', () => {
      // The bug this gate closes: the Wilson bound is deliberately conservative, so a
      // domain that has succeeded every time it was ever tried (1/1 → ~0.21) tripped the
      // <0.5 threshold and the primer opened with "⚠ low competence in termpolis
      // (1/1 succeeded)" — condemning a domain that had never once failed.
      expect(summarizeCompetence([rec('termpolis', confidenceScore(1, 1), 1, 1)])).toBe('')
      expect(summarizeCompetence([rec('termpolis', 0, 1, 0)])).toBe('') // one failure is just as thin
      expect(summarizeCompetence([rec('termpolis', 0.1, 2, 0)])).toBe('') // 2 < MIN_EVIDENCE
    })

    it('still warns once weakness is actually evidenced (3/10)', () => {
      expect(summarizeCompetence([rec('termpolis', confidenceScore(3, 10), 10, 3)])).toBe(
        '⚠ low competence in termpolis (3/10 succeeded)',
      )
    })

    it('warns at exactly MIN_EVIDENCE attempts (3, inclusive — same gate as assessDomain)', () => {
      expect(summarizeCompetence([rec('deploy', 0.1, 3, 0)])).toBe(
        '⚠ low competence in deploy (0/3 succeeded)',
      )
    })

    it('a thin record never displaces a well-evidenced one, however low its bound', () => {
      // Ordering is weakest-first, so an ungated 0-confidence single-attempt record would
      // sort ABOVE a genuinely weak domain and eat the only slot at limit 1.
      const out = summarizeCompetence([rec('new-thing', 0, 1, 0), rec('rust', 0.1, 9, 1)], 1)
      expect(out).toBe('⚠ low competence in rust (1/9 succeeded)')
    })

    it('respects a custom limit, keeping the WEAKEST domains', () => {
      const out = summarizeCompetence(
        [rec('a', 0.1, 3, 0), rec('b', 0.2, 3, 1), rec('c', 0.3, 3, 1), rec('d', 0.4, 3, 1)],
        2,
      )
      expect(out.split('\n')).toEqual([
        '⚠ low competence in a (0/3 succeeded)',
        '⚠ low competence in b (1/3 succeeded)',
      ])
    })

    it('defaults the limit to 3', () => {
      const out = summarizeCompetence([
        rec('a', 0.1, 3, 0),
        rec('b', 0.2, 3, 1),
        rec('c', 0.3, 3, 1),
        rec('d', 0.4, 3, 1),
      ])
      expect(out.split('\n')).toHaveLength(3)
      expect(out).not.toContain('in d')
    })

    it('coerces a non-positive limit to an empty digest', () => {
      expect(summarizeCompetence([rec('a', 0.1, 3, 0)], 0)).toBe('')
      expect(summarizeCompetence([rec('a', 0.1, 3, 0)], -5)).toBe('')
    })

    it('does not mutate the input array', () => {
      const records = [rec('b', 0.4, 3, 1), rec('a', 0.1, 3, 0)]
      const order = records.map((r) => r.domain)
      summarizeCompetence(records)
      expect(records.map((r) => r.domain)).toEqual(order)
    })
  })

  describe('integration — folds compose into assessments', () => {
    it('a success streak folds up to a CONFIDENT assessment', () => {
      let r: CompetenceRecord | undefined
      for (let i = 0; i < 12; i++) r = updateCompetence(r, 'ts', true, i)
      expect(r!.attempts).toBe(12)
      expect(r!.successes).toBe(12)
      expect(r!.confidence).toBeGreaterThanOrEqual(0.7)
      expect(assessDomain([r!], 'ts').verdict).toBe('confident')
    })

    it('a failure streak folds down to a CAUTION assessment and surfaces in the digest', () => {
      let r: CompetenceRecord | undefined
      for (let i = 0; i < 5; i++) r = updateCompetence(r, 'rust', false, i)
      expect(r!.confidence).toBe(0)
      expect(assessDomain([r!], 'rust').verdict).toBe('caution')
      expect(summarizeCompetence([r!])).toBe('⚠ low competence in rust (0/5 succeeded)')
    })
  })

// ── Calibration ────────────────────────────────────────────────────────────────────────────
// The Wilson LOWER bound is the right tool for ranking under uncertainty and the wrong number to
// show a user as "confidence". Through v1.46 the verdict thresholded that single edge, so:
//
//   * a spotless 3/3 scored 0.438 and was reported as "⚠ low competence in <x> (3/3 succeeded)" —
//     a flawless record rendered as a weakness, which is the one thing a self-assessment must
//     never do, because the agent then distrusts the area it is actually good at;
//   * 4/5 and 7/10 also read "caution"; you needed TEN flawless runs to clear "confident".
//
// A wide interval means WE DO NOT KNOW YET — that is `unproven`. `caution` has to mean "the
// evidence says this goes badly", which is a statement about the UPPER bound, not the lower one.
describe('calibration — thin evidence reads unproven, never incompetent', () => {
  it('never calls a spotless record low competence', () => {
    const rec = { domain: 'mesh', attempts: 3, successes: 3, lastTs: 1, confidence: confidenceScore(3, 3) }
    expect(assessDomain([rec], 'mesh').verdict).not.toBe('caution')
    expect(summarizeCompetence([rec])).toBe('')
  })

  it('reads a thin perfect record as unproven — not yet proven, not bad', () => {
    const rec = { domain: 'mesh', attempts: 3, successes: 3, lastTs: 1, confidence: confidenceScore(3, 3) }
    expect(assessDomain([rec], 'mesh').verdict).toBe('unproven')
  })

  it('reports the observed success RATE as confidence, not the interval edge', () => {
    // "How often has this worked?" is what a reader takes `confidence` to mean.
    const rec = { domain: 'mesh', attempts: 4, successes: 3, lastTs: 1, confidence: confidenceScore(3, 4) }
    expect(assessDomain([rec], 'mesh').confidence).toBeCloseTo(0.75, 5)
  })

  it('still says CAUTION when the evidence genuinely says this goes badly', () => {
    const rec = { domain: 'flaky', attempts: 12, successes: 2, lastTs: 1, confidence: confidenceScore(2, 12) }
    const a = assessDomain([rec], 'flaky')
    expect(a.verdict).toBe('caution')
    expect(summarizeCompetence([rec])).toContain('flaky')
  })

  it('does not call a long mediocre record unproven — enough evidence settles it', () => {
    const rec = { domain: 'mid', attempts: 40, successes: 28, lastTs: 1, confidence: confidenceScore(28, 40) }
    // 70% over 40 attempts is a real, known track record — it is neither a warning nor a mystery.
    expect(assessDomain([rec], 'mid').verdict).toBe('confident')
  })

  it('keeps a no-evidence domain at unproven with zero confidence', () => {
    expect(assessDomain([], 'never-seen')).toEqual({ known: false, confidence: 0, attempts: 0, verdict: 'unproven' })
  })

  it('surfaces only genuinely weak domains in the digest, worst first', () => {
    const recs = [
      { domain: 'good', attempts: 30, successes: 29, lastTs: 1, confidence: confidenceScore(29, 30) },
      { domain: 'bad', attempts: 10, successes: 1, lastTs: 1, confidence: confidenceScore(1, 10) },
      { domain: 'meh', attempts: 10, successes: 4, lastTs: 1, confidence: confidenceScore(4, 10) },
    ]
    const out = summarizeCompetence(recs)
    expect(out).not.toContain('good')
    expect(out.indexOf('bad')).toBeLessThan(out.indexOf('meh'))
  })
})

// memory_selfcheck asks "how reliable have you been at X?" and through v1.46 answered with the
// fleet-wide warnings digest — so asking about `termpolis` could come back "⚠ low competence in
// mesh (3/3 succeeded)": a warning about a DIFFERENT domain, and a false one. An answer about
// something you did not ask about trains the reader to skip the answer.
describe('describeCompetence — the summary answers about the domain you ASKED about', () => {
  const recs = [
    { domain: 'mesh', attempts: 3, successes: 3, lastTs: 1, confidence: 0 },
    { domain: 'flaky', attempts: 12, successes: 2, lastTs: 1, confidence: 0 },
    { domain: 'termpolis', attempts: 30, successes: 28, lastTs: 1, confidence: 0 },
  ]

  it('never mentions a domain other than the one asked about', () => {
    expect(describeCompetence(recs, 'termpolis')).not.toContain('mesh')
    expect(describeCompetence(recs, 'termpolis')).not.toContain('flaky')
    expect(describeCompetence(recs, 'termpolis')).toContain('termpolis')
  })

  it('says a proven domain is proven, with the evidence behind it', () => {
    const out = describeCompetence(recs, 'termpolis')
    expect(out).toContain('28/30')
    expect(out).not.toContain('⚠')
  })

  it('warns on a genuinely weak domain', () => {
    const out = describeCompetence(recs, 'flaky')
    expect(out).toContain('⚠')
    expect(out).toContain('2/12')
  })

  it('calls thin evidence unproven rather than either praising or warning', () => {
    const out = describeCompetence(recs, 'mesh')
    expect(out).not.toContain('⚠')
    expect(out).toContain('3/3')
    expect(out.toLowerCase()).toContain('unproven')
  })

  it('says so plainly when there is no record at all', () => {
    const out = describeCompetence(recs, 'brand-new')
    expect(out).toContain('brand-new')
    expect(out.toLowerCase()).toContain('no track record')
  })
})
})
