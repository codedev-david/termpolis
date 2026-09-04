import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setBridgeSpawner, startRemoteBridge, stopRemoteBridge, isRemoteBridgeRunning,
  isRemoteDisabled, onBridgeMessage, _resetSupervisorForTests, type BridgeHandle,
} from '../../src/main/remoteBridgeSupervisor'
import type { BridgeToHost, HostToBridge } from '../../src/main/remoteBridge/protocol'

function fakeBridge() {
  const messageCbs: Array<(m: BridgeToHost) => void> = []
  const exitCbs: Array<(code: number) => void> = []
  const sent: HostToBridge[] = []
  const handle: BridgeHandle = {
    postMessage: (m) => sent.push(m),
    on: (event: string, cb: never) => {
      if (event === 'message') messageCbs.push(cb)
      else exitCbs.push(cb)
    },
    kill: vi.fn(),
  } as BridgeHandle
  return { handle, sent, emitExit: (c: number) => exitCbs.forEach((f) => f(c)), emit: (m: BridgeToHost) => messageCbs.forEach((f) => f(m)) }
}

const init = { mcpPort: 9315, mcpToken: 'tok', identitySecretKey: 'sk', devices: [] }

beforeEach(() => _resetSupervisorForTests())

describe('remoteBridgeSupervisor', () => {
  it('is not running before start', () => {
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('spawns and sends init on start', () => {
    const b = fakeBridge()
    setBridgeSpawner(() => b.handle)
    startRemoteBridge(init)
    expect(isRemoteBridgeRunning()).toBe(true)
    expect(b.sent[0]).toEqual({ kind: 'init', ...init })
  })

  it('forwards bridge messages to subscribers', () => {
    const b = fakeBridge()
    setBridgeSpawner(() => b.handle)
    const seen: BridgeToHost[] = []
    onBridgeMessage((m) => seen.push(m))
    startRemoteBridge(init)
    b.emit({ kind: 'ready' })
    expect(seen).toEqual([{ kind: 'ready' }])
  })

  it('respawns after a crash', () => {
    let spawns = 0
    const bridges: ReturnType<typeof fakeBridge>[] = []
    setBridgeSpawner(() => { spawns++; const b = fakeBridge(); bridges.push(b); return b.handle })
    startRemoteBridge(init)
    bridges[0].emitExit(1)
    expect(spawns).toBe(2)
    expect(isRemoteDisabled()).toBe(false)
  })

  it('fails closed after too many crashes instead of falling back', () => {
    const bridges: ReturnType<typeof fakeBridge>[] = []
    setBridgeSpawner(() => { const b = fakeBridge(); bridges.push(b); return b.handle })
    startRemoteBridge(init)
    for (let i = 0; i < 5; i++) bridges[bridges.length - 1].emitExit(1)
    expect(isRemoteDisabled()).toBe(true)
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('stop kills the child and does not respawn', () => {
    const b = fakeBridge()
    setBridgeSpawner(() => b.handle)
    startRemoteBridge(init)
    stopRemoteBridge()
    expect(b.handle.kill).toHaveBeenCalled()
    expect(isRemoteBridgeRunning()).toBe(false)
    b.emitExit(0)
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('start is idempotent — a second call does not spawn twice', () => {
    let spawns = 0
    setBridgeSpawner(() => { spawns++; return fakeBridge().handle })
    startRemoteBridge(init)
    startRemoteBridge(init)
    expect(spawns).toBe(1)
  })
})
