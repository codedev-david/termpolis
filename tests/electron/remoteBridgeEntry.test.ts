import { describe, it, expect, vi, afterEach } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { createHash } from 'crypto'
import { createBridgeCore, type FlattenerLike } from '../../src/main/remoteBridge/entry'
import { ScreenFlattener } from '../../src/main/remoteBridge/screenFlattener'
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
  type Capabilities,
  type PairedDevice,
  type RemoteRequest,
  type TerminalSize,
} from '../../src/main/remoteBridge/protocol'
import type {
  PairingRelayDeps,
  RelayClientDeps,
  RelayState,
  SessionRelayDeps,
} from '../../src/main/remoteBridge/relayClient'
import { MAX_PAYLOAD_BYTES, type OutputPayload } from '../../src/main/remoteBridge/outputChunker'
import { FORGET_FROM, formatGapMarker } from '../../src/main/remoteBridge/outputFanout'

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

function core(
  devices: PairedDevice[] = [],
  { init = true, flattener }: { init?: boolean; flattener?: FlattenerLike } = {},
) {
  const sent: BridgeToHost[] = []
  const rooms: ReturnType<typeof stubRoom>[] = []
  const callTool = vi.fn().mockResolvedValue({ terminals: [] })
  const c = createBridgeCore({
    send: (m) => sent.push(m),
    mcp: { callTool },
    relayUrl: 'wss://relay.test',
    flattener,
    // Pinned so the name in the ack is the harness's, not whatever machine is
    // running the suite.
    desktopName: 'Bench desktop',
    openRelay: (d) => {
      const room = stubRoom(d)
      rooms.push(room)
      return room
    },
  })
  if (init) {
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: DESKTOP_SECRET, devices })
  }
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

/** A phone's copy of one terminal: the text it shows, and where that text ends
 *  in the desktop's numbering. */
interface PhoneCopy {
  text: string
  end: number
}

/** Apply chunks to a phone's copy exactly as the app does.
 *
 *  A line-for-line mirror of `onOutput` in mobile/src/state/remoteStore.ts,
 *  which is also what the App Store build (1.1.0) runs. Asserting on the chunks
 *  alone would test the bridge against itself: an edit is "truncate to here,
 *  then append", and whether a screen survives that is a property of the two
 *  ends together. The 200k display cap is left out; nothing here comes near it. */
function onPhone(chunks: OutputPayload['chunks'], from: PhoneCopy = { text: '', end: 0 }): PhoneCopy {
  let { text, end } = from
  for (const c of chunks) {
    const gap = c.missed > 0 && c.marker !== null ? c.marker : ''
    const keep =
      c.replaceFrom === null
        ? text.length
        : Math.min(text.length, Math.max(0, text.length - (end - c.replaceFrom)))
    text = text.slice(0, keep) + gap + c.chunk
    end = c.replaceFrom === null ? end + c.missed + c.chunk.length : c.replaceFrom + c.chunk.length
  }
  return { text, end }
}

/** Everything a stub room has sent, flattened out of its frames. */
function chunksIn(room: ReturnType<typeof stubRoom>): OutputPayload['chunks'] {
  return room.sent.flatMap((p) => p.chunks)
}

/** The chunks that draw something, without the forget the fan-out puts ahead of
 *  every whole screen (see `FORGET_FROM`). For the tests about WHO is sent
 *  output and what it says, where that empty chunk is bookkeeping between the
 *  bridge and the phone's copy rather than anything a phone shows. */
