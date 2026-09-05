import { describe, it, expect, vi, afterEach } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { createHash } from 'crypto'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
import {
  generateIdentity,
  deriveVerificationPhrase,
  fromHex,
  toHex,
  PHRASE_WORDS,
} from '../../src/main/remoteBridge/sealedChannel'
import { deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import { sealPairingHello, openPairingAck } from '../../src/main/remoteBridge/pairing'
import {
  DEVICE_EXPIRY_SWEEP_MS,
  DEVICE_IDLE_EXPIRY_MS,
  NO_CAPABILITIES,
  SEEN_ANNOUNCE_INTERVAL_MS,
  type BridgeToHost,
  type PairedDevice,
  type RemoteRequest,
} from '../../src/main/remoteBridge/protocol'
import type {
  PairingRelayDeps,
  RelayClientDeps,
  RelayState,
  SessionRelayDeps,
} from '../../src/main/remoteBridge/relayClient'
import { MAX_PAYLOAD_BYTES, type OutputPayload } from '../../src/main/remoteBridge/outputChunker'

// A real curve point: the core mints a Handshake against every paired device's
// key the moment it opens that device's room, so a placeholder string no longer
// survives init.
const PEER = generateIdentity()

/** The identity `init` hands the core in every test here. Named rather than
 *  inlined because the session room is a DH over it: a device fixture whose room
 *  was derived from some other secret would be a room the core never dials. */
const DESKTOP_SECRET = 'a'.repeat(64)

/** One identity per device id, so two paired devices are two real phones.
 *
 *  Devices sharing a public key would derive the SAME session room, and the
 *  second desktop socket into it takes a 409 off the first. `d1` is `PEER`
 *  because the pairing tests below scan with that key. */
const PEERS: Record<string, ReturnType<typeof generateIdentity>> = { d1: PEER }

/** Frozen per run so a device record stays comparable across assertions. */
const SEEN_NOW = Date.now()

function device(id = 'd1'): PairedDevice {
  const keys = PEERS[id] ?? (PEERS[id] = generateIdentity())
  return {
    id,
    label: 'phone',
    publicKey: keys.publicKey,
    sessionRoomId: deriveSessionRoomId(DESKTOP_SECRET, keys.publicKey),
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: 0,
    // Seen just now, not at the epoch. The bridge expires pairings that have
    // gone quiet for `DEVICE_IDLE_EXPIRY_MS`, and it sweeps at startup -- a
    // fixture dated 1970 is a device the bridge is right to forget on sight.
    lastSeenAt: SEEN_NOW,
  }
}

/** A relay room that records instead of dialling. Every test goes through this:
 *  a core that opened real sockets would leave reconnect timers running in the
 *  suite and, worse, would make these tests depend on a network. */
function stubRoom(deps: RelayClientDeps) {
  const room = {
    deps,
    started: false,
    stopped: false,
    state: 'offline' as RelayState,
    sent: [] as OutputPayload[],
    frames: [] as Uint8Array[],
    /** How many raw frames had been written when this room was stopped. */
    stoppedAtFrame: -1,
    start() {
      room.started = true
    },
    send(payload: unknown) {
      room.sent.push(payload as OutputPayload)
    },
    sendFrame(frame: Uint8Array) {
      room.frames.push(frame)
    },
    stop() {
      room.stopped = true
      room.stoppedAtFrame = room.frames.length
    },
  }
  return room
}

function core(devices: PairedDevice[] = []) {
  const sent: BridgeToHost[] = []
  const rooms: ReturnType<typeof stubRoom>[] = []
  const callTool = vi.fn().mockResolvedValue({ terminals: [] })
  const c = createBridgeCore({
    send: (m) => sent.push(m),
    mcp: { callTool },
    relayUrl: 'wss://relay.test',
    openRelay: (d) => {
      const room = stubRoom(d)
      rooms.push(room)
      return room
    },
  })
  c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: DESKTOP_SECRET, devices })
  return { c, sent, callTool, rooms }
}

/** Attach a room the way the relay client would, so the core's own
 *  state-change handling runs rather than being bypassed.
 *
 *  `attached` and not `online`: `online` means only that this desktop got a seat
 *  in the relay room. There is no session in that state, so nothing can be sealed
 *  and nothing can be sent. */
function attach(room: ReturnType<typeof stubRoom>): void {
  room.state = 'attached'
  room.deps.onStateChange('attached')
}

