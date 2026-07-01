import { describe, it, expect } from 'vitest'
import { augmentPrimer } from '../../src/main/mnemePrimerAugment'

describe('augmentPrimer — compose primer with metacognition / curiosity / identity', () => {
  it('returns the primer unchanged when there is nothing to add', () => {
    expect(augmentPrimer('base', {})).toBe('base')
    expect(augmentPrimer('base', { curiosity: [] })).toBe('base')
    expect(augmentPrimer(null, {})).toBe(null)
  })

  it('appends competence, curiosity, and identity blocks', () => {
    const out = augmentPrimer('base primer', {
      competence: 'low competence in deploy (1/4 succeeded)',
      curiosity: ['try Y', 'check Z'],
      identity: 'Active goals: ship v1.17',
    })
    expect(out).toContain('base primer')
    expect(out).toContain('Self-competence')
    expect(out).toContain('low competence in deploy')
    expect(out).toContain('Open questions')
    expect(out).toContain('- try Y')
    expect(out).toContain('- check Z')
    expect(out).toContain('Active goals: ship v1.17')
  })

  it('returns just the blocks when the base primer is null', () => {
    expect(augmentPrimer(null, { identity: 'I am the shared brain' })).toBe('I am the shared brain')
  })
})
