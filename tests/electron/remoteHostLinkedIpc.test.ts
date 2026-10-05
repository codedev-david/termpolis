// The app's single remote host, as Linked machines reaches it: the stable port,
// the refresh and code accessors, the `linkedInit` binding -- and the Remote IPC
// surface, which must go on describing phones and nothing else. The supervisor
// underneath is the real one: this is where the init factory meets it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { _resetSupervisorForTests, type BridgeHandle } from '../../src/main/remoteBridgeSupervisor'
import { deriveVerificationPhrase, generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { getOrCreateRemoteIdentity } from '../../src/main/remoteIdentityStore'
import { saveRemoteDevices } from '../../src/main/remoteDeviceStore'
import { saveRemoteSettings } from '../../src/main/remoteSettings'
import {
  DEFAULT_RELAY_URL,
  NO_CAPABILITIES,
  type BridgeLink,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
} from '../../src/main/remoteBridge/protocol'
import type { LinkedInit, RemoteEvent, RemoteStatusView } from '../../src/main/remoteBridgeHost'
import {
  REMOTE_LINKED_DEVICE,
  REMOTE_NOT_RUNNING,
  _resetRemoteHostForTests,
  beginRemoteLinkPairing,
  cancelRemoteLinkPairing,
  refreshRemoteLinked,
  registerRemoteIpc,
  remoteLinkedPort,
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
const COMPUTER = generateIdentity()
const COMPUTER_ID = '0f1e2d3c4b5a6978'

function phone(): PairedDevice {
  return {
    id: 'dev1',
    label: 'Pixel 9 Pro',
    publicKey: PHONE.publicKey,
    sessionRoomId: '9e6d0a4c1b8f7e25a3d40c19bf7e6a11',
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
  }
}

function computer(): PairedDevice {
  return {
    id: COMPUTER_ID,
    label: 'build-box',
    publicKey: COMPUTER.publicKey,
    sessionRoomId: '1a2b3c4d5e6f708192a3b4c5d6e7f801',
    capabilities: { ...NO_CAPABILITIES },
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    kind: 'desktop',
  }
}

function link(n: number): BridgeLink {
  const hex = (len: number) => String(n % 10).repeat(len)
  return { id: hex(16), hostPublicKey: hex(64), relayUrl: 'wss://relay.example/ws', sessionRoomId: hex(32), secretKey: hex(64) }
}

type Envelope = { success: boolean; data?: unknown; error?: string }
type Child = {
  relayUrl: string
  posted: HostToBridge[]
  listeners: Record<string, (arg: never) => void>
  killed: number
}

let dir: string

function makeHarness() {
  const forks: Child[] = []
  const statuses: RemoteStatusView[] = []
  const events: RemoteEvent[] = []
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  let linked: LinkedInit = { enabled: false, links: [] }

  registerRemoteIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

  return {
    forks,
    statuses,
    events,
    setLinked: (next: LinkedInit) => {
      linked = next
    },
    start: () =>
      startRemoteBridgeHost({
        userDataDir: dir,
        mcpPort: 4711,
        mcpToken: 'mcp-token',
        sendStatus: (s) => statuses.push(s),
        sendEvent: (e) => events.push(e),
        readOutput: () => ({ output: '', nextOffset: 0, missed: 0 }),
        readRecent: () => null,
        terminalSize: () => null,
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
        linkedInit: () => linked,
      }),
    call: (channel: string, input?: unknown): Envelope => handlers.get(channel)!(null, input) as Envelope,
    /** Deliver a message as the running child would. */
    fromBridge: (m: BridgeToHost) => forks.at(-1)?.listeners.message?.(m as never),
    child: (): Child => forks.at(-1)!,
    initOf: (child: Child) => child.posted[0] as Extract<HostToBridge, { kind: 'init' }>,
  }
}

let h: ReturnType<typeof makeHarness>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-host-linked-ipc-'))
  setSafeStorage(fakeSafeStorage())
  _resetSupervisorForTests()
  _resetRemoteHostForTests()
  h = makeHarness()
})

