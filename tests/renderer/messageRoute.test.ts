import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getRouterMode, setRouterMode, applyRouterSettings, modelName, routeChipText, routeChipTitle, teachRoute, setRouteHome,
  ROUTER_MODE_KEY, DEFAULT_ROUTER_MODE, ROUTER_MODES, type RouteEvent,
} from '../../src/renderer/src/lib/messageRoute'

const ev = (over: Partial<RouteEvent> = {}): RouteEvent => ({
  terminalId: 't1', prompt: 'what branch am I on', model: 'haiku', from: 'opus', switched: true, reason: 'cheaper',
  label: 'haiku', source: 'local-model', confidence: 0.87, ms: 3.6, saving: 0.0123, ...over,
})

const w = window as unknown as { termpolis?: Record<string, unknown> }
const had = w.termpolis
let api: Record<string, unknown>
beforeEach(() => {
  localStorage.clear()
  api = {}
  w.termpolis = api
})
afterEach(() => { w.termpolis = had })

describe('message routing setting', () => {
  it('defaults, reads and validates the stored mode', () => {
    expect(ROUTER_MODES.map((m) => m.value)).toEqual(['every', 'off'])
    expect(DEFAULT_ROUTER_MODE).toBe('every')
    expect(ROUTER_MODES[0].label).toBe('Every Claude terminal (steps down from its start model; Auto terminals route freely) and Codex')
    expect(getRouterMode()).toBe(DEFAULT_ROUTER_MODE)
    localStorage.setItem(ROUTER_MODE_KEY, 'off')
    expect(getRouterMode()).toBe('off')
    localStorage.setItem(ROUTER_MODE_KEY, 'junk')
    expect(getRouterMode()).toBe(DEFAULT_ROUTER_MODE)
  })

  it('MODELHOME: a mode saved before 2.0 reads as the one default, and is saved so', () => {
    for (const old of ['auto-panes', 'all']) {
      localStorage.setItem(ROUTER_MODE_KEY, old)
      expect(getRouterMode()).toBe('every')
      expect(localStorage.getItem(ROUTER_MODE_KEY)).toBe('every')
    }
    localStorage.setItem(ROUTER_MODE_KEY, 'all')
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try { expect(getRouterMode()).toBe('every') } finally { set.mockRestore() }
  })

  it('setRouterMode stores it and tells main, with the tuning', () => {
    const configure = vi.fn(async () => ({ success: true }))
    api.routerConfigure = configure
    expect(setRouterMode('off')).toBe('off')
    expect(localStorage.getItem(ROUTER_MODE_KEY)).toBe('off')
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ mode: 'off', tuning: expect.objectContaining({ haikuMaxWords: expect.any(Number) }) }))
    expect(setRouterMode('nonsense' as never)).toBe(DEFAULT_ROUTER_MODE)
    applyRouterSettings()
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ mode: DEFAULT_ROUTER_MODE }))
  })

  it('survives a missing API, a rejecting one, and a throwing one, and blocked storage', async () => {
    api.routerConfigure = undefined
    expect(() => applyRouterSettings('every')).not.toThrow()
    api.routerConfigure = vi.fn(async () => { throw new Error('x') })
    expect(() => applyRouterSettings('every')).not.toThrow()
    api.routerConfigure = () => { throw new Error('sync') }
    expect(() => applyRouterSettings('every')).not.toThrow()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      expect(getRouterMode()).toBe(DEFAULT_ROUTER_MODE)
      expect(setRouterMode('every')).toBe('every')
    } finally { get.mockRestore(); set.mockRestore() }
    await Promise.resolve()
  })
})

