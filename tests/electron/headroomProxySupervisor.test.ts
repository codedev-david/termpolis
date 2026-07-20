import { describe, it, expect, beforeEach } from 'vitest'
const { setProxySpawner, onProxyResult, startProxy, isProxyHealthy, getProxyEnv, stopProxy, _resetProxyForTest } =
  await import('../../src/main/headroomProxy/proxySupervisor')

interface Fake { transport: unknown; fireExit: () => void; fireResult: (r: Record<string, unknown>) => void; killed: boolean }
let fakes: Fake[] = []

function fakeSpawner(): unknown {
  let msgCb: (m: unknown) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const f: Fake = {
    transport: {
      postMessage: (m: { kind?: string; port?: number }) => { if (m?.kind === 'init') msgCb({ kind: 'ready', port: m.port }) },
      onMessage: (cb: (m: unknown) => void) => { msgCb = cb },
      onExit: (cb: (c: number) => void) => { exitCb = cb },
      kill: () => { f.killed = true },
      pid: 1,
    },
    fireExit: () => exitCb(1),
    fireResult: (r: Record<string, unknown>) => msgCb({ kind: 'result', ...r }),
    killed: false,
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
})
