import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setBridgeSpawner, startRemoteBridge, stopRemoteBridge, isRemoteBridgeRunning,
  isRemoteDisabled, onBridgeMessage, sendToBridge, clearRemoteDisabled,
  _resetSupervisorForTests, type BridgeHandle,
} from '../../src/main/remoteBridgeSupervisor'
import {
  NO_CAPABILITIES,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
} from '../../src/main/remoteBridge/protocol'

/** A device that did not exist when the bridge was first launched. */
const pairedLater: PairedDevice = {
  id: 'paired-later',
  label: 'Pixel',
  publicKey: 'a'.repeat(64),
  sessionRoomId: 'b'.repeat(32),
  capabilities: { ...NO_CAPABILITIES },
  pairedAt: 1,
  lastSeenAt: 1,
}

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

  it('replays the CURRENT init on a respawn, not the one it launched with', () => {
    // The stale-respawn bug: init was captured once at launch, so a bridge that
    // crashed an hour later came back with the devices and links of an hour ago
    // -- a phone paired since then was gone until the next manual restart, and a
    // revoked one was live again. A factory is asked afresh on every spawn.
    const bridges: ReturnType<typeof fakeBridge>[] = []
    setBridgeSpawner(() => {
      const b = fakeBridge()
      bridges.push(b)
      return b.handle
    })
    let devices: PairedDevice[] = []
    const factory = vi.fn(() => ({ ...init, devices }))
    startRemoteBridge(factory)
    expect(bridges[0].sent[0]).toEqual({ kind: 'init', ...init, devices: [] })

    devices = [{ ...pairedLater }]
    bridges[0].emitExit(1)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(bridges[1].sent[0]).toMatchObject({ kind: 'init', devices: [{ id: 'paired-later' }] })
  })

  it('ignores the late exit of a child it already replaced', () => {
    // stop → start → the OLD child's exit arrives. Acting on it would clear the new
    // child's handle, count a crash, and spawn a third bridge that 409s against the
    // second one, which nothing would ever kill.
    const first = fakeBridge()
    const second = fakeBridge()
    const spawned = [first, second]
    let spawns = 0
    setBridgeSpawner(() => spawned[spawns++]?.handle ?? fakeBridge().handle)
    startRemoteBridge(init)
    stopRemoteBridge()
    startRemoteBridge(init)
    expect(spawns).toBe(2)

    first.emitExit(0)

    expect(spawns).toBe(2)
    expect(isRemoteBridgeRunning()).toBe(true)
    sendToBridge({ kind: 'cancelPairing' })
    expect(second.sent.at(-1)).toEqual({ kind: 'cancelPairing' })
  })

  it('drops messages from a child it already stopped', () => {
    const first = fakeBridge()
    const second = fakeBridge()
    const spawned = [first, second]
    let spawns = 0
    setBridgeSpawner(() => spawned[spawns++]!.handle)
    const seen: BridgeToHost[] = []
    onBridgeMessage((m) => seen.push(m))
    startRemoteBridge(init)
    stopRemoteBridge()
    startRemoteBridge(init)

    first.emit({ kind: 'ready' })
    second.emit({ kind: 'devicesChanged', devices: [] })

    expect(seen).toEqual([{ kind: 'devicesChanged', devices: [] }])
  })

  it('start is idempotent — a second call does not spawn twice', () => {
    let spawns = 0
    setBridgeSpawner(() => { spawns++; return fakeBridge().handle })
    startRemoteBridge(init)
    startRemoteBridge(init)
    expect(spawns).toBe(1)
  })
})

