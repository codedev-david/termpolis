// The remote host as Linked machines sees it: one bridge that runs while Remote
// OR Linked machines is on, told at every spawn which kinds of room to open, and
// a port through which Linked machines hears every bridge message -- while the
// phone UI keeps seeing phones and nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { deriveVerificationPhrase, generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import {
  NO_CAPABILITIES,
  type BridgeLink,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
} from '../../src/main/remoteBridge/protocol'
import { loadRemoteDevices, saveRemoteDevices } from '../../src/main/remoteDeviceStore'
import { getOrCreateRemoteIdentity } from '../../src/main/remoteIdentityStore'
import { saveRemoteSettings } from '../../src/main/remoteSettings'
import {
  createRemoteHost,
  type LinkedBridgePort,
  type LinkedInit,
  type RemoteEvent,
  type RemoteHost,
  type RemoteHostDeps,
  type RemoteStatusView,
} from '../../src/main/remoteBridgeHost'

type InitParams = Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>

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
const COMPUTER_ID = 'a1b2c3d4e5f60718'
const LINK_CODE = 'termpolis-link:eyJ2IjoxfQ'

function phone(over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'phone1',
    label: 'Pixel 9 Pro',
    publicKey: PHONE.publicKey,
    sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    ...over,
  }
}

/** The host's half of a link: a paired device that is another computer. */
function computer(over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: COMPUTER_ID,
    label: 'build-box',
    publicKey: COMPUTER.publicKey,
    sessionRoomId: '5e1f0c2d3b4a69788796a5b4c3d2e1f0',
    capabilities: { ...NO_CAPABILITIES },
    pairedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    kind: 'desktop',
    ...over,
  }
}

/** A link this machine joined, as main hands it down. */
function link(n: number, over: Partial<BridgeLink> = {}): BridgeLink {
  const hex = (len: number) => String(n % 10).repeat(len)
  return {
    id: hex(16),
    hostPublicKey: hex(64),
    relayUrl: 'wss://relay.example/ws',
    sessionRoomId: hex(32),
    secretKey: hex(64),
    ...over,
  }
}

/** A code from the bridge: a phone QR, or -- with `link` -- a code for another computer. */
function code(opts: { link?: boolean; expiresAt?: number } = {}): BridgeToHost {
  return {
    kind: 'pairingCode',
    qrPayload: opts.link ? 'link-qr' : 'phone-qr',
    expiresAt: opts.expiresAt ?? 9e15,
    ...(opts.link ? { linkCode: LINK_CODE } : {}),
  }
}

let dir: string

/** The host with a supervisor stand-in that behaves like the real one where it
 *  matters here: a tripped supervisor spawns nothing, a running one ignores a
 *  second start, a send while it is down goes nowhere, and a crash respawn asks
 *  the init factory again. */
function makeHarness(opts: { provider?: boolean } = {}) {
  const started: Array<{ init: InitParams; relayUrl: string }> = []
  let factory: (() => InitParams) | null = null
  let relay = ''
  const posted: HostToBridge[] = []
  const statuses: RemoteStatusView[] = []
  const events: RemoteEvent[] = []
  const heard: BridgeToHost[] = []
  const timers: Array<() => void> = []
  const reads = vi.fn()
  let bridgeListener: (m: BridgeToHost) => void = () => {}
  let running = false
  let disabled = false
  let stops = 0
  let rearms = 0
  let linked: LinkedInit = { enabled: false, links: [] }

  const deps: RemoteHostDeps = {
    userDataDir: dir,
    mcpPort: 3369,
    mcpToken: 'mcp-token',
    sendStatus: (s) => statuses.push(s),
    sendEvent: (e) => events.push(e),
    readOutput: (id) => {
      reads(id)
      return { output: '', nextOffset: 0, missed: 0 }
    },
    readRecent: (id) => {
      reads(id)
      return null
    },
    terminalSize: () => null,
    startBridge: (init, relayUrl) => {
      if (disabled || running) return
      factory = init
      relay = relayUrl
      started.push({ init: init(), relayUrl })
      running = true
    },
    stopBridge: () => {
      stops++
      running = false
    },
    sendToBridge: (msg) => {
      if (running) posted.push(msg)
    },
    onBridgeMessage: (cb) => {
      bridgeListener = cb
    },
    isBridgeRunning: () => running,
    isDisabled: () => disabled,
    clearDisabled: () => {
      rearms++
      disabled = false
    },
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
    ...(opts.provider === false ? {} : { linkedInit: () => linked }),
  }
  const host: RemoteHost = createRemoteHost(deps)
  const port: LinkedBridgePort = host.linkedPort()
  port.onMessage((m) => heard.push(m))

  return {
    host,
    port,
    started,
    posted,
    statuses,
    events,
    heard,
    reads,
    fromBridge: (m: BridgeToHost) => bridgeListener(m),
    setLinked: (next: LinkedInit) => {
      linked = next
    },
    /** The child died and the supervisor spawned another, as it does by itself. */
    respawn: () => {
      if (!factory) throw new Error('nothing was ever spawned')
      started.push({ init: factory(), relayUrl: relay })
    },
    /** The supervisor gave up after a crash loop. */
    trip: () => {
      disabled = true
      running = false
    },
    tick: () => {
      for (const fn of timers.splice(0, timers.length)) fn()
    },
    get running() {
      return running
    },
    get disabled() {
      return disabled
    },
    get stops() {
      return stops
    },
    get rearms() {
      return rearms
    },
    lastInit: () => started.at(-1)!.init,
  }
}