describe('bridge core', () => {
  it('announces ready on init', () => {
    expect(core().sent.some((m) => m.kind === 'ready')).toBe(true)
  })

  it('emits a QR payload on beginPairing', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    expect(code).toBeDefined()
    const payload = JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload)
    expect(payload.desktopPublicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.oneTimeSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does NOT emit a verification phrase before a device has answered', () => {
    // The safety number is a function of both public keys. Before the device
    // replies there is no second key, so any phrase shown here would encode
    // nothing about who the user is actually talking to -- while looking exactly
    // like one that did. Comparing it against the phone would be a ritual, not a
    // check, so there must be nothing to compare yet.
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    expect(sent.some((m) => m.kind === 'verificationPhrase')).toBe(false)
    expect(sent.find((m) => m.kind === 'pairingCode')).not.toHaveProperty('verificationPhrase')
  })

  it('emits the real 8-word phrase once a device completes pairing', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    const payload = JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload)
    const phone = generateIdentity()

    const { device, verificationPhrase } = c.acceptPairing({
      oneTimeSecret: payload.oneTimeSecret,
      devicePublicKey: phone.publicKey,
      label: 'Pixel',
    })

    expect(verificationPhrase.split(' ')).toHaveLength(PHRASE_WORDS)
    // Derived from both keys, so the phone computes the identical words and a
    // relay that swapped in its own key makes the two screens disagree.
    expect(verificationPhrase).toBe(
      deriveVerificationPhrase(payload.desktopPublicKey, phone.publicKey),
    )
    expect(sent.some((m) => m.kind === 'paired')).toBe(true)
    expect(sent.some((m) => m.kind === 'verificationPhrase')).toBe(true)
    expect(device.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('refuses a second pairing against a spent offer', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    const payload = JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload)
    c.acceptPairing({
      oneTimeSecret: payload.oneTimeSecret,
      devicePublicKey: generateIdentity().publicKey,
      label: 'First',
    })
    expect(() =>
      c.acceptPairing({
        oneTimeSecret: payload.oneTimeSecret,
        devicePublicKey: generateIdentity().publicKey,
        label: 'Second',
      }),
    ).toThrow(/no pairing offer is open/)
  })

  it('refuses a device that did not see the QR', () => {
    const { c } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    expect(() =>
      c.acceptPairing({
        oneTimeSecret: 'f'.repeat(64),
        devicePublicKey: generateIdentity().publicKey,
        label: 'Attacker',
      }),
    ).toThrow(/secret/i)
  })

  it('serves an allowed request', async () => {
    const { c, callTool } = core([device()])
    const res = await c.handleRemoteRequest('d1', { id: 7, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('ok')
    // With the device id, not without it: `mcp-audit.log` is the only record of
    // which paired phone caused a tool call, and it can only carry what is passed
    // here. Spec section 4.4.
    expect(callTool).toHaveBeenCalledWith('list_terminals', {}, 'd1')
  })

  it('refuses a request from an unknown device', async () => {
    const { c, callTool } = core([])
    const res = await c.handleRemoteRequest('ghost', { id: 1, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('refuses a request the device lacks capability for', async () => {
    const { c, callTool } = core([device()])
    const res = await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'writeToTerminal', terminalId: 't', text: 'x' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('stops serving a revoked device immediately', async () => {
    const { c } = core([device()])
    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    const res = await c.handleRemoteRequest('d1', { id: 3, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
  })

  it('applies a capability change without a restart', async () => {
    const { c, callTool } = core([device()])
    c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: { ...NO_CAPABILITIES, read: true, writeToTerminal: true } })
    const res = await c.handleRemoteRequest('d1', { id: 4, request: { kind: 'writeToTerminal', terminalId: 't', text: 'hi' } })
    expect(res.kind).toBe('ok')
    expect(callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't', text: 'hi' }, 'd1')
  })

  it('reports device changes to the host after a revoke', () => {
    const { c, sent } = core([device()])
    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    const changed = sent.filter((m) => m.kind === 'devicesChanged')
    expect(changed.length).toBeGreaterThan(0)
  })

  it('returns an error response rather than throwing when MCP fails', async () => {
    const sent: BridgeToHost[] = []
    const c = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool: vi.fn().mockRejectedValue(new Error('mcp down')) },
      relayUrl: 'wss://relay.test',
    })
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: DESKTOP_SECRET, devices: [device()] })
    const res = await c.handleRemoteRequest('d1', { id: 5, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect((res as Extract<typeof res, { kind: 'error' }>).message).toMatch(/mcp down/)
  })

  it('cancelPairing closes the window — a QR photographed off a screen is dead', () => {
    const { c, sent } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    if (code?.kind !== 'pairingCode') throw new Error('no pairing code')
    const { oneTimeSecret } = JSON.parse(code.qrPayload) as { oneTimeSecret: string }

    c.handleHostMessage({ kind: 'cancelPairing' })

    expect(() =>
      c.acceptPairing({ oneTimeSecret, devicePublicKey: generateIdentity().publicKey, label: 'late' }),
    ).toThrow(/no pairing offer/)
  })

  it('shutdown stops serving requests', async () => {
    const { c, callTool } = core([device()])
    c.handleHostMessage({ kind: 'shutdown' })
    const res = await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })

  it('builds a real MCP client when the host did not inject one', () => {
    const sent: BridgeToHost[] = []
    const c = createBridgeCore({ send: (m) => sent.push(m), relayUrl: 'wss://relay.test' })
    // No `mcp` dep: init must construct LocalMcpClient against the loopback port
    // rather than crash. Nothing is dialled until a request arrives.
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: DESKTOP_SECRET, devices: [] })
    expect(sent.some((m) => m.kind === 'ready')).toBe(true)
  })

  it('wires subscribe and unsubscribe into the output fan-out', async () => {
    const { c } = core([device()])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    c.handleHostMessage({ kind: 'terminalOutput', terminalId: 't1', slice: { output: 'hello', nextOffset: 5, missed: 0 } })
    expect(c.drainOutput('d1').map((x) => x.chunk)).toEqual(['hello'])

    await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'unsubscribe', terminalId: 't1' } })
    c.handleHostMessage({ kind: 'terminalOutput', terminalId: 't1', slice: { output: 'more', nextOffset: 9, missed: 0 } })
    expect(c.drainOutput('d1')).toEqual([])
  })

  it('stops the live output stream when read is withdrawn, not just future requests', async () => {
    const { c } = core([device()])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })

    c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: { ...NO_CAPABILITIES } })

    c.handleHostMessage({ kind: 'terminalOutput', terminalId: 't1', slice: { output: 'secret', nextOffset: 6, missed: 0 } })
    expect(c.drainOutput('d1')).toEqual([])
  })

  it('keeps the stream alive when a capability change still grants read', async () => {
    const { c } = core([device()])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })

    c.handleHostMessage({
      kind: 'setCapabilities', deviceId: 'd1',
      capabilities: { ...NO_CAPABILITIES, read: true, writeToTerminal: true },
    })

    c.handleHostMessage({ kind: 'terminalOutput', terminalId: 't1', slice: { output: 'still here', nextOffset: 10, missed: 0 } })
    expect(c.drainOutput('d1').map((x) => x.chunk)).toEqual(['still here'])
  })
})

describe('capability enforcement precedes side effects', () => {
  it('does not enrol an ungranted device in the fan-out when subscribe is refused', async () => {
    const ungranted = { ...device(), capabilities: { ...NO_CAPABILITIES } }
    const { c } = core([ungranted])

    const res = await c.handleRemoteRequest(ungranted.id, {
      id: 1,
      request: { kind: 'subscribe', terminalId: 't1' },
    })
    expect(res.kind).toBe('error')

    // The refusal must unwind the subscription too. Registering fan-out state
    // before the capability check let a device that was refused `read` keep
    // receiving every subsequent chunk -- the error told it "no" while the
    // output stream said "yes".
    c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'SECRET=hunter2\r\n', nextOffset: 16, missed: 0 },
    })
    expect(c.drainOutput(ungranted.id)).toEqual([])
  })

  it('does not unsubscribe an ungranted device that never should have been subscribed', async () => {
    const granted = device()
    const { c } = core([granted])
    await c.handleRemoteRequest(granted.id, {
      id: 1,
      request: { kind: 'subscribe', terminalId: 't1' },
    })

    const ungranted = { ...device(), id: 'other', capabilities: { ...NO_CAPABILITIES } }
    c.handleHostMessage({
      kind: 'init',
      mcpPort: 1,
      mcpToken: 't',
      identitySecretKey: DESKTOP_SECRET,
      devices: [granted, ungranted],
    })
    // An ungranted device must not be able to reach the fan-out at all -- neither
    // to join it nor to mutate it. `unsubscribe` is a write too.
    await c.handleRemoteRequest(ungranted.id, {
      id: 2,
      request: { kind: 'unsubscribe', terminalId: 't1' },
    })

    c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'still here\r\n', nextOffset: 12, missed: 0 },
    })
    expect(c.drainOutput(granted.id)).toHaveLength(1)
  })

  it('still subscribes a device that holds read', async () => {
    const granted = device()
    const { c } = core([granted])
    const res = await c.handleRemoteRequest(granted.id, {
      id: 1,
      request: { kind: 'subscribe', terminalId: 't1' },
    })
    expect(res.kind).toBe('ok')
    c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'hello\r\n', nextOffset: 7, missed: 0 },
    })
    expect(c.drainOutput(granted.id)).toHaveLength(1)
  })
})

