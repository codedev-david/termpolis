import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordElision, recordRedemption, recentByClass, elisionState, loadElisionState, resetElisionLedger, elisionRevision, ELISION_WINDOW,
} from '../../src/main/headroom/elisionLedger'
import type { ElisionMeta } from '../../src/main/headroom/elisionMeta'

/**
 * R1 criterion 3, the counting half. The ledger answers one question the app could not answer
 * before: of the text the proxy took out, how much did the model ask for back? Every elision is
 * counted once when its token is first stored and every redemption once, by class, with a rolling
 * window beside the lifetime counts so a change of regime shows up in days rather than never.
 */

const compactRead = (chars = 5000, view = 1100): ElisionMeta => ({ kind: 'compact', tool: 'Read', chars, view })
const compactBash = (chars = 2000, view = 1100): ElisionMeta => ({ kind: 'compact', tool: 'Bash', chars, view })
const tok = (n: number): string => 'hr_' + n.toString(16).padStart(16, '0')

beforeEach(() => resetElisionLedger())

describe('elisions', () => {
  it('counts each token in its class, with the sizes it removed and left behind', () => {
    recordElision(tok(1), compactRead(5000, 1100))
    recordElision(tok(2), compactRead(9000, 1200))
    recordElision(tok(3), compactBash(2000, 1100))
    const s = elisionState()
    expect(s.classes['compact|Read|4-10k']).toEqual({ elided: 2, redeemed: 0, chars: 14000, view: 2300 })
    expect(s.classes['compact|Bash|1.6-4k']).toEqual({ elided: 1, redeemed: 0, chars: 2000, view: 1100 })
    expect(s.legacyRedeemed).toBe(0)
  })

  it('counts what it is told: deciding that a token is new belongs to the stash that stored it', () => {
    // A token whose stash was lost and which comes back IS a new elision, so the ledger must not
    // second-guess its caller; the window holds one live entry for it, the newest.
    recordElision(tok(1), compactRead())
    recordElision(tok(1), compactRead())
    expect(elisionState().classes['compact|Read|4-10k'].elided).toBe(2)
    expect(recentByClass().get('compact|Read|4-10k')?.elided).toBe(1)
  })

  it('keeps kinds apart: the same tool and size under two kinds are two classes', () => {
    recordElision(tok(1), { kind: 'compact', tool: 'Read', chars: 5000, view: 1100 })
    recordElision(tok(2), { kind: 'decay', tool: 'Read', chars: 5000, view: 140 })
    expect(Object.keys(elisionState().classes).sort()).toEqual(['compact|Read|4-10k', 'decay|Read|4-10k'])
  })
})

describe('redemptions', () => {
  it('counts a redemption in the class of the token it redeems', () => {
    recordElision(tok(1), compactRead())
    recordElision(tok(2), compactBash())
    recordRedemption(tok(1), compactRead())
    const s = elisionState()
    expect(s.classes['compact|Read|4-10k'].redeemed).toBe(1)
    expect(s.classes['compact|Bash|1.6-4k'].redeemed).toBe(0)
  })

  it('the class this run saw a token elided in wins over what a later request says about the same content', () => {
    // Compacted the first time; the request that sends it again describes it as aged out. The redemption
    // belongs to the elision that made the token.
    recordElision(tok(1), compactRead())
    recordRedemption(tok(1), { kind: 'decay', tool: 'Read', chars: 6000, view: 140 })
    const s = elisionState()
    expect(s.classes['compact|Read|4-10k'].redeemed).toBe(1)
    expect(s.classes['decay|Read|4-10k']).toBeUndefined()
  })

  it('a token this run never saw elided takes the class the stash recorded', () => {
    recordRedemption(tok(1), compactRead())
    const s = elisionState()
    expect(s.classes['compact|Read|4-10k']).toMatchObject({ elided: 0, redeemed: 1 })
    expect(s.legacyRedeemed).toBe(0)
  })

  it('a token with no meta falls back to the class it was elided in, when this run saw it', () => {
    recordElision(tok(1), compactRead())
    recordRedemption(tok(1))
    expect(elisionState().classes['compact|Read|4-10k'].redeemed).toBe(1)
    expect(elisionState().legacyRedeemed).toBe(0)
  })

  it('a token nobody can classify is counted as a legacy redemption, apart from every class', () => {
    recordRedemption(tok(9))
    recordRedemption(tok(10))
    recordRedemption(undefined) // a give-back that arrived with no token at all
    const s = elisionState()
    expect(s.legacyRedeemed).toBe(3)
    expect(s.classes).toEqual({})
  })

  it('a redemption can predate the ledger: it counts, and the class shows more asked than elided', () => {
    recordRedemption(tok(1), compactRead())
    expect(elisionState().classes['compact|Read|4-10k']).toEqual({ elided: 0, redeemed: 1, chars: 0, view: 0 })
  })
})

