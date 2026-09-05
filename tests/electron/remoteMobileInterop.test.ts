import { describe, expect, it } from 'vitest'

// The desktop bridge, exactly as it ships.
import * as desktopPairing from '../../src/main/remoteBridge/pairing'
import {
  deriveVerificationPhrase as desktopPhrase,
  fromHex as desktopFromHex,
  toHex as desktopToHex,
} from '../../src/main/remoteBridge/sealedChannel'
import {
  Handshake as DesktopHandshake,
  deriveSessionRoomId as desktopRoomId,
  FRAME_SESSION,
  SESSION_HEADER_BYTES,
} from '../../src/main/remoteBridge/sessionCrypto'
import {
  NO_CAPABILITIES as DESKTOP_NO_CAPABILITIES,
  RELAY_MAX_FRAME_BYTES as DESKTOP_MAX_FRAME,
  type Capabilities as DesktopCapabilities,
  type RemoteMessage as DesktopMessage,
  type RemoteRequest as DesktopRequest,
} from '../../src/main/remoteBridge/protocol'
// The source the desktop protocol imports its status union FROM, so the phone's
// retyped copy is compared against the original rather than against a re-export.
import type { AgentStatus as DesktopAgentStatus } from '../../src/shared/agentStatusDetector'

// The phone, from a tree that shares no code with the above.
import * as phonePairing from '../../mobile/src/wire/pairing'
import { parseQrPayload } from '../../mobile/src/wire/qr'
import { deriveVerificationPhrase as phonePhrase } from '../../mobile/src/wire/safetyNumber'
import {
  Handshake as PhoneHandshake,
  deriveSessionRoomId as phoneRoomId,
} from '../../mobile/src/wire/sessionCrypto'
import {
  NO_CAPABILITIES as PHONE_NO_CAPABILITIES,
  parseCapabilities,
  parseRemoteMessage,
  RELAY_MAX_FRAME_BYTES as PHONE_MAX_FRAME,
  type AgentStatus as PhoneAgentStatus,
  type Capabilities as PhoneCapabilities,
  type RemoteMessage as PhoneMessage,
  type RemoteRequest as PhoneRequest,
} from '../../mobile/src/wire/protocol'
import { utf8Encode, utf8Decode } from '../../mobile/src/wire/bytes'

// Wire format section 12. Fixed rather than generated so a failure here names a
// concrete frame the vector suite also covers.
const DESKTOP_SK = '11'.repeat(32)
const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const PHONE_SK = '22'.repeat(32)
const PHONE_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const DESKTOP_EPH = '33'.repeat(32)
const PHONE_EPH = '44'.repeat(32)
const RELAY = 'wss://relay.test'

/** One full pairing, both ends real. Returned so later stages build on it rather
 *  than re-deriving from constants and quietly testing themselves. */
function pair(): {
  offer: ReturnType<typeof desktopPairing.createPairingOffer>
  desktopView: { devicePublicKey: string; label: string; oneTimeSecret: string }
  deviceId: string
} {
  const offer = desktopPairing.createPairingOffer({
    relayUrl: RELAY,
    desktopPublicKey: DESKTOP_PK,
    now: 1_700_000_000_000,
  })
  const qr = parseQrPayload(offer.qrPayload)
  if (qr === null) throw new Error('the phone could not read the desktop QR')

  const hello = phonePairing.sealPairingHello({
    deviceSecretKey: PHONE_SK,
    devicePublicKey: PHONE_PK,
    desktopPublicKey: qr.desktopPublicKey,
    pairingId: qr.pairingId,
    label: 'Pixel 9 Pro',
    oneTimeSecret: qr.oneTimeSecret,
  })
  const desktopView = desktopPairing.openPairingHello({
    desktopSecretKey: DESKTOP_SK,
    pairingId: offer.pairingId,
    frame: hello,
  })
  const session = new desktopPairing.PairingSession(offer, DESKTOP_PK, DESKTOP_SK)
  const { device } = session.accept({
    oneTimeSecret: desktopView.oneTimeSecret,
    devicePublicKey: desktopView.devicePublicKey,
    label: desktopView.label,
    now: 1_700_000_000_001,
  })
  return { offer, desktopView, deviceId: device.id }
}

