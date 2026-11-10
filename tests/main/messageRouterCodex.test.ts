// v1.58.0 Codex effort per message: main's half (messageRouter.routeCodexTurn).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetMessageRouterForTests, configureRouter, registerTerminal, forgetTerminal, pinTerminal, setRouterMode, routeCodexTurn, routePrompt,
  CODEX_EFFORT_OF, type RouterDeps,
} from '../../src/main/messageRouter'
import type { ClassifyResult } from '../../src/main/routerModel'

const vote = (label: string, confidence = 0.95, topSim = 0.95, ms = 4): ClassifyResult =>
  ({ cls: { label, confidence, topSim }, ms }) as unknown as ClassifyResult

function deps(over: Partial<RouterDeps> = {}) {
  const d = {
    classify: vi.fn(async () => vote('sonnet')),
    setRoute: vi.fn(),
    setCodexRoute: vi.fn(),
    forgetCodex: vi.fn(),
    notify: vi.fn(),
    now: () => 1_000_000,
    ...over,
  }
  configureRouter(d as RouterDeps)
  return d
}

const BUILD = 'fix the failing terminalManager test'
const turn = (task: unknown = BUILD, extra: Record<string, unknown> = {}) => routeCodexTurn({ terminal: 'c1', key: 1, task, asked: 'medium', ...extra })

describe('routeCodexTurn', () => {
  beforeEach(() => _resetMessageRouterForTests())

  it('maps every router effort onto one Codex takes', () => {
    expect(CODEX_EFFORT_OF).toEqual({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' })
  })

  it('does nothing without deps, a Codex sender, an id or a key', async () => {
    expect(await turn()).toBeNull()
    configureRouter({ classify: vi.fn(), setRoute: vi.fn(), notify: vi.fn() } as unknown as RouterDeps)
    expect(await turn()).toBeNull()
    const d = deps()
    expect(await routeCodexTurn({ terminal: 5, key: 1, task: BUILD })).toBeNull()
    expect(await routeCodexTurn({ terminal: 'c1', key: '1', task: BUILD })).toBeNull()
    expect(await routeCodexTurn(undefined as unknown as { terminal: string })).toBeNull()
    expect(d.setCodexRoute).not.toHaveBeenCalled()
  })

  it('answers null for an unknown, Claude, pinned or empty-message terminal, and with the router off', async () => {
    const d = deps()
    expect(await turn()).toBeNull()
    registerTerminal('c1', true) // a Claude terminal
    expect(await turn()).toBeNull()
    registerTerminal('c1', true, true)
    expect(await turn('   ')).toBeNull()
    expect(await turn(7)).toBeNull()
    pinTerminal('c1')
    expect(await turn()).toBeNull()
    registerTerminal('c1', true, true)
    setRouterMode('off')
    expect(await turn()).toBeNull()
    expect(d.setCodexRoute.mock.calls.every((c) => c[2] === null)).toBe(true)
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('routes a Codex terminal, sends the effort and tells the pane', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku')) })
    registerTerminal('c1', true, true)
    const e = await turn('what does this flag do?')
    expect(d.setCodexRoute).toHaveBeenCalledWith('c1', 1, 'low')
    expect(e).toMatchObject({ terminalId: 'c1', model: 'haiku', from: null, codex: { effort: 'low', from: 'medium' }, switched: true, reason: 'codex', saving: 0 })
    expect(d.notify).toHaveBeenCalledWith(e)
    // The next turn's "from" is the effort the last one ran at.
    d.classify.mockResolvedValueOnce(vote('opus'))
    const e2 = await routeCodexTurn({ terminal: 'c1', key: 2, task: 'design the architecture for the new sync protocol and its failure modes', asked: 'medium' })
    expect(e2?.codex?.from).toBe('low')
    expect(['high', 'xhigh']).toContain(e2?.codex?.effort)
  })

  it('a confirmation keeps the effort the work ran at, and is not routed before there is one', async () => {
    const d = deps({ classify: vi.fn(async () => vote('keep')) })
    registerTerminal('c1', true, true)
    expect(await turn('yes')).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c1', 1, null)
    d.classify.mockResolvedValueOnce(vote('sonnet'))
    await routeCodexTurn({ terminal: 'c1', key: 2, task: BUILD, asked: 'medium' })
    const sent = d.setCodexRoute.mock.calls.at(-1)?.[2]
    const kept = await routeCodexTurn({ terminal: 'c1', key: 3, task: 'yes', asked: 'bogus' })
    expect(kept).toMatchObject({ reason: 'keep', model: 'sonnet', codex: { effort: sent, from: sent } })
    expect(kept?.switched).toBe(true) // asked was not an effort Codex knows
  })

  it('a Codex command that set its own effort is routed only when every terminal is', async () => {
    const d = deps()
    registerTerminal('c1', false, true)
    expect(await turn()).toBeNull()
    setRouterMode('all')
    expect(await turn()).not.toBeNull()
    expect(d.setCodexRoute).toHaveBeenCalledTimes(2)
  })

  it('a vote it is not sure enough of runs as Codex asked', async () => {
    const d = deps({ classify: vi.fn(async () => vote('opus', 0.2, 0.2)) })
    registerTerminal('c1', true, true)
    expect(await turn('hmm interesting thought about the colour')).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c1', 1, null)
  })

  it('a terminal closed or pinned while the vote ran gets null', async () => {
    let release!: (r: ClassifyResult) => void
    const d = deps({ classify: vi.fn(() => new Promise<ClassifyResult>((r) => { release = r })) })
    registerTerminal('c1', true, true)
    const p = turn()
    await Promise.resolve()
    forgetTerminal('c1')
    expect(d.forgetCodex).toHaveBeenCalledWith('c1')
    release(vote('sonnet'))
    expect(await p).toBeNull()
    expect(d.setCodexRoute).toHaveBeenLastCalledWith('c1', 1, null)
  })

  it('a Codex terminal is never routed from the prompt hook, and forgetting a Claude one leaves Codex alone', async () => {
    const d = deps()
    registerTerminal('c1', true, true)
    expect(await routePrompt({ terminalId: 'c1', prompt: BUILD })).toBeNull()
    registerTerminal('k1', true)
    forgetTerminal('k1')
    expect(d.forgetCodex).not.toHaveBeenCalled()
  })
})