/** A host whose supervisor spawns when the test says, not when it is asked --
 *  as one would that waits for the old child to exit first. `runningAtStart`
 *  is whether the child counts as running before its init is built. */
function deferredHost(opts: { runningAtStart: boolean }) {
  let factory: (() => InitParams) | null = null
  let running = false
  let listener: (m: BridgeToHost) => void = () => {}
  const events: RemoteEvent[] = []
  const posted: HostToBridge[] = []
  const host = createRemoteHost({
    userDataDir: dir,
    mcpPort: 1,
    mcpToken: 't',
    sendStatus: () => {},
    sendEvent: (e) => events.push(e),
    readOutput: () => ({ output: '', nextOffset: 0, missed: 0 }),
    readRecent: () => null,
    terminalSize: () => null,
    startBridge: (init) => {
      factory = init
      if (opts.runningAtStart) running = true
    },
    stopBridge: () => {
      running = false
    },
    sendToBridge: (msg) => {
      if (running) posted.push(msg)
    },
    onBridgeMessage: (cb) => {
      listener = cb
    },
    isBridgeRunning: () => running,
    isDisabled: () => false,
    clearDisabled: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
    linkedInit: () => ({ enabled: true, links: [] }),
  })
  return {
    host,
    events,
    posted,
    spawn: () => {
      running = true
      factory!()
    },
    fromBridge: (m: BridgeToHost) => listener(m),
  }
}

let h: ReturnType<typeof makeHarness>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-host-linked-'))
  setSafeStorage(fakeSafeStorage())
  h = makeHarness()
})