describe('stage 1: pairing', () => {
  it('the phone reads the QR the desktop actually mints', () => {
    const offer = desktopPairing.createPairingOffer({
      relayUrl: RELAY,
      desktopPublicKey: DESKTOP_PK,
      now: 1_700_000_000_000,
    })
    const qr = parseQrPayload(offer.qrPayload)
    expect(qr).not.toBeNull()
    expect(qr?.relayUrl).toBe(RELAY)
    expect(qr?.desktopPublicKey).toBe(DESKTOP_PK)
    expect(qr?.pairingId).toBe(offer.pairingId)
    expect(qr?.oneTimeSecret).toBe(offer.oneTimeSecret)
  })

  it('the desktop opens a hello the phone sealed', () => {
    const { desktopView } = pair()
    expect(desktopView.devicePublicKey).toBe(PHONE_PK)
    expect(desktopView.label).toBe('Pixel 9 Pro')
  })

  it('both ends derive the same device id', () => {
    const { deviceId } = pair()
    expect(deviceId).toBe(phonePairing.deviceIdFor(PHONE_PK))
    expect(deviceId).toBe('12faa049f0ec7720')
  })

  it('the phone derives the desktop public key the desktop published', () => {
    // Cheap, and it is the assertion that catches a phone whose x25519 is not the
    // desktop's -- every later stage would then fail as "decryption", which says
    // nothing about where the fault is.
    expect(new PhoneHandshake('desktop', DESKTOP_SK, PHONE_PK).ownPublicKey).toBe(DESKTOP_PK)
    expect(new PhoneHandshake('device', PHONE_SK, DESKTOP_PK).ownPublicKey).toBe(PHONE_PK)
  })
})

describe('stage 2: the ack', () => {
  it('the phone opens an ack the desktop sealed', () => {
    const { offer, deviceId } = pair()
    const ack = desktopPairing.sealPairingAck({
      desktopSecretKey: DESKTOP_SK,
      devicePublicKey: PHONE_PK,
      pairingId: offer.pairingId,
      deviceId,
    })
    expect(
      phonePairing.openPairingAck({
        frame: ack,
        deviceSecretKey: PHONE_SK,
        desktopPublicKey: DESKTOP_PK,
        pairingId: offer.pairingId,
      }),
    ).toEqual({ deviceId })
  })

  it('the phone refuses an ack from a different pairing', () => {
    const { offer, deviceId } = pair()
    const other = pair()
    const ack = desktopPairing.sealPairingAck({
      desktopSecretKey: DESKTOP_SK,
      devicePublicKey: PHONE_PK,
      pairingId: other.offer.pairingId,
      deviceId,
    })
    expect(
      phonePairing.openPairingAck({
        frame: ack,
        deviceSecretKey: PHONE_SK,
        desktopPublicKey: DESKTOP_PK,
        pairingId: offer.pairingId,
      }),
    ).toBeNull()
  })
})

describe('stage 3: the safety number', () => {
  it('both ends derive the same phrase from the same two keys', () => {
    // A wordlist that drifted by one entry passes every crypto test and fails
    // only here -- and in the field, as two screens the user cannot reconcile.
    expect(phonePhrase(DESKTOP_PK, PHONE_PK)).toBe(desktopPhrase(DESKTOP_PK, PHONE_PK))
  })

  it('agrees regardless of the order the two keys are given in', () => {
    expect(phonePhrase(PHONE_PK, DESKTOP_PK)).toBe(desktopPhrase(DESKTOP_PK, PHONE_PK))
  })

  it('is eight words', () => {
    expect(phonePhrase(DESKTOP_PK, PHONE_PK).split(' ')).toHaveLength(8)
  })
})