/** Only the per-device SESSION rooms. `beginPairing` opens a room too -- named in
 *  the clear by the QR, holding no session -- and it is not one of these. */
function sessionRooms(rooms: ReturnType<typeof stubRoom>[]) {
  return rooms.filter((r) => r.deps.mode !== 'pairing')
}

describe('relay rooms', () => {
  it('dials one room per paired device on init', () => {
    const { rooms } = core([device('d1'), device('d2')])
    expect(rooms).toHaveLength(2)
    expect(rooms.every((r) => r.started)).toBe(true)
    // Per device, so revoking one cannot disturb another's connection -- and two
    // real phones are two rooms, because the room is a DH over the pair of
    // identities and the phones' halves differ.
    expect(new Set(rooms.map((r) => r.deps.roomId)).size).toBe(2)
    expect(rooms[0].deps.url).toBe('wss://relay.test')
  })

  it('closes the room when the device is revoked', () => {
    const { c, rooms } = core([device()])
    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })

    // Dropping the registry record alone would leave a socket the phone is still
    // holding open. Removing a device has to reach the wire.
    expect(rooms[0].stopped).toBe(true)
  })

  it('opens a room for a device as soon as it pairs', () => {
    const { c, sent, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.find((m) => m.kind === 'pairingCode') as Extract<
      BridgeToHost,
      { kind: 'pairingCode' }
    >
    const offer = JSON.parse(code.qrPayload)
    c.acceptPairing({
      oneTimeSecret: offer.oneTimeSecret,
      devicePublicKey: PEER.publicKey,
      label: 'Pixel',
    })

    // NOT the id it scanned. That one is on screen for anyone with a camera, and
    // a room name is enough to take a seat: a stranger holding the `device` slot
    // leaves the real phone looping on a 409 it cannot explain. The room the two
    // actually meet in is a DH over their identity keys, so it never appears in
    // the QR and never crosses the wire -- and the phone computes the same value
    // from what it already holds, which is what makes them meet at all.
    const [session] = sessionRooms(rooms)
    expect(sessionRooms(rooms)).toHaveLength(1)
    expect(session.deps.roomId).not.toBe(offer.pairingId)
    expect(session.deps.roomId).toBe(deriveSessionRoomId(PEER.secretKey, offer.desktopPublicKey))
    expect(session.started).toBe(true)
  })

  it('keeps the live room when the same phone re-pairs', () => {
    const { c, sent, rooms } = core()
    const pairOnce = () => {
      c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
      const code = sent.filter((m) => m.kind === 'pairingCode').at(-1) as Extract<
        BridgeToHost,
        { kind: 'pairingCode' }
      >
      const offer = JSON.parse(code.qrPayload)
      c.acceptPairing({
        oneTimeSecret: offer.oneTimeSecret,
        devicePublicKey: PEER.publicKey,
        label: 'Pixel',
      })
      return offer.pairingId as string
    }
    const first = pairOnce()
    const second = pairOnce()

    // Two offers, two pairing ids -- and one room, because the room is a function
    // of two identity keys and neither changed. Back when the room WAS the
    // pairing id, a re-pair moved the phone somewhere the desktop was not, so
    // the desktop had to redial to follow it. Now there is nowhere to follow to,
    // and redialling would drop a live socket to arrive back where it started.
    expect(second).not.toBe(first)
    expect(sessionRooms(rooms)).toHaveLength(1)
    expect(sessionRooms(rooms)[0].stopped).toBe(false)
  })

  it('abandons a stale room when the desktop identity behind it has changed', () => {
    // Persisted device records outlive the identity they were derived from: lose
    // the stored desktop key and the next boot mints a new one, at which point
    // every `sessionRoomId` on disk names a room nobody will ever be in. The
    // re-pair that follows recomputes the room -- and the socket already dialled
    // to the stale one has to be dropped, or the desktop sits in an empty room
    // while the phone waits in the real one.
    // The id a re-pair of this phone will produce -- a hash of its public key, so
    // the persisted record and the fresh one are the same DEVICE and the guard
    // in openRoom is what decides whether the old socket lives.
    const id = createHash('sha256').update(PEER.publicKey).digest('hex').slice(0, 16)
    const stale = { ...device(), id, sessionRoomId: 'f'.repeat(32) }
    const { c, sent, rooms } = core([stale])
    expect(rooms[0].deps.roomId).toBe('f'.repeat(32))

    c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    const code = sent.filter((m) => m.kind === 'pairingCode').at(-1) as Extract<
      BridgeToHost,
      { kind: 'pairingCode' }
    >
    const offer = JSON.parse(code.qrPayload)
    c.acceptPairing({
      oneTimeSecret: offer.oneTimeSecret,
      devicePublicKey: PEER.publicKey,
      label: 'Pixel',
    })

    const [before, after] = sessionRooms(rooms)
    expect(sessionRooms(rooms)).toHaveLength(2)
    expect(before.stopped).toBe(true)
    expect(after.deps.roomId).toBe(deriveSessionRoomId(DESKTOP_SECRET, PEER.publicKey))
    expect(after.started).toBe(true)
  })

  it('leaves a room alone when the same device is opened twice', () => {
    const dev = device()
    const { c, rooms } = core([dev])
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: DESKTOP_SECRET, devices: [dev] })

    // Same device, same room: the socket already dialled is the right one.
    // Redialling would drop a live connection and lose whatever it was carrying.
    expect(rooms).toHaveLength(1)
    expect(rooms[0].stopped).toBe(false)
  })

  it('binds each room to its own device', async () => {
    const { c, rooms } = core([device('d1'), device('d2')])
    for (const r of rooms) attach(r)
    for (const r of rooms) r.sent.length = 0

    // Requests arrive on the ROOM, not through a shared entry point, so the
    // device id comes from the closure rather than the message. A room wired to
    // the wrong id would serve one phone's subscription to another -- the exact
    // shape of cross-device leak this per-device model exists to prevent.
    await (rooms[1].deps as SessionRelayDeps).onRequest({
      id: 1,
      request: { kind: 'subscribe', terminalId: 't1' },
    })
    c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'only for d2', nextOffset: 11, missed: 0 },
    })

    expect(rooms[0].sent).toHaveLength(0)
    expect(rooms[1].sent[0].chunks[0].chunk).toBe('only for d2')
  })

  it('closes every room on shutdown', () => {
    const { c, rooms } = core([device('d1'), device('d2')])
    c.handleHostMessage({ kind: 'shutdown' })
    expect(rooms.map((r) => r.stopped)).toEqual([true, true])
  })

  it('reports reachability to the host, separately from being paired', () => {
    const { sent, rooms } = core([device()])
    attach(rooms[0])
    expect(sent).toContainEqual({ kind: 'deviceConnected', deviceId: 'd1' })

    rooms[0].state = 'offline'
    rooms[0].deps.onStateChange('offline')
    expect(sent).toContainEqual({ kind: 'deviceDisconnected', deviceId: 'd1' })
  })

  it.each(['connecting', 'online'] as const)('treats %s as not yet reachable', (state) => {
    const { sent, rooms } = core([device()])
    rooms[0].deps.onStateChange(state)

    // Neither is connected. `connecting` is a dial in progress; `online` is a seat
    // in a relay room with nobody else in it -- reachable by the relay, with no
    // phone on the other end and no session to seal into. Reporting either as
    // connected lights up Settings for a device that cannot receive anything.
    expect(sent).toContainEqual({ kind: 'deviceDisconnected', deviceId: 'd1' })
    expect(sent.some((m) => m.kind === 'deviceConnected')).toBe(false)
  })

  it('reports a quota cut to the host, naming the limit', () => {
    // For `frame-size` and `frame-rate` the client also stops redialing, so the
    // room stays dark until the app restarts. Silence would leave the user with a
    // phone that simply stopped working and nothing to act on.
    const { sent, rooms } = core([device()])
    rooms[0].deps.onQuota?.('frame-rate')
    expect(sent).toContainEqual({
      kind: 'error',
      message: 'relay closed the phone connection: frame-rate',
    })
  })
})