afterEach(() => {
  setSafeStorage(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('one bridge for two switches', () => {
  it('starts the bridge for Linked machines alone, with no phone room open', () => {
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.start()
    expect(h.started).toHaveLength(1)
    expect(h.lastInit()).toMatchObject({ phones: false, linked: true, links: [link(1)] })
    // Remote's switch is off, so the phone UI says so -- the child is running,
    // but no phone can reach this desktop through it.
    expect(h.host.status()).toMatchObject({ enabled: false, running: false })
    expect(h.port.running()).toBe(true)
  })

  it('leaves the bridge down while both switches are off', () => {
    h.host.start()
    h.host.refreshLinked()
    expect(h.started).toEqual([])
    expect(h.port.running()).toBe(false)
  })

  it('tells a phones-only bridge to keep linked rooms shut', () => {
    // Both switches always travel: an init that left `linked` out would mean
    // the same thing today, but one that left `phones` out would mean "on".
    const bare = makeHarness({ provider: false })
    saveRemoteSettings(dir, { enabled: true })
    bare.host.start()
    expect(bare.lastInit()).toMatchObject({ phones: true, linked: false, links: [] })
    expect(bare.port.running()).toBe(false)
    expect(bare.host.status().running).toBe(true)
    // With no provider there is nothing to refresh to.
    bare.host.refreshLinked()
    expect(bare.started).toHaveLength(1)
    expect(bare.posted).toEqual([])
  })

  it('hands a respawned bridge the devices, links and switches of now', () => {
    h.setLinked({ enabled: true, links: [link(1)] })
    saveRemoteSettings(dir, { enabled: true })
    h.host.start()
    h.fromBridge({ kind: 'devicesChanged', devices: [phone(), computer()] })
    h.setLinked({ enabled: true, links: [link(1), link(2)] })

    h.respawn()
    expect(h.lastInit().devices.map((d) => d.id)).toEqual(['phone1', COMPUTER_ID])
    expect(h.lastInit().links).toEqual([link(1), link(2)])
    // And the host records what the new child was actually told, so a refresh
    // now has nothing to send it.
    h.host.refreshLinked()
    expect(h.posted.filter((m) => m.kind === 'setLinks')).toEqual([])
  })

  it('resolves the identity before the bridge is spawned, not inside the factory', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    expect(h.lastInit().identitySecretKey).toBe(getOrCreateRemoteIdentity(dir).secretKey)
    expect(h.lastInit()).toMatchObject({ mcpPort: 3369, mcpToken: 'mcp-token' })
  })
})

describe('refreshLinked', () => {
  it('starts the bridge when Linked machines is switched on', () => {
    h.host.start()
    const pushed = h.statuses.length
    h.setLinked({ enabled: true, links: [] })
    h.host.refreshLinked()
    expect(h.started).toHaveLength(1)
    expect(h.lastInit()).toMatchObject({ phones: false, linked: true })
    expect(h.statuses.length).toBe(pushed + 1)
  })

  it('stops the bridge when Linked machines is switched off and Remote is off', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.setLinked({ enabled: false, links: [] })
    h.host.refreshLinked()
    expect(h.running).toBe(false)
    expect(h.port.running()).toBe(false)
  })

  it('restarts a running phone bridge with linked rooms when Linked machines is switched on', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.host.start()
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.refreshLinked()
    // Which rooms open is fixed at init, so this is a new bridge, not a message.
    expect(h.started.map((s) => [s.init.phones, s.init.linked])).toEqual([
      [true, false],
      [true, true],
    ])
    expect(h.stops).toBe(1)
    expect(h.lastInit().links).toEqual([link(1)])
    expect(h.port.running()).toBe(true)
    expect(h.host.status().running).toBe(true)
  })

  it('restarts without linked rooms when Linked machines is switched off while Remote runs', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.start()
    h.setLinked({ enabled: false, links: [link(1)] })
    h.host.refreshLinked()
    expect(h.started.map((s) => [s.init.phones, s.init.linked])).toEqual([
      [true, true],
      [true, false],
    ])
    expect(h.running).toBe(true)
    expect(h.port.running()).toBe(false)
  })

  it('hands a running bridge a changed link list instead of restarting it', () => {
    // A restart would drop every live session -- phones included -- for the
    // sake of one new room. The bridge diffs the list itself.
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.start()
    const pushed = h.statuses.length
    h.setLinked({ enabled: true, links: [link(1), link(2)] })
    h.host.refreshLinked()
    expect(h.started).toHaveLength(1)
    expect(h.posted).toEqual([{ kind: 'setLinks', links: [link(1), link(2)] }])
    // Nothing the phone UI shows has moved.
    expect(h.statuses.length).toBe(pushed)
  })

  it('sends nothing when nothing changed', () => {
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.start()
    h.host.refreshLinked()
    h.host.refreshLinked()
    expect(h.started).toHaveLength(1)
    expect(h.posted).toEqual([])
  })

  it('notices a link list the provider edited in place', () => {
    const links = [link(1)]
    h.setLinked({ enabled: true, links })
    h.host.start()
    links.push(link(2))
    h.host.refreshLinked()
    expect(h.posted).toEqual([{ kind: 'setLinks', links: [link(1), link(2)] }])
  })

  it('treats a changed record under the same id as a change', () => {
    // A new key under an old id is a different room to the bridge.
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.start()
    h.setLinked({ enabled: true, links: [link(1, { secretKey: '9'.repeat(64) })] })
    h.host.refreshLinked()
    expect(h.posted).toEqual([{ kind: 'setLinks', links: [link(1, { secretKey: '9'.repeat(64) })] }])
  })

  it('records a link list posted straight through the port', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.port.send({ kind: 'setLinks', links: [link(1)] })
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.refreshLinked()
    expect(h.posted).toEqual([{ kind: 'setLinks', links: [link(1)] }])
  })

  it('does nothing before start, and nothing once stopped', () => {
    // `start()` reads `linkedInit` itself; a refresh before it would launch a
    // bridge whose messages nothing is listening to yet.
    h.setLinked({ enabled: true, links: [] })
    h.host.refreshLinked()
    expect(h.started).toEqual([])
    h.host.start()
    h.host.stop()
    h.host.refreshLinked()
    expect(h.started).toHaveLength(1)
    expect(h.running).toBe(false)
  })

  it('replaces a running bridge it has no record of rather than trusting it', () => {
    let running = true
    const startBridge = vi.fn()
    const stopBridge = vi.fn(() => {
      running = false
    })
    const host = createRemoteHost({
      userDataDir: dir,
      mcpPort: 1,
      mcpToken: 't',
      sendStatus: () => {},
      sendEvent: () => {},
      readOutput: () => ({ output: '', nextOffset: 0, missed: 0 }),
      readRecent: () => null,
      terminalSize: () => null,
      // Never asks the factory, so the host never learns what this child was told.
      startBridge,
      stopBridge,
      sendToBridge: () => {},
      onBridgeMessage: () => {},
      isBridgeRunning: () => running,
      isDisabled: () => false,
      clearDisabled: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
      linkedInit: () => ({ enabled: true, links: [] }),
    })
    host.start()
    host.refreshLinked()
    expect(stopBridge).toHaveBeenCalledTimes(1)
    expect(startBridge).toHaveBeenCalledTimes(2)
  })

  it('reads a provider that answers nothing as Linked machines off', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked(null as unknown as LinkedInit)
    h.host.start()
    expect(h.lastInit()).toMatchObject({ phones: true, linked: false, links: [] })
  })

  it('reads a malformed provider answer as off, with no links', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: 'yes', links: 'all of them' } as unknown as LinkedInit)
    h.host.start()
    expect(h.lastInit()).toMatchObject({ linked: false, links: [] })
  })

  it('a provider that throws does not take the host down on a respawn', () => {
    h.setLinked({ enabled: true, links: [] })
    saveRemoteSettings(dir, { enabled: true })
    h.host.start()
    h.setLinked({
      get enabled(): boolean {
        throw new Error('state not loaded')
      },
      links: [],
    })
    expect(() => h.respawn()).not.toThrow()
    expect(h.lastInit()).toMatchObject({ phones: true, linked: false })
  })
})

