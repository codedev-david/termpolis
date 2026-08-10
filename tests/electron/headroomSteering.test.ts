import { describe, it, expect } from 'vitest'
const { steeringDirective } = await import('../../src/main/headroom/outputSteering')

describe('output steering', () => {
  it('is a terse, non-empty directive that discourages preamble', () => {
    const d = steeringDirective()
    expect(d.length).toBeGreaterThan(20)
    expect(d.toLowerCase()).toContain('terse')
    expect(d.toLowerCase()).toContain('preamble')
  })

  it('grades verbosity by mode: conservative < balanced < aggressive', () => {
    const con = steeringDirective('conservative')
    const bal = steeringDirective('balanced')
    const agg = steeringDirective('aggressive')
    expect(con.length).toBeLessThan(bal.length)
    expect(agg.length).toBeGreaterThan(bal.length)
    for (const d of [con, bal, agg]) expect(d.toLowerCase()).toContain('terse')
  })

  it('defaults to balanced, byte-identical to the historical directive', () => {
    expect(steeringDirective()).toBe(steeringDirective('balanced'))
    expect(steeringDirective('balanced')).toContain('preamble') // full base retained
  })
})

describe('the max tier — the one an unhandled mode silently downgraded', () => {
  it('is strictly stronger than aggressive, never weaker', () => {
    // Before this existed, steeringDirective('max') fell through to the BALANCED text: choosing the
    // hardest compression tier bought the WEAKEST output directive. Superset, and longer.
    const aggressive = steeringDirective('aggressive')
    const max = steeringDirective('max')
    expect(max).not.toBe(aggressive)
    expect(max.length).toBeGreaterThan(aggressive.length)
    for (const s of aggressive.split(' ')) expect(max).toContain(s)
  })

  it('is never the balanced directive by accident', () => {
    expect(steeringDirective('max')).not.toBe(steeringDirective('balanced'))
  })

  it('stays deterministic — the directive rides in the cached system prompt', () => {
    expect(steeringDirective('max')).toBe(steeringDirective('max'))
  })
})