describe('output pump', () => {
  function subscribed(deviceId = 'd1') {
    const h = core([device(deviceId)])
    attach(h.rooms[0])
    h.rooms[0].sent.length = 0
    return h
  }

  it('pushes terminal output to an attached device', async () => {
    const h = subscribed()
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'compiling...', nextOffset: 12, missed: 0 },
    })

    expect(h.rooms[0].sent).toHaveLength(1)
    expect(h.rooms[0].sent[0].chunks[0].chunk).toBe('compiling...')
  })

  it.each(['offline', 'connecting', 'online'] as const)(
    'holds output while a device is %s and delivers it on reconnect',
    async (state) => {
      const h = core([device()])
      attach(h.rooms[0])
      await h.c.handleRemoteRequest('d1', {
        id: 1,
        request: { kind: 'subscribe', terminalId: 't1' },
      })
      h.rooms[0].state = state
      h.rooms[0].sent.length = 0

      h.c.handleHostMessage({
        kind: 'terminalOutput',
        terminalId: 't1',
        slice: { output: 'built in 4s', nextOffset: 11, missed: 0 },
      })
      // Draining is DESTRUCTIVE, so anything short of attached must hold. `online`
      // is the subtle one: the socket is alive and `send` will not throw, but there
      // is no session behind it, so every frame handed over would be dropped
      // unsealed -- and the drain that produced them has already emptied the queue.
      // The fan-out is the buffer for exactly this: a phone in a tunnel mid-build,
      // or one that has not walked into the room yet.
      expect(h.rooms[0].sent).toHaveLength(0)

      attach(h.rooms[0])
      expect(h.rooms[0].sent.flatMap((p) => p.chunks).map((c) => c.chunk)).toContain('built in 4s')
    },
  )

  it('sends nothing for a device that never subscribed', () => {
    const h = subscribed()
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'SECRET=hunter2', nextOffset: 14, missed: 0 },
    })
    expect(h.rooms[0].sent).toHaveLength(0)
  })

  it('splits a burst too large for one relay frame', async () => {
    const h = subscribed()
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    // Bare ESC, not a full colour sequence: ESC costs six wire bytes and the
    // bracket-and-digits cost one each, so '\u001b[31m' averages two bytes per
    // character and never reaches the cap within the fan-out's 262144-character
    // queue. The density that overflows is escapes with little text between
    // them, which is what a progress bar or a spinner actually emits.
    const burst = '\u001b'.repeat(200_000)
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: burst, nextOffset: burst.length, missed: 0 },
    })

    // An oversized frame is not truncated by the relay -- the connection is cut.
    // Escape-dense output is exactly what a build produces, so this is the
    // ordinary case rather than an adversarial one.
    expect(h.rooms[0].sent.length).toBeGreaterThan(1)
    for (const payload of h.rooms[0].sent) {
      expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(
        MAX_PAYLOAD_BYTES,
      )
    }
    expect(h.rooms[0].sent.flatMap((p) => p.chunks).map((c) => c.chunk).join('')).toBe(burst)
  })
})

