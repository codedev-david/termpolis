import { describe, it, expect } from 'vitest'
import { REVIEW_POLICY, nextReviewScope, shouldStop, reviewPolicyText } from '../../src/shared/reviewPolicy'

describe('review policy', () => {
  it('stops at round 3 or when no blocker/major', () => {
    expect(shouldStop(1, [{ severity: 'major' }])).toBe(false)
    expect(shouldStop(2, [{ severity: 'blocker' }, { severity: 'minor' }])).toBe(false)
    expect(shouldStop(1, [{ severity: 'minor' }, { severity: 'minor' }])).toBe(true)
    expect(shouldStop(1, [])).toBe(true)
    expect(shouldStop(REVIEW_POLICY.maxRounds, [{ severity: 'blocker' }])).toBe(true)
  })

  it('round 2 scope is the delta', () => {
    expect(nextReviewScope(null, 'abc')).toEqual({ range: 'abc', full: true })
    expect(nextReviewScope('  ', 'abc')).toEqual({ range: 'abc', full: true })
    expect(nextReviewScope('r1', 'abc')).toEqual({ range: 'r1..abc', full: false })
    expect(nextReviewScope('abc', 'abc')).toEqual({ range: 'abc', full: false })
  })

  it('reviewers and fixers on Sonnet, one Opus lens, checks as commands', () => {
    expect(REVIEW_POLICY.reviewer.model).toBe('sonnet')
    expect(REVIEW_POLICY.fixer.model).toBe('sonnet')
    const t = reviewPolicyText()
    expect(t).toContain("'--model sonnet --effort medium'")
    expect(t).toContain('as commands')
    expect(t).toContain('round 1')
  })
})
