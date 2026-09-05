import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { _resetSupervisorForTests, type BridgeHandle } from '../../src/main/remoteBridgeSupervisor'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { getOrCreateRemoteIdentity } from '../../src/main/remoteIdentityStore'
import { saveRemoteDevices } from '../../src/main/remoteDeviceStore'
import { saveRemoteSettings, loadRemoteSettings } from '../../src/main/remoteSettings'
import {
  NO_CAPABILITIES,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
} from '../../src/main/remoteBridge/protocol'
import type { RemoteEvent, RemoteStatusView } from '../../src/main/remoteBridgeHost'
import {
  REMOTE_UNAVAILABLE,
  _resetRemoteHostForTests,
  noteTerminalClosed,
  noteTerminalOutput,
  registerRemoteIpc,
  startRemoteBridgeHost,
  stopRemoteBridgeHost,
} from '../../src/main/remoteHost'

const XOR = 0x5a
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8'),
  }
}

const PHONE = generateIdentity()

function pairedDevice(over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'dev1',
    label: 'Pixel 9 Pro',
    publicKey: PHONE.publicKey,
    sessionRoomId: '9e6d0a4c1b8f7e25a3d40c19bf7e6a11',
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    ...over,
  }
}

type Envelope = { success: boolean; data?: unknown; error?: string }

let dir: string

/** The module wired to fakes: a recording ipcMain, a recording renderer and a
 *  child that is an object rather than a process. The supervisor underneath is
 *  the real one -- this is the seam where the two are joined, so stubbing it
 *  would test nothing. */
function makeHarness() {
  const forks: Array<{
    relayUrl: string
    posted: HostToBridge[]
    listeners: Record<string, (arg: never) => void>
    killed: number
  }> = []
  const statuses: RemoteStatusView[] = []
  const events: RemoteEvent[] = []
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  const text: Record<string, string> = {}

  registerRemoteIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

  function start(): void {
    startRemoteBridgeHost({
      userDataDir: dir,
      mcpPort: 4711,
      mcpToken: 'mcp-token',
      sendStatus: (s) => statuses.push(s),
      sendEvent: (e) => events.push(e),
      readOutput: (id, from) => {
        const all = text[id] ?? ''
        return { output: all.slice(from), nextOffset: all.length, missed: 0 }
      },
      createTransport: (relayUrl) => {
        const child = {
          relayUrl,
          posted: [] as HostToBridge[],
          listeners: {} as Record<string, (arg: never) => void>,
          killed: 0,
          postMessage: (m: HostToBridge) => child.posted.push(m),
          on: (event: string, cb: (arg: never) => void) => {
            child.listeners[event] = cb
          },
          kill: () => {
            child.killed++
          },
        }
        forks.push(child)
        return child as unknown as BridgeHandle
      },
    })
  }

  return {
    forks,
    statuses,
    events,
    text,
    start,
    channels: () => [...handlers.keys()],
    call: (channel: string, input?: unknown): Envelope =>
      handlers.get(channel)!(null, input) as Envelope,
    /** Deliver a message as the running child would. */
    fromBridge: (m: BridgeToHost) => forks.at(-1)?.listeners.message?.(m as never),
    child: () => forks.at(-1)!,
  }
}

let harness: ReturnType<typeof makeHarness>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-remote-host-'))
  setSafeStorage(fakeSafeStorage() as never)
  _resetSupervisorForTests()
  _resetRemoteHostForTests()
  harness = makeHarness()
})

afterEach(() => {
  stopRemoteBridgeHost()
  _resetSupervisorForTests()
  _resetRemoteHostForTests()
  setSafeStorage(null as never)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('remoteHost lifecycle', () => {
  it('starts stopped, and every channel says so rather than throwing', () => {
    // The Settings pane asks for status on mount whether or not remote ever came
    // up. A rejected invoke there is an unhandled rejection in the renderer and a
    // pane with nothing in it; a message is something the user can read.
    for (const channel of harness.channels()) {
      const res = harness.call(channel, { deviceId: 'dev1', capabilities: {} })
      expect(res).toEqual({ success: false, error: REMOTE_UNAVAILABLE })
    }
  })

  it('reports the desktop public key once started', () => {
    harness.start()
    const status = harness.call('remote:status').data as RemoteStatusView
    expect(status.enabled).toBe(false)
    expect(status.running).toBe(false)
    expect(status.publicKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not mint an identity until remote is actually used', () => {
    // A user who never turns remote on should never find a key file in their
    // profile. `start()` alone is not use: it runs on every launch.
    saveRemoteSettings(dir, { enabled: false })
    harness.start()
    expect(fs.existsSync(path.join(dir, 'remote-identity.json'))).toBe(false)
  })

  it('brings the bridge up on start when the setting is already on', () => {
    saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    harness.start()
    expect(harness.forks).toHaveLength(1)
    expect(harness.child().relayUrl).toBe('wss://relay.example/ws')
    const init = harness.child().posted[0] as Extract<HostToBridge, { kind: 'init' }>
    expect(init.kind).toBe('init')
    expect(init.mcpPort).toBe(4711)
    expect(init.mcpToken).toBe('mcp-token')
    expect(init.identitySecretKey).toBe(getOrCreateRemoteIdentity(dir).secretKey)
  })

  it('hands the stored devices to the child so a paired phone survives a restart', () => {
    saveRemoteDevices(dir, [pairedDevice()])
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    const init = harness.child().posted[0] as Extract<HostToBridge, { kind: 'init' }>
    expect(init.devices.map((d) => d.id)).toEqual(['dev1'])
  })

  it('starting twice does not build a second host', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.start()
    expect(harness.forks).toHaveLength(1)
  })

  it('stopping asks the child to close its rooms, then kills it', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    stopRemoteBridgeHost()
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'shutdown' })
    expect(harness.child().killed).toBe(1)
    expect(harness.call('remote:status')).toEqual({ success: false, error: REMOTE_UNAVAILABLE })
  })

  it('a restarted host is the only one listening to the bridge', () => {
    // The supervisor has no unsubscribe. Subscribing again on every start would
    // leave the previous host's handler live -- and it would keep writing its own
    // stale device list to disk on every `devicesChanged`.
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    stopRemoteBridgeHost()

    harness.start()
    harness.fromBridge({ kind: 'devicesChanged', devices: [pairedDevice({ id: 'only-once' })] })
    const seen = harness.events.filter((e) => e.kind === 'devicesChanged')
    expect(seen).toHaveLength(1)
  })
})