function drawing<T extends { replaceFrom: number | null }>(chunks: T[]): T[] {
  return chunks.filter((c) => c.replaceFrom !== FORGET_FROM)
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

  it('shuts down cleanly when init never arrived', () => {
    // Main forks the bridge and can decide to stop it before `init` lands -- a
    // quick off/on of the Remote toggle is enough. There is no identity, no
    // room and no expiry sweep to clear at that point, and shutdown still has
    // to complete: a bridge that throws on the way out leaves main waiting on
    // an exit that never comes.
    const { c, sent } = core([], { init: false })
    expect(() => c.handleHostMessage({ kind: 'shutdown' })).not.toThrow()
    expect(sent.some((m) => m.kind === 'ready')).toBe(false)
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
    await c.settled()
    expect(drawing(c.drainOutput('d1')).map((x) => x.chunk)).toEqual(['hello'])

    await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'unsubscribe', terminalId: 't1' } })
    c.handleHostMessage({ kind: 'terminalOutput', terminalId: 't1', slice: { output: 'more', nextOffset: 9, missed: 0 } })
    await c.settled()
    expect(c.drainOutput('d1')).toEqual([])
  })

  it('stops the live output stream when read is withdrawn, not just future requests', async () => {
    const { c } = core([device()])
    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })

    c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: { ...NO_CAPABILITIES } })

    c.handleHostMessage({ kind: 'terminalOutput', terminalId: 't1', slice: { output: 'secret', nextOffset: 6, missed: 0 } })
    await c.settled()
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
    await c.settled()
    expect(drawing(c.drainOutput('d1')).map((x) => x.chunk)).toEqual(['still here'])
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
    await c.settled()
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
    await c.settled()
    expect(drawing(c.drainOutput(granted.id))).toHaveLength(1)
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
    await c.settled()
    expect(drawing(c.drainOutput(granted.id))).toHaveLength(1)
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
    await c.settled()

    expect(rooms[0].sent).toHaveLength(0)
    expect(drawing(chunksIn(rooms[1]))[0].chunk).toBe('only for d2')
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
  function subscribed(deviceId = 'd1', flattener?: FlattenerLike) {
    const h = core([device(deviceId)], { flattener })
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
    await h.c.settled()

    // One frame, and a whole screen in it -- the first thing a new grid draws is
    // anchored at 0, so it goes out behind the forget that makes it the phone's
    // whole copy.
    expect(h.rooms[0].sent).toHaveLength(1)
    expect(h.rooms[0].sent[0].chunks).toMatchObject([
      { chunk: '', replaceFrom: FORGET_FROM },
      { chunk: 'compiling...', replaceFrom: 0 },
    ])
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
      await h.c.settled()
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

  it('sends nothing for a device that never subscribed', async () => {
    const h = subscribed()
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'SECRET=hunter2', nextOffset: 14, missed: 0 },
    })
    await h.c.settled()
    expect(h.rooms[0].sent).toHaveLength(0)
  })

  it('hands the emulator the geometry the host reported', async () => {
    // Everything the flattener does is grid arithmetic, so the width and height
    // have to be the pty's rather than a default. Dropping them here is
    // invisible for `ls` and shreds a TUI: a redraw addressed to column 130 of a
    // 203-column screen lands somewhere else entirely in a 120-column one.
    const seen: Array<TerminalSize | undefined> = []
    const real = new ScreenFlattener()
    const h = subscribed('d1', {
      feed: (id, raw, size) => {
        seen.push(size)
        return real.feed(id, raw, size)
      },
      snapshot: (id) => real.snapshot(id),
      forget: (id) => real.forget(id),
      forgetAll: () => real.forgetAll(),
    })
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })

    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'frame', nextOffset: 5, missed: 0 },
      size: { cols: 203, rows: 51 },
    })
    await h.c.settled()
    expect(seen).toEqual([{ cols: 203, rows: 51 }])
  })

  it('survives an emulator that throws, and keeps flattening afterwards', async () => {
    // The chain is fire-and-forget: an unhandled rejection here takes the whole
    // bridge process down and every paired phone with it. One frame is the right
    // price -- the next write re-renders the screen from the emulator's own grid.
    let boom = true
    const real = new ScreenFlattener()
    const h = subscribed('d1', {
      feed: (id, raw) => {
        if (boom) {
          boom = false
          return Promise.reject(new Error('emulator gave up'))
        }
        return real.feed(id, raw)
      },
      snapshot: (id) => real.snapshot(id),
      forget: (id) => real.forget(id),
      forgetAll: () => real.forgetAll(),
    })
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })

    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'lost frame', nextOffset: 10, missed: 0 },
    })
    await h.c.settled()
    expect(h.rooms[0].sent).toHaveLength(0)

    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'next frame', nextOffset: 20, missed: 0 },
    })
    await h.c.settled()
    expect(drawing(chunksIn(h.rooms[0])).map((x) => x.chunk)).toEqual(['next frame'])
  })

  it('keeps the emulator alive while another device is still watching', async () => {
    // Dropping the grid on the first unsubscribe would restart the surviving
    // phone's scrollback: the next edit would arrive anchored at offset 0 and
    // wipe everything already on its screen.
    const h = core([device('d1'), device('d2')])
    attach(h.rooms[0])
    attach(h.rooms[1])
    h.rooms[0].sent.length = 0
    h.rooms[1].sent.length = 0
    for (const id of ['d1', 'd2']) {
      await h.c.handleRemoteRequest(id, { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    }

    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'line one', nextOffset: 8, missed: 0 },
    })
    await h.c.settled()
    await h.c.handleRemoteRequest('d1', { id: 2, request: { kind: 'unsubscribe', terminalId: 't1' } })
    h.rooms[1].sent.length = 0

    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: ' and two', nextOffset: 16, missed: 0 },
    })
    await h.c.settled()

    // Incremental: the shared prefix is not re-sent, which is only possible if
    // the emulator still remembers what it drew for the first write.
    const chunks = h.rooms[1].sent.flatMap((p) => p.chunks)
    expect(chunks.map((x) => x.chunk)).toEqual([' and two'])
    expect(chunks[0].replaceFrom).toBe(8)
  })

  it('shows a second phone the screen the first one is already watching', async () => {
    // The reported bug, for a terminal that is already being watched. Main only
    // reads a terminal when it JOINS the watched set, and a second phone joining
    // does not change that set -- so without the bridge's own copy, the second
    // phone got nothing until the terminal printed again, and then only edits
    // against a screen it never had. The terminal here is idle: no terminalOutput
    // follows the subscribe.
    const h = core([device('d1'), device('d2')])
    attach(h.rooms[0])
    attach(h.rooms[1])
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'Claude Code\r\n> waiting for input', nextOffset: 32, missed: 0 },
      reset: true,
    })
    await h.c.settled()
    const first = onPhone(chunksIn(h.rooms[0]))
    expect(first.text).toContain('> waiting for input')
    h.rooms[0].sent.length = 0
    h.rooms[1].sent.length = 0

    await h.c.handleRemoteRequest('d2', { id: 2, request: { kind: 'subscribe', terminalId: 't1' } })

    expect(onPhone(chunksIn(h.rooms[1]))).toEqual(first)
    // And the phone that was already watching is left exactly as it was.
    expect(h.rooms[0].sent).toHaveLength(0)
  })

  it('shows a phone that lost its copy the screen again when it reopens the terminal', async () => {
    // The app was killed while a terminal was open, so it never unsubscribed and
    // the bridge still counts it as watching. Relaunched, it opens the terminal
    // again holding nothing -- and to the bridge that is a REPEAT subscribe, which
    // changes nothing main can see. It still has to come back with the screen.
    const h = subscribed()
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'Claude Code\r\n> waiting for input', nextOffset: 32, missed: 0 },
      reset: true,
    })
    await h.c.settled()
    const before = onPhone(chunksIn(h.rooms[0]))
    h.rooms[0].sent.length = 0

    await h.c.handleRemoteRequest('d1', { id: 2, request: { kind: 'subscribe', terminalId: 't1' } })

    expect(onPhone(chunksIn(h.rooms[0]))).toEqual(before)
  })

  it('still reports dropped output when the surviving bytes change nothing', async () => {
    // Main tells the bridge how much it evicted before the bridge could read it.
    // If that count only rode along with visible text, a gap whose remaining
    // bytes happen to redraw nothing would vanish silently -- and a silent gap
    // reads as the agent having gone quiet, which is the one failure the user
    // cannot detect for themselves.
    const h = subscribed()
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'ESCAPE'.replace(/[A-Z]+/, () => '\u001b'), nextOffset: 4_096, missed: 4_095 },
    })
    await h.c.settled()

    const chunks = h.rooms[0].sent.flatMap((p) => p.chunks)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].chunk).toBe('')
    expect(chunks[0].replaceFrom).toBeNull()
    expect(chunks[0].marker).toContain('skipped')
  })

  it('consumes an escape-dense burst instead of forwarding it', async () => {
    const h = subscribed()
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    // Bare ESC, one after another: each starts a sequence the next one aborts, so
    // the screen never changes. This used to be the shape that overflowed a relay
    // frame -- ESC costs six wire bytes JSON-encoded, so 200k of them made 1.2 MB
    // of payload out of nothing the user could see. The emulator eats it now.
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: '\u001b'.repeat(200_000), nextOffset: 200_000, missed: 0 },
    })
    await h.c.settled()

    expect(h.rooms[0].sent).toHaveLength(0)
  })

  it('keeps a burst larger than the fan-out queue inside one relay frame', async () => {
    const h = subscribed()
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    // 300k characters of ordinary output -- more than the fan-out's 262144-char
    // queue holds, so this exercises eviction and the gap notice as well.
    //
    // It cannot split across frames, and that is now a property rather than an
    // accident: the queue caps what one drain can carry at 262144 characters, and
    // the densest thing the flattener emits is a `\u001b[0m` run every four
    // characters, which JSON-encodes to well under the 1 MiB frame limit. The
    // split path is still wired in and still tested -- see remoteOutputChunker.
    const burst = Array.from({ length: 3_000 }, (_, i) => `line ${i} `.padEnd(100, '.')).join('\r\n')
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: burst, nextOffset: burst.length, missed: 0 },
    })
    await h.c.settled()

    expect(h.rooms[0].sent).toHaveLength(1)
    const chunks = h.rooms[0].sent[0].chunks
    expect(chunks).toHaveLength(1)
    expect(chunks[0].chunk.length).toBeLessThanOrEqual(262_144)
    // The tail of the burst is what the user is looking at, so that is the end
    // that has to survive eviction.
    expect(chunks[0].chunk.endsWith('.')).toBe(true)
    expect(chunks[0].chunk).toContain('line 2999')
    expect(chunks[0].marker).toContain('skipped')
  })
})

