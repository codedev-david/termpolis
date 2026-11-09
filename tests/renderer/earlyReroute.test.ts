// v1.55.0 Task 9: after a Claude session's first prompt, the header may offer a better-fitting model.
import { describe, it, expect, beforeEach } from 'vitest'
import { REROUTE_MAX_TURNS, rerouteChipText, rerouteOffer, runningClaudeModel, shouldOfferReroute } from '../../src/renderer/src/lib/earlyReroute'
import { ROUTER_TUNING_KEY, autoLaunchArgs, noteMisroute, routerTuning } from '../../src/renderer/src/lib/autoModel'
import { DEFAULT_ROUTER_TUNING, MISROUTE_LIMIT, type RouteDecision } from '../../src/shared/taskRouter'

const LOOKUP = 'explain what the release workflow does'
const DEEP = 'design the plugin architecture for the new sync engine'
const deep: RouteDecision = { model: 'opus', effort: 'high', rule: 'deep', confidence: 0.8 }

describe('early re-route', () => {
  it('down chip for a lookup on opus', () => {
    expect(rerouteOffer(LOOKUP, 'opus')).toEqual({ direction: 'down', model: 'haiku', text: 'Looks like a quick lookup. Continue on Haiku?' })
  })

  it('up chip for deep work on haiku or sonnet', () => {
    expect(rerouteOffer(DEEP, 'haiku')?.text).toBe('This looks deep. Switch to Opus?')
    expect(rerouteOffer(DEEP, 'sonnet')?.direction).toBe('up')
  })

  it('no chip after turn 2', () => {
    expect(shouldOfferReroute('haiku', deep, REROUTE_MAX_TURNS)).toBe('up')
    expect(shouldOfferReroute('haiku', deep, REROUTE_MAX_TURNS + 1)).toBeNull()
    expect(rerouteOffer(DEEP, 'haiku', 3)).toBeNull()
  })

  it('no chip for the same tier, the default rule (a guess), or an empty prompt', () => {
    expect(rerouteOffer(DEEP, 'opus')).toBeNull()
    expect(rerouteOffer(DEEP, 'opusplan')).toBeNull()
    expect(rerouteOffer('hello there my friend', 'haiku')).toBeNull()
    expect(rerouteOffer('   ', 'opus')).toBeNull()
    expect(shouldOfferReroute('opus', { ...deep, rule: 'no-task', model: 'opusplan' }, 1)).toBeNull()
  })

  it('an unknown model (a session started by hand without --model) is offered only Haiku', () => {
    expect(rerouteOffer(LOOKUP, null)?.model).toBe('haiku')
    expect(rerouteOffer(DEEP, null)).toBeNull()
  })

  it('words for each direction', () => {
    expect(rerouteChipText('down', 'sonnet')).toBe('Looks like everyday work. Continue on Sonnet?')
    expect(rerouteChipText('up', 'sonnet')).toBe('This looks like more than a lookup. Switch to Sonnet?')
  })

  it('knows the running model from the picker, then Auto, then the launch line', () => {
    const routed = deep
    expect(runningClaudeModel({ liveModel: 'sonnet', routed, agentCommand: 'claude --model haiku' })).toBe('sonnet')
    expect(runningClaudeModel({ liveModel: 'claude-haiku-5-5', routed })).toBe('haiku')
    expect(runningClaudeModel({ liveModel: '', routed, agentCommand: 'claude --model haiku' })).toBe('opus')
    expect(runningClaudeModel({ agentCommand: 'claude --model=sonnet --effort low' })).toBe('sonnet')
    expect(runningClaudeModel({ agentCommand: 'claude --model gpt-5' })).toBeNull()
    expect(runningClaudeModel({})).toBeNull()
  })
})

describe('router tuning', () => {
  beforeEach(() => localStorage.clear())

  it('starts at the default, and survives bad or broken storage', () => {
    expect(routerTuning()).toEqual(DEFAULT_ROUTER_TUNING)
    localStorage.setItem(ROUTER_TUNING_KEY, '{nope')
    expect(routerTuning()).toEqual(DEFAULT_ROUTER_TUNING)
    localStorage.setItem(ROUTER_TUNING_KEY, JSON.stringify({ haikuMaxWords: -4, misroutes: { lookup: 2, build: 'x', deep: 1.5 } }))
    expect(routerTuning()).toEqual({ haikuMaxWords: 25, misroutes: { lookup: 2 } })
    localStorage.setItem(ROUTER_TUNING_KEY, JSON.stringify({ haikuMaxWords: 40, misroutes: [] }))
    expect(routerTuning()).toEqual({ haikuMaxWords: 40, misroutes: {} })
    localStorage.setItem(ROUTER_TUNING_KEY, 'null')
    expect(routerTuning()).toEqual(DEFAULT_ROUTER_TUNING)
  })

  it('a rule moved up MISROUTE_LIMIT times routes one tier up at the next Auto launch', () => {
    expect(autoLaunchArgs(LOOKUP, 'claude').decision?.model).toBe('haiku')
    for (let i = 0; i < MISROUTE_LIMIT; i++) noteMisroute('lookup')
    expect(routerTuning().misroutes.lookup).toBe(MISROUTE_LIMIT)
    expect(autoLaunchArgs(LOOKUP, 'claude').decision?.model).toBe('sonnet')
  })
})
