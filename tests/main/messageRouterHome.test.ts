// MODELHOME: a Claude terminal that did not start on Auto starts on its home model (the Default Models
// pick, the pane's Model menu, or what the session itself asks for), and the router only steps a surely
// simple message down from it, to a cheaper model, coming back home on the next one that is not.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetMessageRouterForTests, configureRouter, isRouterMode, setRouterMode, getRouterMode, registerTerminal,
  setTerminalHome, noteProxyResult, routePrompt, routeAgentTask, routeCodexTurn, type RouterDeps,
} from '../../src/main/messageRouter'
import type { ClassifyResult } from '../../src/main/routerModel'

type Label = 'haiku' | 'sonnet' | 'opus' | 'keep'
const vote = (label: Label, confidence = 0.9, topSim = 0.9, ms = 3): ClassifyResult => ({ cls: { label, confidence, topSim }, ms }) as ClassifyResult

function deps(over: Partial<RouterDeps> = {}) {
  const d = {
    classify: vi.fn(async () => vote('haiku')),
    setRoute: vi.fn(),
    setAgentRoute: vi.fn(),
    notify: vi.fn(),
    now: () => 1_000_000,
    ...over,
  }
  configureRouter(d)
  return d
}

const QUICK = 'what does git stash pop do'
const BUILD = 'fix the failing terminalManager test' // rules: sonnet 0.75
const DEEP = 'think hard about the architecture of the sync engine' // rules: opus 0.8
const GUESS = 'rename foo to bar' // rules: their default, sonnet 0.4
const main = (terminal: string, model: string, asked: string, usage: Record<string, number> = { input_tokens: 10, cache_read_input_tokens: 20_000 }) =>
  noteProxyResult({ terminal, main: true, model, asked, usage }, 1_000_000)