describe('the Remote switch with Linked machines on', () => {
  it('switching Remote off keeps the bridge for Linked machines, without phone rooms', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.start()
    h.host.setEnabled(false)
    expect(h.running).toBe(true)
    expect(h.started.map((s) => [s.init.phones, s.init.linked])).toEqual([
      [true, true],
      [false, true],
    ])
    expect(h.host.status()).toMatchObject({ enabled: false, running: false })
    expect(h.port.running()).toBe(true)
  })

  it('switching Remote on restarts a linked-only bridge with phone rooms', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.host.setEnabled(true)
    expect(h.started.map((s) => [s.init.phones, s.init.linked])).toEqual([
      [false, true],
      [true, true],
    ])
    expect(h.host.status().running).toBe(true)
  })

  it('does not restart a bridge that already has phone rooms when Remote is switched on again', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.host.start()
    h.host.setEnabled(true)
    expect(h.started).toHaveLength(1)
    expect(h.stops).toBe(0)
  })

  it('switching both off stops the bridge', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.setLinked({ enabled: false, links: [] })
    h.host.refreshLinked()
    h.host.setEnabled(false)
    expect(h.running).toBe(false)
  })

  it('moves a linked-only bridge to a new relay', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.host.setRelayUrl('wss://other.example/ws')
    expect(h.started.map((s) => s.relayUrl)).toEqual(['wss://relay.termpolis.com', 'wss://other.example/ws'])
    expect(h.lastInit()).toMatchObject({ phones: false, linked: true })
    expect(h.port.relayUrl()).toBe('wss://other.example/ws')
  })

  it('tells the phone pane nothing while Remote is off -- only its status', () => {
    // The bridge runs for Linked machines alone. Its relay errors, its device
    // list and its restarts are not something the phone pane has to show.
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    const pushed = h.statuses.length
    h.fromBridge({ kind: 'ready' })
    h.fromBridge({ kind: 'error', message: 'relay closed a linked machine connection: frame-rate' })
    h.fromBridge({ kind: 'devicesChanged', devices: [computer()] })
    expect(h.events).toEqual([])
    expect(h.statuses.length).toBe(pushed + 3)
    expect(h.heard.map((m) => m.kind)).toEqual(['ready', 'error', 'devicesChanged'])
  })
})

describe('re-arming a supervisor that gave up', () => {
  it('switching Linked machines on re-arms it, as switching Remote on does', () => {
    h.host.start()
    h.trip()
    h.setLinked({ enabled: true, links: [] })
    h.host.refreshLinked()
    expect(h.disabled).toBe(false)
    expect(h.running).toBe(true)
  })

  it('a changed link list does not re-arm it', () => {
    // Only the switch is the user saying "try again". A link that arrives while
    // the bridge is down is not.
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.trip()
    h.setLinked({ enabled: true, links: [link(1)] })
    h.host.refreshLinked()
    expect(h.rearms).toBe(0)
    expect(h.disabled).toBe(true)
    expect(h.running).toBe(false)
  })
})

describe('terminals', () => {
  it('does not read terminals for a bridge running for Linked machines alone', () => {
    // The pumps stream terminals to phones. With Remote off there is no phone,
    // and every PTY write would otherwise pay for one.
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.fromBridge({ kind: 'subscriptionsChanged', terminalIds: ['t1'] })
    h.host.noteTerminalOutput('t1')
    h.tick()
    h.host.noteTerminalClosed('t1')
    expect(h.reads).not.toHaveBeenCalled()
    expect(h.posted.filter((m) => m.kind === 'terminalOutput' || m.kind === 'terminalStatus')).toEqual([])
  })

  it('pumps again once Remote is switched on', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.host.setEnabled(true)
    h.fromBridge({ kind: 'subscriptionsChanged', terminalIds: ['t1'] })
    expect(h.reads).toHaveBeenCalledWith('t1')
  })
})

