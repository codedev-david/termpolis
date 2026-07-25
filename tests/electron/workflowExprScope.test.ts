import { describe, it, expect } from 'vitest'
import { interpolate, evalCondition } from '../../src/main/workflow/workflowExpr'
import type { ExprScope } from '../../src/main/workflow/workflowExpr'

// ---------------------------------------------------------------------------
// v1.32.1 — the reusable half of the expression engine: `${inputs.NAME}` and
// `${project.*}`. These are what make ONE workflow definition work in every
// repo, so the resolution rules (and the refusal to resolve anything outside
// the two known namespaces) are pinned here. Still no `eval`: an unknown
// reference resolves to '' rather than leaking `${...}` into a command line.
// ---------------------------------------------------------------------------

const results = {
  build: { stepId: 'build', status: 'succeeded' as const, exitCode: 0, output: 'ok' },
}

const scope: ExprScope = {
  inputs: { target: 'prod', empty: '' },
  project: { cwd: '/repos/termpolis', name: 'termpolis', branch: 'main' },
}

describe('interpolate — inputs', () => {
  it('substitutes a declared input', () => {
    expect(interpolate('deploy ${inputs.target}', results, scope)).toBe('deploy prod')
  })

  it('supports the {{ }} form as well as ${ }', () => {
    expect(interpolate('deploy {{ inputs.target }}', results, scope)).toBe('deploy prod')
  })

  it('substitutes the same input more than once', () => {
    expect(interpolate('${inputs.target}-${inputs.target}', results, scope)).toBe('prod-prod')
  })

  it('an input declared but left empty collapses to nothing', () => {
    expect(interpolate('x=${inputs.empty}', results, scope)).toBe('x=')
  })

  it('an undeclared input collapses to nothing rather than leaking the token', () => {
    expect(interpolate('x=${inputs.nope}', results, scope)).toBe('x=')
  })

  it('with no scope at all an input reference is empty, not a throw', () => {
    expect(interpolate('x=${inputs.target}', results)).toBe('x=')
  })

  it('mixes step output and inputs in one string', () => {
    expect(interpolate('${steps.build.output}:${inputs.target}', results, scope)).toBe('ok:prod')
  })

  it('leaves an unknown namespace untouched — only known refs are substituted', () => {
    expect(interpolate('${secrets.token}', results, scope)).toBe('${secrets.token}')
  })
})

describe('interpolate — project context', () => {
  it('substitutes the project cwd', () => {
    expect(interpolate('cd ${project.cwd}', results, scope)).toBe('cd /repos/termpolis')
  })

  it('substitutes the project name', () => {
    expect(interpolate('${project.name}', results, scope)).toBe('termpolis')
  })

  it('substitutes the current branch', () => {
    expect(interpolate('${project.branch}', results, scope)).toBe('main')
  })

  it('an unknown field of a KNOWN namespace collapses to empty, like steps.X.bogus', () => {
    expect(interpolate('r=${project.remote}', results, scope)).toBe('r=')
  })

  it('a missing branch resolves to empty rather than "undefined"', () => {
    const noBranch: ExprScope = { project: { cwd: '/x', name: 'x' } }
    expect(interpolate('b=${project.branch}', results, noBranch)).toBe('b=')
  })

  it('the same template renders differently per project — that is the point', () => {
    const a: ExprScope = { project: { cwd: '/repos/alpha', name: 'alpha' } }
    const b: ExprScope = { project: { cwd: '/repos/beta', name: 'beta' } }
    expect(interpolate('build ${project.name}', results, a)).toBe('build alpha')
    expect(interpolate('build ${project.name}', results, b)).toBe('build beta')
  })
})

describe('evalCondition — inputs and project', () => {
  it('compares an input against a literal', () => {
    expect(evalCondition('inputs.target == prod', results, scope)).toBe(true)
    expect(evalCondition('inputs.target == staging', results, scope)).toBe(false)
  })

  it('compares the branch so a workflow can gate on where it is running', () => {
    expect(evalCondition('project.branch == main', results, scope)).toBe(true)
    expect(evalCondition('project.branch != main', results, scope)).toBe(false)
  })

  it('=~ is substring containment on an input (deliberately no regex engine)', () => {
    expect(evalCondition('inputs.target =~ pro', results, scope)).toBe(true)
    expect(evalCondition('inputs.target =~ stag', results, scope)).toBe(false)
    // A regex anchor is matched literally — proof no pattern engine is reachable.
    expect(evalCondition('inputs.target =~ ^pro', results, scope)).toBe(false)
  })

  it('an undeclared input compares as empty rather than throwing', () => {
    expect(evalCondition('inputs.ghost == prod', results, scope)).toBe(false)
    expect(evalCondition('inputs.ghost != prod', results, scope)).toBe(true)
  })

  it('combines a step result and an input in one gate', () => {
    expect(evalCondition('steps.build.exitCode == 0', results, scope)).toBe(true)
    expect(evalCondition('inputs.target == prod', results, scope)).toBe(true)
  })

  it('with no scope an input gate is false, never a throw', () => {
    expect(evalCondition('inputs.target == prod', results)).toBe(false)
  })

  it('an input name that is not a plain identifier does not resolve', () => {
    // Names are validated at save; a hand-edited file must not smuggle syntax in.
    expect(interpolate('${inputs.a-b}', results, { inputs: { 'a-b': 'x' } })).toBe('${inputs.a-b}')
  })
})