describe('the route chip', () => {
  it('names the move and the time', () => {
    expect(modelName('opus')).toBe('Opus')
    expect(routeChipText(ev())).toBe('Opus → Haiku · 4 ms')
    expect(routeChipText(ev({ switched: false, from: 'haiku', reason: 'same' }))).toBe('Haiku · 4 ms')
    expect(routeChipText(ev({ from: null, reason: 'first' }))).toBe('Haiku · 4 ms')
    expect(routeChipText(ev({ ms: -2 }))).toBe('Opus → Haiku · 0 ms')
    // v1.57.0: the effort, its move on the same model, a subagent, and more thought for failing calls
    expect(routeChipText(ev({ effort: 'low' }))).toBe('Opus → Haiku · low · 4 ms')
    expect(routeChipText(ev({ model: 'sonnet', from: 'sonnet', effort: 'low', reason: 'lighter' }))).toBe('Sonnet · high → low · 4 ms')
    expect(routeChipText(ev({ model: 'sonnet', from: 'sonnet', effort: 'high', fromEffort: 'high', reason: 'same' }))).toBe('Sonnet · high · 4 ms')
    expect(routeChipText(ev({ model: 'sonnet', from: null, effort: 'medium', reason: 'first' }))).toBe('Sonnet · medium · 4 ms')
    expect(routeChipText(ev({ model: 'sonnet', from: 'sonnet', effort: 'xhigh', fromEffort: 'high', reason: 'struggling' }))).toBe('Sonnet · high → xhigh · more thought')
    expect(routeChipText(ev({ effort: 'low', agent: true, reason: 'agent' }))).toBe('Subagent: Opus → Haiku · low · 4 ms')
    expect(routeChipTitle(ev({ effort: 'low', agent: true, reason: 'agent' }))).toContain('This subagent runs on Haiku at low effort: a subagent')
  })

  it('a Codex turn shows only its effort (v1.58.0)', () => {
    const cx = (codex: { from: string | null; effort: string }, o: Partial<RouteEvent> = {}): RouteEvent =>
      ev({ reason: 'codex', codex: codex as RouteEvent['codex'], ...o })
    expect(routeChipText(cx({ from: 'medium', effort: 'low' }))).toBe('Codex · medium → low · 4 ms')
    expect(routeChipText(cx({ from: 'medium', effort: 'low' }, { switched: false }))).toBe('Codex · low · 4 ms')
    expect(routeChipText(cx({ from: null, effort: 'high' }, { ms: 3.6 }))).toBe('Codex · high · 4 ms')
    expect(routeChipText(cx({ from: 'low', effort: 'low' }, { ms: -1 }))).toBe('Codex · low · 0 ms')
    expect(routeChipTitle(cx({ from: 'medium', effort: 'xhigh' }))).toContain('This message runs at xhigh effort in Codex: this message fits this effort; Codex keeps its model.')
  })

  it('explains why, who decided, how sure, and the saving', () => {
    const t = routeChipTitle(ev())
    expect(t).toContain('runs on Haiku')
    expect(t).toContain('costs less even after re-reading')
    expect(t).toContain('by the local model (87% sure)')
    expect(t).toContain('$0.012')
    expect(routeChipTitle(ev({ source: 'rules', saving: 0, confidence: 2 }))).toContain('by the word rules (100% sure).')
    expect(routeChipTitle(ev({ source: 'rules', saving: 0 }))).not.toContain('saving')
    expect(routeChipTitle(ev({ source: 'both', confidence: -1 }))).toContain('the local model and the word rules (0% sure)')
    expect(routeChipTitle(ev({ reason: 'mystery' }))).toContain(': mystery.')
  })
})