describe('the phone UI sees phones only', () => {
  beforeEach(() => {
    saveRemoteSettings(dir, { enabled: true })
  })

  it('lists phones in Remote and computers through the port, and persists both', () => {
    h.host.start()
    h.fromBridge({ kind: 'devicesChanged', devices: [phone(), computer()] })
    expect(h.host.status().devices.map((d) => d.id)).toEqual(['phone1'])
    expect(h.statuses.at(-1)!.devices.map((d) => d.id)).toEqual(['phone1'])
    expect(h.port.desktopPeers()).toEqual([computer()])
    // The file is the host's half of every link, so the computer stays in it --
    // as a computer.
    expect(loadRemoteDevices(dir)).toEqual([phone(), computer()])
  })

  it('keeps a computer that just paired out of the phone UI', () => {
    // A `paired` reaching Remote would open the "phone paired" modal for a
    // machine, with safety words the user is comparing on another screen.
    h.host.start()
    const pushed = h.statuses.length
    h.fromBridge({ kind: 'paired', device: computer() })
    h.fromBridge({ kind: 'verificationPhrase', deviceId: COMPUTER_ID, phrase: 'a b c d e f g h' })
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    h.fromBridge({ kind: 'deviceDisconnected', deviceId: COMPUTER_ID })
    expect(h.events).toEqual([])
    expect(h.statuses.length).toBe(pushed)
    expect(h.heard.map((m) => m.kind)).toEqual([
      'paired',
      'verificationPhrase',
      'deviceConnected',
      'deviceDisconnected',
    ])
  })

  it("keeps a new computer's room out even though it is reported before the pairing", () => {
    // The bridge opens the new device's room -- and reports it -- before it
    // reports the pairing, so the first word about a computer comes under an id
    // nothing has heard of. The offer is what says what it is.
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.host.beginLinkPairing()
    h.fromBridge(code({ link: true }))
    h.fromBridge({ kind: 'deviceDisconnected', deviceId: COMPUTER_ID })
    h.fromBridge({ kind: 'paired', device: computer() })
    expect(h.events).toEqual([])

    // The same first word during a PHONE offer is a phone's, as it always was.
    h.host.beginPairing('iPhone 17')
    h.fromBridge(code())
    h.fromBridge({ kind: 'deviceDisconnected', deviceId: 'phone2' })
    expect(h.events).toEqual([{ kind: 'pairingCode' }, { kind: 'deviceDisconnected', deviceId: 'phone2' }])
  })

  it('knows a stored computer for what it is from the first message', () => {
    saveRemoteDevices(dir, [phone(), computer()])
    h.host.start()
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    h.fromBridge({ kind: 'deviceConnected', deviceId: 'phone1' })
    expect(h.events).toEqual([{ kind: 'deviceConnected', deviceId: 'phone1' }])
    expect([...h.port.attachedDeviceIds()].sort()).toEqual([COMPUTER_ID, 'phone1'].sort())
    expect(h.host.status().devices).toEqual([expect.objectContaining({ id: 'phone1', attached: true })])
  })

  it('keeps a revoked computer out even when its room reports closing afterwards', () => {
    // The bridge announces the shorter device list first and closes the room
    // after, so the last word about the computer arrives once it is gone.
    h.host.start()
    h.fromBridge({ kind: 'devicesChanged', devices: [computer()] })
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    h.fromBridge({ kind: 'devicesChanged', devices: [] })
    h.fromBridge({ kind: 'deviceDisconnected', deviceId: COMPUTER_ID })
    expect(h.events.map((e) => e.kind)).toEqual(['devicesChanged', 'devicesChanged'])
    expect(h.port.attachedDeviceIds().size).toBe(0)
  })

  it('keeps every link-only message out of the Remote renderer', () => {
    h.host.start()
    const pushed = h.statuses.length
    const linkOnly: BridgeToHost[] = [
      {
        kind: 'linkJoined',
        publicKey: COMPUTER.publicKey,
        hostPublicKey: PHONE.publicKey,
        hostName: 'studio',
        deviceId: COMPUTER_ID,
        sessionRoomId: '5e1f0c2d3b4a69788796a5b4c3d2e1f0',
        relayUrl: 'wss://relay.example/ws',
        phrase: 'a b c d e f g h',
      },
      { kind: 'joinFailed', message: 'The other computer stopped showing that code.' },
      { kind: 'linkCallResult', callId: 'c1', ok: true, data: { name: 'studio' } },
      { kind: 'linkCallResult', callId: 'c2', ok: false, message: 'offline' },
      { kind: 'peerRequest', callId: 'peer-1', from: { via: 'device', id: COMPUTER_ID }, request: { kind: 'peerHello' } },
      { kind: 'linkStateChanged', id: COMPUTER_ID, attached: true },
      { kind: 'linkBye', from: { via: 'link', id: COMPUTER_ID } },
    ]
    for (const m of linkOnly) h.fromBridge(m)
    expect(h.events).toEqual([])
    expect(h.statuses.length).toBe(pushed)
    expect(h.heard).toEqual(linkOnly)
  })

  it('still tells the phone UI about phones while Linked machines is on', () => {
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    h.fromBridge({ kind: 'paired', device: phone() })
    h.fromBridge({ kind: 'verificationPhrase', deviceId: 'phone1', phrase: 'x y z' })
    expect(h.events).toEqual([
      { kind: 'paired', deviceId: 'phone1', label: 'Pixel 9 Pro' },
      { kind: 'verificationPhrase', deviceId: 'phone1', phrase: 'x y z' },
    ])
  })

  it('forwards a kind it has no rule for, as it always did', () => {
    h.host.start()
    h.fromBridge({ kind: 'attachedChanged', attachedDeviceIds: [] })
    expect(h.events).toEqual([{ kind: 'attachedChanged' }])
  })
})

