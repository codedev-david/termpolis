import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetMessageRouterForTests, configureRouter, isRouterMode, setRouterMode, getRouterMode, registerTerminal,
  forgetTerminal, pinTerminal, noteProxyResult, routePrompt, FIRST_MIN_CONFIDENCE, type RouterDeps,
} from '../../src/main/messageRouter'
import type { ClassifyResult } from '../../src/main/routerModel'
import { HAIKU_MAX_CTX } from '../../src/shared/switchEconomics'

const vote = (label: ClassifyResult['cls'] extends infer C ? C extends { label: infer L } ? L : never : never, confidence = 0.9, topSim = 0.9, ms = 3): ClassifyResult =>
  ({ cls: { label, confidence, topSim }, ms }) as ClassifyResult

function deps(over: Partial<RouterDeps> = {}) {
  const d = {
    classify: vi.fn(async () => vote('haiku')),
    setRoute: vi.fn(),
    notify: vi.fn(),
    now: () => 1_000_000,
    ...over,
  }
  configureRouter(d)
  return d
}

const BUILD = 'fix the failing terminalManager test' // rules: sonnet 0.75
const main = (terminal: string, model: string, usage = { input_tokens: 10, cache_read_input_tokens: 20_000 }, extra = {}) =>
  noteProxyResult({ terminal, main: true, model, usage, ...extra }, 1_000_000)

