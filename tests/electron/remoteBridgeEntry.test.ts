import { describe, it, expect, vi } from 'vitest'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
import {
  generateIdentity,
  deriveVerificationPhrase,
  PHRASE_WORDS,
} from '../../src/main/remoteBridge/sealedChannel'
import { NO_CAPABILITIES, type BridgeToHost, type PairedDevice } from '../../src/main/remoteBridge/protocol'
import type { RelayClientDeps, RelayState } from '../../src/main/remoteBridge/relayClient'
import { MAX_PAYLOAD_BYTES, type OutputPayload } from '../../src/main/remoteBridge/outputChunker'

// A real curve point: the core builds a SealedChannel against every paired
// device's key the moment it opens that device's room, so a placeholder string
// no longer survives init.
const PEER = generateIdentity()

function device(id = 'd1'): PairedDevice {
  return {
    id,
    label: 'phone',
    publicKey: PEER.publicKey,
    pairingId: 'f'.repeat(32),
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: 0,
    lastSeenAt: 0,
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
    start() {
      room.started = true
    },
    send(payload: unknown) {
      room.sent.push(payload as OutputPayload)
    },
    stop() {
      room.stopped = true
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
  c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: 'a'.repeat(64), devices })
  return { c, sent, callTool, rooms }
}

/** Bring a room up the way the relay client would, so the core's own
 *  state-change handling runs rather than being bypassed. */
function goOnline(room: ReturnType<typeof stubRoom>): void {
  room.state = 'online'
  room.deps.onStateChange('online')
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
    expect(callTool).toHaveBeenCalledWith('list_terminals', {})
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
    expect(callTool).toHaveBeenCalledWith('write_to_terminal', { terminalId: 't', text: 'hi' })
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
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: 'a'.repeat(64), devices: [device()] })
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
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: 'a'.repeat(64), devices: [] })
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
      identitySecretKey: 'a'.repeat(64),
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

describe('relay rooms', () => {
  it('dials one room per paired device on init', () => {
    const { rooms } = core([device('d1'), device('d2')])
    expect(rooms).toHaveLength(2)
    expect(rooms.every((r) => r.started)).toBe(true)
    // Per device, so revoking one cannot disturb another's connection.
    expect(new Set(rooms.map((r) => r.deps.pairingId)).size).toBe(1)
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

    // The room the phone is already waiting in -- the id it scanned, not a fresh
    // one. A new id here would mean the two ends never meet.
    expect(rooms).toHaveLength(1)
    expect(rooms[0].deps.pairingId).toBe(offer.pairingId)
    expect(rooms[0].started).toBe(true)
  })

  it('moves the device to the new room when the same phone re-pairs', () => {
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

    // A device id is a hash of the phone's public key, so it is the SAME phone
    // both times -- but a pairing id is minted per offer, so the phone is now
    // waiting in a room the desktop is not in. Keeping the first room because
    // the device is "already open" is a re-pair that silently never connects.
    expect(second).not.toBe(first)
    expect(rooms).toHaveLength(2)
    expect(rooms[0].deps.pairingId).toBe(first)
    expect(rooms[0].stopped).toBe(true)
    expect(rooms[1].deps.pairingId).toBe(second)
    expect(rooms[1].started).toBe(true)
  })

  it('leaves a room alone when the same device is opened twice', () => {
    const dev = device()
    const { c, rooms } = core([dev])
    c.handleHostMessage({ kind: 'init', mcpPort: 1, mcpToken: 't', identitySecretKey: 'a'.repeat(64), devices: [dev] })

    // Same device, same pairing id: the socket already dialled is the right one.
    // Redialling would drop a live connection and lose whatever it was carrying.
    expect(rooms).toHaveLength(1)
    expect(rooms[0].stopped).toBe(false)
  })

  it('binds each room to its own device', async () => {
    const { c, rooms } = core([device('d1'), device('d2')])
    for (const r of rooms) goOnline(r)
    for (const r of rooms) r.sent.length = 0

    // Requests arrive on the ROOM, not through a shared entry point, so the
    // device id comes from the closure rather than the message. A room wired to
    // the wrong id would serve one phone's subscription to another -- the exact
    // shape of cross-device leak this per-device model exists to prevent.
    await rooms[1].deps.onRequest({ id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
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
    goOnline(rooms[0])
    expect(sent).toContainEqual({ kind: 'deviceConnected', deviceId: 'd1' })

    rooms[0].state = 'offline'
    rooms[0].deps.onStateChange('offline')
    expect(sent).toContainEqual({ kind: 'deviceDisconnected', deviceId: 'd1' })
  })

  it('treats a dial in progress as not yet reachable', () => {
    const { sent, rooms } = core([device()])
    rooms[0].deps.onStateChange('connecting')

    // Connecting is not connected. Reporting it as connected would light up
    // Settings for a device that cannot receive anything.
    expect(sent).toContainEqual({ kind: 'deviceDisconnected', deviceId: 'd1' })
    expect(sent.some((m) => m.kind === 'deviceConnected')).toBe(false)
  })
})

describe('output pump', () => {
  function subscribed(deviceId = 'd1') {
    const h = core([device(deviceId)])
    goOnline(h.rooms[0])
    h.rooms[0].sent.length = 0
    return h
  }

  it('pushes terminal output to an online device', async () => {
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

  it('holds output for an offline device and delivers it on reconnect', async () => {
    const h = core([device()])
    goOnline(h.rooms[0])
    await h.c.handleRemoteRequest('d1', { id: 1, request: { kind: 'subscribe', terminalId: 't1' } })
    h.rooms[0].state = 'offline'
    h.rooms[0].sent.length = 0

    h.c.handleHostMessage({
      kind: 'terminalOutput',
      terminalId: 't1',
      slice: { output: 'built in 4s', nextOffset: 11, missed: 0 },
    })
    // Draining into a dead socket would discard it silently. The fan-out is the
    // buffer for exactly this: a phone that went into a tunnel mid-build.
    expect(h.rooms[0].sent).toHaveLength(0)

    goOnline(h.rooms[0])
    expect(h.rooms[0].sent.flatMap((p) => p.chunks).map((c) => c.chunk)).toContain('built in 4s')
  })

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