describe('stage 4: the session room', () => {
  it('both ends derive the same room without either announcing it', () => {
    // A port that got this wrong would not fail a handshake. It would sit in an
    // empty room forever. This is the only place that shows up as a failure
    // rather than as a hang.
    expect(phoneRoomId(PHONE_SK, DESKTOP_PK)).toBe(desktopRoomId(DESKTOP_SK, PHONE_PK))
  })

  it('and it is not the room the QR named', () => {
    const { offer } = pair()
    expect(phoneRoomId(PHONE_SK, DESKTOP_PK)).not.toBe(offer.pairingId)
  })
})

/** Both ends greeted and accepted. The ephemerals default to fixed values so a
 *  failure names a frame rather than a random one; pass a different pair to model
 *  a second, genuinely distinct connection. */
function connect(
  desktopEph: string = DESKTOP_EPH,
  phoneEph: string = PHONE_EPH,
): {
  desktop: ReturnType<DesktopHandshake['accept']>
  phone: NonNullable<ReturnType<PhoneHandshake['accept']>>
} {
  const desktopHs = new DesktopHandshake({
    ownSecretKey: DESKTOP_SK,
    peerPublicKey: PHONE_PK,
    role: 'desktop',
    ephemeralSecretKey: desktopEph,
  })
  const phoneHs = new PhoneHandshake('device', PHONE_SK, DESKTOP_PK, phoneEph)

  const phoneGreeting = phoneHs.greeting()
  const desktop = desktopHs.accept(phoneGreeting)
  const phone = phoneHs.accept(desktopHs.greeting)
  if (phone === null) throw new Error('the phone rejected the desktop greeting')
  return { desktop, phone }
}

describe('stage 5: the session handshake', () => {
  it('each end accepts the other greeting', () => {
    expect(() => connect()).not.toThrow()
  })

  it('the two sessions seal and open each other', () => {
    const { desktop, phone } = connect()
    const header = Uint8Array.from([FRAME_SESSION])

    const fromDesktop = desktop.seal(header, utf8Encode('down'))
    expect(utf8Decode(phone.open(fromDesktop, SESSION_HEADER_BYTES)!)).toBe('down')

    const fromPhone = phone.seal(header, utf8Encode('up'))
    expect(utf8Decode(desktop.open(fromPhone, SESSION_HEADER_BYTES))).toBe('up')
  })

  it('the phone refuses a greeting sealed for the wrong role', () => {
    // Two desktops in a room is not a session, and a client that accepted one
    // would be talking to a peer that cannot answer.
    const impostor = new DesktopHandshake({
      ownSecretKey: PHONE_SK,
      peerPublicKey: DESKTOP_PK,
      role: 'device',
      ephemeralSecretKey: PHONE_EPH,
    })
    const phoneHs = new PhoneHandshake('device', PHONE_SK, DESKTOP_PK, PHONE_EPH)
    expect(phoneHs.accept(impostor.greeting)).toBeNull()
  })
})

describe('stage 6: a request round trip', () => {
  it('carries an envelope down and an answer back up', () => {
    const { desktop, phone } = connect()
    const header = Uint8Array.from([FRAME_SESSION])

    const envelope = phone.seal(
      header,
      utf8Encode(JSON.stringify({ id: 1, request: { kind: 'listTerminals' } })),
    )
    const asRead = JSON.parse(
      new TextDecoder().decode(desktop.open(envelope, SESSION_HEADER_BYTES)),
    )
    expect(asRead).toEqual({ id: 1, request: { kind: 'listTerminals' } })

    const answer = desktop.seal(
      header,
      utf8Encode(JSON.stringify({ kind: 'ok', id: 1, data: { terminals: [] } })),
    )
    const opened = phone.open(answer, SESSION_HEADER_BYTES)
    expect(opened).not.toBeNull()
    expect(parseRemoteMessage(opened!)).toEqual({ kind: 'ok', id: 1, data: { terminals: [] } })
  })

  it('carries a batched output push the phone can parse', () => {
    const { desktop, phone } = connect()
    const chunks = [{ terminalId: 't1', chunk: 'npm test\r\n', missed: 0, marker: null }]
    const frame = desktop.seal(
      Uint8Array.from([FRAME_SESSION]),
      utf8Encode(JSON.stringify({ kind: 'output', chunks })),
    )
    expect(parseRemoteMessage(phone.open(frame, SESSION_HEADER_BYTES)!)).toEqual({
      kind: 'output',
      chunks,
    })
  })
})