afterEach(() => {
  stopRemoteBridgeHost()
  _resetSupervisorForTests()
  _resetRemoteHostForTests()
  setSafeStorage(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the linked port before Remote has started', () => {
  it('answers "down" and drops what it is sent, rather than throwing', () => {
    const port = remoteLinkedPort()
    expect(port.running()).toBe(false)
    expect(port.desktopPeers()).toEqual([])
    expect(port.attachedDeviceIds().size).toBe(0)
    expect(port.verificationPhraseFor(COMPUTER_ID)).toBeNull()
    expect(port.relayUrl()).toBe(DEFAULT_RELAY_URL)
    expect(port.linkOfferLive()).toBe(false)
    expect(() => port.send({ kind: 'cancelJoin' })).not.toThrow()
    expect(() => refreshRemoteLinked()).not.toThrow()
    expect(() => beginRemoteLinkPairing()).not.toThrow()
    expect(() => cancelRemoteLinkPairing()).not.toThrow()
    expect(h.forks).toEqual([])
  })

  it('is one port for the whole run', () => {
    const before = remoteLinkedPort()
    h.start()
    expect(remoteLinkedPort()).toBe(before)
  })

  it('keeps a subscription made before start, across a host restart, until it is dropped', () => {
    // Linked machines subscribes while it starts, which can be before Remote has
    // -- Remote waits for the MCP port.
    const heard: string[] = []
    const off = remoteLinkedPort().onMessage((m) => heard.push(m.kind))
    saveRemoteSettings(dir, { enabled: true })
    h.start()
    h.fromBridge({ kind: 'ready' })
    stopRemoteBridgeHost()
    h.start()
    h.fromBridge({ kind: 'devicesChanged', devices: [] })
    off()
    h.fromBridge({ kind: 'ready' })
    expect(heard).toEqual(['ready', 'devicesChanged'])
  })

  it('one listener that throws does not deafen the next', () => {
    remoteLinkedPort().onMessage(() => {
      throw new Error('listener bug')
    })
    const heard: string[] = []
    remoteLinkedPort().onMessage((m) => heard.push(m.kind))
    saveRemoteSettings(dir, { enabled: true })
    h.start()
    expect(() => h.fromBridge({ kind: 'ready' })).not.toThrow()
    expect(heard).toEqual(['ready'])
  })
})

describe('linkedInit and the one bridge', () => {
  it('starts the bridge for Linked machines alone and tells it so', () => {
    h.setLinked({ enabled: true, links: [link(1)] })
    h.start()
    expect(h.forks).toHaveLength(1)
    expect(h.initOf(h.child())).toMatchObject({ kind: 'init', phones: false, linked: true, links: [link(1)] })
    expect(remoteLinkedPort().running()).toBe(true)
    // The phone pane says Remote is not running: no phone can reach this machine.
    expect((h.call('remote:status').data as RemoteStatusView).running).toBe(false)
    expect(h.call('remote:begin-pairing', { label: 'Pixel' })).toEqual({ success: false, error: REMOTE_NOT_RUNNING })
  })

  it('restarts the bridge when the Linked machines switch flips', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.start()
    h.setLinked({ enabled: true, links: [] })
    refreshRemoteLinked()
    expect(h.forks).toHaveLength(2)
    expect(h.forks[0].posted.at(-1)).toEqual({ kind: 'shutdown' })
    expect(h.forks[0].killed).toBe(1)
    expect(h.initOf(h.child())).toMatchObject({ phones: true, linked: true })
  })

  it('hands a changed link list to the running child', () => {
    h.setLinked({ enabled: true, links: [] })
    h.start()
    h.setLinked({ enabled: true, links: [link(2)] })
    refreshRemoteLinked()
    expect(h.forks).toHaveLength(1)
    expect(h.child().posted.at(-1)).toEqual({ kind: 'setLinks', links: [link(2)] })
  })

  it('a crash respawn replays the devices and links of now', () => {
    // The supervisor respawns by itself. Handed the launch-time params, the new
    // child would forget every pairing and link made since.
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: true, links: [link(1)] })
    h.start()
    h.fromBridge({ kind: 'devicesChanged', devices: [phone(), computer()] })
    h.setLinked({ enabled: true, links: [link(1), link(2)] })

    h.child().listeners.exit?.(1 as never)
    expect(h.forks).toHaveLength(2)
    const init = h.initOf(h.child())
    expect(init.devices.map((d) => d.id)).toEqual(['dev1', COMPUTER_ID])
    expect(init.links).toEqual([link(1), link(2)])
  })

  it('a stopped child that exits after its replacement started leaves the replacement alone', () => {
    // A killed utilityProcess reports `exit` a moment later -- by then the
    // restart has spawned the next child. Read as a crash of the CURRENT child,
    // that exit would drop the new child's handle and spawn a third, leaving the
    // second running, unkilled, in every relay seat the third dials.
    saveRemoteSettings(dir, { enabled: true })
    h.start()
    h.setLinked({ enabled: true, links: [] })
    refreshRemoteLinked()
    expect(h.forks).toHaveLength(2)
    const [old, current] = h.forks
    expect(old.killed).toBe(1)

    old.listeners.exit?.(0 as never)
    expect(h.forks).toHaveLength(2)
    expect(current.killed).toBe(0)
    expect(remoteLinkedPort().running()).toBe(true)

    // Its last words are dropped too: they describe a bridge main has let go of.
    const heard: string[] = []
    remoteLinkedPort().onMessage((m) => heard.push(m.kind))
    old.listeners.message?.({ kind: 'devicesChanged', devices: [] } as never)
    current.listeners.message?.({ kind: 'ready' } as never)
    expect(heard).toEqual(['ready'])
  })

  it('a child that crashes on its own is still respawned', () => {
    h.setLinked({ enabled: true, links: [] })
    h.start()
    h.child().listeners.exit?.(1 as never)
    expect(h.forks).toHaveLength(2)
    expect(remoteLinkedPort().running()).toBe(true)
  })

  it('switching Remote off keeps the bridge running for Linked machines', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: true, links: [] })
    h.start()
    const res = h.call('remote:set-enabled', { enabled: false })
    expect((res.data as RemoteStatusView).running).toBe(false)
    expect(h.forks).toHaveLength(2)
    expect(h.child().killed).toBe(0)
    expect(h.initOf(h.child())).toMatchObject({ phones: false, linked: true })
    expect(remoteLinkedPort().running()).toBe(true)
  })
})

