import { describe, it, expect, beforeEach } from 'vitest'
const { setProxySpawner, onProxyResult, onProxyStash, startProxy, isProxyHealthy, getProxyEnv, stopProxy, pickFreePort, setProxyMode, _resetProxyForTest, setProxyEnabled, isProxyEnabled, isProxyStarted, userRoutingVar, setAgentEnvReader, USER_ROUTING_ENV, PROVIDER_SWITCH_ENV, getProxyMode } =
  await import('../../src/main/headroomProxy/proxySupervisor')

interface Fake { transport: unknown; fireExit: () => void; fireResult: (r: Record<string, unknown>) => void; fireStash: (stashes: Array<{ token: string; original: string }>) => void; killed: boolean; posted: Array<Record<string, unknown>> }
let fakes: Fake[] = []

function fakeSpawner(): unknown {
  let msgCb: (m: unknown) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const f: Fake = {
    transport: {
      postMessage: (m: { kind?: string; port?: number; mode?: string }) => { f.posted.push(m as Record<string, unknown>); if (m?.kind === 'init') msgCb({ kind: 'ready', port: m.port }) },
      onMessage: (cb: (m: unknown) => void) => { msgCb = cb },
      onExit: (cb: (c: number) => void) => { exitCb = cb },
      kill: () => { f.killed = true },
      pid: 1,
    },
    fireExit: () => exitCb(1),
    fireResult: (r: Record<string, unknown>) => msgCb({ kind: 'result', ...r }),
    fireStash: (stashes: Array<{ token: string; original: string }>) => msgCb({ kind: 'stash', stashes }),
    killed: false,
    posted: [],
  }
  fakes.push(f)
  return f.transport
}

beforeEach(() => { _resetProxyForTest(); fakes = []; setProxySpawner(fakeSpawner) })

describe('proxy supervisor', () => {
  it('is unhealthy before start, healthy after ready, and exposes the launch env', () => {
    expect(getProxyEnv()).toBeNull()
    startProxy({ port: 9999 })
    expect(isProxyHealthy()).toBe(true)
    expect(getProxyEnv()).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:9999',
      CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
      ENABLE_TOOL_SEARCH: 'true',
    })
  })

  it('forwards result messages to the registered consumer', () => {
    const got: Array<Record<string, unknown>> = []
    onProxyResult((r) => got.push(r as unknown as Record<string, unknown>))
    startProxy({ port: 9999 })
    fakes[0].fireResult({ changed: true, stats: { trBlocks: 2 }, usage: { input_tokens: 5 }, stashes: [] })
    expect(got).toHaveLength(1)
    expect((got[0].stats as { trBlocks: number }).trBlocks).toBe(2)
  })

  it('forwards stash messages to the registered consumer', () => {
    const got: Array<{ token: string; original: string }> = []
    onProxyStash((s) => got.push(...s.stashes))
    startProxy({ port: 9999 })
    fakes[0].fireStash([{ token: 'hr_abc', original: 'the original' }])
    expect(got).toEqual([{ token: 'hr_abc', original: 'the original' }])
  })

  it('drops stash messages once the consumer is cleared, rather than calling a stale one', () => {
    const got: Array<{ token: string; original: string }> = []
    onProxyStash((s) => got.push(...s.stashes))
    _resetProxyForTest() // e.g. the app tore the proxy down and rebuilt it
    setProxySpawner(fakeSpawner)
    startProxy({ port: 9999 })
    expect(() => fakes[0].fireStash([{ token: 'hr_abc', original: 'the original' }])).not.toThrow()
    expect(got).toEqual([])
  })

  it('auto-restarts on child crash and recovers health', () => {
    startProxy({ port: 9999 })
    expect(isProxyHealthy()).toBe(true)
    fakes[0].fireExit()
    expect(fakes).toHaveLength(2) // respawned
    expect(isProxyHealthy()).toBe(true)
  })

  it('gives up after flapping so Claude launches direct (env null)', () => {
    startProxy({ port: 9999 })
    for (let i = 0; i < 6; i++) fakes[fakes.length - 1].fireExit()
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyEnv()).toBeNull()
  })

  it('stopProxy kills the child and marks unhealthy', () => {
    startProxy({ port: 9999 })
    stopProxy()
    expect(fakes[0].killed).toBe(true)
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyEnv()).toBeNull()
  })

  it('pickFreePort resolves a usable loopback port', async () => {
    const p = await pickFreePort()
    expect(p).toBeGreaterThan(0)
  })

  it('carries the wire mode on the child init — default aggressive', () => {
    startProxy({ port: 5000 })
    expect(fakes[0].posted.find((m) => m.kind === 'init')).toMatchObject({ kind: 'init', mode: 'aggressive' })
  })

  it('setProxyMode before start is carried on the first init', () => {
    setProxyMode('balanced')
    startProxy({ port: 5000 })
    expect(fakes[0].posted.find((m) => m.kind === 'init')).toMatchObject({ mode: 'balanced' })
  })

  it('setProxyMode posts a live config message to the running child', () => {
    startProxy({ port: 5000 })
    setProxyMode('conservative')
    expect(fakes[0].posted.some((m) => m.kind === 'config' && m.mode === 'conservative')).toBe(true)
  })

  it('re-applies the current mode on the init of every respawn', () => {
    startProxy({ port: 5000 })
    setProxyMode('conservative')
    fakes[0].fireExit() // child died → supervisor respawns synchronously
    expect(fakes.length).toBe(2)
    expect(fakes[1].posted.find((m) => m.kind === 'init')).toMatchObject({ mode: 'conservative' })
  })

  it('setProxyMode is a safe no-op before any spawn, then still rides the first init', () => {
    expect(() => setProxyMode('balanced')).not.toThrow() // no transport yet
    startProxy({ port: 5000 })
    expect(fakes[0].posted.find((m) => m.kind === 'init')).toMatchObject({ mode: 'balanced' })
  })
})

