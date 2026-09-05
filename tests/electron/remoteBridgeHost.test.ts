import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import {
  deriveVerificationPhrase,
  generateIdentity,
} from '../../src/main/remoteBridge/sealedChannel'
import { deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import { NO_CAPABILITIES, type BridgeToHost, type HostToBridge, type PairedDevice } from '../../src/main/remoteBridge/protocol'
import { loadRemoteDevices, saveRemoteDevices } from '../../src/main/remoteDeviceStore'
import { getOrCreateRemoteIdentity } from '../../src/main/remoteIdentityStore'
import { loadRemoteSettings, saveRemoteSettings } from '../../src/main/remoteSettings'
import { createRemoteHost, type RemoteHost } from '../../src/main/remoteBridgeHost'

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
    sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    ...over,
  }
}

let dir: string
let harness: ReturnType<typeof makeHarness>

/** The host with every seam recorded: the supervisor, the renderer and the
 *  terminal buffers are all injected, so nothing here touches Electron. */
function makeHarness() {
  const started: Array<{ init: Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>; relayUrl: string }> = []
  const posted: HostToBridge[] = []
  const events: Array<{ channel: string; payload: unknown }> = []
  const timers: Array<() => void> = []
  let bridgeListener: (m: BridgeToHost) => void = () => {}
  let running = false
  let disabled = false
  let cleared = 0
  const text: Record<string, string> = {}

  const host: RemoteHost = createRemoteHost({
    userDataDir: dir,
    mcpPort: 3369,
    mcpToken: 'mcp-token',
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    readOutput: (id, from) => {
      const all = text[id] ?? ''
      return { output: all.slice(from), nextOffset: all.length, missed: 0 }
    },
    startBridge: (init, relayUrl) => {
      started.push({ init, relayUrl })
      running = true
    },
    stopBridge: () => {
      running = false
    },
    sendToBridge: (msg) => posted.push(msg),
    onBridgeMessage: (cb) => {
      bridgeListener = cb
    },
    isBridgeRunning: () => running,
    isDisabled: () => disabled,
    clearDisabled: () => {
      disabled = false
    },
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {
      cleared++
    },
  })

  return {
    host,
    get cleared() {
      return cleared
    },
    started,
    posted,
    events,
    /** Deliver a message as the bridge child would. */
    fromBridge: (m: BridgeToHost) => bridgeListener(m),
    write: (id: string, s: string) => {
      text[id] = (text[id] ?? '') + s
    },
    /** Fire every timer the pump has scheduled. */
    tick: () => {
      const due = timers.splice(0, timers.length)
      for (const fn of due) fn()
    },
    trip: () => {
      disabled = true
      running = false
    },
    get running() {
      return running
    },
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-host-'))
  setSafeStorage(fakeSafeStorage())
  harness = makeHarness()
})
afterEach(() => {
  setSafeStorage(null)
  vi.restoreAllMocks()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** Renderer payloads pushed on the `remote:event` channel. */
function remoteEvents(): Array<Record<string, unknown>> {
  return harness.events
    .filter((e) => e.channel === 'remote:event')
    .map((e) => e.payload as Record<string, unknown>)
}

describe('remote bridge host', () => {
  it('does not spawn while remote is disabled in settings', () => {
    // Off by default. A network-facing channel into every terminal on this
    // machine must not open because the app started.
    harness.host.start()
    expect(harness.started).toEqual([])
    expect(harness.host.status().enabled).toBe(false)
  })

  it('spawns with the persisted identity, devices and relay URL when enabled', () => {
    saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    saveRemoteDevices(dir, [pairedDevice()])
    const identity = getOrCreateRemoteIdentity(dir)

    harness.host.start()
    expect(harness.started).toHaveLength(1)
    expect(harness.started[0].relayUrl).toBe('wss://relay.example/ws')
    expect(harness.started[0].init.identitySecretKey).toBe(identity.secretKey)
    expect(harness.started[0].init.devices.map((d) => d.id)).toEqual(['dev1'])
    expect(harness.started[0].init.mcpPort).toBe(3369)
    expect(harness.started[0].init.mcpToken).toBe('mcp-token')
  })

  it('starts the bridge and persists the switch when remote is enabled', () => {
    harness.host.start()
    harness.host.setEnabled(true)
    expect(harness.started).toHaveLength(1)
    expect(loadRemoteSettings(dir).enabled).toBe(true)
  })

  it('stops the bridge but keeps the paired devices when remote is disabled', () => {
    // Disabling is "stop listening", not "forget my phones". Re-pairing every
    // device to pause remote for an afternoon is not what the switch says.
    saveRemoteSettings(dir, { enabled: true })
    saveRemoteDevices(dir, [pairedDevice()])
    harness.host.start()
    harness.host.setEnabled(false)
    expect(harness.running).toBe(false)
    expect(loadRemoteDevices(dir).map((d) => d.id)).toEqual(['dev1'])
    expect(harness.host.status().devices.map((d) => d.id)).toEqual(['dev1'])
  })

  it('persists the device list the bridge reports', () => {
    harness.host.start()
    harness.host.setEnabled(true)
    harness.fromBridge({ kind: 'devicesChanged', devices: [pairedDevice()] })
    expect(loadRemoteDevices(dir).map((d) => d.id)).toEqual(['dev1'])
  })

  it('never exposes the identity secret to the renderer or in status', () => {
    // The renderer renders the pairing UI and nothing else needs the secret. A
    // key that reaches a window is a key in a devtools console.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    const identity = getOrCreateRemoteIdentity(dir)
    harness.fromBridge({ kind: 'devicesChanged', devices: [pairedDevice()] })
    harness.fromBridge({ kind: 'pairingCode', qrPayload: 'qr', expiresAt: 9e15 })

    const serialized = JSON.stringify({ status: harness.host.status(), events: harness.events })
    expect(serialized).not.toContain(identity.secretKey)
    expect(harness.host.status()).not.toHaveProperty('identitySecretKey')
  })

  it('keeps the session room id out of the renderer', () => {
    // The room id is the address on the relay. It is not a decryption key, but
    // knowing it is enough to occupy the desktop's seat -- the relay allows one
    // socket per role and answers the second with 409.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'devicesChanged', devices: [pairedDevice()] })
    const serialized = JSON.stringify({ status: harness.host.status(), events: harness.events })
    expect(serialized).not.toContain('c9dc49b87f0dc983be61f034ceab7c52')
  })

  it('forwards bridge events to the renderer', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'error', message: 'relay closed the connection' })
    expect(remoteEvents()).toContainEqual({
      kind: 'error',
      message: 'relay closed the connection',
    })
  })

  it('carries the safety number and the device it belongs to', () => {
    // The phrase is worthless without knowing which device it is for -- that is
    // the entire comparison the user is being asked to make.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'verificationPhrase', deviceId: 'dev1', phrase: 'a b c d e f g h' })
    expect(remoteEvents()).toContainEqual({
      kind: 'verificationPhrase',
      deviceId: 'dev1',
      phrase: 'a b c d e f g h',
    })
  })

  it('names the device that just paired without shipping its record', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'paired', device: pairedDevice() })
    expect(remoteEvents()).toContainEqual({
      kind: 'paired',
      deviceId: 'dev1',
      label: 'Pixel 9 Pro',
    })
  })

  it('names the device that attached and detached', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'deviceConnected', deviceId: 'dev1' })
    harness.fromBridge({ kind: 'deviceDisconnected', deviceId: 'dev1' })
    expect(remoteEvents()).toContainEqual({ kind: 'deviceConnected', deviceId: 'dev1' })
    expect(remoteEvents()).toContainEqual({ kind: 'deviceDisconnected', deviceId: 'dev1' })
  })

  it('forwards a bare event with nothing to add', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'ready' })
    expect(remoteEvents()).toContainEqual({ kind: 'ready' })
  })

  it('exposes the pairing code and drops it once the device pairs', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'pairingCode', qrPayload: 'qr-payload', expiresAt: 9e15 })
    expect(harness.host.status().pairing).toEqual({ qrPayload: 'qr-payload', expiresAt: 9e15 })
    harness.fromBridge({ kind: 'paired', device: pairedDevice() })
    expect(harness.host.status().pairing).toBeNull()
  })

  it('reports an expired pairing code as no pairing at all', () => {
    // A QR on screen is a bearer credential. Reporting a dead one as live puts a
    // code in front of the user that will simply never work.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'pairingCode', qrPayload: 'qr', expiresAt: Date.now() - 1 })
    expect(harness.host.status().pairing).toBeNull()
  })

  it('recomputes a verification phrase from the two public keys', () => {
    // A pure function of both identities, so it survives a restart and needs no
    // round trip through the child -- which would add a failure mode and answer
    // nothing extra.
    saveRemoteSettings(dir, { enabled: true })
    saveRemoteDevices(dir, [pairedDevice()])
    harness.host.start()
    const identity = getOrCreateRemoteIdentity(dir)
    expect(harness.host.verificationPhraseFor('dev1')).toBe(
      deriveVerificationPhrase(identity.publicKey, PHONE.publicKey),
    )
  })

  it('returns no phrase for a device it has never paired', () => {
    harness.host.start()
    expect(harness.host.verificationPhraseFor('ghost')).toBeNull()
  })

  it('tracks which devices are attached', () => {
    // Paired is not reachable: a device stays paired while the phone is in a
    // tunnel. Showing the two as one thing makes the indicator lie.
    saveRemoteSettings(dir, { enabled: true })
    saveRemoteDevices(dir, [pairedDevice()])
    harness.host.start()
    expect(harness.host.status().devices[0].attached).toBe(false)
    harness.fromBridge({ kind: 'deviceConnected', deviceId: 'dev1' })
    expect(harness.host.status().devices[0].attached).toBe(true)
    harness.fromBridge({ kind: 'deviceDisconnected', deviceId: 'dev1' })
    expect(harness.host.status().devices[0].attached).toBe(false)
  })

  it('forgets attachment when the device is revoked', () => {
    saveRemoteSettings(dir, { enabled: true })
    saveRemoteDevices(dir, [pairedDevice()])
    harness.host.start()
    harness.fromBridge({ kind: 'deviceConnected', deviceId: 'dev1' })
    harness.host.revokeDevice('dev1')
    harness.fromBridge({ kind: 'devicesChanged', devices: [] })
    expect(harness.host.status().devices).toEqual([])
    expect(harness.posted).toContainEqual({ kind: 'revokeDevice', deviceId: 'dev1' })
  })

  it('keeps the other devices attached when one is revoked', () => {
    // Attachment is per device. Clearing the whole set on any registry change
    // would make every other phone read as offline until it happened to send
    // something.
    const other = pairedDevice({ id: 'dev2', label: 'iPad' })
    saveRemoteSettings(dir, { enabled: true })
    saveRemoteDevices(dir, [pairedDevice(), other])
    harness.host.start()
    harness.fromBridge({ kind: 'deviceConnected', deviceId: 'dev1' })
    harness.fromBridge({ kind: 'deviceConnected', deviceId: 'dev2' })
    harness.fromBridge({ kind: 'devicesChanged', devices: [other] })
    expect(harness.host.status().devices).toEqual([
      expect.objectContaining({ id: 'dev2', attached: true }),
    ])
  })

  it('reports the supervisor giving up', () => {
    // The supervisor fails closed on a crash loop. If Settings still showed
    // remote as on, the user would have a switch that says yes and a phone that
    // never connects.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.trip()
    expect(harness.host.status().disabled).toBe(true)
  })

  it('re-arms the supervisor when the user switches remote back on', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.trip()
    harness.host.setEnabled(false)
    harness.host.setEnabled(true)
    expect(harness.host.status().disabled).toBe(false)
    expect(harness.running).toBe(true)
  })

  it('pumps output only for the terminals the bridge subscribed to', () => {
    // The whole point of the subscription message: main pays the serialisation
    // cost for watched terminals and no others.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'subscriptionsChanged', terminalIds: ['t1'] })
    harness.write('t1', 'watched')
    harness.write('t2', 'ignored')
    harness.host.noteTerminalOutput('t1')
    harness.host.noteTerminalOutput('t2')
    harness.tick()
    expect(harness.posted).toEqual([
      { kind: 'terminalOutput', terminalId: 't1', slice: { output: 'watched', nextOffset: 7, missed: 0 } },
    ])
  })

  it('does not read terminals at all while remote is off', () => {
    // No bridge means nowhere to send. Reading anyway would put the cost of
    // remote on every user who never turned it on.
    const read = vi.fn()
    const host = createRemoteHost({
      userDataDir: dir,
      mcpPort: 1,
      mcpToken: 't',
      sendToRenderer: () => {},
      readOutput: read,
      startBridge: () => {},
      stopBridge: () => {},
      sendToBridge: () => {},
      onBridgeMessage: () => {},
      isBridgeRunning: () => false,
      isDisabled: () => false,
      clearDisabled: () => {},
      setTimer: (fn) => {
        fn()
        return 1
      },
      clearTimer: () => {},
    })
    host.start()
    host.noteTerminalOutput('t1')
    expect(read).not.toHaveBeenCalled()
  })

  it('forgets a closed terminal so a reused id starts clean', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'subscriptionsChanged', terminalIds: ['t1'] })
    harness.write('t1', 'first')
    harness.host.noteTerminalOutput('t1')
    harness.tick()
    harness.host.noteTerminalClosed('t1')
    harness.host.noteTerminalOutput('t1')
    harness.tick()
    expect(harness.posted.map((m) => (m as { slice: { output: string } }).slice.output)).toEqual([
      'first',
      'first',
    ])
  })

  it('sends pairing, capability and relay changes down to the bridge', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.host.beginPairing('iPhone 17')
    harness.host.cancelPairing()
    harness.host.setDeviceCapabilities('dev1', { ...NO_CAPABILITIES, read: true })
    expect(harness.posted).toEqual([
      { kind: 'beginPairing', label: 'iPhone 17' },
      { kind: 'cancelPairing' },
      { kind: 'setCapabilities', deviceId: 'dev1', capabilities: { ...NO_CAPABILITIES, read: true } },
    ])
  })

  it('clears a pending pairing code when pairing is cancelled', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'pairingCode', qrPayload: 'qr', expiresAt: 9e15 })
    harness.host.cancelPairing()
    expect(harness.host.status().pairing).toBeNull()
  })

  it('restarts the bridge when the relay URL changes', () => {
    // The child reads the URL once, at bootstrap. Saving the setting without a
    // restart leaves every device dialling the old relay.
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.host.setRelayUrl('wss://other.example/ws')
    expect(harness.started).toHaveLength(2)
    expect(harness.started[1].relayUrl).toBe('wss://other.example/ws')
    expect(harness.host.status().relayUrl).toBe('wss://other.example/ws')
  })

  it('does not start a stopped bridge just because the relay URL changed', () => {
    harness.host.start()
    harness.host.setRelayUrl('wss://other.example/ws')
    expect(harness.started).toEqual([])
    expect(loadRemoteSettings(dir).relayUrl).toBe('wss://other.example/ws')
  })

  it('keeps running when the renderer window is gone', () => {
    // Events are pushed at a window that may have been destroyed a moment ago.
    // A throw here would escape into a bridge message handler and kill remote.
    const host = createRemoteHost({
      userDataDir: dir,
      mcpPort: 1,
      mcpToken: 't',
      sendToRenderer: () => {
        throw new Error('Object has been destroyed')
      },
      readOutput: () => ({ output: '', nextOffset: 0, missed: 0 }),
      startBridge: () => {},
      stopBridge: () => {},
      sendToBridge: () => {},
      onBridgeMessage: (cb) => {
        listener = cb
      },
      isBridgeRunning: () => true,
      isDisabled: () => false,
      clearDisabled: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
    })
    let listener: (m: BridgeToHost) => void = () => {}
    host.start()
    expect(() => listener({ kind: 'error', message: 'x' })).not.toThrow()
  })

  it('stops the bridge and the pump on shutdown', () => {
    saveRemoteSettings(dir, { enabled: true })
    harness.host.start()
    harness.fromBridge({ kind: 'subscriptionsChanged', terminalIds: ['t1'] })
    harness.write('t1', 'in flight')
    harness.host.noteTerminalOutput('t1')
    harness.host.stop()
    expect(harness.running).toBe(false)
    expect(harness.cleared).toBe(1)
    harness.write('t1', 'after')
    harness.host.noteTerminalOutput('t1')
    harness.tick()
    expect(harness.posted).toEqual([])
  })

  it('mints an identity whose public key is what devices pair against', () => {
    harness.host.start()
    const status = harness.host.status()
    expect(status.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(status.publicKey).toBe(getOrCreateRemoteIdentity(dir).publicKey)
    // And it is the key the session room is derived from, so a device paired
    // against it lands in a room this desktop actually dials.
    expect(deriveSessionRoomId(getOrCreateRemoteIdentity(dir).secretKey, PHONE.publicKey)).toMatch(
      /^[0-9a-f]{32}$/,
    )
  })
})