describe('last seen, and forgetting a phone that never comes back', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('tells main when a device is heard from', async () => {
    // `registry.touch` only ever moved a number inside this process. Main owns
    // both the settings file and the "last seen" column, so without an
    // announcement a phone in daily use showed the moment it was paired.
    const { c, sent } = core([device()])
    const before = sent.filter((m) => m.kind === 'devicesChanged').length

    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'listTerminals' } })

    const announced = sent.filter((m) => m.kind === 'devicesChanged')
    expect(announced.length).toBe(before + 1)
    expect(announced.at(-1)!.devices[0].lastSeenAt).toBeGreaterThanOrEqual(SEEN_NOW)
  })

  it('does not rewrite the settings file once per request', async () => {
    // Every request advances the timestamp. Announcing each one would put a disk
    // write behind every keystroke a phone sends, for a column rounded to the
    // minute and redrawn on a one-minute tick.
    const { c, sent } = core([device()])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'listTerminals' } })
    const after = sent.filter((m) => m.kind === 'devicesChanged').length

    for (let i = 2; i < 40; i++) {
      await c.handleRemoteRequest('d1', { id: i, request: { kind: 'listTerminals' } })
    }

    expect(sent.filter((m) => m.kind === 'devicesChanged').length).toBe(after)
  })

  it('announces again once the record has drifted past the interval', async () => {
    const { c, sent } = core([device()])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'listTerminals' } })
    const announced = sent.filter((m) => m.kind === 'devicesChanged')
    const after = announced.length
    // Measured from what was actually announced, not from a constant: the first
    // request lands a millisecond or two after the fixture was built, and a
    // threshold test that ignores that drift is a threshold test that flakes.
    const seenAt = announced.at(-1)!.devices[0].lastSeenAt

    vi.spyOn(Date, 'now').mockReturnValue(seenAt + SEEN_ANNOUNCE_INTERVAL_MS)
    await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'listTerminals' } })

    expect(sent.filter((m) => m.kind === 'devicesChanged').length).toBe(after + 1)
  })

  it('says nothing about a device that was revoked mid-request', async () => {
    // `getCapabilities` is answered above the dispatcher and touches the device
    // on the way through. A revoke that lands first leaves nothing to touch.
    const { c, sent } = core([device()])
    c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    const after = sent.filter((m) => m.kind === 'devicesChanged').length

    const res = await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'getCapabilities' } })

    expect(res.kind).toBe('error')
    expect(sent.filter((m) => m.kind === 'devicesChanged').length).toBe(after)
  })

  it('forgets a pairing that went quiet for longer than the idle window', () => {
    // The design promises idle pairings auto-expire. Nothing called `expireIdle`,
    // so a phone lost two years ago stayed authorised until somebody happened to
    // open Settings and revoke it by hand.
    const stale = { ...device('d1'), lastSeenAt: Date.now() - DEVICE_IDLE_EXPIRY_MS - 1 }
    const { sent, rooms } = core([stale])

    const changed = sent.filter((m) => m.kind === 'devicesChanged').at(-1)
    expect(changed?.devices).toEqual([])
    // And no room opened for it: expiry runs before the reconnect loop, or an
    // expired device is live again for the length of every startup.
    expect(rooms).toHaveLength(0)
    expect(sent.some((m) => m.kind === 'error' && m.message.includes('forgotten'))).toBe(true)
  })

  it('keeps a pairing that is merely old', () => {
    const recent = { ...device('d1'), lastSeenAt: Date.now() - DEVICE_IDLE_EXPIRY_MS + 60_000 }
    const { sent, rooms } = core([recent])

    expect(sent.some((m) => m.kind === 'error')).toBe(false)
    expect(rooms).toHaveLength(1)
  })

  it('keeps sweeping while the bridge runs, and stops when it does not', () => {
    vi.useFakeTimers()
    const { c, sent, rooms } = core([device('d1')])
    expect(rooms).toHaveLength(1)

    // Past the window without the phone ever coming back.
    vi.setSystemTime(Date.now() + DEVICE_IDLE_EXPIRY_MS + 1)
    vi.advanceTimersByTime(DEVICE_EXPIRY_SWEEP_MS)
    expect(sent.filter((m) => m.kind === 'devicesChanged').at(-1)?.devices).toEqual([])
    expect(rooms[0].stopped).toBe(true)

    // A timer left running in a process that is going away is exactly what the
    // shutdown path exists to prevent.
    c.handleHostMessage({ kind: 'shutdown' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('pairing over the relay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const DESKTOP_PUBLIC = toHex(x25519.getPublicKey(fromHex(DESKTOP_SECRET)))

  /** What the phone reads off the QR, parsed rather than reached for internally:
   *  the QR is the entire input a phone gets. */
  function scan(sent: BridgeToHost[]) {
    const code = sent.find((m) => m.kind === 'pairingCode')
    return JSON.parse((code as Extract<BridgeToHost, { kind: 'pairingCode' }>).qrPayload) as {
      relayUrl: string
      pairingId: string
      desktopPublicKey: string
      oneTimeSecret: string
    }
  }

  /** Push a frame into the pairing room the way the relay does. */
  function feed(room: ReturnType<typeof stubRoom>, frame: Uint8Array): void {
    ;(room.deps as PairingRelayDeps).onFrame(frame)
  }

  function message<K extends BridgeToHost['kind']>(
    sent: BridgeToHost[],
    kind: K,
  ): Extract<BridgeToHost, { kind: K }> | undefined {
    return sent.find((m) => m.kind === kind) as Extract<BridgeToHost, { kind: K }> | undefined
  }

  /** Paint a QR, then hand back everything a phone would hold after scanning it. */
  function begin() {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    const qr = scan(ctx.sent)
    const phone = generateIdentity()
    const hello = (oneTimeSecret = qr.oneTimeSecret, label = 'Pixel') =>
      sealPairingHello({
        deviceSecretKey: phone.secretKey,
        devicePublicKey: phone.publicKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        label,
        oneTimeSecret,
      })
    return { ...ctx, qr, phone, hello, room: ctx.rooms[0] }
  }

  it('names the device what the desktop user typed, not what the phone claims', () => {
    // The label field in Settings used to be decoration: `beginPairing` carried
    // it to the bridge and the bridge dropped it on the floor, so every device
    // row was named by the phone regardless of what the user asked for.
    const { sent, room, hello } = begin()
    feed(room, hello(undefined, 'Definitely Your Laptop'))
    expect(message(sent, 'paired')?.device.label).toBe('desk')
  })

  it('falls back to the phone name when the user typed nothing', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '   ' })
    const qr = scan(ctx.sent)
    const phone = generateIdentity()
    feed(
      ctx.rooms[0],
      sealPairingHello({
        deviceSecretKey: phone.secretKey,
        devicePublicKey: phone.publicKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        label: 'Pixel 9',
        oneTimeSecret: qr.oneTimeSecret,
      }),
    )
    expect(message(ctx.sent, 'paired')?.device.label).toBe('Pixel 9')
  })

  it('will not persist an escape sequence or a novel as a device name', () => {
    // This label crosses the relay, so its bytes and its length are the sender's
    // choice. It is then written to `remote-devices.json` and drawn beside a live
    // terminal -- unbounded and unfiltered, a paired phone could park a screen
    // clear in the desktop's own settings file.
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '' })
    const qr = scan(ctx.sent)
    const phone = generateIdentity()
    feed(
      ctx.rooms[0],
      sealPairingHello({
        deviceSecretKey: phone.secretKey,
        devicePublicKey: phone.publicKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        label: '\u001b[2J\u0007 ' + 'A'.repeat(400),
        oneTimeSecret: qr.oneTimeSecret,
      }),
    )
    // The introducer is gone, so what is left is inert text rather than a screen
    // clear, and the whole thing is capped at 64.
    const label = message(ctx.sent, 'paired')!.device.label
    expect(label).toBe('[2J ' + 'A'.repeat(60))
    expect(label).not.toContain('\u001b')
    expect(label).not.toContain('\u0007')
  })

  it('names a phone that sends nothing usable at all', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '' })
    const qr = scan(ctx.sent)
    const phone = generateIdentity()
    feed(
      ctx.rooms[0],
      sealPairingHello({
        deviceSecretKey: phone.secretKey,
        devicePublicKey: phone.publicKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        label: '\u0000\u0001',
        oneTimeSecret: qr.oneTimeSecret,
      }),
    )
    expect(message(ctx.sent, 'paired')?.device.label).toBe('Phone')
  })

  it('opens the room the QR names, in pairing mode', () => {
    // Without this the QR was an invitation to a room nobody was in: the phone
    // scanned it, connected, sent its hello, and the desktop never arrived.
    const { qr, room } = begin()
    expect(room.deps.roomId).toBe(qr.pairingId)
    expect(room.deps.mode).toBe('pairing')
    expect(room.started).toBe(true)
  })

  it('publishes the desktop public key, never the secret behind it', () => {
    const { qr } = begin()
    expect(qr.desktopPublicKey).toBe(DESKTOP_PUBLIC)
    expect(JSON.stringify(qr)).not.toContain(DESKTOP_SECRET)
  })

  it('pairs the phone from its hello and seats itself in the session room', () => {
    const { sent, rooms, room, phone, hello } = begin()
    feed(room, hello())
    // 'desk' is what the desktop user typed into Settings; 'Pixel' is what the
    // phone calls itself. The user's name wins -- see the label tests below.
    expect(message(sent, 'paired')?.device.label).toBe('desk')
    expect(message(sent, 'verificationPhrase')?.phrase.split(' ')).toHaveLength(PHRASE_WORDS)
    // The session room is DERIVED, so the desktop is seated in it before the phone
    // has been told anything -- which is the only ordering that works, since a
    // frame into an empty relay room is dropped rather than queued.
    expect(rooms[1].deps.roomId).toBe(deriveSessionRoomId(phone.secretKey, DESKTOP_PUBLIC))
    expect(rooms[1].deps.roomId).not.toBe(room.deps.roomId)
  })

  it('answers with an ack only that phone can open, then closes the room', () => {
    const { room, qr, phone, hello } = begin()
    feed(room, hello())
    expect(room.frames).toHaveLength(1)
    expect(
      openPairingAck({
        deviceSecretKey: phone.secretKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        frame: room.frames[0],
      }),
    ).toEqual({ deviceId: createHash('sha256').update(phone.publicKey).digest('hex').slice(0, 16) })
    // Acked, THEN closed. The other order writes into a socket already closing and
    // leaves the phone waiting on an answer that was never sent.
    expect(room.stoppedAtFrame).toBe(1)
  })

  it('ignores a frame that does not open, and keeps the offer live', () => {
    // The room's name is on screen for ninety seconds, so anything at all can
    // arrive in it. Reporting every one would train the user to ignore the report
    // that matters, and closing on one would let a photograph deny pairing.
    const { sent, room, hello } = begin()
    feed(room, new Uint8Array(64))
    expect(sent.filter((m) => m.kind === 'error')).toEqual([])
    expect(room.stopped).toBe(false)
    feed(room, hello())
    expect(message(sent, 'paired')).toBeDefined()
  })

  it('reports a hello that opens but carries the wrong secret', () => {
    // Worth surfacing: it opened, so the sender had the QR's pairing id and public
    // key but not its secret. A refusal does not spend the offer, so the real
    // phone can still finish.
    const { sent, room, hello } = begin()
    feed(room, hello('0'.repeat(64)))
    expect(message(sent, 'error')?.message).toMatch(/secret mismatch/)
    expect(room.stopped).toBe(false)
    feed(room, hello())
    expect(message(sent, 'paired')).toBeDefined()
  })

  it('closes the room when the user cancels', () => {
    const { c, room } = begin()
    c.handleHostMessage({ kind: 'cancelPairing' })
    expect(room.stopped).toBe(true)
  })

  it('closes the room on shutdown', () => {
    const { c, room } = begin()
    c.handleHostMessage({ kind: 'shutdown' })
    expect(room.stopped).toBe(true)
  })

  it('replaces the room when a second QR is painted', () => {
    // Two rooms means two sockets, and the abandoned one holds a Durable Object
    // alive for a QR that is no longer on screen.
    const { c, room, rooms } = begin()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    expect(room.stopped).toBe(true)
    expect(rooms).toHaveLength(2)
    expect(rooms[1].deps.roomId).not.toBe(room.deps.roomId)
  })

  it('closes the room when the offer expires', () => {
    // A user who taps Pair and walks away would otherwise leave a socket and a
    // Durable Object alive indefinitely -- keepalived every two minutes, for a QR
    // that stopped being valid after ninety seconds.
    vi.useFakeTimers()
    const { c, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    expect(rooms[0].stopped).toBe(false)
    vi.advanceTimersByTime(90_000)
    expect(rooms[0].stopped).toBe(true)
  })

  it('leaves no expiry timer behind when pairing succeeds', () => {
    // The timer closes `pairingRoom`, and by the time it fires that name has been
    // reused by the NEXT pairing. Left running, a QR painted 80 seconds after a
    // successful pair would be torn down ten seconds later for no visible reason.
    vi.useFakeTimers()
    const ctx = begin()
    feed(ctx.room, ctx.hello())
    // A minute later, so the first offer's expiry falls INSIDE the window advanced
    // below and the second one's falls outside it. Painting both at t=0 would let
    // a stale timer survive the test by simply not having come due yet.
    vi.advanceTimersByTime(60_000)
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    const second = ctx.rooms[ctx.rooms.length - 1]
    vi.advanceTimersByTime(31_000)
    expect(second.stopped).toBe(false)
  })
})

