import { describe, it, expect } from 'vitest'
import { describeWireTier } from '../../src/main/headroom/wireTier'

/**
 * R1 criterion 7, the tier half. The research found 39% of 600-1,600 character results redeemed in
 * September, a size band the default tier never elides, and could not say which tier was running:
 * the resolved tier lived only in memory. It is logged once at launch, in words, with the size
 * from which this tier starts eliding results.
 */

describe('describeWireTier', () => {
  it('names the tier and the size it starts eliding from', () => {
    expect(describeWireTier('aggressive', 'aggressive', false)).toBe(
      '[headroom] wire tier at launch: aggressive, eliding tool results of 1,600 characters or more (as selected; floor control off)',
    )
  })

  it('says when the savings floor held the selected tier', () => {
    expect(describeWireTier('aggressive', 'aggressive', true)).toBe(
      '[headroom] wire tier at launch: aggressive, eliding tool results of 1,600 characters or more (as selected; the savings floor held it)',
    )
  })

  it('says when the savings floor raised the tier, which is the case that moves the size band', () => {
    expect(describeWireTier('aggressive', 'max', true)).toBe(
      '[headroom] wire tier at launch: max, eliding tool results of 600 characters or more (raised from aggressive by the savings floor)',
    )
  })

  it('gives the size band of every tier', () => {
    const from = (m: string): string => describeWireTier(m, m, false).match(/of ([\d,]+) characters/)?.[1] ?? ''
    expect(from('conservative')).toBe('6,000')
    expect(from('balanced')).toBe('3,200')
    expect(from('aggressive')).toBe('1,600')
    expect(from('max')).toBe('600')
  })

  it('does not invent a size for a tier it does not know', () => {
    expect(describeWireTier('turbo', 'turbo', false)).toBe('[headroom] wire tier at launch: turbo (as selected; floor control off)')
    expect(describeWireTier(undefined, undefined, true)).toBe('[headroom] wire tier at launch: unknown (as selected; the savings floor held it)')
    expect(describeWireTier('', '', false)).toBe('[headroom] wire tier at launch: unknown (as selected; floor control off)')
  })

  describe('with the first-sight policy', () => {
    it('under late, starts eliding at the policy floor, whatever the tier, and says the savings floor is not used', () => {
      expect(describeWireTier('aggressive', 'aggressive', true, 'late')).toBe(
        '[headroom] wire tier at launch: aggressive, eliding tool results of 40,000 characters or more (as selected; the savings floor is not used under late; first-sight policy late)',
      )
      for (const m of ['conservative', 'balanced', 'aggressive', 'max']) {
        expect(describeWireTier(m, m, false, 'late').match(/of ([\d,]+) characters/)?.[1], m).toBe('40,000')
      }
    })

    it('under legacy, says so and keeps the tier floor', () => {
      expect(describeWireTier('aggressive', 'aggressive', true, 'legacy')).toBe(
        '[headroom] wire tier at launch: aggressive, eliding tool results of 1,600 characters or more (as selected; the savings floor held it; first-sight policy legacy)',
      )
      expect(describeWireTier('aggressive', 'max', true, 'legacy')).toBe(
        '[headroom] wire tier at launch: max, eliding tool results of 600 characters or more (raised from aggressive by the savings floor; first-sight policy legacy)',
      )
    })

    it('says nothing of a policy it was not given, or was given a word that is not one', () => {
      for (const bad of [undefined, null, '', 'Late', 'off', 5, {}]) {
        expect(describeWireTier('aggressive', 'aggressive', true, bad)).toBe(describeWireTier('aggressive', 'aggressive', true))
      }
    })

    it('does not invent a size for a tier it does not know, even under late', () => {
      expect(describeWireTier('turbo', 'turbo', false, 'late')).toBe(
        '[headroom] wire tier at launch: turbo (as selected; the savings floor is not used under late; first-sight policy late)',
      )
    })
  })
})
