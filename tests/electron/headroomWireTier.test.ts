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
})