describe('subscription announcements', () => {
  /** Every terminal set the core has announced, in order. */
  function announced(sent: BridgeToHost[]): string[][] {
    return sent
      .filter((m): m is Extract<BridgeToHost, { kind: 'subscriptionsChanged' }> =>
        m.kind === 'subscriptionsChanged')
      .map((m) => [...m.terminalIds].sort())
  }

  /** Drive one request through the core the way an attached room would. */
  async function request(
    c: ReturnType<typeof core>['c'],
    deviceId: string,
    request: RemoteRequest,
  ) {
    return c.handleRemoteRequest(deviceId, { id: 1, request })
  }

  it('announces the new set after a granted subscribe', async () => {
    // Main has no other way to learn this. Without the message it pumps output
    // for every terminal or for none.
    const h = core([device()])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    expect(announced(h.sent)).toEqual([['t1']])
  })

  it('says nothing when a repeat subscribe leaves the set unchanged', async () => {
    // A phone re-subscribing on reconnect is routine. Re-announcing an identical
    // set would wake main and reset its pump for no reason.
    const h = core([device()])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    expect(announced(h.sent)).toEqual([['t1']])
  })

  it('announces the empty set when the last subscriber unsubscribes', async () => {
    const h = core([device()])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    await request(h.c, 'd1', { kind: 'unsubscribe', terminalId: 't1' })
    expect(announced(h.sent)).toEqual([['t1'], []])
  })

  it('does not announce for a subscribe the policy refused', async () => {
    // The fan-out is only updated after a successful dispatch, and the
    // announcement must follow the fan-out rather than the request -- otherwise
    // main starts pumping a terminal for a device that was told no.
    const h = core([{ ...device(), capabilities: { ...NO_CAPABILITIES, read: false } }])
    const res = await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    expect(res.kind).toBe('error')
    expect(announced(h.sent)).toEqual([])
  })

  it('announces after revoking the only subscriber', async () => {
    // Revoking has to stop the output too. A terminal left in the set would keep
    // main serialising PTY output for a phone that is gone.
    const h = core([device()])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    h.c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    expect(announced(h.sent)).toEqual([['t1'], []])
  })

  it('announces after withdrawing read from the only subscriber', async () => {
    const h = core([device()])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    h.c.handleHostMessage({
      kind: 'setCapabilities',
      deviceId: 'd1',
      capabilities: { ...NO_CAPABILITIES, read: false },
    })
    expect(announced(h.sent)).toEqual([['t1'], []])
  })

  it('keeps a terminal in the set while a second device still watches it', async () => {
    const h = core([device('d1'), device('d2')])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    await request(h.c, 'd2', { kind: 'subscribe', terminalId: 't1' })
    h.c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    expect(announced(h.sent)).toEqual([['t1']])
  })

  it('announces the empty set on shutdown so main stops pumping', async () => {
    const h = core([device()])
    await request(h.c, 'd1', { kind: 'subscribe', terminalId: 't1' })
    h.c.handleHostMessage({ kind: 'shutdown' })
    expect(announced(h.sent)).toEqual([['t1'], []])
  })
})

