import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getRouterMode, setRouterMode, applyRouterSettings, modelName, routeChipText, routeChipTitle, teachRoute, pinRoute,
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
    expect(ROUTER_MODES.map((m) => m.value)).toEqual(['auto-panes', 'all', 'off'])
    expect(getRouterMode()).toBe(DEFAULT_ROUTER_MODE)
    localStorage.setItem(ROUTER_MODE_KEY, 'all')
    expect(getRouterMode()).toBe('all')
    localStorage.setItem(ROUTER_MODE_KEY, 'junk')
    expect(getRouterMode()).toBe(DEFAULT_ROUTER_MODE)
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
    expect(() => applyRouterSettings('all')).not.toThrow()
    api.routerConfigure = vi.fn(async () => { throw new Error('x') })
    expect(() => applyRouterSettings('all')).not.toThrow()
    api.routerConfigure = () => { throw new Error('sync') }
    expect(() => applyRouterSettings('all')).not.toThrow()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      expect(getRouterMode()).toBe(DEFAULT_ROUTER_MODE)
      expect(setRouterMode('all')).toBe('all')
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

describe('teaching and pinning', () => {
  it('sends the correction and the pin to main, best effort', () => {
    const learn = vi.fn(async () => ({ success: true, data: true }))
    const pin = vi.fn(async () => ({ success: true }))
    api.routerLearn = learn
    api.routerPin = pin
    teachRoute(ev(), 'opus')
    expect(learn).toHaveBeenCalledWith({ prompt: 'what branch am I on', label: 'opus' })
    pinRoute('t1')
    expect(pin).toHaveBeenCalledWith({ terminalId: 't1', pinned: true })
    api.routerLearn = vi.fn(async () => { throw new Error('x') })
    api.routerPin = vi.fn(async () => { throw new Error('x') })
    expect(() => { teachRoute(ev(), 'keep'); pinRoute('t1') }).not.toThrow()
    api.routerLearn = () => { throw new Error('sync') }
    api.routerPin = () => { throw new Error('sync') }
    expect(() => { teachRoute(ev(), 'keep'); pinRoute('t1') }).not.toThrow()
    api.routerLearn = undefined
    api.routerPin = undefined
    expect(() => { teachRoute(ev(), 'keep'); pinRoute('t1') }).not.toThrow()
  })
})