describe('messageRouter: home model (MODELHOME)', () => {
  beforeEach(() => _resetMessageRouterForTests())

  it('modes: every Claude terminal by default, off; the old values move to the new default', () => {
    expect(getRouterMode()).toBe('every')
    expect(isRouterMode('every')).toBe(true)
    expect(isRouterMode('off')).toBe(true)
    expect(isRouterMode('all')).toBe(false)
    expect(setRouterMode('off')).toBe('off')
    expect(setRouterMode('auto-panes')).toBe('every')
    setRouterMode('off')
    expect(setRouterMode('all')).toBe('every')
    expect(setRouterMode('bogus')).toBe('every')
  })

  it('steps a surely simple message down from home, and comes back home on the next one', async () => {
    const d = deps()
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    const e = await routePrompt({ terminalId: 't', prompt: QUICK })
    expect(e).toMatchObject({ model: 'haiku', effort: 'low', from: null, switched: true, reason: 'first' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: 'haiku', effort: 'low', down: true })
    main('t', 'haiku', 'opus')

    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    const back = await routePrompt({ terminalId: 't', prompt: DEEP })
    expect(back).toMatchObject({ model: 'opus', from: 'haiku', effort: null, switched: true, reason: 'home' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: null, effort: null })
    main('t', 'opus', 'opus')

    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    const stay = await routePrompt({ terminalId: 't', prompt: DEEP })
    expect(stay).toMatchObject({ model: 'opus', from: 'opus', effort: null, switched: false, reason: 'at-home' })
    expect(d.setRoute).toHaveBeenCalledTimes(2)
  })

  it('an unsure message runs on home', async () => {
    const d = deps({ classify: vi.fn(async () => null as unknown as ClassifyResult) })
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    expect(await routePrompt({ terminalId: 't', prompt: GUESS })).toMatchObject({ model: 'opus', switched: false, reason: 'at-home' })
    // Nothing to change, but the pane is routed: its subagents and a struggling message still are.
    expect(d.setRoute).toHaveBeenCalledWith('t', { family: null, effort: null })
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.5, 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'opus', reason: 'at-home' })
    expect(d.setRoute).toHaveBeenCalledTimes(1)
  })

  it('never routes above home', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'sonnet')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'sonnet', reason: 'at-home', switched: false })
    setTerminalHome('t', 'haiku')
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.95))
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ model: 'haiku', reason: 'at-home' })
    for (const [, pick] of d.setRoute.mock.calls) expect(pick?.family ?? null).toBeNull()
  })

  it('later step-downs pay for their re-read, and move up only as far as home', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.9)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    // A big, warm conversation on home: Haiku's re-read costs more than it saves on a quick answer.
    main('t', 'opus', 'opus', { input_tokens: 10, cache_read_input_tokens: 170_000 })
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'opus', switched: false, reason: 'switch-costs-more' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: null, effort: null })
    // A small one: it pays.
    main('t', 'opus', 'opus', { input_tokens: 100 })
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', from: 'opus', reason: 'cheaper' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: 'haiku', effort: 'low', down: true })
    main('t', 'haiku', 'opus', { input_tokens: 100 })
    // From Haiku, a sure Sonnet message goes up to Sonnet, still under home, without the up gate.
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.56))
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ model: 'sonnet', from: 'haiku', switched: true, reason: 'needs-stronger' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', expect.objectContaining({ family: 'sonnet', down: true }))
  })

  it('a step-down the API refused climbs back no higher than home', async () => {
    const d = deps({ classify: vi.fn(async () => vote('sonnet', 0.9)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    noteProxyResult({ terminal: 't', refused: 'sonnet' })
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ model: 'opus', reason: 'at-home' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: null, effort: null })
  })

  it('a confirmation stays on the model doing the work', async () => {
    const d = deps({ classify: vi.fn(async () => vote('keep', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    expect(await routePrompt({ terminalId: 't', prompt: 'yes go ahead' })).toBeNull()
    main('t', 'sonnet', 'opus')
    expect(await routePrompt({ terminalId: 't', prompt: 'yes go ahead' })).toMatchObject({ model: 'sonnet', reason: 'keep', switched: false })
    expect(d.setRoute).toHaveBeenCalledTimes(1)
  })

  it('learns home from what the session asks for, and stops routing a model it cannot place', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false) // "Agent's own default": home unknown until the first request
    main('t', 'sonnet', 'sonnet')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'sonnet', reason: 'at-home' })
    noteProxyResult({ terminal: 't', main: true, model: 'fable', asked: 'fable' }, 1_000_000)
    expect(d.setRoute).toHaveBeenLastCalledWith('t', null)
    d.classify.mockClear()
    const e = await routePrompt({ terminalId: 't', prompt: QUICK })
    expect(e).toMatchObject({ unplaced: 'fable', switched: false, reason: 'unplaced', effort: null })
    expect(d.classify).not.toHaveBeenCalled()
    // A subagent's request, or one that is not the session's own, teaches nothing.
    noteProxyResult({ terminal: 't', main: true, agent: true, model: 'opus', asked: 'opus' }, 1_000_000)
    noteProxyResult({ terminal: 't', model: 'opus', asked: 'opus' }, 1_000_000)
    noteProxyResult({ terminal: 't', main: true }, 1_000_000)
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ reason: 'unplaced' })
    // Back on a model it can place.
    main('t', 'opus', 'opus')
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', from: 'opus', reason: 'cheaper' })
    expect(d.classify).toHaveBeenCalled()
  })

  it('home unknown: a sure step-down is sent for the proxy to apply only below what the session asks', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.9)) })
    registerTerminal('t', false)
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', reason: 'first', switched: true })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: 'haiku', effort: 'low', down: true })
    _resetMessageRouterForTests()
    const d2 = deps({ classify: vi.fn(async () => vote('opus', 0.9)) })
    registerTerminal('t', false)
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toBeNull()
    expect(d2.setRoute).toHaveBeenLastCalledWith('t', { family: null, effort: null })
  })

  it('setTerminalHome: model names, bad input, and a new home clears a step-down', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.9)) })
    setTerminalHome(5, 'opus')
    setTerminalHome('bad id!', 'opus')
    expect(d.setRoute).not.toHaveBeenCalled()
    registerTerminal('t', true) // an Auto pane picked by hand becomes a home pane
    setTerminalHome('t', 'claude-sonnet-5-5')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'sonnet', reason: 'at-home' })
    setTerminalHome('t', 'opusplan')
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', expect.objectContaining({ family: 'haiku', down: true }))
    setTerminalHome('t', 'sonnet')
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: null, effort: null })
    setTerminalHome('t', 'fable')
    expect(d.setRoute).toHaveBeenLastCalledWith('t', null)
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ reason: 'unplaced', unplaced: 'fable' })
    setTerminalHome('t', 'some-new-model-9')
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ unplaced: 'some-new-model-9' })
    setTerminalHome('t', 'x'.repeat(200))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ unplaced: 'other' })
    setTerminalHome('t', '')
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', reason: 'first' })
    setTerminalHome('t', undefined)
    // A relaunch (terminal:create again) forgets the home.
    setTerminalHome('t', 'fable')
    registerTerminal('t', false)
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku' })
  })

  it('a home pane is not routed when the router is off, and an Auto pane still routes freely', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.9)) })
    registerTerminal('auto', true)
    main('auto', 'sonnet', 'sonnet', { input_tokens: 100 })
    expect(await routePrompt({ terminalId: 'auto', prompt: DEEP })).toMatchObject({ model: 'opus', from: 'sonnet', reason: 'needs-stronger' })
    expect(d.setRoute).toHaveBeenLastCalledWith('auto', expect.objectContaining({ family: 'opus' }))
    expect(d.setRoute.mock.lastCall?.[1]).not.toHaveProperty('down')
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    setRouterMode('off')
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toBeNull()
  })

  it('a Codex terminal that sets its own effort is still left as it is', async () => {
    const d = deps({ setCodexRoute: vi.fn() })
    registerTerminal('c', false, true)
    expect(await routeCodexTurn({ terminal: 'c', key: 1, task: QUICK, asked: 'high' })).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 1, null)
  })

  it('setTerminalHome on a terminal it does not know does nothing', () => {
    const d = deps()
    setTerminalHome('nobody', 'opus')
    expect(d.setRoute).not.toHaveBeenCalled()
  })

  it('a session that asks for the model it was stepped down to is no longer stepped down', async () => {
    const d = deps()
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    await routePrompt({ terminalId: 't', prompt: QUICK }) // haiku, down from opus
    // The user switched the session itself to Haiku (/model): home is Haiku now, nothing to step down.
    main('t', 'haiku', 'haiku')
    d.setRoute.mockClear()
    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'haiku', reason: 'at-home', switched: false })
    expect(d.setRoute).not.toHaveBeenCalled()
  })

  it('a refusal of the model it was stepped down to ends the step down', async () => {
    const d = deps()
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    await routePrompt({ terminalId: 't', prompt: QUICK })
    noteProxyResult({ terminal: 't', main: true, model: 'opus', refused: 'haiku', usage: { input_tokens: 10 } }, 1_000_000)
    d.setRoute.mockClear()
    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    // Not routed any more: the message is simply at home, with nothing to undo.
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'opus', reason: 'at-home' })
  })

  it('a home that became one it cannot place while the vote ran is not routed', async () => {
    let answer: (r: ClassifyResult) => void = () => {}
    const d = deps({ classify: vi.fn(() => new Promise<ClassifyResult>((r) => { answer = r })) })
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    const p = routePrompt({ terminalId: 't', prompt: QUICK })
    setTerminalHome('t', 'claude-fable-1')
    answer(vote('haiku'))
    expect(await p).toMatchObject({ reason: 'unplaced', unplaced: 'fable', switched: false })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', null)
  })

  it("a home pane's subagents never run above home or what they asked for", async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'sonnet')
    const e = await routeAgentTask({ terminal: 't', key: 1, task: DEEP, asked: 'haiku', effort: null })
    expect(e).toMatchObject({ model: 'sonnet', agent: true })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 1, expect.objectContaining({ family: 'sonnet' }))
    // Asked above home by Claude Code itself: it may stay where it asked.
    await routeAgentTask({ terminal: 't', key: 2, task: DEEP, asked: 'opus', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 2, expect.objectContaining({ family: 'opus' }))
    // An unplaced pane's subagents are left alone.
    setTerminalHome('t', 'fable')
    expect(await routeAgentTask({ terminal: 't', key: 3, task: DEEP, asked: 'sonnet', effort: null })).toBeNull()
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 3, null)
  })
})