describe('remote IPC surface', () => {
  it('turns the bridge on and off', () => {
    harness.start()
    expect((harness.call('remote:set-enabled', { enabled: true }).data as RemoteStatusView).running).toBe(true)
    expect(loadRemoteSettings(dir).enabled).toBe(true)

    expect((harness.call('remote:set-enabled', { enabled: false }).data as RemoteStatusView).running).toBe(false)
    expect(loadRemoteSettings(dir).enabled).toBe(false)
  })

  it('treats a payload that is not exactly `true` as off', () => {
    // A switch that opens a network path fails in the safe direction. `'true'`,
    // `1` and `{}` are all truthy, and any of them arriving here is a bug.
    harness.start()
    harness.call('remote:set-enabled', { enabled: 'true' })
    expect(loadRemoteSettings(dir).enabled).toBe(false)
    harness.call('remote:set-enabled', {})
    expect(loadRemoteSettings(dir).enabled).toBe(false)
  })

  it('saves a relay URL and moves the running bridge to it', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    const res = harness.call('remote:set-relay-url', { relayUrl: 'wss://relay2.example/ws ' })
    expect(res.success).toBe(true)
    expect(harness.forks).toHaveLength(2)
    expect(harness.child().relayUrl).toBe('wss://relay2.example/ws')
  })

  it('rejects a relay URL the store will not keep, and leaves the bridge alone', () => {
    // The store answers a refused address by keeping the old one, so without the
    // effective-value check the field would look saved while every device kept
    // using the previous relay.
    saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    harness.start()
    const res = harness.call('remote:set-relay-url', { relayUrl: 'http://relay.example' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/ws:\/\/ or wss:\/\//)
    expect(harness.forks).toHaveLength(1)
    expect(loadRemoteSettings(dir).relayUrl).toBe('wss://relay.example/ws')
  })

  it('rejects a relay URL that is not a string at all', () => {
    harness.start()
    expect(harness.call('remote:set-relay-url', { relayUrl: 42 }).success).toBe(false)
  })

  it('does not restart the bridge when the address has not changed', () => {
    // Re-saving the address already in effect would otherwise drop every
    // connected phone for nothing.
    saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    harness.start()
    expect(harness.call('remote:set-relay-url', { relayUrl: 'wss://relay.example/ws' }).success).toBe(true)
    expect(harness.forks).toHaveLength(1)
  })

  it('asks the bridge to begin and cancel pairing', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.call('remote:begin-pairing', { label: 'David iPhone' })
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'beginPairing', label: 'David iPhone' })

    harness.call('remote:cancel-pairing')
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'cancelPairing' })
  })

  it('strips control characters out of a device label', () => {
    // The label lands in the device list beside a live terminal. An embedded
    // escape sequence there is a way to redraw a pane it has no business touching.
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.call('remote:begin-pairing', { label: '  Pixel[2J 9  ' })
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'beginPairing', label: 'Pixel[2J 9' })
  })

  it('caps a label and falls back to a name when there is nothing left', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.call('remote:begin-pairing', { label: 'x'.repeat(200) })
    expect((harness.child().posted.at(-1) as { label: string }).label).toHaveLength(64)

    harness.call('remote:begin-pairing', { label: ' ' })
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'beginPairing', label: 'Phone' })

    harness.call('remote:begin-pairing', {})
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'beginPairing', label: 'Phone' })
  })

  it('revokes a device by id', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    expect(harness.call('remote:revoke-device', { deviceId: ' dev1 ' }).success).toBe(true)
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'revokeDevice', deviceId: 'dev1' })
  })

  it('refuses a revoke with no device id', () => {
    harness.start()
    expect(harness.call('remote:revoke-device', { deviceId: '  ' }).error).toMatch(/device id/)
    expect(harness.call('remote:revoke-device', {}).error).toMatch(/device id/)
  })
})