describe('stage 7: rejections, phone-side', () => {
  const header = Uint8Array.from([FRAME_SESSION])

  it('refuses a flipped ciphertext byte', () => {
    const { desktop, phone } = connect()
    const frame = desktop.seal(header, utf8Encode('down'))
    frame[frame.length - 1] ^= 0x01
    expect(phone.open(frame, SESSION_HEADER_BYTES)).toBeNull()
  })

  it('refuses a flipped header byte', () => {
    // The header is the AEAD associated data, so retagging a frame breaks it.
    const { desktop, phone } = connect()
    const frame = desktop.seal(header, utf8Encode('down'))
    frame[0] ^= 0x01
    expect(phone.open(frame, SESSION_HEADER_BYTES)).toBeNull()
  })

  it('refuses a replay', () => {
    const { desktop, phone } = connect()
    const frame = desktop.seal(header, utf8Encode('down'))
    expect(phone.open(frame.slice(), SESSION_HEADER_BYTES)).not.toBeNull()
    expect(phone.open(frame.slice(), SESSION_HEADER_BYTES)).toBeNull()
  })

  it('refuses its own frame reflected back', () => {
    // The two directions use different keys, so a relay that echoes cannot make
    // the phone talk to itself.
    const { phone } = connect()
    const mine = phone.seal(header, utf8Encode('up'))
    expect(phone.open(mine, SESSION_HEADER_BYTES)).toBeNull()
  })

  it('refuses a frame from a previous connection', () => {
    // Distinct ephemerals, because that is what makes it a second connection.
    // With the same pair on both sides the two sessions derive the same root and
    // a stale frame legitimately opens -- which is forward secrecy working, not
    // a replay slipping through.
    const first = connect()
    const second = connect('55'.repeat(32), '66'.repeat(32))
    const stale = first.desktop.seal(header, utf8Encode('down'))
    expect(second.phone.open(stale, SESSION_HEADER_BYTES)).toBeNull()
  })

  it('refuses a truncated frame without throwing', () => {
    const { desktop, phone } = connect()
    const frame = desktop.seal(header, utf8Encode('down'))
    for (const cut of [0, 1, 5, frame.length - 1]) {
      expect(() => phone.open(frame.subarray(0, cut), SESSION_HEADER_BYTES)).not.toThrow()
      expect(phone.open(frame.subarray(0, cut), SESSION_HEADER_BYTES)).toBeNull()
    }
  })

  it('leaves the session usable after a rejection', () => {
    // A failed open must not advance the high-water mark, or one injected frame
    // would deafen the phone to every real one after it.
    const { desktop, phone } = connect()
    const junk = desktop.seal(header, utf8Encode('down'))
    junk[junk.length - 1] ^= 0x01
    expect(phone.open(junk, SESSION_HEADER_BYTES)).toBeNull()

    const good = desktop.seal(header, utf8Encode('still here'))
    expect(utf8Decode(phone.open(good, SESSION_HEADER_BYTES)!)).toBe('still here')
  })
})

