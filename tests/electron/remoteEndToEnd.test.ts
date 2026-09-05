import { describe, it, expect, vi } from 'vitest'
import { createBridgeCore } from '../../src/main/remoteBridge/entry'
import { generateIdentity, deriveVerificationPhrase } from '../../src/main/remoteBridge/sealedChannel'
import { Handshake, FRAME_SESSION, deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import { sealPairingHello, openPairingAck } from '../../src/main/remoteBridge/pairing'
import type {
  PairingRelayDeps,
  RelayClientDeps,
  RelayState,
} from '../../src/main/remoteBridge/relayClient'
import { NO_CAPABILITIES, type BridgeToHost, type RemoteResponse } from '../../src/main/remoteBridge/protocol'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Relay rooms, recorded instead of dialled.
 *
 *  The bridge joins a room the moment a QR is painted, so without this the test
 *  would open a real socket to a host that does not exist. Recording them is also
 *  what lets the phone's frames be pushed in the way the relay would push them --
 *  which is the point of driving pairing from here at all. */
interface RecordedRoom {
  deps: RelayClientDeps
  frames: Uint8Array[]
  started: boolean
  stopped: boolean
  state: RelayState
  start(): void
  send(): void
  sendFrame(frame: Uint8Array): void
  stop(): void
}

function relayRecorder() {
  const rooms: RecordedRoom[] = []
  const openRelay = (deps: RelayClientDeps): RecordedRoom => {
    const r: RecordedRoom = {
      deps,
      frames: [],
      started: false,
      stopped: false,
      state: 'offline',
      start() {
        r.started = true
      },
      send() {},
      sendFrame(frame) {
        r.frames.push(frame)
      },
      stop() {
        r.stopped = true
      },
    }
    rooms.push(r)
    return r
  }
  return { rooms, openRelay }
}

/** The QR code the desktop paints. The phone scans exactly this and nothing else. */
interface QrPayload {
  v: number
  relayUrl: string
  pairingId: string
  desktopPublicKey: string
  oneTimeSecret: string
}

describe('remote bridge end-to-end', () => {
  // Everything below goes through createBridgeCore — the same entry point the
  // utilityProcess bootstrap calls — rather than the pairing/policy primitives
  // underneath it. The primitives already have their own unit tests; what is
  // untested until here is the WIRING: that beginPairing's QR really carries a
  // secret acceptPairing will honour, that accepting really reaches the registry
  // the dispatcher consults, and that revoking really unhooks it. Reaching past
  // the core to drive PairingSession directly would prove none of that.
  it('pairs, grants, serves, and revokes — with every frame sealed', async () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()

    const sent: BridgeToHost[] = []
    const callTool = vi.fn().mockResolvedValue({ terminals: [{ id: 't1', name: 'agent' }] })
    const { rooms, openRelay } = relayRecorder()
    const core = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool },
      relayUrl: 'wss://relay.test',
      openRelay,
    })

    // 1. Boot with no devices at all. Pairing has to create the only one.
    core.handleHostMessage({
      kind: 'init',
      mcpPort: 1,
      mcpToken: 'tok',
      identitySecretKey: desktop.secretKey,
      devices: [],
    })
    expect(sent.map((m) => m.kind)).toEqual(['ready'])

    // 2. User taps "Pair a phone". The desktop paints a QR.
    core.handleHostMessage({ kind: 'beginPairing', label: 'Kitchen iPhone' })
    const code = sent.find((m) => m.kind === 'pairingCode')
    if (code?.kind !== 'pairingCode') throw new Error('no pairing code was emitted')
    const qr = JSON.parse(code.qrPayload) as QrPayload
    expect(qr.v).toBe(1)
    expect(qr.relayUrl).toBe('wss://relay.test')
    // The QR carries the desktop's PUBLIC key. If this ever leaked the secret key,
    // pairing would hand the whole identity to anyone who photographed the screen.
    expect(qr.desktopPublicKey).toBe(desktop.publicKey)
    expect(qr.desktopPublicKey).not.toBe(desktop.secretKey)

    // The desktop is already sitting in the room its QR names. It has to be: a
    // frame sent into an empty relay room is dropped rather than queued, so a QR
    // painted before the socket exists is an invitation to nowhere.
    const pairingRoom = rooms.find((r) => r.deps.roomId === qr.pairingId)
    if (!pairingRoom) throw new Error('the desktop never joined the room its QR names')
    expect(pairingRoom.deps.mode).toBe('pairing')
    expect(pairingRoom.started).toBe(true)

    // 3. The phone answers with a hello sealed under a root derived from the QR.
    //    Everything the desktop learns about this phone arrives in these bytes --
    //    no in-process call, no shared object, the same frame Expo will send.
    const hello = (oneTimeSecret: string, label: string) =>
      sealPairingHello({
        deviceSecretKey: phone.secretKey,
        devicePublicKey: phone.publicKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        label,
        oneTimeSecret,
      })
    const deliver = (frame: Uint8Array) => (pairingRoom.deps as PairingRelayDeps).onFrame(frame)
    deliver(hello(qr.oneTimeSecret, 'iPhone'))

    const paired = sent.find((m) => m.kind === 'paired')
    if (paired?.kind !== 'paired') throw new Error('the hello paired nobody')
    const device = paired.device
    // The name the DESKTOP user typed wins over the name the phone gives for
    // itself. The phone's arrives over the relay and is sender-chosen text, so a
    // handset could otherwise seat itself in the device list under the name of a
    // phone the user already trusts.
    expect(device.label).toBe('Kitchen iPhone')
    // Ungranted on arrival: pairing establishes WHO, never WHAT.
    expect(device.capabilities).toEqual(NO_CAPABILITIES)

    // The answer is sealed to that phone alone and carries the device id it will
    // quote on every later request.
    expect(
      openPairingAck({
        deviceSecretKey: phone.secretKey,
        desktopPublicKey: qr.desktopPublicKey,
        pairingId: qr.pairingId,
        frame: pairingRoom.frames[0],
      }),
    ).toEqual({ deviceId: device.id })

    // The room the two ends actually meet in appears in no QR and on no wire: it
    // is a Diffie-Hellman over the two identity keys, and the desktop is seated in
    // it before the phone has been told anything at all.
    expect(rooms.map((r) => r.deps.roomId)).toContain(
      deriveSessionRoomId(phone.secretKey, desktop.publicKey),
    )

    // Both ends independently derive the same phrase — this is what defeats a MITM
    // relay. The phone computes it from the two keys it holds; the desktop emits it
    // to the host so the user can read the two aloud and compare.
    const announced = sent.find((m) => m.kind === 'verificationPhrase')
    if (announced?.kind !== 'verificationPhrase') throw new Error('no phrase was announced')
    expect(announced.deviceId).toBe(device.id)
    expect(announced.phrase).toBe(deriveVerificationPhrase(phone.publicKey, desktop.publicKey))
    expect(sent.some((m) => m.kind === 'devicesChanged')).toBe(true)

    // 4. The offer is spent. A second phone photographing the same QR gets nothing.
    //    Two defences, and both are load-bearing: the room is gone, so in production
    //    the frame never arrives at all — and were it somehow delivered anyway, the
    //    offer behind it has already been used.
    expect(pairingRoom.stopped).toBe(true)
    deliver(hello(qr.oneTimeSecret, 'attacker'))
    expect(sent.filter((m) => m.kind === 'paired')).toHaveLength(1)
    const refused = sent.find((m) => m.kind === 'error')
    if (refused?.kind !== 'error') throw new Error('the second scan was not refused')
    expect(refused.message).toMatch(/no pairing offer/)

    // 5. Paired is not granted. The device is refused and MCP is never touched.
    const denied = await core.handleRemoteRequest(device.id, { id: 1, request: { kind: 'listTerminals' } })
    expect(denied.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()

    // 6. User grants read in Settings.
    core.handleHostMessage({
      kind: 'setCapabilities',
      deviceId: device.id,
      capabilities: { ...NO_CAPABILITIES, read: true },
    })

    // 7. Now it is served — and the response survives a sealed round-trip.
    const ok = await core.handleRemoteRequest(device.id, { id: 2, request: { kind: 'listTerminals' } })
    expect(ok.kind).toBe('ok')
    // Named, not anonymous: the device id rides along to MCP so `mcp-audit.log`
    // records WHICH phone asked. Spec section 4.4.
    expect(callTool).toHaveBeenCalledWith('list_terminals', {}, device.id)

    // The two ends greet, agree a session neither the relay nor a later thief of
    // both identity keys can derive, and only then does a response cross.
    const dh = new Handshake({
      ownSecretKey: desktop.secretKey,
      peerPublicKey: phone.publicKey,
      role: 'desktop',
    })
    const ph = new Handshake({
      ownSecretKey: phone.secretKey,
      peerPublicKey: desktop.publicKey,
      role: 'device',
    })
    const toPhone = dh.accept(ph.greeting)
    const atPhone = ph.accept(dh.greeting)

    const H = new Uint8Array([FRAME_SESSION])
    const frame = toPhone.seal(H, enc.encode(JSON.stringify(ok)))
    const received = JSON.parse(dec.decode(atPhone.open(frame, 1))) as RemoteResponse
    expect(received).toEqual(ok)

    // 8. A relay that tampers with the frame gets nothing through.
    const tampered = toPhone.seal(H, enc.encode(JSON.stringify(ok)))
    tampered[tampered.length - 1] ^= 0xff
    expect(() => atPhone.open(tampered, 1)).toThrow()

    // 8b. Nor does one that replays the frame it just forwarded. Under the old
    // static channel this was only survivable while the bridge stayed up; a
    // restart reset the counters and the replay landed.
    expect(() => atPhone.open(frame, 1)).toThrow(/replay/)

    // 9. Revoke takes effect immediately — no reconnect, no restart.
    core.handleHostMessage({ kind: 'revokeDevice', deviceId: device.id })
    const afterRevoke = await core.handleRemoteRequest(device.id, { id: 3, request: { kind: 'listTerminals' } })
    expect(afterRevoke.kind).toBe('error')
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('never lets an unpaired device reach MCP even with a valid-looking request', async () => {
    const callTool = vi.fn()
    const core = createBridgeCore({ send: () => {}, mcp: { callTool }, relayUrl: 'wss://relay.test' })
    core.handleHostMessage({
      kind: 'init', mcpPort: 1, mcpToken: 'tok', identitySecretKey: generateIdentity().secretKey, devices: [],
    })
    const res = await core.handleRemoteRequest('never-paired', { id: 1, request: { kind: 'listTerminals' } })
    expect(res.kind).toBe('error')
    expect(callTool).not.toHaveBeenCalled()
  })
})