describe('whose offer the bridge holds', () => {
  beforeEach(() => {
    saveRemoteSettings(dir, { enabled: true })
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
  })

  /** What `linkOfferLive()` said while each error was being delivered. */
  function ownersOfErrors(): boolean[] {
    const owners: boolean[] = []
    h.port.onMessage((m) => {
      if (m.kind === 'error') owners.push(h.port.linkOfferLive())
    })
    return owners
  }

  it('asks for a code for another computer, unnamed unless told', () => {
    h.host.beginLinkPairing()
    h.host.beginLinkPairing('build-box')
    expect(h.posted).toEqual([
      { kind: 'beginPairing', label: '', link: true },
      { kind: 'beginPairing', label: 'build-box', link: true },
    ])
    expect(h.port.linkOfferLive()).toBe(true)
  })

  it('never shows a code for another computer as a phone QR', () => {
    h.fromBridge(code({ link: true }))
    expect(h.host.status().pairing).toBeNull()
    expect(h.events).toEqual([])
    expect(h.heard.at(-1)).toMatchObject({ kind: 'pairingCode', linkCode: LINK_CODE })
    expect(h.port.linkOfferLive()).toBe(true)
  })

  it('drops a phone QR that a code for another computer replaced', () => {
    h.fromBridge(code())
    expect(h.host.status().pairing?.qrPayload).toBe('phone-qr')
    h.fromBridge(code({ link: true }))
    expect(h.host.status().pairing).toBeNull()
    // Pushed, so the phone dialog stops showing a QR that can no longer pair.
    expect(h.statuses.at(-1)!.pairing).toBeNull()
  })

  it('keeps errors about a code for another computer out of Remote, and says whose they are', () => {
    const owners = ownersOfErrors()
    h.fromBridge(code({ link: true, expiresAt: Date.now() + 60_000 }))
    const pushed = h.statuses.length
    h.fromBridge({ kind: 'error', message: 'That code is for linking another computer, not a phone.' })
    expect(h.events).toEqual([])
    // The status still goes: it is the whole picture, and it may have moved.
    expect(h.statuses.length).toBe(pushed + 1)
    expect(owners).toEqual([true])
  })

  it('keeps an error the bridge marks as Linked machines\' out of Remote, whatever the offer', () => {
    // A relay cut on a link room has nothing to do with any offer: with no
    // code for another computer out, the offer alone would have handed it to
    // the phone pane's error banner.
    const pushed = h.statuses.length
    h.fromBridge({ kind: 'error', message: 'relay closed a linked machine connection: frame-rate', scope: 'link' })
    expect(h.events).toEqual([])
    expect(h.statuses.length).toBe(pushed + 1)
    // Linked machines hears it, mark and all.
    expect(h.heard.at(-1)).toEqual({
      kind: 'error',
      message: 'relay closed a linked machine connection: frame-rate',
      scope: 'link',
    })
    // An unmarked error is still the phone pane's, and the mark never reaches it.
    h.fromBridge({ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' })
    expect(h.events).toEqual([{ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' }])
  })

  it('claims a refused request for its own, and only that one error', () => {
    // A refusal is the bridge's answer to the request -- there is no code -- so
    // only the request can say whose it is. Listeners hear it while the request
    // still stands; after that, it is answered.
    const owners = ownersOfErrors()
    h.host.beginLinkPairing()
    h.fromBridge({ kind: 'error', message: 'This computer already has 16 linked machines.' })
    expect(h.port.linkOfferLive()).toBe(false)
    h.fromBridge({ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' })
    expect(owners).toEqual([true, false])
    expect(h.events).toEqual([{ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' }])
  })

  it('a refused request leaves the phone QR it did not replace for Remote to withdraw', () => {
    // Refused, the request changed nothing over there: the phone's offer is
    // still live, and closing the phone dialog must still kill it.
    h.fromBridge(code())
    h.host.beginLinkPairing()
    h.fromBridge({ kind: 'error', message: 'Linked machines needs an encrypted relay (wss://).' })
    h.host.cancelPairing()
    expect(h.posted.at(-1)).toEqual({ kind: 'cancelPairing' })
  })

  it('shows errors in Remote again once the link code has expired', () => {
    h.fromBridge(code({ link: true, expiresAt: Date.now() - 1 }))
    h.fromBridge({ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' })
    expect(h.events).toEqual([{ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' }])
  })

  it("leaves the supervisor's own error with Remote, as it always was", () => {
    // Raised after the child is gone: no offer survives that, of either kind.
    const owners = ownersOfErrors()
    h.fromBridge(code({ link: true }))
    h.trip()
    h.fromBridge({ kind: 'error', message: 'remote bridge crashed 4x in 60s — remote disabled' })
    expect(owners).toEqual([false])
    expect(h.events).toEqual([{ kind: 'error', message: 'remote bridge crashed 4x in 60s — remote disabled' }])
  })

  it('answers requests in the order they were made', () => {
    h.host.beginLinkPairing()
    h.host.beginPairing('iPhone 17')
    h.fromBridge(code({ link: true }))
    expect(h.port.linkOfferLive()).toBe(false)
    h.fromBridge(code())
    h.fromBridge({ kind: 'error', message: 'pairing failed: bad secret' })
    expect(h.events).toEqual([
      { kind: 'pairingCode' },
      { kind: 'error', message: 'pairing failed: bad secret' },
    ])
  })

  it('a request posted while the bridge is down claims nothing', () => {
    h.host.stop()
    h.host.beginLinkPairing()
    h.host.start()
    h.fromBridge({ kind: 'error', message: 'x' })
    expect(h.events).toEqual([{ kind: 'error', message: 'x' }])
  })

  it('a respawned child owes nothing the dead one was asked', () => {
    h.host.beginLinkPairing()
    h.respawn()
    h.host.beginPairing('iPhone 17')
    h.fromBridge({ kind: 'ready' })
    // The link request died with its child; the phone request went to this one.
    expect(h.port.linkOfferLive()).toBe(false)
    h.fromBridge({ kind: 'error', message: 'Phone pairing is off.' })
    expect(h.events.at(-1)).toEqual({ kind: 'error', message: 'Phone pairing is off.' })
  })

  it('a relaunch after the supervisor gave up starts the mirror over', () => {
    // The child that held the code -- and owed an answer -- is gone, and the
    // user switching Remote back on is a new bridge, not that one back.
    h.fromBridge(code({ link: true }))
    h.host.beginLinkPairing()
    h.trip()
    h.host.setEnabled(true)
    expect(h.running).toBe(true)
    expect(h.port.linkOfferLive()).toBe(false)
    h.fromBridge({ kind: 'error', message: 'x' })
    expect(h.events.at(-1)).toEqual({ kind: 'error', message: 'x' })
  })

  it('a respawned child holds no offer the dead one held', () => {
    h.fromBridge(code({ link: true }))
    h.respawn()
    expect(h.port.linkOfferLive()).toBe(false)
  })

  it('a request posted before the child exists is dropped with it', () => {
    // The supervisor drops a message sent with no child running, so the
    // request is never answered -- and must not wait to claim an error.
    const d = deferredHost({ runningAtStart: false })
    d.host.start()
    d.host.beginLinkPairing()
    expect(d.posted).toEqual([])
    d.spawn()
    d.fromBridge({ kind: 'ready' })
    d.fromBridge({ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' })
    expect(d.events.at(-1)).toEqual({ kind: 'error', message: 'relay closed the Pixel 9 Pro connection: frame-rate' })
  })

  it("a request posted before a slow spawn builds its init is still that child's", () => {
    // The first init after a launch keeps what was asked since: it went to the
    // very child that init is for. Only a RESPAWN starts the mirror over.
    const d = deferredHost({ runningAtStart: true })
    const owners: boolean[] = []
    d.host.linkedPort().onMessage((m) => {
      if (m.kind === 'error') owners.push(d.host.linkedPort().linkOfferLive())
    })
    const refusedOnce = (): void => {
      d.host.beginLinkPairing()
      d.spawn()
      d.fromBridge({ kind: 'ready' })
      d.fromBridge({ kind: 'error', message: 'Linked machines needs an encrypted relay (wss://).' })
    }
    // The first launch, and a relaunch: switching Remote off restarts the
    // bridge without phone rooms, and that launch's first spawn is no respawn.
    d.host.start()
    refusedOnce()
    d.host.setEnabled(false)
    refusedOnce()
    expect(owners).toEqual([true, true])
    expect(d.events.filter((e) => e.kind === 'error')).toEqual([])
  })

  it("a request made before a new child's ready is still that child's", () => {
    // Switching Linked machines on and asking for a code at once: the child
    // answers `ready` first and the request after, so `ready` must not drop it.
    h.setLinked({ enabled: false, links: [] })
    h.host.setEnabled(false)
    h.setLinked({ enabled: true, links: [] })
    h.host.refreshLinked()
    const owners = ownersOfErrors()
    h.host.beginLinkPairing()
    h.fromBridge({ kind: 'ready' })
    h.fromBridge({ kind: 'error', message: 'Linked machines needs an encrypted relay (wss://).' })
    expect(owners).toEqual([true])
  })

  it('a phone QR arriving means the code for another computer is gone', () => {
    h.fromBridge(code({ link: true }))
    h.fromBridge(code())
    expect(h.port.linkOfferLive()).toBe(false)
    expect(h.events).toEqual([{ kind: 'pairingCode' }])
  })

  it('pairing a computer spends the code', () => {
    h.fromBridge(code({ link: true }))
    h.fromBridge({ kind: 'paired', device: computer() })
    expect(h.port.linkOfferLive()).toBe(false)
  })

  it("Remote's cancel leaves a code for another computer alone", () => {
    // The phone dialog cancels whenever it closes. By then the bridge's one
    // offer may be a code the user is carrying to another machine.
    h.fromBridge(code({ link: true }))
    const pushed = h.statuses.length
    h.host.cancelPairing()
    expect(h.posted.filter((m) => m.kind === 'cancelPairing')).toEqual([])
    expect(h.port.linkOfferLive()).toBe(true)
    expect(h.statuses.length).toBe(pushed + 1)
  })

  it("Remote's cancel withdraws a phone QR as it always did", () => {
    h.fromBridge(code({ link: true, expiresAt: Date.now() - 1 }))
    h.host.cancelPairing()
    expect(h.posted).toEqual([{ kind: 'cancelPairing' }])
  })

  it('cancelLinkPairing withdraws a code for another computer and nothing else', () => {
    h.fromBridge(code({ link: true }))
    h.host.cancelLinkPairing()
    expect(h.posted).toEqual([{ kind: 'cancelPairing' }])
    expect(h.port.linkOfferLive()).toBe(false)

    // A phone QR on screen now: the linked cancel must not touch it.
    h.fromBridge(code())
    h.host.cancelLinkPairing()
    expect(h.posted).toEqual([{ kind: 'cancelPairing' }])
    expect(h.host.status().pairing?.qrPayload).toBe('phone-qr')
  })

  it('a code withdrawn before it arrived is gone when it does', () => {
    // The bridge reads in order: it makes the code, then cancels it. The code
    // still crosses -- and must not be taken for a live offer when it does.
    h.port.send({ kind: 'beginPairing', label: '', link: true })
    expect(h.port.linkOfferLive()).toBe(true)
    h.port.send({ kind: 'cancelPairing' })
    // Still owed an answer, and an error now would be that answer.
    expect(h.port.linkOfferLive()).toBe(true)
    h.fromBridge(code({ link: true }))
    expect(h.port.linkOfferLive()).toBe(false)
    expect(h.posted).toEqual([{ kind: 'beginPairing', label: '', link: true }, { kind: 'cancelPairing' }])
  })

  it('a listener that restarts the bridge and asks again keeps its new request', () => {
    // The refused request is spent after the listeners -- by identity, so a
    // listener that rebuilt the queue meanwhile does not lose what it added.
    h.port.onMessage((m) => {
      if (m.kind !== 'error') return
      h.setLinked({ enabled: true, links: [] })
      h.host.setEnabled(false)
      h.host.beginLinkPairing()
    })
    h.host.beginLinkPairing()
    h.fromBridge({ kind: 'error', message: 'This computer already has 16 linked machines.' })
    expect(h.started).toHaveLength(2)
    expect(h.port.linkOfferLive()).toBe(true)
  })

  it('a fresh bridge holds no offer', () => {
    h.host.beginLinkPairing()
    h.setLinked({ enabled: false, links: [] })
    h.host.refreshLinked()
    expect(h.port.linkOfferLive()).toBe(false)
  })

  it('a stopped bridge holds no offer', () => {
    h.host.beginLinkPairing()
    h.host.stop()
    expect(h.port.linkOfferLive()).toBe(false)
  })
})

describe('the port', () => {
  it('runs a listener after the host has applied the message', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.host.start()
    const seen: Array<{ peers: string[]; attached: string[] }> = []
    h.port.onMessage(() =>
      seen.push({ peers: h.port.desktopPeers().map((d) => d.id), attached: [...h.port.attachedDeviceIds()] }),
    )
    h.fromBridge({ kind: 'devicesChanged', devices: [phone(), computer()] })
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    expect(seen).toEqual([
      { peers: [COMPUTER_ID], attached: [] },
      { peers: [COMPUTER_ID], attached: [COMPUTER_ID] },
    ])
  })

  it('stops delivering once unsubscribed', () => {
    h.host.start()
    const got: string[] = []
    const off = h.port.onMessage((m) => got.push(m.kind))
    h.fromBridge({ kind: 'ready' })
    off()
    h.fromBridge({ kind: 'ready' })
    expect(got).toEqual(['ready'])
  })

  it('a listener that throws neither deafens the others nor stops the host', () => {
    saveRemoteSettings(dir, { enabled: true })
    h.host.start()
    h.port.onMessage(() => {
      throw new Error('listener bug')
    })
    const after: string[] = []
    h.port.onMessage((m) => after.push(m.kind))
    expect(() => h.fromBridge({ kind: 'deviceConnected', deviceId: 'phone1' })).not.toThrow()
    expect(after).toEqual(['deviceConnected'])
    expect(h.events).toEqual([{ kind: 'deviceConnected', deviceId: 'phone1' }])
  })

  it('posts to the bridge, and goes nowhere while it is down', () => {
    h.host.start()
    h.port.send({ kind: 'setLinks', links: [] })
    expect(h.posted).toEqual([])
    h.setLinked({ enabled: true, links: [] })
    h.host.refreshLinked()
    h.port.send({ kind: 'renameDevice', deviceId: COMPUTER_ID, label: 'ci' })
    expect(h.posted).toEqual([{ kind: 'renameDevice', deviceId: COMPUTER_ID, label: 'ci' }])
  })

  it('reports nothing attached while the bridge is down', () => {
    // A crashed child never says goodbye, so its last words cannot be trusted.
    h.setLinked({ enabled: true, links: [] })
    saveRemoteDevices(dir, [computer()])
    h.host.start()
    h.fromBridge({ kind: 'deviceConnected', deviceId: COMPUTER_ID })
    expect([...h.port.attachedDeviceIds()]).toEqual([COMPUTER_ID])
    h.trip()
    expect(h.port.attachedDeviceIds().size).toBe(0)
    expect(h.port.running()).toBe(false)
  })

  it('derives the safety words of a hosted computer', () => {
    saveRemoteDevices(dir, [computer()])
    h.host.start()
    expect(h.port.verificationPhraseFor(COMPUTER_ID)).toBe(
      deriveVerificationPhrase(getOrCreateRemoteIdentity(dir).publicKey, COMPUTER.publicKey),
    )
    expect(h.port.verificationPhraseFor('nobody')).toBeNull()
  })

  it('hands out copies of the computers, not the host record', () => {
    saveRemoteDevices(dir, [computer()])
    h.setLinked({ enabled: true, links: [] })
    h.host.start()
    const [peer] = h.port.desktopPeers()
    peer.label = 'renamed by a caller'
    peer.capabilities.writeToTerminal = true
    expect(h.port.desktopPeers()).toEqual([computer()])
    const ids = h.port.attachedDeviceIds() as Set<string>
    ids.add('forged')
    expect(h.port.attachedDeviceIds().has('forged')).toBe(false)
  })

  it('reports the relay this machine uses', () => {
    saveRemoteSettings(dir, { enabled: false, relayUrl: 'wss://relay.example/ws' })
    h.host.start()
    expect(h.port.relayUrl()).toBe('wss://relay.example/ws')
  })

  it('is the same port every time it is asked for', () => {
    expect(h.host.linkedPort()).toBe(h.port)
  })
})