/** `n` rows of ordinary output, each ending in a newline. 2,000 of them come to
 *  about 48,000 chars flattened -- more than the 32,768 of history the bridge
 *  keeps for a phone that opens a terminal late. */
function rows(n: number, from = 0): string {
  return Array.from({ length: n }, (_, i) => `row ${from + i} of output here\r\n`).join('')
}

// David's report, 2026-09-30: "when i click into a terminal it does not show the
// output or what the agent is working on until I type any kind of message". An
// agent parked at its prompt prints nothing, so anything that waited for the
// terminal's NEXT output waited for the user. Every test here is a phone opening
// a terminal that is not printing, and what it has to be shown regardless.
describe('the screen for a phone opening a terminal', () => {
  /** Two attached phones with nothing sent to either yet. */
  function twoPhones(flattener?: FlattenerLike) {
    const h = core([device('d1'), device('d2')], { flattener })
    attach(h.rooms[0])
    attach(h.rooms[1])
    h.rooms[0].sent.length = 0
    h.rooms[1].sent.length = 0
    return h
  }

  type Harness = ReturnType<typeof twoPhones>

  let requestId = 0

  function open(h: Harness, deviceId: string, terminalId = 't1') {
    requestId += 1
    return h.c.handleRemoteRequest(deviceId, { id: requestId, request: { kind: 'subscribe', terminalId } })
  }

  function close(h: Harness, deviceId: string, terminalId = 't1') {
    requestId += 1
    return h.c.handleRemoteRequest(deviceId, { id: requestId, request: { kind: 'unsubscribe', terminalId } })
  }

  /** One slice from main, flattened and fanned out before this returns.
   *  `reset` is main's opening read: the terminal's whole window, from its start. */
  async function output(h: Harness, text: string, reset = false): Promise<void> {
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: text, nextOffset: text.length, missed: 0 },
      ...(reset ? { reset: true } : {}),
    })
    await h.c.settled()
  }

  function announcements(h: Harness): number {
    return h.sent.filter((m) => m.kind === 'subscriptionsChanged').length
  }

  it('shows a phone switching back the screen as it is now, not as it left it', async () => {
    // Opening another terminal unsubscribes this one. With a second phone still
    // watching, the set main pumps does not change -- so main reads nothing when
    // the first phone comes back, and it used to come back to the screen it
    // left, frozen, until the agent next printed.
    const h = twoPhones()
    await open(h, 'd1')
    await open(h, 'd2')
    await output(h, 'Claude Code\r\n> ', true)
    const left = onPhone(chunksIn(h.rooms[0]))
    await close(h, 'd1')
    await output(h, 'fix the tests\r\nWorking...')
    const before = announcements(h)
    h.rooms[0].sent.length = 0

    await open(h, 'd1')

    const back = onPhone(chunksIn(h.rooms[0]), left)
    expect(back).toEqual(onPhone(chunksIn(h.rooms[1])))
    expect(back.text).toBe('Claude Code\n> fix the tests\nWorking...')
    // All of it from the bridge's own grid: main was not asked for anything.
    expect(announcements(h)).toBe(before)
  })

  it('clears a copy from an earlier visit before drawing a long screen', async () => {
    // A copy kept from before the desktop restarted is numbered in a stream that
    // no longer exists. Drawn over rather than cleared, a screen that starts
    // past the end of that copy would be appended to it.
    const h = twoPhones()
    await open(h, 'd2')
    await output(h, rows(2000), true)

    await open(h, 'd1')

    const chunks = chunksIn(h.rooms[0])
    expect(chunks[0]).toMatchObject({ chunk: '', replaceFrom: FORGET_FROM })
    expect(chunks[1].replaceFrom).toBeGreaterThan(0)
    const early = onPhone(chunksIn(h.rooms[1]))
    // The second old copy had a gap notice drawn into it, so it runs a notice
    // longer than its end mark says. A clear at 0 kept exactly that much of it.
    for (const old of [
      { text: 'old copy', end: 8 },
      { text: formatGapMarker(4096) + 'old copy', end: 8 },
    ]) {
      const late = onPhone(chunks, old)
      expect(late.end).toBe(early.end)
      expect(early.text.endsWith(late.text)).toBe(true)
      expect(late.text.startsWith('row ')).toBe(true)
      expect(late.text.endsWith('row 1999 of output here')).toBe(true)
    }
  }, 60_000)

  it('starts the screen over on a phone whose copy holds a gap notice', async () => {
    // The phone draws a gap notice into its copy without counting it in the
    // copy's end mark, so afterwards the copy runs a notice longer than the mark
    // says. A whole screen anchored at 0 counted back from that mark kept the
    // difference -- the top of the OLD screen, over the new one, for good.
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, 'Claude Code\r\n> first prompt', true)
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: '\r\nlater', nextOffset: 99_000, missed: 40_000 },
    })
    await h.c.settled()
    const gapped = onPhone(chunksIn(h.rooms[0]))
    expect(gapped.text).toContain('output skipped')
    expect(gapped.text.length).toBeGreaterThan(gapped.end)
    h.rooms[0].sent.length = 0

    // Main's opening read, as when the phone leaves and comes back as the only
    // one watching.
    await output(h, 'Claude Code\r\n> second prompt', true)

    expect(onPhone(chunksIn(h.rooms[0]), gapped).text).toBe('Claude Code\n> second prompt')
  })

  it('keeps a phone that opened late in step with one that watched from the start', async () => {
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, rows(2000), true)
    await open(h, 'd2')

    await output(h, 'Thinking... (1s)')
    await output(h, '\r\x1b[2KThinking... (2s)')
    await output(h, `\r\x1b[2Kdone\r\n${rows(50, 2000)}`)
    await output(h, '\x1b[A\x1b[2K')

    const early = onPhone(chunksIn(h.rooms[0]))
    const late = onPhone(chunksIn(h.rooms[1]))
    expect(late.end).toBe(early.end)
    expect(early.text.endsWith(late.text)).toBe(true)
    expect(late.text).toContain('done\nrow 2000 of output here')
    expect(late.text).not.toContain('Thinking')
  }, 60_000)

  it('leaves a phone that is already current exactly as it was', async () => {
    // A phone back from a tunnel is sent what queued while it was away, and may
    // then open the terminal again. It holds the whole stream -- clearing it
    // for the screen would throw away the history above the screen.
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, rows(2000), true)
    h.rooms[0].state = 'offline'
    await output(h, rows(20, 2000))
    attach(h.rooms[0])
    const current = onPhone(chunksIn(h.rooms[0]))
    expect(current.text).toContain('row 0 of output here')

    await open(h, 'd1')

    expect(onPhone(chunksIn(h.rooms[0]))).toEqual(current)
  }, 60_000)

  it('queues the screen behind a backlog the phone has not been sent yet', async () => {
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, 'Claude Code\r\n> ', true)
    const kept = onPhone(chunksIn(h.rooms[0]))
    h.rooms[0].state = 'offline'
    h.rooms[0].sent.length = 0
    await output(h, 'fix the tests\r\nWorking...')

    await open(h, 'd1')
    expect(h.rooms[0].sent).toHaveLength(0)
    attach(h.rooms[0])

    expect(onPhone(chunksIn(h.rooms[0]), kept).text).toBe('Claude Code\n> fix the tests\nWorking...')
  })

  it('leaves the drawing to main while main has not read the terminal yet', async () => {
    // No grid yet: main's opening read is on its way and draws the terminal for
    // every phone watching it at once. Opening it twice before then is not two
    // screens' worth of anything.
    const h = twoPhones()
    await open(h, 'd1')
    await open(h, 'd1')
    await open(h, 'd2')
    expect(chunksIn(h.rooms[0])).toEqual([])
    expect(chunksIn(h.rooms[1])).toEqual([])

    await output(h, 'Claude Code\r\n> ', true)

    expect(onPhone(chunksIn(h.rooms[0])).text).toBe('Claude Code\n>')
    expect(onPhone(chunksIn(h.rooms[1])).text).toBe('Claude Code\n>')
  })

  it('starts the screen over when main reads the terminal from the top again', async () => {
    // Main's opening read is the whole window. Drawn on top of the grid already
    // here, the terminal would appear twice, the second copy typed after the
    // first one's cursor.
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, 'Claude Code\r\n> first prompt', true)
    await output(h, 'Claude Code\r\n> second prompt', true)
    expect(onPhone(chunksIn(h.rooms[0])).text).toBe('Claude Code\n> second prompt')
  })

  it('clears the phone when main reads a terminal and finds it empty', async () => {
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, 'old screen')
    await output(h, '', true)
    const chunks = chunksIn(h.rooms[0])
    expect(chunks.at(-1)).toMatchObject({ chunk: '', replaceFrom: 0 })
    expect(onPhone(chunks).text).toBe('')
  })

  it('tells a second phone that an empty terminal is empty', async () => {
    // Not "there is no screen yet" -- that leaves a phone showing what it held
    // for this terminal the last time it looked.
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, '', true)
    await open(h, 'd2')
    expect(onPhone(chunksIn(h.rooms[1]), { text: 'what it showed last week', end: 24 }).text).toBe('')
  })

  it('takes lines off the phone when the screen gets shorter', async () => {
    // A menu closing, a line erased: the edit carries no text, only the point to
    // cut back to. It used to be dropped as empty, leaving the menu on the phone.
    const h = twoPhones()
    await open(h, 'd1')
    await output(h, 'menu\r\n  option one', true)
    await output(h, '\x1b[2K')
    const chunks = chunksIn(h.rooms[0])
    expect(chunks.at(-1)).toMatchObject({ chunk: '', replaceFrom: 4 })
    expect(onPhone(chunks).text).toBe('menu')
  })

  it('plants no grid from a slice that arrives for a terminal nobody watches', async () => {
    // Main read it just before hearing the last phone had gone. Fed, it would be
    // a grid holding one stray slice -- and the next phone to open the terminal
    // would be shown that as its screen instead of waiting for main's read.
    const h = twoPhones()
    await output(h, 'stray slice read just before the last phone left')
    await open(h, 'd1')
    expect(chunksIn(h.rooms[0])).toEqual([])
    expect(h.sent.filter((m) => m.kind === 'subscriptionsChanged').at(-1)).toEqual({
      kind: 'subscriptionsChanged',
      terminalIds: ['t1'],
    })
  })
})

