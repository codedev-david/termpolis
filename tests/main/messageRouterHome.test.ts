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
    // Surely simple, but the one cheaper model it fits is refused: the tooltip says so, not "not surely simple".
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ model: 'opus', reason: 'nothing-cheaper' })
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

  it("learns an Agent's-own-default home once, from the session's first own request", async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false) // "Agent's own default": home unknown until the first request
    // A subagent's request, or one that is not the session's own, teaches nothing.
    noteProxyResult({ terminal: 't', main: true, agent: true, model: 'opus', asked: 'opus' }, 1_000_000)
    noteProxyResult({ terminal: 't', model: 'opus', asked: 'opus' }, 1_000_000)
    noteProxyResult({ terminal: 't', main: true }, 1_000_000)
    main('t', 'sonnet', 'sonnet')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'sonnet', reason: 'at-home' })
    // Later requests that ask for another model (opusplan's planning turns, /model in the session) do
    // not move the home: the first one set it.
    main('t', 'opus', 'opus')
    // The chip names what runs: the session's own ask, with the home beside it.
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'opus', home: 'sonnet', reason: 'at-home' })
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', reason: 'cheaper' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', expect.objectContaining({ family: 'haiku', down: true }))
  })

  it('a learned home the router cannot place stops routing the pane', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.9)) })
    registerTerminal('t', false)
    // The proxy reports a model it cannot name a family for as 'other'.
    noteProxyResult({ terminal: 't', main: true, model: 'other', asked: 'other' }, 1_000_000)
    const e = await routePrompt({ terminalId: 't', prompt: QUICK })
    expect(e).toMatchObject({ unplaced: 'other', switched: false, reason: 'unplaced', effort: null })
    expect(d.classify).not.toHaveBeenCalled()
    // Learned once: a later request does not route it again; a pick in the Model menu does.
    main('t', 'opus', 'opus')
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ reason: 'unplaced' })
    setTerminalHome('t', 'opus')
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', from: 'opus', reason: 'cheaper' })
  })

  it('a Fable home steps down like any other, and a message labelled Opus stays on Fable', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false)
    main('t', 'fable', 'fable') // learned from the session's first request
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'fable', reason: 'at-home', switched: false })
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', from: 'fable', reason: 'cheaper' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: 'haiku', effort: 'low', down: true })
    main('t', 'haiku', 'fable')
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ model: 'sonnet', from: 'haiku', reason: 'needs-stronger' })
    main('t', 'sonnet', 'fable')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'fable', from: 'sonnet', reason: 'home', switched: true })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', { family: null, effort: null })
  })

  it('an Auto pane never climbs to Fable past a refused Opus', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('a', true)
    noteProxyResult({ terminal: 'a', refused: 'opus' })
    main('a', 'sonnet', 'sonnet', { input_tokens: 100 })
    expect(await routePrompt({ terminalId: 'a', prompt: DEEP })).toBeNull()
    await routeAgentTask({ terminal: 'a', key: 1, task: DEEP, asked: 'sonnet', effort: null })
    for (const [, pick] of d.setRoute.mock.calls) expect(pick?.family ?? null).not.toBe('fable')
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('a', 1, expect.objectContaining({ family: 'sonnet' }))
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
    // Fable is a family the router ranks by price: a home like the others.
    setTerminalHome('t', 'claude-fable-5-2')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'fable', reason: 'at-home' })
    setTerminalHome('t', 'some-new-model-9')
    expect(d.setRoute).toHaveBeenLastCalledWith('t', null)
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ unplaced: 'some-new-model-9' })
    setTerminalHome('t', 'x'.repeat(200))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ unplaced: 'other' })
    setTerminalHome('t', '')
    d.classify.mockResolvedValueOnce(vote('haiku', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', reason: 'first' })
    setTerminalHome('t', undefined)
    // A relaunch (terminal:create again) forgets the home.
    setTerminalHome('t', 'some-new-model-9')
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

  it('a Codex terminal that sets its own effort steps down from it, never above it', async () => {
    const d = deps({ setCodexRoute: vi.fn() })
    registerTerminal('c', false, true)
    // A quick question: down from the command's high to low.
    expect(await routeCodexTurn({ terminal: 'c', key: 1, task: QUICK, asked: 'high' }))
      .toMatchObject({ codex: { effort: 'low', from: 'high' }, switched: true, reason: 'codex' })
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 1, 'low')
    // A hard one would run at high on Auto; launched at medium, it stays at medium.
    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    expect(await routeCodexTurn({ terminal: 'c', key: 2, task: DEEP, asked: 'medium' }))
      .toMatchObject({ codex: { effort: 'medium', from: 'low' }, switched: false, reason: 'at-home' })
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 2, null)
    // Unsure: it runs at its own effort.
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.5, 0.9))
    expect(await routeCodexTurn({ terminal: 'c', key: 3, task: GUESS, asked: 'xhigh' })).toMatchObject({ codex: { effort: 'xhigh' }, reason: 'at-home' })
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 3, null)
    // A sure build message runs lighter than xhigh.
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.9))
    const build = await routeCodexTurn({ terminal: 'c', key: 4, task: BUILD, asked: 'xhigh' })
    expect(build).toMatchObject({ reason: 'codex', switched: true })
    expect(['low', 'medium', 'high']).toContain(build?.codex?.effort)
    // An effort the router cannot read is not stepped down from: nothing to measure "down" against.
    d.classify.mockClear()
    expect(await routeCodexTurn({ terminal: 'c', key: 5, task: QUICK, asked: 'turbo' })).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 5, null)
    expect(d.classify).not.toHaveBeenCalled()
    // Off is off.
    setRouterMode('off')
    expect(await routeCodexTurn({ terminal: 'c', key: 6, task: QUICK, asked: 'high' })).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 6, null)
  })

  it("a confirmation on an own-effort Codex terminal carries on at the effort the work ran at, capped at the command's", async () => {
    const d = deps({ setCodexRoute: vi.fn() })
    registerTerminal('c', false, true)
    d.classify.mockResolvedValueOnce(vote('keep', 0.95))
    expect(await routeCodexTurn({ terminal: 'c', key: 1, task: 'yes go ahead', asked: 'high' })).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 1, null)
    await routeCodexTurn({ terminal: 'c', key: 2, task: QUICK, asked: 'high' }) // low
    d.classify.mockResolvedValueOnce(vote('keep', 0.95))
    expect(await routeCodexTurn({ terminal: 'c', key: 3, task: 'yes go ahead', asked: 'high' })).toMatchObject({ codex: { effort: 'low' }, reason: 'keep' })
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 3, 'low')
    d.classify.mockResolvedValueOnce(vote('keep', 0.95))
    expect(await routeCodexTurn({ terminal: 'c', key: 4, task: 'yes go ahead', asked: 'minimal' })).toMatchObject({ codex: { effort: 'minimal' }, reason: 'keep' })
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c', 4, null)
  })

  it('setTerminalHome on a terminal it does not know does nothing', () => {
    const d = deps()
    setTerminalHome('nobody', 'opus')
    expect(d.setRoute).not.toHaveBeenCalled()
  })

  it('an explicit home stays when the session asks for another model; a step down it no longer needs ends', async () => {
    const d = deps()
    registerTerminal('t', false)
    setTerminalHome('t', 'opus')
    // The old session's last result, or /model inside the session, does not move a home the user picked.
    main('t', 'sonnet', 'sonnet')
    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    // It runs on what the session asks for, and the chip says so, with the home beside it.
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'sonnet', home: 'opus', reason: 'at-home' })
    await routePrompt({ terminalId: 't', prompt: QUICK }) // haiku, down from opus
    // The session itself asks for Haiku now: the proxy will not apply the step down, so it is not one.
    main('t', 'haiku', 'haiku')
    d.setRoute.mockClear()
    d.classify.mockResolvedValueOnce(vote('opus', 0.9))
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'haiku', home: 'opus', reason: 'at-home', switched: false })
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
    setTerminalHome('t', 'some-new-model-9')
    answer(vote('haiku'))
    expect(await p).toMatchObject({ reason: 'unplaced', unplaced: 'some-new-model-9', switched: false })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', null)
  })

  it("a home pane's subagents never run above home or what they asked for", async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'sonnet')
    // The ceiling is the lower of the two: a subagent that asked for Haiku stays on Haiku, however hard
    // its task looks.
    const e = await routeAgentTask({ terminal: 't', key: 1, task: DEEP, asked: 'haiku', effort: null })
    expect(e).toMatchObject({ model: 'haiku', agent: true })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 1, expect.objectContaining({ family: 'haiku' }))
    // Asked above home by Claude Code itself: it comes down to home.
    const up = await routeAgentTask({ terminal: 't', key: 2, task: DEEP, asked: 'opus', effort: null })
    expect(up).toMatchObject({ model: 'sonnet', from: 'opus', switched: true })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 2, expect.objectContaining({ family: 'sonnet' }))
    // An Auto pane's subagent may still go up to what its task needs.
    registerTerminal('a', true)
    await routeAgentTask({ terminal: 'a', key: 4, task: DEEP, asked: 'haiku', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('a', 4, expect.objectContaining({ family: 'opus' }))
    // A Fable home's subagent asked for Fable keeps it for a hard task, and steps down for a simple one.
    registerTerminal('f', false)
    setTerminalHome('f', 'fable')
    await routeAgentTask({ terminal: 'f', key: 5, task: DEEP, asked: 'fable', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('f', 5, expect.objectContaining({ family: 'fable' }))
    d.classify.mockResolvedValueOnce(vote('sonnet', 0.95))
    await routeAgentTask({ terminal: 'f', key: 6, task: BUILD, asked: 'fable', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('f', 6, expect.objectContaining({ family: 'sonnet' }))
    // An unplaced pane's subagents are left alone.
    setTerminalHome('t', 'some-new-model-9')
    expect(await routeAgentTask({ terminal: 't', key: 3, task: DEEP, asked: 'sonnet', effort: null })).toBeNull()
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 3, null)
  })

  it("after a refused step down, a home pane's subagents look further down, never above home", async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'sonnet')
    // One 400 on a subagent request rewritten to Sonnet: the proxy marks Sonnet refused for the pane.
    noteProxyResult({ terminal: 't', refused: 'sonnet' })
    const e = await routeAgentTask({ terminal: 't', key: 1, task: DEEP, asked: 'opus', effort: null })
    expect(e).toMatchObject({ model: 'haiku', from: 'opus', agent: true, switched: true })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('t', 1, expect.objectContaining({ family: 'haiku' }))
    // Nothing at or below home is left: only then does it run as Claude Code asked.
    noteProxyResult({ terminal: 't', refused: 'haiku' })
    expect(await routeAgentTask({ terminal: 't', key: 2, task: DEEP, asked: 'opus', effort: null })).toMatchObject({ model: 'opus' })
    // An Auto pane is not searched downward: a refused climb falls back to what it asked.
    registerTerminal('a', true)
    noteProxyResult({ terminal: 'a', refused: 'opus' })
    await routeAgentTask({ terminal: 'a', key: 3, task: DEEP, asked: 'opus', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('a', 3, expect.objectContaining({ family: 'opus' }))
  })

  it("a home pane's subagent never thinks harder than it asked, or than its model's default", async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('o', false)
    setTerminalHome('o', 'opus')
    // No effort asked: Opus's default is medium, so a design task is sent at medium, not xhigh.
    const o = await routeAgentTask({ terminal: 'o', key: 1, task: DEEP, asked: 'opus', effort: null })
    expect(o).toMatchObject({ model: 'opus', effort: 'medium', switched: false })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('o', 1, { family: 'opus', effort: 'medium' })
    // Asked for low: it stays at low.
    await routeAgentTask({ terminal: 'o', key: 2, task: DEEP, asked: 'opus', effort: 'low' })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('o', 2, { family: 'opus', effort: 'low' })
    registerTerminal('s', false)
    setTerminalHome('s', 'sonnet')
    // Sonnet's default is high.
    await routeAgentTask({ terminal: 's', key: 3, task: DEEP, asked: 'sonnet', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('s', 3, { family: 'sonnet', effort: 'high' })
    // Asked for medium (the conductor's reviewers): never above it.
    await routeAgentTask({ terminal: 's', key: 4, task: DEEP, asked: 'sonnet', effort: 'medium' })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('s', 4, { family: 'sonnet', effort: 'medium' })
    // A lighter effort the route picked stays lighter.
    d.classify.mockResolvedValueOnce(vote('haiku', 0.95))
    await routeAgentTask({ terminal: 's', key: 5, task: 'list the files in src', asked: 'sonnet', effort: 'high' })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('s', 5, { family: 'haiku', effort: 'low' })
    // An Auto pane's subagent may still think harder than it asked.
    registerTerminal('a', true)
    await routeAgentTask({ terminal: 'a', key: 6, task: DEEP, asked: 'opus', effort: null })
    expect(d.setAgentRoute).toHaveBeenLastCalledWith('a', 6, { family: 'opus', effort: 'xhigh' })
  })

  it('a /model typed in the session shows on the chip: what runs, beside the home', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'haiku')
    // The user typed /model opus inside Claude: Termpolis does not see it, but the proxy sees its requests.
    main('t', 'opus', 'opus')
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'opus', home: 'haiku', reason: 'at-home', switched: false })
    // A subagent's request, or one not the session's own, says nothing of what the session runs.
    noteProxyResult({ terminal: 't', main: true, agent: true, model: 'sonnet' }, 1_000_000)
    noteProxyResult({ terminal: 't', model: 'sonnet' }, 1_000_000)
    expect(await routePrompt({ terminalId: 't', prompt: DEEP })).toMatchObject({ model: 'opus', home: 'haiku' })
    // Back on the home model: no home beside it.
    main('t', 'haiku', 'haiku')
    const e = await routePrompt({ terminalId: 't', prompt: DEEP })
    expect(e).toMatchObject({ model: 'haiku', reason: 'at-home' })
    expect(e).not.toHaveProperty('home')
    expect(d.setRoute.mock.calls.every(([, p]) => p?.family == null)).toBe(true)
  })

  it('a surely simple message with nothing cheaper than home says so', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.95)) })
    registerTerminal('t', false)
    setTerminalHome('t', 'haiku')
    expect(await routePrompt({ terminalId: 't', prompt: QUICK })).toMatchObject({ model: 'haiku', reason: 'nothing-cheaper', switched: false })
    // An unsure one is still "not surely simple".
    setTerminalHome('t', 'sonnet')
    d.classify.mockResolvedValueOnce(null as unknown as ClassifyResult)
    expect(await routePrompt({ terminalId: 't', prompt: GUESS })).toMatchObject({ model: 'sonnet', reason: 'at-home' })
  })

  it('a first message routed before the home was known gets its chip put right once the home is learned', async () => {
    const d = deps({ classify: vi.fn(async () => vote('sonnet', 0.9)) })
    registerTerminal('t', false)
    // Home unknown: a building message is stepped to Sonnet from the dearest model.
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ model: 'sonnet', switched: true, reason: 'first' })
    // The session asks for Haiku: the proxy ran it there, and the chip now says so.
    main('t', 'haiku', 'haiku')
    expect(d.notify).toHaveBeenLastCalledWith(expect.objectContaining({ terminalId: 't', model: 'haiku', switched: false, reason: 'at-home', saving: 0 }))
    const n = d.notify.mock.calls.length
    // Learned once: a later result changes nothing.
    main('t', 'haiku', 'haiku')
    expect(d.notify.mock.calls.length).toBe(n)
    // A sure quick vote above the learned home reads "nothing cheaper".
    d.classify.mockResolvedValue(vote('haiku', 0.95))
    registerTerminal('u', false)
    // A step down still under the learned home was right: nothing to correct.
    await routePrompt({ terminalId: 'u', prompt: QUICK })
    const stepped = d.notify.mock.calls.length
    main('u', 'opus', 'opus')
    expect(d.notify.mock.calls.length).toBe(stepped)
    const before = d.notify.mock.calls.length
    registerTerminal('v', false)
    await routePrompt({ terminalId: 'v', prompt: QUICK })
    main('v', 'haiku', 'haiku')
    expect(d.notify.mock.calls.length).toBe(before + 2)
    expect(d.notify).toHaveBeenLastCalledWith(expect.objectContaining({ terminalId: 'v', model: 'haiku', reason: 'nothing-cheaper' }))
  })
})