describe('messageRouter', () => {
  beforeEach(() => _resetMessageRouterForTests())

  it('modes: validates, and off clears every route', () => {
    const d = deps()
    expect(getRouterMode()).toBe('auto-panes')
    expect(isRouterMode('all')).toBe(true)
    expect(isRouterMode('nope')).toBe(false)
    expect(isRouterMode(3)).toBe(false)
    expect(setRouterMode('bogus')).toBe('auto-panes')
    registerTerminal('t1', true)
    registerTerminal('t2', false)
    expect(setRouterMode('off')).toBe('off')
    expect(d.setRoute).toHaveBeenCalledWith('t1', null)
    expect(d.setRoute).toHaveBeenCalledWith('t2', null)
    expect(setRouterMode('all')).toBe('all')
  })

  it('off without deps does not throw', () => {
    registerTerminal('t1', true)
    expect(setRouterMode('off')).toBe('off')
  })

  it('returns null without deps, an id, a prompt, or a registered pane', async () => {
    expect(await routePrompt({ terminalId: 't1', prompt: BUILD })).toBeNull()
    deps()
    expect(await routePrompt({ terminalId: 5, prompt: BUILD })).toBeNull()
    expect(await routePrompt({ terminalId: 't1', prompt: '   ' })).toBeNull()
    expect(await routePrompt({ terminalId: 't1', prompt: 7 })).toBeNull()
    expect(await routePrompt(undefined as unknown as { terminalId: string })).toBeNull()
    expect(await routePrompt({ terminalId: 'unknown', prompt: BUILD })).toBeNull()
  })

  it('register/forget/pin ignore bad ids', () => {
    const d = deps()
    registerTerminal(42, true)
    registerTerminal('bad id!', true)
    pinTerminal(42)
    pinTerminal('bad id!')
    forgetTerminal(42)
    forgetTerminal('never-seen')
    expect(d.setRoute).not.toHaveBeenCalled()
  })

  it('only auto panes route in auto-panes mode; every pane in all; none when pinned', async () => {
    const d = deps()
    registerTerminal('auto', true)
    registerTerminal('manual', false)
    expect(await routePrompt({ terminalId: 'manual', prompt: BUILD })).toBeNull()
    expect(await routePrompt({ terminalId: 'auto', prompt: BUILD })).not.toBeNull()
    setRouterMode('all')
    expect(await routePrompt({ terminalId: 'manual', prompt: BUILD })).not.toBeNull()
    pinTerminal('manual')
    expect(d.setRoute).toHaveBeenLastCalledWith('manual', null)
    expect(await routePrompt({ terminalId: 'manual', prompt: BUILD })).toBeNull()
    pinTerminal('manual', false)
    expect(await routePrompt({ terminalId: 'manual', prompt: BUILD })).not.toBeNull()
    registerTerminal('manual', false) // a relaunch unpins
    setRouterMode('off')
    expect(await routePrompt({ terminalId: 'auto', prompt: BUILD })).toBeNull()
  })

  it('first message: switches to the sure pick, stays on the launch model when unsure', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.9)) })
    registerTerminal('t', true)
    const e = await routePrompt({ terminalId: 't', prompt: 'what branch am I on' })
    expect(e).toMatchObject({ model: 'haiku', from: null, switched: true, reason: 'first', source: 'local-model', terminalId: 't' })
    expect(d.setRoute).toHaveBeenCalledWith('t', 'haiku')
    expect(d.notify).toHaveBeenCalledWith(e)

    _resetMessageRouterForTests()
    const d2 = deps({ classify: vi.fn(async () => null as unknown as ClassifyResult) })
    registerTerminal('t', true)
    // rules default is sonnet at 0.4 < FIRST_MIN_CONFIDENCE
    expect(0.4).toBeLessThan(FIRST_MIN_CONFIDENCE)
    expect(await routePrompt({ terminalId: 't', prompt: 'hmm interesting thought about the colour' })).toBeNull()
    expect(d2.setRoute).not.toHaveBeenCalled()
  })

  it('keep: stays on the current model, and does nothing before one is known', async () => {
    const d = deps({ classify: vi.fn(async () => vote('keep', 0.9)) })
    registerTerminal('t', true)
    expect(await routePrompt({ terminalId: 't', prompt: 'yes please' })).toBeNull()
    main('t', 'opus')
    const e = await routePrompt({ terminalId: 't', prompt: 'yes please' })
    expect(e).toMatchObject({ model: 'opus', from: 'opus', switched: false, reason: 'keep', saving: 0 })
    expect(d.setRoute).not.toHaveBeenCalled()
    expect(d.notify).toHaveBeenCalledTimes(1)
  })

  it('later messages go through the cost gate', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.9)) })
    registerTerminal('t', true)
    main('t', 'opus', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never)
    const e = await routePrompt({ terminalId: 't', prompt: 'what branch am I on' })
    expect(e).toMatchObject({ model: 'haiku', from: 'opus', switched: true, reason: 'cheaper' })
    expect(e!.saving).toBeGreaterThan(0)
    expect(d.setRoute).toHaveBeenCalledWith('t', 'haiku')
    // a huge conversation: haiku is out
    main('t', 'opus', { input_tokens: HAIKU_MAX_CTX + 1, cache_read_input_tokens: 0 })
    expect(await routePrompt({ terminalId: 't', prompt: 'what branch am I on' })).toMatchObject({ model: 'opus', switched: false, reason: 'too-big-for-haiku' })
  })

  it('noteProxyResult: tracks context, warm caches, ttl and refusals; ignores the rest', async () => {
    const d = deps({ classify: vi.fn(async () => vote('haiku', 0.9)) })
    noteProxyResult(undefined as never)
    noteProxyResult({ terminal: 'bad id!', main: true, model: 'opus' })
    noteProxyResult({ terminal: 't', main: false, model: 'opus' }) // not main: no current
    noteProxyResult({ terminal: 't', main: true, model: 'fable' }) // not a family
    registerTerminal('t', true)
    let e = await routePrompt({ terminalId: 't', prompt: 'what branch am I on' })
    expect(e!.reason).toBe('first') // still no current model
    noteProxyResult({ terminal: 't', main: true, model: 'sonnet', ttl1h: true }) // no usage: ctx unchanged
    noteProxyResult({ terminal: 't', refused: 'haiku' })
    noteProxyResult({ terminal: 't', refused: 'nonsense' })
    e = await routePrompt({ terminalId: 't', prompt: 'what branch am I on' })
    // haiku refused for this pane: bumped to sonnet, which is what it is on
    expect(e).toMatchObject({ model: 'sonnet', from: 'sonnet', reason: 'same' })
    expect(d.setRoute).toHaveBeenLastCalledWith('t', 'sonnet')
  })

  it('every model refused: no route', async () => {
    deps({ classify: vi.fn(async () => vote('sonnet', 0.9)) })
    registerTerminal('t', true)
    noteProxyResult({ terminal: 't', refused: 'sonnet' })
    noteProxyResult({ terminal: 't', refused: 'opus' })
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toBeNull()
  })

  it('a vote past the budget, or a failing one, falls back to the rules', async () => {
    vi.useFakeTimers()
    try {
      deps({ classify: vi.fn(() => new Promise<ClassifyResult>(() => { /* never */ })), budgetMs: 50 })
      registerTerminal('t', true)
      const p = routePrompt({ terminalId: 't', prompt: BUILD })
      await vi.advanceTimersByTimeAsync(60)
      expect(await p).toMatchObject({ model: 'sonnet', source: 'rules', reason: 'first' })
    } finally {
      vi.useRealTimers()
    }
    _resetMessageRouterForTests()
    deps({ classify: vi.fn(async () => { throw new Error('host down') }) })
    registerTerminal('t', true)
    expect(await routePrompt({ terminalId: 't', prompt: BUILD })).toMatchObject({ source: 'rules' })
  })

  it('drops the decision when the pane changed while the vote ran', async () => {
    let release!: (r: ClassifyResult) => void
    const d = deps({ classify: vi.fn(() => new Promise<ClassifyResult>((r) => { release = r })) })
    registerTerminal('t', true)
    const p = routePrompt({ terminalId: 't', prompt: BUILD })
    forgetTerminal('t')
    expect(d.setRoute).toHaveBeenCalledWith('t', null)
    registerTerminal('t', true) // a new pane with the same id
    release(vote('opus'))
    expect(await p).toBeNull()

    const p2 = routePrompt({ terminalId: 't', prompt: BUILD })
    pinTerminal('t')
    release(vote('opus'))
    expect(await p2).toBeNull()
  })

  it('uses the tuning, the vote time and the default clock', async () => {
    const tuning = vi.fn(() => ({ haikuMaxWords: 25, misroutes: { build: 3 } }))
    configureRouter({ classify: async () => ({ cls: null, ms: 42 }) as ClassifyResult, setRoute: vi.fn(), notify: vi.fn(), tuning })
    registerTerminal('t', true)
    const e = await routePrompt({ terminalId: 't', prompt: BUILD })
    expect(tuning).toHaveBeenCalled()
    expect(e).toMatchObject({ model: 'opus', source: 'rules' })
    expect(e!.ms).toBeGreaterThanOrEqual(42)
  })

  it('caps the prompt it reports', async () => {
    deps({ classify: vi.fn(async () => vote('opus', 0.9)) })
    registerTerminal('t', true)
    const e = await routePrompt({ terminalId: 't', prompt: 'design ' + 'x'.repeat(5000) })
    expect(e!.prompt).toHaveLength(2000)
  })
})
