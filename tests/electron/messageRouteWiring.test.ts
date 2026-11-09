// v1.56.0 per-message routing: the hops between the router and the rest of the app — the launch env
// tag, the proxy supervisor's route table, and the memory_primer hook that routes a submitted prompt.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withRouteHeader, CUSTOM_HEADERS_ENV } from '../../src/main/headroom/shapingEnv'
import {
  setProxySpawner, startProxy, stopProxy, setProxyRoute, setProxyThinkingCap, setProxyDecay, _resetProxyForTest,
  type ProxyTransport,
} from '../../src/main/headroomProxy/proxySupervisor'
import { executeTool } from '../../src/main/mcpServer'
import { resetPrimerGuard, onFirstPrompt } from '../../src/main/primerSessionGuard'
import { HOST_HANDLERS } from '../../src/main/memoryHost'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

describe('withRouteHeader', () => {
  const PROXY = { TERMPOLIS_HEADROOM_PROXY: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }

  it('tags a proxied launch with its terminal', () => {
    expect(withRouteHeader(PROXY, 't-1', {})).toEqual({ ...PROXY, [CUSTOM_HEADERS_ENV]: 'X-Termpolis-Terminal: t-1' })
  })

  it('keeps headers the user set, and replaces an old tag', () => {
    expect(withRouteHeader(PROXY, 't-1', { [CUSTOM_HEADERS_ENV]: 'A: 1\r\nx-termpolis-terminal: old\n\n' })![CUSTOM_HEADERS_ENV])
      .toBe('A: 1\nX-Termpolis-Terminal: t-1')
    expect(withRouteHeader({ ...PROXY, [CUSTOM_HEADERS_ENV]: 'B: 2' }, 't-1', { [CUSTOM_HEADERS_ENV]: 'A: 1' })![CUSTOM_HEADERS_ENV])
      .toBe('B: 2\nX-Termpolis-Terminal: t-1')
  })

  it('leaves alone a launch without the proxy, or a bad id', () => {
    expect(withRouteHeader(undefined, 't-1', {})).toBeUndefined()
    const direct = { A: '1' }
    expect(withRouteHeader(direct, 't-1', {})).toBe(direct)
    expect(withRouteHeader(PROXY, 'bad id!', {})).toBe(PROXY)
    expect(withRouteHeader(PROXY, 7, {})).toBe(PROXY)
    expect(withRouteHeader(PROXY, 't-1')).toMatchObject({ TERMPOLIS_HEADROOM_PROXY: '1' }) // default env
  })
})

describe('the supervisor keeps the routes', () => {
  interface FakeChild { posted: Array<Record<string, unknown>>; exit: () => void }
  let children: FakeChild[] = []
  let failPost = false
  function spawner(): ProxyTransport {
    let onMsg: (m: unknown) => void = () => {}
    let onExit: (c: number) => void = () => {}
    const child: FakeChild = { posted: [], exit: () => onExit(1) }
    children.push(child)
    return {
      postMessage: (m: unknown) => {
        if (failPost && (m as { kind?: string }).kind === 'route') throw new Error('post failed')
        child.posted.push(m as Record<string, unknown>)
        if ((m as { kind?: string })?.kind === 'init') onMsg({ kind: 'ready', port: (m as { port: number }).port })
      },
      onMessage: (cb) => { onMsg = cb },
      onExit: (cb) => { onExit = cb },
      kill: () => {},
      pid: 1,
    }
  }
  const routesOf = (c: FakeChild) => c.posted.filter((m) => m.kind === 'route')

  beforeEach(() => {
    vi.useFakeTimers()
    _resetProxyForTest(); setProxyThinkingCap(0); setProxyDecay(false)
    children = []; failPost = false
    setProxySpawner(spawner)
  })
  afterEach(() => { stopProxy(); _resetProxyForTest(); vi.useRealTimers() })

  it('posts a route to the child and replays the table to a respawned one', async () => {
    setProxyRoute('early', 'opus') // before any child: kept for its init
    startProxy({ port: 7501 })
    expect(routesOf(children[0])).toEqual([{ kind: 'route', terminal: 'early', family: 'opus' }])
    setProxyRoute('t1', 'haiku')
    setProxyRoute('early', null)
    expect(routesOf(children[0]).slice(1)).toEqual([
      { kind: 'route', terminal: 't1', family: 'haiku' },
      { kind: 'route', terminal: 'early', family: null },
    ])
    children[0].exit()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(children.length).toBeGreaterThan(1)
    expect(routesOf(children[children.length - 1])).toEqual([{ kind: 'route', terminal: 't1', family: 'haiku' }])
  })

  it('a post that fails does not throw', () => {
    startProxy({ port: 7502 })
    failPost = true
    expect(() => setProxyRoute('t1', 'haiku')).not.toThrow()
  })
})

describe('memory_primer routes a submitted prompt', () => {
  const handlers = (routePrompt?: (o: { terminalId?: unknown; prompt?: unknown }) => Promise<unknown>) => ({
    memoryPrimer: async () => ({ project: null, primer: null }),
    ...(routePrompt ? { routePrompt } : {}),
  }) as unknown as Parameters<typeof executeTool>[2]
  beforeEach(() => resetPrimerGuard())

  it('calls the router with the pane and the prompt, and a routed pane gets no switch offer', async () => {
    const heard: string[] = []
    const off = onFirstPrompt((sid) => heard.push(sid))
    const route = vi.fn(async () => ({ model: 'haiku' }))
    await executeTool('memory_primer', { cwd: '/repo', query: 'what branch am I on', source: 'prompt', sessionId: 's-routed', terminalId: 'term-1', prime: false }, handlers(route))
    expect(route).toHaveBeenCalledWith({ terminalId: 'term-1', prompt: 'what branch am I on' })
    expect(heard).toEqual([])
    // not routed (null), failing, or no router at all: the offer goes out as before
    await executeTool('memory_primer', { cwd: '/repo', query: 'q', source: 'prompt', sessionId: 's-null', prime: false }, handlers(async () => null))
    await executeTool('memory_primer', { cwd: '/repo', query: 'q', source: 'prompt', sessionId: 's-throw', prime: false }, handlers(async () => { throw new Error('x') }))
    await executeTool('memory_primer', { cwd: '/repo', query: 'q', source: 'prompt', sessionId: 's-none', prime: false }, handlers())
    expect(heard).toEqual(['s-null', 's-throw', 's-none'])
    off()
  })

  it('only the prompt hook routes', async () => {
    const route = vi.fn(async () => null)
    await executeTool('memory_primer', { cwd: '/repo', limit: 5, source: 'session-start' }, handlers(route))
    expect(route).not.toHaveBeenCalled()
  })
})

describe('the memory host serves the router', () => {
  it('lists the router calls', () => {
    for (const k of ['routerClassify', 'routerLearn', 'routerWarm']) expect(typeof HOST_HANDLERS[k]).toBe('function')
  })
})