describe('proxy supervisor — the user decides where Claude traffic goes', () => {
  it('launches direct while the master switch is off, and resumes the moment it is back on', () => {
    startProxy({ port: 9999 })
    expect(isProxyEnabled()).toBe(true)
    setProxyEnabled(false)
    expect(isProxyEnabled()).toBe(false)
    expect(getProxyEnv({})).toBeNull()
    expect(isProxyHealthy()).toBe(true) // a live session pinned to the port is not cut off
    setProxyEnabled(true)
    expect(getProxyEnv({})?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999')
  })

  it('never replaces a base URL or outbound proxy the user configured', () => {
    startProxy({ port: 9999 })
    for (const k of USER_ROUTING_ENV) {
      expect(getProxyEnv({ [k]: 'http://gateway.corp.example:4000' })).toBeNull()
      expect(userRoutingVar({ [k]: 'http://gateway.corp.example:4000' })).toBe(k)
    }
  })

  it('steps aside for a Bedrock, Vertex or Foundry switch — those never talk to api.anthropic.com', () => {
    startProxy({ port: 9999 })
    for (const k of PROVIDER_SWITCH_ENV) {
      for (const on of ['1', 'true', 'TRUE', ' yes ']) {
        expect(userRoutingVar({ [k]: on })).toBe(k)
        expect(getProxyEnv({ [k]: on })).toBeNull()
      }
      for (const off of ['', '  ', '0', 'false', 'False']) {
        expect(userRoutingVar({ [k]: off })).toBeNull()
        expect(getProxyEnv({ [k]: off })).not.toBeNull()
      }
    }
  })

  it('ignores blank values — an empty variable routes nothing', () => {
    startProxy({ port: 9999 })
    expect(userRoutingVar({ ANTHROPIC_BASE_URL: '   ', HTTPS_PROXY: '' })).toBeNull()
    expect(getProxyEnv({ ANTHROPIC_BASE_URL: '' })).not.toBeNull()
  })

  it('is not fooled by the proxy URL a parent Termpolis handed down', () => {
    startProxy({ port: 9999 })
    const inherited = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:61586', TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:61586' }
    expect(userRoutingVar(inherited)).toBeNull()
    expect(getProxyEnv(inherited)?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999')
    // ...but a user base URL that merely sits next to a stale marker is still the user's.
    expect(userRoutingVar({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:61586' })).toBe('ANTHROPIC_BASE_URL')
  })

  it('reads the real process env by default', () => {
    startProxy({ port: 9999 })
    process.env.HTTPS_PROXY = 'http://egress.corp.example:3128'
    try { expect(getProxyEnv()).toBeNull() } finally { delete process.env.HTTPS_PROXY }
    expect(getProxyEnv()).not.toBeNull()
  })

  it('reports the tier it will run — aggressive until told otherwise', () => {
    expect(getProxyMode()).toBe('aggressive')
    setProxyMode('max')
    expect(getProxyMode()).toBe('max')
  })

  it('tracks whether it has been started, so a Settings flip can start it lazily', () => {
    expect(isProxyStarted()).toBe(false)
    startProxy({ port: 9999 })
    expect(isProxyStarted()).toBe(true)
    stopProxy()
    expect(isProxyStarted()).toBe(false)
  })

  it('steps aside for a route set only in Claude Code settings.json', () => {
    startProxy({ port: 9999 })
    for (const k of USER_ROUTING_ENV) {
      setAgentEnvReader(() => ({ [k]: 'http://corp:8080' }))
      expect(userRoutingVar({})).toBe(k)
      expect(getProxyEnv({})).toBeNull()
    }
    setAgentEnvReader(() => ({ CLAUDE_CODE_USE_BEDROCK: '1' }))
    expect(userRoutingVar({})).toBe('CLAUDE_CODE_USE_BEDROCK')
  })

  it('lets settings.json override the launch env, as Claude Code applies it', () => {
    // The inherited base URL is ours (the marker matches) — but settings.json sets its own.
    const inherited = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:61586', TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:61586' }
    expect(userRoutingVar(inherited)).toBeNull()
    setAgentEnvReader(() => ({ ANTHROPIC_BASE_URL: 'https://gateway.corp.example' }))
    expect(userRoutingVar(inherited)).toBe('ANTHROPIC_BASE_URL')
    // …and a switch turned off there beats one left on in the env.
    setAgentEnvReader(() => ({ CLAUDE_CODE_USE_VERTEX: '0' }))
    expect(userRoutingVar({ CLAUDE_CODE_USE_VERTEX: '1' })).toBeNull()
  })

  it('ignores a settings env block it cannot use', () => {
    startProxy({ port: 9999 })
    const ours = 'http://127.0.0.1:9999'
    for (const read of [
      () => null,
      () => { throw new Error('EACCES') },
      () => 'HTTPS_PROXY=http://corp:8080' as unknown as Record<string, unknown>,
      () => ({ HTTPS_PROXY: 8080, ALL_PROXY: null, HTTP_PROXY: { url: 'x' }, ANTHROPIC_BASE_URL: '  ' }),
    ]) {
      setAgentEnvReader(read)
      expect(userRoutingVar({})).toBeNull()
      expect(getProxyEnv({})?.ANTHROPIC_BASE_URL).toBe(ours)
    }
    setAgentEnvReader(null)
    expect(getProxyEnv({})?.ANTHROPIC_BASE_URL).toBe(ours)
  })
})
