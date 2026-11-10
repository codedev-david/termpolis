import { describe, it, expect } from 'vitest'
import {
  knnClassify, routeMessage, routeSubagent, chooseEffort, EFFORT_RANGE, LONG_PROMPT_WORDS, quickQuestion, KNN_K, USER_WEIGHT, MIN_TOP_SIM, OVERRIDE_CONFIDENCE, HAIKU_MIN_CONFIDENCE, HAIKU_MAX_WORDS,
  type LabeledVec, type Classification,
} from '../../src/shared/smartRoute'
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

  it('a sure vote overrides a disagreeing rule, however sure the rule', () => {
    const p = 'fix the failing terminalManager test' // rule: sonnet 0.75
    expect(routeMessage(p, cls('opus', 0.8))).toMatchObject({ label: 'opus', effort: 'high', source: 'local-model' })
    expect(routeMessage(p, cls('opus', 0.6))).toMatchObject({ label: 'opus', source: 'local-model' })
    expect(routeMessage(p, cls('opus', OVERRIDE_CONFIDENCE - 0.01)).source).toBe('rules')
    // the weak default rule (0.4) loses to a 0.55 vote
    expect(routeMessage('hmm interesting thought about the colour', cls('opus', 0.55))).toMatchObject({ label: 'opus', effort: 'high' })
  })

  it('Haiku only on a clear vote for a short question that does not sound like work', () => {
    const q = 'what does the current release have?'
    expect(routeMessage(q, cls('haiku', HAIKU_MIN_CONFIDENCE))).toMatchObject({ label: 'haiku', effort: 'low', source: 'local-model' })
    // an unsure vote, a vote on a message unlike any example, or no vote at all: Sonnet
    expect(routeMessage(q, cls('haiku', HAIKU_MIN_CONFIDENCE - 0.01))).toMatchObject({ label: 'sonnet', effort: 'medium' })
    expect(routeMessage(q, cls('haiku', 1, MIN_TOP_SIM - 0.01))).toMatchObject({ label: 'sonnet', source: 'rules' })
    expect(routeMessage('list the open ports', null)).toMatchObject({ label: 'sonnet', effort: 'medium', source: 'rules', rule: 'lookup' })
    // a sure vote on something that sounds like work: Sonnet
    expect(routeMessage('fix the failing terminalManager test', cls('haiku', 0.9))).toMatchObject({ label: 'sonnet', effort: 'medium' })
    expect(routeMessage('what is the status?', cls('haiku', 0.9)).label).toBe('sonnet')
  })

  it('quickQuestion: short, and nothing that sounds like work', () => {
    for (const p of ['what does the current release have?', 'did you put the markdown in that same folder?', 'the addon list?', 'which branch?'])
      expect(quickQuestion(p), p).toBe(true)
    for (const p of [
      '', '   ', 'what is the status?', 'i dont see any builds?', "I don't see it", 'why is it red', 'Running?', 'make it blue',
      'can you look at the slides', 'give me the above update in a pdf report', 'C:\\Users\\me\\shot.png what is this',
      'see https://example.com', Array(HAIKU_MAX_WORDS + 1).fill('word').join(' '),
    ]) expect(quickQuestion(p), p).toBe(false)
    expect(quickQuestion(Array(HAIKU_MAX_WORDS).fill('word').join(' '))).toBe(true)
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

describe('chooseEffort (v1.57.0)', () => {
  const r = (label: 'haiku' | 'sonnet' | 'opus' | 'keep', effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', confidence = 0.9) =>
    ({ label, effort, confidence, source: 'local-model' as const })

  it("keeps the level of a keep, and the model's range bounds the rest", () => {
    expect(chooseEffort('ultrathink', r('keep', 'medium'))).toBe('medium')
    expect(chooseEffort('ultrathink about this', r('sonnet', 'medium'))).toBe(EFFORT_RANGE.sonnet[1])
    expect(chooseEffort('think as hard as you can', r('opus', 'high'))).toBe('max')
    expect(chooseEffort('ultrathink', r('haiku', 'low'))).toBe('medium')
  })

  it('goes up for care and length, down for a sure small ask, never out of range', () => {
    expect(chooseEffort('find the root cause of the race condition', r('sonnet', 'medium'))).toBe('high')
    const long = Array(LONG_PROMPT_WORDS + 1).fill('word').join(' ')
    expect(chooseEffort(long, r('sonnet', 'medium'))).toBe('high')
    expect(chooseEffort(long, r('sonnet', 'medium'), { countLength: false })).toBe('medium')
    expect(chooseEffort('carefully ' + long, r('sonnet', 'medium'))).toBe('xhigh')
    expect(chooseEffort('fix a quick typo', r('sonnet', 'medium'))).toBe('low')
    expect(chooseEffort('fix a quick typo', r('sonnet', 'medium', 0.3))).toBe('medium') // unsure: the safer level
    expect(chooseEffort('quick fix', r('opus', 'medium'))).toBe('medium') // Opus's floor
    expect(chooseEffort('carefully check this', r('haiku', 'medium'))).toBe('medium') // Haiku's ceiling
  })
})

describe('routeSubagent (v1.57.0)', () => {
  it('keep leaves the subagent as launched', () => {
    expect(routeSubagent('yes go ahead', cls('keep', 0.95), 'opus').label).toBe('keep')
  })

  it("Haiku only on a clear vote for it, whatever the task's length", () => {
    const long = 'list every test file under the tests folder and print their names ' + Array(40).fill('please').join(' ')
    expect(routeSubagent(long, cls('haiku', 0.95), 'sonnet')).toMatchObject({ label: 'haiku' })
    expect(routeSubagent(long, cls('haiku', 0.95, 0.1), 'sonnet').label).not.toBe('haiku')
    expect(routeSubagent(long, cls('haiku', HAIKU_MIN_CONFIDENCE - 0.01), 'opus').label).not.toBe('haiku')
  })

  it("moves up only when sure, down only when very sure, and takes the new model's level", () => {
    const t = 'design the architecture for the new sync protocol and its failure modes'
    const up = routeSubagent(t, cls('opus', 0.95), 'sonnet')
    expect(up.label).toBe('opus')
    expect(['high', 'xhigh', 'max']).toContain(up.effort)
    // a vote that beats the rules but is under UP_MIN_CONFIDENCE (0.6) does not move it up
    const build = 'implement the settings toggle and its test'
    expect(routeSubagent(build, cls('opus', 0.58), 'sonnet')).toMatchObject({ label: 'sonnet', effort: 'medium' })
    expect(routeSubagent(build, cls('opus', 0.9), 'sonnet')).toMatchObject({ label: 'opus', effort: 'high' })
    // a vote under OVERRIDE_CONFIDENCE leaves it to the rules; a lower model they pick is not taken unless sure
    const vague = 'hmm interesting thought about the colour'
    const ruled = routeMessage(vague, null)
    const down = routeSubagent(vague, null, 'opus')
    expect(down.label).toBe(ruled.confidence < OVERRIDE_CONFIDENCE ? 'opus' : ruled.label)
    expect(routeSubagent(build, cls('sonnet', 0.99), 'opus')).toMatchObject({ label: 'sonnet' })
  })
})
