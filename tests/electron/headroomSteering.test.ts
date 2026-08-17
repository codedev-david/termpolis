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

/**
 * v1.36.0 promoted the anti-restatement line out of the `max` tier and into BASE. Output is the
 * second-largest slice of the bill and restating tool output is its largest avoidable sink, so the
 * one directive that targets it must not be gated behind the tier almost nobody selects.
 */
describe('output steering — the anti-restatement directive is universal', () => {
  const MODES = ['conservative', 'balanced', 'aggressive', 'max'] as const
  const NEVER_REPEAT = 'Never repeat content already visible in tool output'

  it('reaches every mode, not just max', () => {
    for (const m of MODES) expect(steeringDirective(m)).toContain(NEVER_REPEAT)
    expect(steeringDirective()).toContain(NEVER_REPEAT)
  })

  it('says it exactly once — a promoted line must be MOVED, not copied', () => {
    // A stray duplicate in MAX_EXTRA would spend tokens repeating an instruction about not
    // repeating things, and would only show up on the one tier hardest to eyeball.
    for (const m of MODES) {
      expect(steeringDirective(m).split(NEVER_REPEAT).length - 1).toBe(1)
    }
  })

  it('still leaves max strictly stronger than the tiers below it', () => {
    // Promoting a line out of MAX_EXTRA must not flatten the ladder.
    const max = steeringDirective('max')
    for (const m of ['conservative', 'balanced', 'aggressive'] as const) {
      expect(max.length).toBeGreaterThan(steeringDirective(m).length)
    }
  })
})