// A grid is only right while something feeds it. Once nobody watches a terminal
// main stops reading it, and a grid kept past that point is a stale screen the
// next phone to open the terminal would be drawn from.
describe('letting a terminal grid go', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function recording() {
    const real = new ScreenFlattener()
    const forgot: string[] = []
    const flattener: FlattenerLike = {
      feed: (id, raw, size) => real.feed(id, raw, size),
      snapshot: (id) => real.snapshot(id),
      forget: (id) => {
        forgot.push(id)
        real.forget(id)
      },
      forgetAll: () => real.forgetAll(),
    }
    return { flattener, forgot }
  }

  /** d1 watching t1 with something on screen, and d2 paired but watching nothing. */
  async function watched() {
    const { flattener, forgot } = recording()
    const h = core([device('d1'), device('d2')], { flattener })
    attach(h.rooms[0])
    attach(h.rooms[1])
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'SECRET=hunter2', nextOffset: 14, missed: 0 },
      reset: true,
    })
    await h.c.settled()
    h.rooms[1].sent.length = 0
    // The opening read starts its grid over, which is a forget of its own.
    forgot.length = 0
    return { h, forgot }
  }

  it('lets it go when the last phone closes the terminal', async () => {
    const { h, forgot } = await watched()
    await h.c.handleRemoteRequest('d1', { id: 2, request: { kind: 'unsubscribe', terminalId: 't1' } })
    expect(forgot).toEqual(['t1'])
  })

  it('keeps it while another phone is still watching', async () => {
    const { h, forgot } = await watched()
    await h.c.handleRemoteRequest('d2', { id: 2, request: { kind: 'subscribe', terminalId: 't1' } })
    await h.c.handleRemoteRequest('d1', { id: 3, request: { kind: 'unsubscribe', terminalId: 't1' } })
    expect(forgot).toEqual([])
  })

  it('lets go of only the terminal that stopped being watched', async () => {
    const { h, forgot } = await watched()
    await h.c.handleRemoteRequest('d1', { id: 2, request: { kind: 'subscribe', terminalId: 't2' } })
    await h.c.handleRemoteRequest('d1', { id: 3, request: { kind: 'unsubscribe', terminalId: 't2' } })
    expect(forgot).toEqual(['t2'])
  })

  it.each([
    ['the phone is removed in Settings', (h: ReturnType<typeof core>) =>
      h.c.handleHostMessage({ kind: 'revokeDevice', deviceId: 'd1' })],
    ['read is withdrawn from the phone', (h: ReturnType<typeof core>) =>
      h.c.handleHostMessage({ kind: 'setCapabilities', deviceId: 'd1', capabilities: { ...NO_CAPABILITIES } })],
    ['the phone unpairs itself', (h: ReturnType<typeof core>) =>
      h.c.handleRemoteRequest('d1', { id: 2, request: { kind: 'unpair' } })],
  ])('lets it go when %s', async (_, leave) => {
    // Each of these empties a watch list without an unsubscribe. The grid used
    // to survive all of them, and the next phone to open the terminal was
    // drawn from it -- a screen from whenever that phone left.
    const { h, forgot } = await watched()
    await leave(h)
    expect(forgot).toEqual(['t1'])

    await h.c.handleRemoteRequest('d2', { id: 3, request: { kind: 'subscribe', terminalId: 't1' } })
    expect(chunksIn(h.rooms[1])).toEqual([])
  })

  it('lets it go when a pairing expires', async () => {
    // Only the sweep's clock is faked. xterm finishes a write off a real timer,
    // so faking that would leave the feed below waiting for ever.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { h, forgot } = await watched()
    vi.setSystemTime(Date.now() + DEVICE_IDLE_EXPIRY_MS + 1)
    vi.advanceTimersByTime(DEVICE_EXPIRY_SWEEP_MS)
    expect(h.sent.filter((m) => m.kind === 'devicesChanged').at(-1)?.devices).toEqual([])
    expect(forgot).toEqual(['t1'])
    h.c.handleHostMessage({ kind: 'shutdown' })
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
  function begin(capabilities?: Capabilities) {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'desk', capabilities })
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

  it('pairs the phone with the grant the user ticked before the QR', () => {
    // The bug this closes: pairing always created a device with NOTHING granted,
    // so the phone attached, asked for the terminal list and was refused --
    // which on the phone reads as "this desktop lacks read capability" and an
    // empty list, not as a switch nobody turned on.
    const granted: Capabilities = {
      ...NO_CAPABILITIES,
      read: true,
      createTerminal: true,
    }
    const { sent, room, hello } = begin(granted)
    feed(room, hello())
    expect(message(sent, 'paired')?.device.capabilities).toEqual(granted)
  })

  it('grants nothing when the offer carried no choice at all', () => {
    // Absent is not "grant everything": a desktop build that predates the choice,
    // or a message that lost the field, must land on the closed default.
    const { sent, room, hello } = begin()
    feed(room, hello())
    expect(message(sent, 'paired')?.device.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('fills in the flags a partial grant left out', () => {
    // `beginPairing` crosses a process boundary, so the object is whatever the
    // sender built. Every missing flag has to resolve to false rather than
    // undefined, which the policy check would read as "not granted" only by luck.
    const { sent, room, hello } = begin({ writeToTerminal: true } as Capabilities)
    feed(room, hello())
    expect(message(sent, 'paired')?.device.capabilities).toEqual({
      ...NO_CAPABILITIES,
      writeToTerminal: true,
    })
  })

  it('does not carry a grant from one pairing into the next offer', () => {
    // Consent is per pairing. A grant left standing would silently apply to the
    // next phone the user pairs, which is the opposite of asking first.
    const ctx = core()
    ctx.c.handleHostMessage({
      kind: 'beginPairing',
      label: 'first',
      capabilities: { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true },
    })
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'second' })
    const qr = scan(ctx.sent.filter((m) => m.kind === 'pairingCode').slice(-1))
    const phone = generateIdentity()
    feed(
      ctx.rooms[ctx.rooms.length - 1],
      sealPairingHello({
        deviceSecretKey: phone.secretKey,
        devicePublicKey: phone.publicKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        label: 'Pixel',
        oneTimeSecret: qr.oneTimeSecret,
      }),
    )
    expect(message(ctx.sent, 'paired')?.device.capabilities).toEqual(NO_CAPABILITIES)
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
    ).toEqual({
      deviceId: createHash('sha256').update(phone.publicKey).digest('hex').slice(0, 16),
      name: 'Bench desktop',
    })
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

/** A phone leaving, and saying so on the way out.
 *
 *  Since v1.40 the phone mints a fresh keypair per desktop, so a handset that
 *  unpairs and pairs again is a genuinely new device here -- by design, since
 *  that is what stops two desktops recognising one phone. The consequence is
 *  that an unpair the desktop never hears about leaves a row nothing can ever
 *  clear: its key is gone from the phone, so it can neither connect nor be
 *  recognised on the next pairing. This request is how the row goes too.
 */
describe('a device unpairing itself', () => {
  it('drops the row, and the next request on that id is refused', async () => {
    const { c, sent, callTool } = core([device('d1')])

    const bye = await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'unpair' } })
    expect(bye.kind).toBe('ok')

    const after = await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'listTerminals' } })
    expect(after.kind).toBe('error')
    // Not "you lack read". The record is gone, so the guard that answers is the
    // one above the policy -- the same one an id that never paired meets.
    expect(after).toMatchObject({ message: expect.stringMatching(/unknown or revoked/) })
    // An unpair is not a way to reach MCP with no grant.
    expect(callTool).not.toHaveBeenCalled()

    // Main has to hear about it, or the desktop's device list keeps drawing a
    // row that no longer exists and `remote-devices.json` keeps storing it.
    const announced = sent.filter((m) => m.kind === 'devicesChanged')
    expect(announced).not.toHaveLength(0)
    expect(announced[announced.length - 1]).toEqual({ kind: 'devicesChanged', devices: [] })
  })

  it('revokes the phone that asked and nobody else', async () => {
    // The whole request carries no device id. The one it acts on comes from the
    // sealed session, so there is no field for a paired phone to point at
    // somebody else's pairing.
    const { c } = core([device('d1'), device('d2')])

    await c.handleRemoteRequest('d1', { id: 1, request: { kind: 'unpair' } })

    expect((await c.handleRemoteRequest('d1', { id: 2, request: { kind: 'listTerminals' } })).kind).toBe('error')
    expect((await c.handleRemoteRequest('d2', { id: 3, request: { kind: 'listTerminals' } })).kind).toBe('ok')
  })

  it('works for a phone that was granted nothing at all', () => {
    // A device can be refused every capability and still has to be able to
    // leave. Requiring a grant to unpair would mean the phones with the least
    // access are the ones that cannot clean up after themselves.
    const ungranted = { ...device('d3'), capabilities: { ...NO_CAPABILITIES } }
    const { c } = core([ungranted])

    return expect(
      c.handleRemoteRequest('d3', { id: 1, request: { kind: 'unpair' } }),
    ).resolves.toMatchObject({ kind: 'ok' })
  })

  it('is refused for an id that was never paired', async () => {
    const { c } = core([])
    const res = await c.handleRemoteRequest('never-paired', { id: 1, request: { kind: 'unpair' } })
    expect(res.kind).toBe('error')
  })
})
