import { describe, it, expect } from 'vitest'
const { steeringDirective } = await import('../../src/main/headroom/outputSteering')

describe('output steering', () => {
  it('is a terse, non-empty directive that discourages preamble', () => {
    const d = steeringDirective()
    expect(d.length).toBeGreaterThan(20)
    expect(d.toLowerCase()).toContain('terse')
    expect(d.toLowerCase()).toContain('preamble')
  })
})