describe('bridge core: telling a phone what it may do', () => {
  it('answers getCapabilities for a device granted nothing at all', async () => {
    const h = core([{ ...device(), capabilities: { ...NO_CAPABILITIES } }])
    const res = await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'getCapabilities' } })
    expect(res).toEqual({ kind: 'ok', id: 1, data: { ...NO_CAPABILITIES } })
  })

  it('reports the grants the device actually holds', async () => {
    const caps = { ...NO_CAPABILITIES, read: true, createTerminal: true }
    const h = core([{ ...device(), capabilities: caps }])
    const res = await h.c.handleRemoteRequest('d1', { id: 7, request: { kind: 'getCapabilities' } })
    expect(res).toEqual({ kind: 'ok', id: 7, data: caps })
  })

  // Answered above the dispatcher, so no tool call may escape from it. A
  // getCapabilities that reached MCP would be the one ungated path to the host.
  it('answers without touching MCP', async () => {
    const h = core([device()])
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'getCapabilities' } })
    expect(h.callTool).not.toHaveBeenCalled()
  })

  it('still refuses a revoked device', async () => {
    const h = core([device()])
    h.c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })
    const res = await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'getCapabilities' } })
    expect(res).toEqual({ kind: 'error', id: 1, message: 'unknown or revoked device' })
  })

  it('pushes the new record to the phone when Settings changes a grant', () => {
    const h = core([device()])
    const room = h.rooms[0]
    attach(room)
    const caps = { ...NO_CAPABILITIES, read: true, createTerminal: true }
    h.c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: caps })
    expect(room.sent).toContainEqual({ kind: 'capabilities', capabilities: caps })
  })

  // Withdrawing read drops the fan-out; the phone has to hear about that too, or
  // its Settings screen keeps claiming a grant the desktop has already taken back.
  it('pushes a withdrawal as readily as a grant', () => {
    const h = core([device()])
    attach(h.rooms[0])
    h.c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: { ...NO_CAPABILITIES } })
    expect(h.rooms[0].sent).toContainEqual({
      kind: 'capabilities',
      capabilities: { ...NO_CAPABILITIES },
    })
  })

  // The push is a courtesy. A phone in a tunnel simply misses it, which is why
  // it re-asks on attach -- and why an edit while it is away must not throw.
  it('does not throw when the phone is not attached', () => {
    const h = core([device()])
    expect(() =>
      h.c.handleHostMessage({
        kind: 'setCapabilities',
        deviceId: 'd1',
        capabilities: { ...NO_CAPABILITIES, read: true },
      }),
    ).not.toThrow()
  })

  it('says nothing to a device that has no room at all', () => {
    const h = core([device()])
    expect(() =>
      h.c.handleHostMessage({
        kind: 'setCapabilities',
        deviceId: 'unknown',
        capabilities: { ...NO_CAPABILITIES, read: true },
      }),
    ).not.toThrow()
    expect(h.rooms[0].sent).toEqual([])
  })
})

describe('remote bridge -- the wiring the stub relay usually stands in for', () => {
  it('opens the pairing room through a real relay client when the host injected none', () => {
    // Production passes no `openRelay`: the utilityProcess bootstrap hands the
    // core a send, an MCP client and a URL, and the default factory is what
    // actually dials. Stubbing it in every test leaves the one factory a user
    // ever reaches unexercised until they scan a QR.
    const sent: BridgeToHost[] = []
    const c = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool: vi.fn() },
      relayUrl: 'wss://relay.test',
    })
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: DESKTOP_SECRET, devices: [] })

    expect(() => c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })).not.toThrow()
    expect(sent.some((m) => m.kind === 'pairingCode')).toBe(true)

    // Hand the socket back before the suite moves on: a real client holds a
    // reconnect timer, and a room left open outlives the test that opened it.
    c.handleHostMessage({ kind: 'cancelPairing' })
    c.handleHostMessage({ kind: 'shutdown' })
  })

  it('says nothing to the host while the pairing room changes state', () => {
    // `deviceConnected` is keyed by device id and the pairing room has no device
    // yet. Reporting from here would light the Settings indicator for a phone
    // that does not exist -- and leave it lit, because nothing later turns an id
    // off that was never turned on.
    const { c, sent, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })
    const before = sent.length

    rooms[0].deps.onStateChange('connecting')
    rooms[0].deps.onStateChange('online')
    rooms[0].deps.onStateChange('offline')

    expect(sent.length).toBe(before)
  })

  it('tells the host when the relay cuts the pairing connection short', () => {
    // Silence is the worst outcome here: the QR stays on screen, the phone keeps
    // failing against a room nobody is in, and the desktop shows no reason why.
    const { c, sent, rooms } = core()
    c.handleHostMessage({ kind: 'beginPairing', label: 'desk' })

    rooms[0].deps.onQuota?.('frame-rate')

    expect(sent).toContainEqual({
      kind: 'error',
      message: 'relay closed the pairing connection: frame-rate',
    })
  })

  it('mints a fresh handshake per dial, so a reconnect is never the old session', () => {
    // The room is handed a FACTORY, not a Handshake. Replay counters restart at
    // zero on every connection, which is only sound because the key they count
    // under is new each time -- one shared handshake would make a recorded
    // session replayable verbatim after any reconnect.
    const { rooms } = core([device()])
    const deps = rooms[0].deps as SessionRelayDeps

    const first = deps.handshake()
    const second = deps.handshake()

    expect(toHex(first.greeting)).not.toBe(toHex(second.greeting))
  })
})