describe('rolling window', () => {
  it('reports the recent elisions per class and which of them were asked back', () => {
    for (let i = 0; i < 10; i++) recordElision(tok(i), compactRead(5000, 1000))
    for (let i = 0; i < 4; i++) recordRedemption(tok(i), compactRead(5000, 1000))
    const r = recentByClass()
    expect(r.get('compact|Read|4-10k')).toEqual({ elided: 10, redeemed: 4, chars: 50_000, view: 10_000 })
  })

  it('forgets the oldest elisions once the window is full, while lifetime counts keep them', () => {
    const extra = 7
    for (let i = 0; i < ELISION_WINDOW + extra; i++) recordElision(tok(i), compactRead())
    expect(recentByClass().get('compact|Read|4-10k')?.elided).toBe(ELISION_WINDOW)
    expect(elisionState().classes['compact|Read|4-10k'].elided).toBe(ELISION_WINDOW + extra)
  })

  it('a redemption of a token already out of the window counts for life only', () => {
    for (let i = 0; i < ELISION_WINDOW + 3; i++) recordElision(tok(i), compactRead())
    recordRedemption(tok(0), compactRead()) // pushed out by the 2,001st elision
    expect(recentByClass().get('compact|Read|4-10k')?.redeemed).toBe(0)
    expect(elisionState().classes['compact|Read|4-10k'].redeemed).toBe(1)
  })

  it('shows a change of regime within one window: old behaviour ages out of the rate', () => {
    // 2,000 results asked back 13% of the time, then 2,000 asked back 66% of the time.
    let n = 0
    for (let i = 0; i < ELISION_WINDOW; i++, n++) { recordElision(tok(n), compactRead()); if (i % 100 < 13) recordRedemption(tok(n), compactRead()) }
    const before = recentByClass().get('compact|Read|4-10k')
    expect(before && before.redeemed / before.elided).toBeCloseTo(0.13, 2)
    for (let i = 0; i < ELISION_WINDOW; i++, n++) { recordElision(tok(n), compactRead()); if (i % 100 < 66) recordRedemption(tok(n), compactRead()) }
    const after = recentByClass().get('compact|Read|4-10k')
    expect(after && after.redeemed / after.elided).toBeCloseTo(0.66, 2)
    // Lifetime is the blend of both, which is exactly why the window exists.
    const life = elisionState().classes['compact|Read|4-10k']
    expect(life.redeemed / life.elided).toBeCloseTo(0.395, 2)
  })

  it('is empty before anything is recorded', () => {
    expect(recentByClass().size).toBe(0)
  })
})