describe('capability validation at the IPC boundary', () => {
  beforeEach(() => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
  })

  it('forwards a clean payload', () => {
    const capabilities = { read: true, createTerminal: true, writeToTerminal: false, closeTerminal: false }
    expect(harness.call('remote:set-capabilities', { deviceId: 'dev1', capabilities }).success).toBe(true)
    expect(harness.child().posted.at(-1)).toEqual({ kind: 'setCapabilities', deviceId: 'dev1', capabilities })
  })

  it('drops a key the protocol does not define', () => {
    // Rebuilt from the allowlist rather than spread, so a field invented by the
    // caller cannot reach the registry -- or the policy check that reads it.
    harness.call('remote:set-capabilities', {
      deviceId: 'dev1',
      capabilities: { read: true, runAnything: true },
    })
    const sent = harness.child().posted.at(-1) as unknown as { capabilities: Record<string, unknown> }
    expect(Object.keys(sent.capabilities).sort()).toEqual(Object.keys(NO_CAPABILITIES).sort())
  })

  it('rejects a non-boolean flag by name instead of silently granting nothing', () => {
    // This is the one place a compromised renderer could grant itself
    // `writeToTerminal`. Coercing `'true'` to false would hide the attempt; the
    // rejection puts it in front of someone.
    const res = harness.call('remote:set-capabilities', {
      deviceId: 'dev1',
      capabilities: { read: true, writeToTerminal: 'true' },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('writeToTerminal')
    expect(harness.child().posted.some((m) => m.kind === 'setCapabilities')).toBe(false)
  })

  it('rejects a capabilities value that is not an object', () => {
    for (const capabilities of [null, 'read', 7, ['read']]) {
      const res = harness.call('remote:set-capabilities', { deviceId: 'dev1', capabilities })
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/must be an object/)
    }
    expect(harness.call('remote:set-capabilities', { deviceId: 'dev1' }).success).toBe(false)
  })

  it('refuses a capability change with no device id', () => {
    expect(harness.call('remote:set-capabilities', { capabilities: {} }).error).toMatch(/device id/)
  })
})

describe('verification phrase over IPC', () => {
  it('derives a phrase for a paired device', () => {
    saveRemoteDevices(dir, [pairedDevice()])
    harness.start()
    const res = harness.call('remote:verification-phrase', { deviceId: 'dev1' })
    expect(res.success).toBe(true)
    const data = res.data as { deviceId: string; phrase: string }
    expect(data.deviceId).toBe('dev1')
    expect(data.phrase.split(' ').length).toBeGreaterThan(2)
  })

  it('says so when the device is not paired here', () => {
    harness.start()
    const res = harness.call('remote:verification-phrase', { deviceId: 'ghost' })
    expect(res).toEqual({ success: false, error: 'That device is not paired with this desktop' })
  })

  it('refuses a phrase lookup with no device id', () => {
    harness.start()
    expect(harness.call('remote:verification-phrase', {}).error).toMatch(/device id/)
  })
})

describe('renderer pushes and terminal hooks', () => {
  it('pushes status and an event when the bridge says something', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.fromBridge({ kind: 'pairingCode', qrPayload: 'tp1:x', expiresAt: Date.now() + 60_000 })
    expect(harness.events.at(-1)).toEqual({ kind: 'pairingCode' })
    expect(harness.statuses.at(-1)?.pairing?.qrPayload).toBe('tp1:x')
  })

  it('never lets a session room id reach the renderer', () => {
    // It decrypts nothing, but it names this desktop's seat on the relay, and a
    // seat is exclusive: holding it locks the real phone out with a 409.
    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.fromBridge({ kind: 'devicesChanged', devices: [pairedDevice()] })
    const pushed = JSON.stringify({ statuses: harness.statuses, events: harness.events })
    expect(pushed).not.toContain(pairedDevice().sessionRoomId)
  })

  it('marks a terminal dirty for the pump only while a host exists', () => {
    // Both run on the PTY data path, ahead of the renderer's own write, so they
    // have to be free before remote has started -- and after it has stopped.
    expect(() => noteTerminalOutput('t1')).not.toThrow()
    expect(() => noteTerminalClosed('t1')).not.toThrow()

    saveRemoteSettings(dir, { enabled: true })
    harness.start()
    harness.text.t1 = 'hello'
    harness.fromBridge({ kind: 'subscriptionsChanged', terminalIds: ['t1'] })
    expect(() => noteTerminalOutput('t1')).not.toThrow()

    stopRemoteBridgeHost()
    expect(() => noteTerminalOutput('t1')).not.toThrow()
    expect(() => noteTerminalClosed('t1')).not.toThrow()
  })
})