describe('agent status, pushed from main to the phones watching', () => {
  it('sends a status frame to every device subscribed to that terminal', async () => {
    const { c, rooms } = core([device('d1'), device('d2')])
    attach(rooms[0])
    attach(rooms[1])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    await c.handleRemoteRequest('d2', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })

    c.handleHostMessage({
      kind: 'terminalStatus',
      terminalId: 't1',
      status: 'waiting_for_input',
      summary: 'Continue?',
    })

    const frame = { kind: 'status', terminalId: 't1', status: 'waiting_for_input', summary: 'Continue?' }
    expect(rooms[0].sent).toContainEqual(frame)
    expect(rooms[1].sent).toContainEqual(frame)
  })

  it('does not send it to a device watching a different terminal', () => {
    // Subscription IS the authorisation here. A device that never asked for this
    // terminal has not been granted a view of what its agent is doing.
    const { c, rooms } = core([device('d1')])
    attach(rooms[0])

    c.handleHostMessage({
      kind: 'terminalStatus',
      terminalId: 't1',
      status: 'thinking',
      summary: 'Thinking',
    })

    expect(rooms[0].sent).toEqual([])
  })

  it('replays the last status when a phone subscribes', async () => {
    // Main only sends when the answer CHANGES, so a phone that reconnects to a
    // terminal that has been idle for an hour would otherwise show a blank label
    // for as long as it stays idle -- which is forever.
    const { c, rooms } = core([device('d1'), device('d2')])
    attach(rooms[0])
    attach(rooms[1])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    c.handleHostMessage({ kind: 'terminalStatus', terminalId: 't1', status: 'idle', summary: 'Idle' })
    rooms[1].sent.length = 0

    await c.handleRemoteRequest('d2', { id: 2, request: { kind: 'subscribe', terminalId: 't1' } })

    expect(rooms[1].sent).toContainEqual({
      kind: 'status',
      terminalId: 't1',
      status: 'idle',
      summary: 'Idle',
    })
  })

  it('stays quiet on subscribe when main has never reported that terminal', async () => {
    // Inventing a status is worse than showing none: on the phone the two look
    // identical, and only one of them is true.
    const { c, rooms } = core([device('d1')])
    attach(rooms[0])

    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 'unknown' } })

    expect(rooms[0].sent.filter((m) => (m as { kind: string }).kind === 'status')).toEqual([])
  })

  it('holds nothing for a terminal no device watches any more', async () => {
    // The bridge is never told a terminal closed, so without this prune the map
    // grows one entry per terminal for the life of the process -- and a reused id
    // would replay a dead terminal's last state to the phone that opened the new
    // one.
    const { c, rooms } = core([device('d1')])
    attach(rooms[0])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    c.handleHostMessage({ kind: 'terminalStatus', terminalId: 't1', status: 'idle', summary: 'Idle' })
    await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'unsubscribe', terminalId: 't1' } })

    // Any later status message is what runs the prune; a second terminal stands
    // in for "the bridge is still alive and still being told things".
    await c.handleRemoteRequest('d1', { id: 3, request: { kind: 'subscribe', terminalId: 't2' } })
    c.handleHostMessage({ kind: 'terminalStatus', terminalId: 't2', status: 'idle', summary: 'Idle' })
    rooms[0].sent.length = 0

    await c.handleRemoteRequest('d1', { id: 4, request: { kind: 'subscribe', terminalId: 't1' } })

    expect(rooms[0].sent.filter((m) => (m as { kind: string }).kind === 'status')).toEqual([])
  })

  it('drops a status for a device that is subscribed but not attached', () => {
    // A frame sent into a room with no session is dropped unsealed. Status is a
    // fact about the present rather than a queued chunk, so it is simply skipped
    // -- the subscribe on reconnect replays it.
    const { c, rooms } = core([device('d1')])
    attach(rooms[0])
    return c
      .handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
      .then(() => {
        rooms[0].state = 'online'
        rooms[0].sent.length = 0
        c.handleHostMessage({
          kind: 'terminalStatus',
          terminalId: 't1',
          status: 'thinking',
          summary: 'Thinking',
        })
        expect(rooms[0].sent).toEqual([])
      })
  })
})

describe('status survives the phone going through a tunnel', () => {
  it('replays every watched terminal when a device re-attaches', async () => {
    // The phone does NOT re-subscribe on reconnect -- its subscription lives on
    // the desktop and survives the drop -- so re-attach is the only moment left
    // to hand it the state it missed.
    const { c, rooms } = core([device('d1')])
    attach(rooms[0])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'subscribe', terminalId: 't2' } })
    c.handleHostMessage({ kind: 'terminalStatus', terminalId: 't1', status: 'thinking', summary: 'Thinking' })
    c.handleHostMessage({ kind: 'terminalStatus', terminalId: 't2', status: 'idle', summary: 'Idle' })

    rooms[0].state = 'offline'
    rooms[0].deps.onStateChange('offline')
    rooms[0].sent.length = 0
    attach(rooms[0])

    const statuses = rooms[0].sent.filter((m) => (m as { kind: string }).kind === 'status')
    expect(statuses).toEqual([
      { kind: 'status', terminalId: 't1', status: 'thinking', summary: 'Thinking' },
      { kind: 'status', terminalId: 't2', status: 'idle', summary: 'Idle' },
    ])
  })

  it('replays nothing for a device that was watching nothing', () => {
    const { c, rooms } = core([device('d1')])
    attach(rooms[0])
    c.handleHostMessage({ kind: 'terminalStatus', terminalId: 't1', status: 'idle', summary: 'Idle' })
    rooms[0].sent.length = 0

    attach(rooms[0])

    expect(rooms[0].sent).toEqual([])
  })
})
