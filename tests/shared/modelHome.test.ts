// MODELHOME: the router ranks models by price, and a terminal started on a model of the user's choosing
// (its home) only steps down from it, to a cheaper model, when the message is surely simple.
import { describe, it, expect } from 'vitest'
import { BY_PRICE, PRICE, priceRank, cheaper, rankByPrice } from '../../src/shared/switchEconomics'
import { homeRoute, routeMessage, routeSubagent, TOP_LABEL, DOWN_MIN_CONFIDENCE, OVERRIDE_CONFIDENCE, type Classification } from '../../src/shared/smartRoute'
import { AGENT_MODEL_TIERS, CLAUDE_MODEL_OPTIONS } from '../../src/renderer/src/lib/modelBroker'

const cls = (label: Classification['label'], confidence: number, topSim = 0.9): Classification => ({ label, confidence, topSim })
const QUICK = 'what does git stash pop do' // a quick question: Haiku on a clear vote
const BUILD = 'fix the failing terminalManager test' // the word rules: sonnet 0.75

describe('price rank', () => {
  it('orders the families cheapest first, by their list price', () => {
    expect(BY_PRICE).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    for (let i = 1; i < BY_PRICE.length; i++) expect(PRICE[BY_PRICE[i]].out).toBeGreaterThan(PRICE[BY_PRICE[i - 1]].out)
    expect(priceRank('haiku')).toBe(0)
    expect(priceRank('opus')).toBe(2)
    expect(cheaper('sonnet', 'opus')).toBe(true)
    expect(cheaper('opus', 'opus')).toBe(false)
    expect(cheaper('opus', 'haiku')).toBe(false)
  })

  it('a new family slots in by its price, and a tie on output goes to the cheaper input', () => {
    expect(rankByPrice({ ...PRICE, nova: { in: 1, out: 10 } })).toEqual(['haiku', 'nova', 'sonnet', 'opus', 'fable'])
    expect(rankByPrice({ ...PRICE, nova: { in: 6, out: 30 } })).toEqual(['haiku', 'sonnet', 'opus', 'nova', 'fable'])
    expect(rankByPrice({ a: { in: 4, out: 10 }, b: { in: 2, out: 10 } })).toEqual(['b', 'a'])
  })

  it("the model menu's savings come from the same prices", () => {
    const top = PRICE.opus.out
    expect(AGENT_MODEL_TIERS.claude.cost).toEqual({ economy: PRICE.haiku.out / top, standard: PRICE.sonnet.out / top, premium: 1 })
    const pct = (alias: string) => CLAUDE_MODEL_OPTIONS.find((o) => o.alias === alias)?.savingsPct
    expect(pct('opus')).toBe(0)
    expect(pct('sonnet')).toBe(Math.round((1 - PRICE.sonnet.out / top) * 100))
    expect(pct('haiku')).toBe(Math.round((1 - PRICE.haiku.out / top) * 100))
  })
})

describe('homeRoute', () => {
  it('steps down the bar the seeds were measured at', () => {
    expect(DOWN_MIN_CONFIDENCE).toBe(OVERRIDE_CONFIDENCE)
    expect(DOWN_MIN_CONFIDENCE).toBe(0.55)
  })

  it('steps a surely simple message down from home, to the cheaper model it fits', () => {
    expect(homeRoute(QUICK, cls('haiku', 0.9), 'opus')).toMatchObject({ label: 'haiku' })
    expect(homeRoute(BUILD, cls('sonnet', 0.8), 'opus')).toMatchObject({ label: 'sonnet', effort: routeMessage(BUILD, cls('sonnet', 0.8)).effort })
    expect(homeRoute(QUICK, cls('haiku', 0.9), 'sonnet')).toMatchObject({ label: 'haiku' })
  })

  it('keeps a message it is unsure of on home', () => {
    // The word rules' own build rule is sure (0.75): that steps down even with no vote.
    expect(homeRoute(BUILD, null, 'opus').label).toBe('sonnet')
    // Their default (0.4, "probably sonnet") is a guess: it stays home.
    expect(routeMessage('rename foo to bar', null)).toMatchObject({ label: 'sonnet', confidence: 0.4 })
    expect(homeRoute('rename foo to bar', null, 'opus')).toMatchObject({ label: 'opus' })
    // A vote just under the bar against a rule that wants more stays home too.
    expect(homeRoute('think hard about the architecture of the sync engine', cls('sonnet', 0.54), 'opus').label).toBe('opus')
  })

  it('never routes above home', () => {
    expect(homeRoute('design the new storage architecture and migrate every caller', cls('opus', 0.95), 'sonnet').label).toBe('sonnet')
    expect(homeRoute(BUILD, cls('sonnet', 0.9), 'haiku').label).toBe('haiku')
    expect(homeRoute(BUILD, cls('sonnet', 0.9), 'sonnet').label).toBe('sonnet')
  })

  it('a confirmation stays where the work is', () => {
    expect(homeRoute('yes go ahead', cls('keep', 0.95), 'opus').label).toBe('keep')
  })

  it('from a Fable home only the Haiku and Sonnet labels step down: a message labelled Opus stays on Fable', () => {
    expect(TOP_LABEL).toBe('opus')
    expect(homeRoute(QUICK, cls('haiku', 0.9), 'fable')).toMatchObject({ label: 'haiku' })
    expect(homeRoute(BUILD, cls('sonnet', 0.8), 'fable')).toMatchObject({ label: 'sonnet' })
    // The classifier's hardest class is as sure as it gets, and still not a reason to leave Fable.
    expect(homeRoute('design the new storage architecture and migrate every caller', cls('opus', 0.95), 'fable').label).toBe('fable')
    expect(homeRoute('rename foo to bar', null, 'fable').label).toBe('fable')
  })

  it('a subagent that asked for Fable keeps it for a task labelled Opus, and steps down for a simple one', () => {
    const deep = 'design the new storage architecture and migrate every caller'
    expect(routeSubagent(deep, cls('opus', 0.95), 'fable')).toMatchObject({ label: 'fable', effort: 'high' })
    expect(routeSubagent(BUILD, cls('sonnet', 0.9), 'fable').label).toBe('sonnet')
    // Asked for Opus, the same task stays on Opus, as before.
    expect(routeSubagent(deep, cls('opus', 0.95), 'opus').label).toBe('opus')
  })
})
