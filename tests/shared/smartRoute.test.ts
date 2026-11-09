import { describe, it, expect } from 'vitest'
import { knnClassify, routeMessage, KNN_K, USER_WEIGHT, MIN_TOP_SIM, OVERRIDE_CONFIDENCE, type LabeledVec, type Classification } from '../../src/shared/smartRoute'
import { ROUTER_SEEDS, flatSeeds } from '../../src/shared/routerSeeds'
import { MISROUTE_LIMIT, DEFAULT_ROUTER_TUNING } from '../../src/shared/taskRouter'

const cls = (label: Classification['label'], confidence: number, topSim = 0.9): Classification => ({ label, confidence, topSim })

describe('knnClassify', () => {
  it('returns null with nothing to compare', () => {
    expect(knnClassify([], [{ label: 'haiku', vec: [1] }])).toBeNull()
    expect(knnClassify([1, 0], [])).toBeNull()
    expect(knnClassify(null as unknown as number[], [{ label: 'haiku', vec: [1] }])).toBeNull()
    // every example points away: no positive vote
    expect(knnClassify([1, 0], [{ label: 'haiku', vec: [-1, 0] }])).toBeNull()
  })

  it('votes by similarity among the k nearest', () => {
    const ex: LabeledVec[] = [
      { label: 'opus', vec: [1, 0] },
      { label: 'opus', vec: [0.9, 0.1] },
      { label: 'haiku', vec: [0, 1] },
    ]
    const r = knnClassify([1, 0], ex)!
    expect(r.label).toBe('opus')
    expect(r.topSim).toBe(1)
    expect(r.confidence).toBe(1) // haiku's similarity is 0
    expect(knnClassify([0, 1], ex, 1)!.label).toBe('haiku')
    expect(knnClassify([0, 1], ex, 0)!.label).toBe('haiku') // k floors at 1
  })

  it('counts user picks double', () => {
    const ex: LabeledVec[] = [
      { label: 'sonnet', vec: [1, 0] },
      { label: 'haiku', vec: [1, 0, 5], weight: USER_WEIGHT },
      { label: 'keep', vec: [1, 0] },
    ]
    const r = knnClassify([1, 0], ex, KNN_K)!
    expect(r.label).toBe('haiku')
    expect(r.confidence).toBeCloseTo(0.5, 5)
  })
})

describe('routeMessage', () => {
  it('a blank message keeps the session model', () => {
    expect(routeMessage('', cls('opus', 1)).label).toBe('keep')
  })

  it('falls back to the word rules without a usable vote', () => {
    const p = 'fix the failing terminalManager test'
    expect(routeMessage(p, null)).toMatchObject({ label: 'sonnet', source: 'rules', rule: 'build', confidence: 0.75 })
    expect(routeMessage(p, cls('opus', 1, MIN_TOP_SIM - 0.01)).source).toBe('rules')
  })

  it('agreement raises the confidence and credits both', () => {
    expect(routeMessage('fix the failing terminalManager test', cls('sonnet', 0.9))).toMatchObject({ label: 'sonnet', source: 'both', confidence: 0.9 })
    expect(routeMessage('fix the failing terminalManager test', cls('sonnet', 0.3)).confidence).toBe(0.75)
  })

  it('a sure keep vote keeps; an unsure one leaves it to the rules', () => {
    expect(routeMessage('sure lets push this', cls('keep', 0.8))).toMatchObject({ label: 'keep', source: 'local-model', confidence: 0.8 })
    expect(routeMessage('sure lets push this', cls('keep', OVERRIDE_CONFIDENCE - 0.1)).source).toBe('rules')
  })

  it('a sure classifier overrides a less sure rule', () => {
    const p = 'fix the failing terminalManager test' // rule: sonnet 0.75
    expect(routeMessage(p, cls('opus', 0.8))).toMatchObject({ label: 'opus', effort: 'high', source: 'local-model' })
    expect(routeMessage(p, cls('haiku', 0.8))).toMatchObject({ label: 'haiku', effort: 'low' })
    expect(routeMessage(p, cls('opus', 0.6)).source).toBe('rules')
    // the weak default rule (0.4) loses to a 0.55 vote
    expect(routeMessage('hmm interesting thought about the colour', cls('opus', 0.55))).toMatchObject({ label: 'opus', effort: 'high' })
  })

  it('applies the misroute tuning through the rules', () => {
    const tune = { ...DEFAULT_ROUTER_TUNING, misroutes: { build: MISROUTE_LIMIT } }
    expect(routeMessage('fix the failing terminalManager test', null, tune).label).toBe('opus')
  })
})

describe('routerSeeds', () => {
  it('flatSeeds lists every seed once with its label', () => {
    const flat = flatSeeds()
    const total = Object.values(ROUTER_SEEDS).reduce((a, l) => a + l.length, 0)
    expect(flat).toHaveLength(total)
    for (const label of ['keep', 'haiku', 'sonnet', 'opus'] as const) {
      expect(ROUTER_SEEDS[label].length).toBeGreaterThan(10)
      expect(flat.filter((s) => s.label === label)).toHaveLength(ROUTER_SEEDS[label].length)
    }
    const texts = flat.map((s) => s.text.toLowerCase())
    expect(new Set(texts).size).toBe(texts.length)
  })
})
