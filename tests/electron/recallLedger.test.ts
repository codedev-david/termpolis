import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteRecall,
  claimRecalled,
  resetRecallLedger,
  RECALL_WINDOW_MS,
  MAX_ATTRIBUTED,
} from '../../src/main/recallLedger'

// Termpolis has had both halves of outcome-grounded learning since v1.28 and they have never been
// connected:
//
//   * outcome detection is live — a red test run reaches recordWorkOutcome, which folds it into
//     the per-domain competence record;
//   * memory demotion is live — memoryFeedback moves a memory's usage counter and suppresses it
//     at -3.
//
// Nothing joined them, because nothing remembered WHICH memories were recalled into the work that
// then failed. Feedback was therefore entirely manual: an agent had to notice a memory was bad and
// call memory_feedback on it, which in practice never happens. The brain could not learn from being
// wrong — only from being told it was wrong.
//
// This ledger is that join. It is deliberately session-scoped and in-memory: an outcome lands
// within minutes of the recall that informed it, and a durable store would invite attributing a
// test failure to a recall from last Tuesday.

beforeEach(() => resetRecallLedger())

describe('recallLedger — join a work outcome back to the memories that informed it', () => {
  it('returns the memories recalled into that project', () => {
    noteRecall('termpolis', ['m1', 'm2'], 1_000)
    expect(claimRecalled('termpolis', 2_000).sort()).toEqual(['m1', 'm2'])
  })

  it('keeps projects apart — a failure here must not demote a memory recalled there', () => {
    noteRecall('termpolis', ['m1'], 1_000)
    noteRecall('other', ['m2'], 1_000)
    expect(claimRecalled('termpolis', 2_000)).toEqual(['m1'])
    expect(claimRecalled('other', 2_000)).toEqual(['m2'])
  })

  it('charges a recall at most ONCE, however many outcomes follow it', () => {
    // Ten green test runs in a row must not bank ten upvotes for one recall — that would let a
    // single lucky memory drown out everything the ranking knows.
    noteRecall('termpolis', ['m1'], 1_000)
    expect(claimRecalled('termpolis', 2_000)).toEqual(['m1'])
    expect(claimRecalled('termpolis', 3_000)).toEqual([])
    expect(claimRecalled('termpolis', 4_000)).toEqual([])
  })

  it('forgets a recall too old to have informed the outcome', () => {
    noteRecall('termpolis', ['stale'], 1_000)
    expect(claimRecalled('termpolis', 1_000 + RECALL_WINDOW_MS + 1)).toEqual([])
  })

  it('still counts a recall right at the edge of the window', () => {
    noteRecall('termpolis', ['edge'], 1_000)
    expect(claimRecalled('termpolis', 1_000 + RECALL_WINDOW_MS)).toEqual(['edge'])
  })

  it('never attributes an outcome to a memory recalled AFTER it', () => {
    noteRecall('termpolis', ['later'], 5_000)
    expect(claimRecalled('termpolis', 4_000)).toEqual([])
    // ...and it is still claimable once its own time has come.
    expect(claimRecalled('termpolis', 6_000)).toEqual(['later'])
  })

  it('counts a memory once even when several recalls surfaced it', () => {
    noteRecall('termpolis', ['m1', 'm2'], 1_000)
    noteRecall('termpolis', ['m1', 'm3'], 1_100)
    expect(claimRecalled('termpolis', 2_000).sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('caps how many memories one outcome can charge', () => {
    // A primer injects tens of memories at launch. One red test run must not be evidence against
    // every one of them — that is a blast radius, not a signal.
    const many = Array.from({ length: MAX_ATTRIBUTED + 25 }, (_, i) => `m${i}`)
    noteRecall('termpolis', many, 1_000)
    expect(claimRecalled('termpolis', 2_000)).toHaveLength(MAX_ATTRIBUTED)
  })

  it('prefers the most recent recalls when it has to cap', () => {
    const older = Array.from({ length: MAX_ATTRIBUTED }, (_, i) => `old${i}`)
    noteRecall('termpolis', older, 1_000)
    noteRecall('termpolis', ['fresh'], 1_500)
    expect(claimRecalled('termpolis', 2_000)).toContain('fresh')
  })

  it('ignores an empty or malformed note rather than banking a phantom recall', () => {
    noteRecall('termpolis', [], 1_000)
    noteRecall('', ['m1'], 1_000)
    expect(claimRecalled('termpolis', 2_000)).toEqual([])
  })

  it('does not grow without bound across many projects', () => {
    for (let i = 0; i < 500; i++) noteRecall(`p${i}`, ['m'], 1_000 + i)
    // The oldest projects are evicted; the newest are still answerable.
    expect(claimRecalled('p499', 2_000)).toEqual(['m'])
    expect(claimRecalled('p0', 2_000)).toEqual([])
  })
})