describe('stage 8: direction independence', () => {
  it('the two directions carry their own counters', () => {
    const { desktop, phone } = connect()
    const header = Uint8Array.from([FRAME_SESSION])

    const down0 = desktop.seal(header, utf8Encode('d0'))
    const down1 = desktop.seal(header, utf8Encode('d1'))
    const up0 = phone.seal(header, utf8Encode('p0'))

    expect(utf8Decode(phone.open(down0, SESSION_HEADER_BYTES)!)).toBe('d0')
    expect(utf8Decode(phone.open(down1, SESSION_HEADER_BYTES)!)).toBe('d1')
    // The phone has now opened two frames and is still on its own counter 0.
    expect(utf8Decode(desktop.open(up0, SESSION_HEADER_BYTES))).toBe('p0')
  })

  it('opens a later frame when an earlier one never arrived', () => {
    // The relay does not reorder, but it does drop. Requiring counter n+1 exactly
    // would wedge the session on any loss.
    const { desktop, phone } = connect()
    const header = Uint8Array.from([FRAME_SESSION])
    desktop.seal(header, utf8Encode('lost'))
    const arrived = desktop.seal(header, utf8Encode('arrived'))
    expect(utf8Decode(phone.open(arrived, SESSION_HEADER_BYTES)!)).toBe('arrived')
  })
})

describe('the constants the two trees each declare for themselves', () => {
  it('agree on the relay frame ceiling', () => {
    expect(PHONE_MAX_FRAME).toBe(DESKTOP_MAX_FRAME)
  })

  it('agree on the agent status union', () => {
    // Structural, not nominal: this fails to compile if either side adds or
    // renames a status, which is the only way a retyped union stays honest.
    const fromDesktop: DesktopAgentStatus = 'waiting_for_input'
    const asPhone: PhoneAgentStatus = fromDesktop
    const backAgain: DesktopAgentStatus = asPhone
    expect(backAgain).toBe('waiting_for_input')
  })

  it('agree on the capability record', () => {
    // Same structural check as the status union. If either tree adds a
    // capability without the other, one of these assignments stops compiling --
    // which matters more here than elsewhere, because a phone that misreads the
    // record draws the wrong buttons.
    const fromDesktop: DesktopCapabilities = {
      read: true,
      createTerminal: true,
      writeToTerminal: true,
      closeTerminal: true,
    }
    const asPhone: PhoneCapabilities = fromDesktop
    const backAgain: DesktopCapabilities = asPhone
    expect(backAgain.writeToTerminal).toBe(true)
  })

  it('agree that a device starts out granted nothing', () => {
    expect({ ...PHONE_NO_CAPABILITIES }).toEqual({ ...DESKTOP_NO_CAPABILITIES })
    expect(Object.values(DESKTOP_NO_CAPABILITIES).every((v) => v === false)).toBe(true)
  })

  it('agree that getCapabilities is a request the phone may make', () => {
    // The phone asks it on every attach. If the desktop dropped the case, the
    // phone would be left drawing controls from a record it never received.
    const asked: PhoneRequest = { kind: 'getCapabilities' }
    const heard: DesktopRequest = asked
    expect(heard.kind).toBe('getCapabilities')
  })

  it('agree on the shape of the capability push', () => {
    const sent: DesktopMessage = {
      kind: 'capabilities',
      capabilities: { ...DESKTOP_NO_CAPABILITIES, read: true },
    }
    const heard: PhoneMessage = sent
    expect(heard).toEqual(parseRemoteMessage(utf8Encode(JSON.stringify(sent))))
  })

  it('the phone reads a real desktop capability record without losing a flag', () => {
    // Round-trip through the wire, not through the type system: `parseCapabilities`
    // reconstructs the record field by field, so a desktop flag it does not name
    // silently becomes `false` even though the types above still line up.
    const granted: DesktopCapabilities = {
      read: true,
      createTerminal: true,
      writeToTerminal: true,
      closeTerminal: true,
    }
    expect(parseCapabilities(JSON.parse(JSON.stringify(granted)))).toEqual(granted)
  })
})
