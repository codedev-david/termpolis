// Competence from REAL work.
//
// The bug this fixes: mnemeCompetence only ever learned from a swarm task completing,
// or from a solo session whose LAST assistant turn happened to contain a magic phrase
// ("fixed", "tests pass"). Ordinary interactive work produced NO outcome at all, so
// every domain read "unproven" forever (attempts: 0) and the dashboard's competence
// panel stayed permanently empty. These tests pin the real-work signals.
import { describe, it, expect } from 'vitest'
import { deriveOutcome } from '../../src/main/outcomeSignals'

describe('outcomeSignals — a landed commit is evidence', () => {
  it('a git commit that succeeded is a SUCCESS signal for the project domain', () => {
    const o = deriveOutcome({ kind: 'git-commit', project: 'termpolis', ok: true })
    expect(o).not.toBeNull()
    expect(o!.domain).toBe('termpolis')
    expect(o!.success).toBe(true)
    expect(o!.reason).toBeTruthy()
  })

  it('a blocked or failed commit is NOT a signal — it says nothing about competence', () => {
    // e.g. the secret shield fired, or it was an empty commit. Recording that as a
    // failure would poison the calibration with non-evidence.
    expect(deriveOutcome({ kind: 'git-commit', project: 'termpolis', ok: false })).toBeNull()
  })
})

describe('outcomeSignals — a test run is the honest signal in BOTH directions', () => {
  it('a passing test run is a SUCCESS signal', () => {
    const o = deriveOutcome({ kind: 'test-run', project: 'termpolis', exitCode: 0 })
    expect(o!.success).toBe(true)
  })

  it('a failing test run is a FAILURE signal — this is what calibrates confidence DOWN', () => {
    const o = deriveOutcome({ kind: 'test-run', project: 'termpolis', exitCode: 1 })
    expect(o!.success).toBe(false)
    expect(o!.reason).toContain('1')
  })
})

describe('outcomeSignals — session end', () => {
  it('an explicitly inferred session outcome still counts, both ways', () => {
    expect(deriveOutcome({ kind: 'session-end', project: 'x', outcome: 'success' })!.success).toBe(true)
    expect(deriveOutcome({ kind: 'session-end', project: 'x', outcome: 'failure' })!.success).toBe(false)
  })

  it('a session with no discernible outcome is not a signal', () => {
    expect(deriveOutcome({ kind: 'session-end', project: 'x' })).toBeNull()
  })
})

describe('outcomeSignals — domain guard', () => {
  it('no project means no domain, so no signal is recorded', () => {
    expect(deriveOutcome({ kind: 'git-commit', project: '', ok: true })).toBeNull()
    expect(deriveOutcome({ kind: 'test-run', project: '   ', exitCode: 0 })).toBeNull()
    expect(deriveOutcome({ kind: 'session-end', project: '', outcome: 'success' })).toBeNull()
  })
})