describe('supervisor message and re-arm surface', () => {
  /** A spawner whose handle records everything, so a test can assert on what
   *  reached the child rather than only on whether it started. */
  function recordingSpawner() {
    const child = {
      posted: [] as HostToBridge[],
      killed: 0,
      listeners: {} as Record<string, (arg: never) => void>,
      postMessage(m: HostToBridge) {
        child.posted.push(m)
      },
      on(event: string, cb: (arg: never) => void) {
        child.listeners[event] = cb
      },
      kill() {
        child.killed++
      },
    }
    setBridgeSpawner(() => child as unknown as BridgeHandle)
    return child
  }

  it('does nothing when asked to send with no bridge running', () => {
    // Callers react to user actions and PTY writes; neither can know whether the
    // child is up, and making every call site check would spread the race.
    expect(() => sendToBridge({ kind: 'cancelPairing' })).not.toThrow()
  })

  it('forwards a message to the running bridge', () => {
    const child = recordingSpawner()
    startRemoteBridge(init)
    sendToBridge({ kind: 'cancelPairing' })
    expect(child.posted.at(-1)).toEqual({ kind: 'cancelPairing' })
  })

  it('asks the bridge to shut down before killing it', () => {
    // The child closes its relay rooms on `shutdown`, freeing each seat at once.
    // A seat is exclusive -- the relay answers a second desktop socket for the
    // same room with 409 -- so without this the next start races the old
    // sockets' timeouts.
    const child = recordingSpawner()
    startRemoteBridge(init)
    stopRemoteBridge()
    expect(child.posted.at(-1)).toEqual({ kind: 'shutdown' })
    expect(child.killed).toBe(1)
  })

  it('does nothing when no spawner has been wired', () => {
    // Order of wiring is not guaranteed: `index.ts` sets the spawner and starts
    // remote from two different points in bootstrap. Starting first must be a
    // no-op, not a crash on a null call.
    expect(() => startRemoteBridge(init)).not.toThrow()
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('refuses to start again while the flap limit is still tripped', () => {
    // Fail-closed means closed to everyone, including a caller that did not read
    // the flag first. The check lives in `spawn` and nowhere else, so no entry
    // point can slip past it.
    const child = recordingSpawner()
    startRemoteBridge(init)
    for (let i = 0; i < 5; i++) child.listeners.exit?.(1 as never)
    expect(isRemoteDisabled()).toBe(true)

    const before = child.posted.length
    startRemoteBridge(init)
    expect(child.posted).toHaveLength(before)
    expect(isRemoteBridgeRunning()).toBe(false)
  })

  it('re-arms after the flap limit tripped', () => {
    // Failing closed on a crash loop is right for an automatic restart and wrong
    // for a person: toggling remote off and on again is a decision to try once
    // more, and without this the switch would do nothing until an app restart.
    const child = recordingSpawner()
    startRemoteBridge(init)
    for (let i = 0; i < 5; i++) child.listeners.exit?.(1 as never)
    expect(isRemoteDisabled()).toBe(true)

    clearRemoteDisabled()
    expect(isRemoteDisabled()).toBe(false)
    startRemoteBridge(init)
    expect(isRemoteBridgeRunning()).toBe(true)
  })
})

describe('remoteBridgeSupervisor -- crashes age out of the window', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not fail closed on crashes spread over more than a minute', () => {
    // The counter is a RATE, not a total. A machine that suspends nightly, or an
    // app left open for a week, will collect a crash here and a crash there --
    // and if those never expire, the fourth one in a month disables remote until
    // the user finds the switch. Only the ones inside the window may count.
    const bridges: ReturnType<typeof fakeBridge>[] = []
    let spawns = 0
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    setBridgeSpawner(() => {
      spawns++
      const b = fakeBridge()
      bridges.push(b)
      return b.handle
    })
    startRemoteBridge(init)

    // Three crashes at once is the most the policy tolerates: one more inside the
    // window would trip it.
    for (let i = 0; i < 3; i++) bridges[bridges.length - 1].emitExit(1)
    expect(isRemoteDisabled()).toBe(false)

    now.mockReturnValue(61_000)
    bridges[bridges.length - 1].emitExit(1)

    expect(isRemoteDisabled()).toBe(false)
    expect(isRemoteBridgeRunning()).toBe(true)
    expect(spawns).toBe(5)
  })
})