describe('MODELHOME: the chip of a terminal with a home model', () => {
  it('says a message went back home, or stayed there', () => {
    const back = ev({ model: 'opus', from: 'haiku', effort: null, switched: true, reason: 'home', label: 'opus' })
    expect(routeChipText(back)).toBe('Haiku → Opus · 4 ms')
    expect(routeChipTitle(back)).toContain('goes back to the model this terminal started on')
    const stay = ev({ model: 'opus', from: 'opus', effort: null, switched: false, reason: 'at-home', label: 'sonnet' })
    expect(routeChipText(stay)).toBe('Opus · 4 ms')
    expect(routeChipTitle(stay)).toContain('stays on the model this terminal started on')
  })

  it('says when a surely simple message has nothing cheaper to go to', () => {
    const e = ev({ model: 'haiku', from: 'haiku', effort: null, switched: false, reason: 'nothing-cheaper', label: 'haiku', confidence: 0.95 })
    expect(routeChipText(e)).toBe('Haiku · 4 ms')
    expect(routeChipTitle(e)).toContain('nothing is cheaper than the model this terminal started on, so it stays there')
    expect(routeChipTitle(e)).not.toContain('refused')
    expect(routeChipTitle({ ...e, model: 'opus', reason: 'refused' })).toContain('the cheaper model it fits was refused by the API earlier in this terminal')
    expect(routeChipTitle(e)).not.toContain('not surely simple')
  })

  it('names the model the session itself asks for, with the home beside it', () => {
    const e = ev({ model: 'opus', from: 'opus', home: 'haiku', effort: null, switched: false, reason: 'at-home', label: 'opus' })
    expect(routeChipText(e)).toBe('Opus (home Haiku) · 4 ms')
    const title = routeChipTitle(e)
    expect(title).toContain('This message runs on Opus: the session itself asks for Opus')
    expect(title).toContain('not for Haiku, this terminal')
    expect(title).toContain('Pick Opus in the Model menu to make it the home')
    expect(title).not.toContain('stays on the model this terminal started on')
    // Back from a step down onto what the session asks for.
    expect(routeChipText(ev({ model: 'sonnet', from: 'haiku', home: 'opus', effort: null, switched: true, reason: 'home', label: 'opus' }))).toBe('Haiku → Sonnet (home Opus) · 4 ms')
  })

  it('names a home it cannot place, and says why nothing is routed', () => {
    const e = (unplaced?: string) => ev({ reason: 'unplaced', unplaced, label: 'keep', switched: false, source: 'rules', confidence: 0, ms: 0, saving: 0 })
    expect(routeChipText(e('claude-nova-1'))).toBe('claude-nova-1 · not routed')
    expect(routeChipText(e('other'))).toBe('This model · not routed')
    expect(routeChipText(e())).toBe('This model · not routed')
    expect(routeChipTitle(e('claude-nova-1'))).toBe("claude-nova-1 is not one the router can rank by price, so this terminal's messages all run on it. Pick another model in the Model menu to have simple messages moved to cheaper ones.")
  })

  it('names Fable like the others: a Fable home is routed', () => {
    const e = ev({ model: 'haiku', from: 'fable', effort: 'low', switched: true, reason: 'cheaper', label: 'haiku' })
    expect(routeChipText(e)).toBe('Fable → Haiku · low · 4 ms')
    expect(routeChipTitle(ev({ model: 'fable', from: 'fable', effort: null, switched: false, reason: 'at-home', label: 'opus' }))).toContain('This message runs on Fable:')
  })

  it('setRouteHome tells main the new home, and survives a missing or failing API', async () => {
    const home = vi.fn(async () => ({ success: true }))
    api.routerHome = home
    setRouteHome('t1', 'sonnet')
    expect(home).toHaveBeenCalledWith({ terminalId: 't1', model: 'sonnet' })
    api.routerHome = undefined
    expect(() => setRouteHome('t1', 'opus')).not.toThrow()
    api.routerHome = vi.fn(async () => { throw new Error('x') })
    expect(() => setRouteHome('t1', 'opus')).not.toThrow()
    api.routerHome = () => { throw new Error('sync') }
    expect(() => setRouteHome('t1', 'opus')).not.toThrow()
    await Promise.resolve()
  })
})

describe('teaching', () => {
  it('sends the correction to main, best effort', () => {
    const learn = vi.fn(async () => ({ success: true, data: true }))
    api.routerLearn = learn
    teachRoute(ev(), 'opus')
    expect(learn).toHaveBeenCalledWith({ prompt: 'what branch am I on', label: 'opus' })
    api.routerLearn = vi.fn(async () => { throw new Error('x') })
    expect(() => teachRoute(ev(), 'keep')).not.toThrow()
    api.routerLearn = () => { throw new Error('sync') }
    expect(() => teachRoute(ev(), 'keep')).not.toThrow()
    api.routerLearn = undefined
    expect(() => teachRoute(ev(), 'keep')).not.toThrow()
  })
})