describe('persisted state', () => {
  it('round-trips the lifetime counts, not the window', () => {
    recordElision(tok(1), compactRead(5000, 1100))
    recordRedemption(tok(1), compactRead(5000, 1100))
    recordRedemption(tok(2))
    const saved = JSON.parse(JSON.stringify(elisionState()))
    resetElisionLedger()
    loadElisionState(saved)
    expect(elisionState()).toEqual(saved)
    expect(recentByClass().size).toBe(0) // the window is this run's, by design
  })

  it('keeps counting on top of what it loaded', () => {
    loadElisionState({ classes: { 'compact|Read|4-10k': { elided: 10, redeemed: 3, chars: 100, view: 20 } }, legacyRedeemed: 4 })
    recordElision(tok(1), compactRead(5000, 1100))
    recordRedemption(tok(1), compactRead(5000, 1100))
    const s = elisionState()
    expect(s.classes['compact|Read|4-10k']).toEqual({ elided: 11, redeemed: 4, chars: 5100, view: 1120 })
    expect(s.legacyRedeemed).toBe(4)
  })

  it('loads nothing from a shape it does not recognise', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}, { classes: null }, { classes: 5 }, { classes: [] }, { classes: 'x' }]) {
      loadElisionState({ classes: { 'compact|Read|4-10k': { elided: 1, redeemed: 1, chars: 1, view: 1 } }, legacyRedeemed: 1 })
      loadElisionState(bad)
      expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    }
  })

  it('drops a class key it did not build and a count that is not a usable number', () => {
    loadElisionState({
      classes: {
        'compact|Read|4-10k': { elided: 5, redeemed: 2, chars: 40, view: 10 },
        'bogus|Read|4-10k': { elided: 9, redeemed: 9, chars: 9, view: 9 },
        'compact|Bash|1.6-4k': { elided: '3', redeemed: -1, chars: Number.NaN, view: null },
        'decay|Grep|<1.6k': 'not an object',
        'diff|Glob|10-40k': null,
        'dedup|Glob|40k+': [],
      },
      legacyRedeemed: -3,
    })
    expect(elisionState()).toEqual({
      classes: {
        'compact|Read|4-10k': { elided: 5, redeemed: 2, chars: 40, view: 10 },
        'compact|Bash|1.6-4k': { elided: 0, redeemed: 0, chars: 0, view: 0 },
      },
      legacyRedeemed: 0,
    })
  })

  it('hands out a copy: editing the snapshot does not edit the ledger', () => {
    recordElision(tok(1), compactRead())
    const s = elisionState()
    s.classes['compact|Read|4-10k'].elided = 999
    s.legacyRedeemed = 999
    expect(elisionState().classes['compact|Read|4-10k'].elided).toBe(1)
    expect(elisionState().legacyRedeemed).toBe(0)
  })
})

describe('reset', () => {
  it('clears the counts and the window together', () => {
    recordElision(tok(1), compactRead())
    recordRedemption(tok(1), compactRead())
    recordRedemption(tok(2))
    resetElisionLedger()
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    expect(recentByClass().size).toBe(0)
    // and the window is empty again, so a redemption of a token it once held is lifetime-only
    recordRedemption(tok(1), compactRead())
    expect(recentByClass().size).toBe(0)
    expect(elisionState().classes['compact|Read|4-10k'].redeemed).toBe(1)
  })
})

describe('revision', () => {
  it('moves on every change to the lifetime counts and on nothing else', () => {
    const r0 = elisionRevision()
    recordElision(tok(1), compactRead())
    const r1 = elisionRevision()
    expect(r1).not.toBe(r0)
    recordRedemption(tok(1), compactRead())
    const r2 = elisionRevision()
    expect(r2).not.toBe(r1)
    recordRedemption(undefined) // a redemption no class can claim is still a change to the counts
    const r3 = elisionRevision()
    expect(r3).not.toBe(r2)
    loadElisionState({ classes: {}, legacyRedeemed: 4 })
    const r4 = elisionRevision()
    expect(r4).not.toBe(r3)
    resetElisionLedger()
    const r5 = elisionRevision()
    expect(r5).not.toBe(r4)
    // Reading it, in any way, is not a change.
    elisionState(); recentByClass(); elisionState()
    expect(elisionRevision()).toBe(r5)
  })

  it('never repeats a value, so "unchanged since" cannot be fooled by a reset back to zero', () => {
    const seen = new Set<number>([elisionRevision()])
    for (let i = 0; i < 20; i++) {
      recordElision(tok(i), compactRead())
      if (i % 5 === 4) resetElisionLedger()
      seen.add(elisionRevision())
    }
    expect(seen.size).toBe(21)
  })
})