describe('the port once Remote has started', () => {
  beforeEach(() => {
    saveRemoteSettings(dir, { enabled: true, relayUrl: 'wss://relay.example/ws' })
    h.setLinked({ enabled: true, links: [] })
    h.start()
  })

  it('reads the host: computers, attachment, safety words and relay', () => {
    const port = remoteLinkedPort()
    h.fromBridge({ kind: 'devicesChanged', devices: [phone(), computer()] })
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    expect(port.desktopPeers().map((d) => d.id)).toEqual([COMPUTER_ID])
    expect([...port.attachedDeviceIds()]).toEqual([COMPUTER_ID])
    expect(port.verificationPhraseFor(COMPUTER_ID)).toBe(
      deriveVerificationPhrase(getOrCreateRemoteIdentity(dir).publicKey, COMPUTER.publicKey),
    )
    expect(port.relayUrl()).toBe('wss://relay.example/ws')
  })

  it('asks for and withdraws a code for another computer', () => {
    beginRemoteLinkPairing()
    expect(h.child().posted.at(-1)).toEqual({ kind: 'beginPairing', label: '', link: true })
    expect(remoteLinkedPort().linkOfferLive()).toBe(true)
    h.fromBridge({ kind: 'pairingCode', qrPayload: 'qr', expiresAt: Date.now() + 60_000, linkCode: 'termpolis-link:x' })
    cancelRemoteLinkPairing()
    expect(h.child().posted.at(-1)).toEqual({ kind: 'cancelPairing' })
    expect(remoteLinkedPort().linkOfferLive()).toBe(false)
  })

  it('posts what Linked machines sends straight to the child', () => {
    remoteLinkedPort().send({ kind: 'renameDevice', deviceId: COMPUTER_ID, label: 'ci' })
    expect(h.child().posted.at(-1)).toEqual({ kind: 'renameDevice', deviceId: COMPUTER_ID, label: 'ci' })
  })

  it('keeps the computer out of everything the phone pane is pushed', () => {
    h.fromBridge({ kind: 'paired', device: computer() })
    h.fromBridge({ kind: 'verificationPhrase', deviceId: COMPUTER_ID, phrase: 'a b c d e f g h' })
    h.fromBridge({ kind: 'devicesChanged', devices: [phone(), computer()] })
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    expect(h.events.map((e) => e.kind)).toEqual(['devicesChanged'])
    const status = h.call('remote:status').data as RemoteStatusView
    expect(status.devices.map((d) => d.id)).toEqual(['dev1'])
    expect(JSON.stringify(h.statuses)).not.toContain(COMPUTER_ID)
  })
})

describe('Remote IPC and linked computers', () => {
  beforeEach(() => {
    saveRemoteSettings(dir, { enabled: true })
    saveRemoteDevices(dir, [phone(), computer()])
    h.start()
  })

  it('refuses to revoke a linked computer, and still revokes a phone', () => {
    // Revoked from here it would vanish without the goodbye Linked machines
    // sends, leaving the other computer holding a link to nothing.
    expect(h.call('remote:revoke-device', { deviceId: COMPUTER_ID })).toEqual({
      success: false,
      error: REMOTE_LINKED_DEVICE,
    })
    expect(h.child().posted.some((m) => m.kind === 'revokeDevice')).toBe(false)
    expect(h.call('remote:revoke-device', { deviceId: 'dev1' }).success).toBe(true)
    expect(h.child().posted.at(-1)).toEqual({ kind: 'revokeDevice', deviceId: 'dev1' })
  })

  it('refuses to grant a linked computer phone capabilities', () => {
    const capabilities = { ...NO_CAPABILITIES, writeToTerminal: true }
    expect(h.call('remote:set-capabilities', { deviceId: COMPUTER_ID, capabilities })).toEqual({
      success: false,
      error: REMOTE_LINKED_DEVICE,
    })
    expect(h.child().posted.some((m) => m.kind === 'setCapabilities')).toBe(false)
  })

  it("gives a linked computer's safety words to Linked machines, not to Remote", () => {
    expect(h.call('remote:verification-phrase', { deviceId: COMPUTER_ID })).toEqual({
      success: false,
      error: REMOTE_LINKED_DEVICE,
    })
    expect(remoteLinkedPort().verificationPhraseFor(COMPUTER_ID)).toMatch(/\w+ \w+/)
    expect(h.call('remote:verification-phrase', { deviceId: 'dev1' }).success).toBe(true)
  })

  it('never makes a code for another computer, even when the payload asks', () => {
    h.call('remote:begin-pairing', { label: 'Pixel', link: true })
    expect(h.child().posted.at(-1)).toEqual({ kind: 'beginPairing', label: 'Pixel' })
    expect(h.child().posted.at(-1)).not.toHaveProperty('link')
    expect(remoteLinkedPort().linkOfferLive()).toBe(false)
  })
})
