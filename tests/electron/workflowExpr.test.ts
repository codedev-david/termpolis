import { describe, it, expect } from 'vitest'
import { interpolate, evalCondition } from '../../src/main/workflow/workflowExpr'
import type { StepResult } from '../../src/renderer/src/types'

const R = (over: Partial<StepResult> & { stepId: string }): StepResult =>
  ({ status: 'succeeded', output: '', ...over })
const results = {
  build: R({ stepId: 'build', output: 'ok done', exitCode: 0, status: 'succeeded' }),
  test:  R({ stepId: 'test',  output: 'FAIL x', exitCode: 1, status: 'failed' }),
}

describe('interpolate', () => {
  it('replaces ${steps.id.output/exitCode/status}', () => {
    expect(interpolate('out=${steps.build.output}', results)).toBe('out=ok done')
    expect(interpolate('code=${steps.test.exitCode}', results)).toBe('code=1')
    expect(interpolate('st=${steps.test.status}', results)).toBe('st=failed')
  })
  it('accepts the {{ }} syntax too', () => {
    expect(interpolate('x={{ steps.build.output }}', results)).toBe('x=ok done')
  })
  it('unknown id or field -> empty string', () => {
    expect(interpolate('a=${steps.nope.output}b', results)).toBe('a=b')
  })
  it('leaves non-refs untouched', () => {
    expect(interpolate('plain $VAR text', results)).toBe('plain $VAR text')
  })
  it('inserts output containing $-replacement patterns literally (no String.replace $& footgun)', () => {
    const withDollar = { x: R({ stepId: 'x', output: 'a $& $1 $` b' }) }
    expect(interpolate('v=${steps.x.output}', withDollar)).toBe('v=a $& $1 $` b')
  })
  it('renders a missing exitCode as empty, not the string "undefined"', () => {
    const noCode = { x: R({ stepId: 'x', output: 'hi' }) } // exitCode omitted (e.g. agent step)
    expect(interpolate('c=${steps.x.exitCode}.', noCode)).toBe('c=.')
  })
})

describe('evalCondition', () => {
  it('numeric comparisons on exitCode', () => {
    expect(evalCondition('steps.test.exitCode != 0', results)).toBe(true)
    expect(evalCondition('steps.build.exitCode == 0', results)).toBe(true)
    expect(evalCondition('steps.build.exitCode >= 1', results)).toBe(false)
  })
  it('.ok / .failed sugar', () => {
    expect(evalCondition('steps.build.ok', results)).toBe(true)
    expect(evalCondition('steps.test.failed', results)).toBe(true)
    expect(evalCondition('steps.build.failed', results)).toBe(false)
  })
  it('string equality + substring =~', () => {
    expect(evalCondition("steps.test.status == 'failed'", results)).toBe(true)
    expect(evalCondition('steps.test.output =~ FAIL', results)).toBe(true)
    expect(evalCondition('steps.build.output =~ nope', results)).toBe(false)
  })
  it('supports all comparison operators, matched longest-first', () => {
    expect(evalCondition('steps.build.exitCode <= 0', results)).toBe(true)   // <= not < then =
    expect(evalCondition('steps.build.exitCode < 1', results)).toBe(true)
    expect(evalCondition('steps.test.exitCode > 0', results)).toBe(true)
    expect(evalCondition('steps.test.exitCode >= 1', results)).toBe(true)    // >= not > then =
    expect(evalCondition('steps.build.exitCode < 0', results)).toBe(false)
  })
  it('requires spaces around the operator (no-space string is not a comparison -> false)', () => {
    expect(evalCondition('steps.test.exitCode!=0', results)).toBe(false)
  })
  it('malformed expression -> false (never throws)', () => {
    expect(evalCondition('this is not valid', results)).toBe(false)
    expect(evalCondition('', results)).toBe(false)
  })
})
