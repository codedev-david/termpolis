import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { generateIdentity, fromHex, toHex } from '../../src/main/remoteBridge/sealedChannel'
import {
  Handshake,
  deriveSessionRoomId,
  pairingRoot,
  SealedSession,
  FRAME_SESSION,
  FRAME_SESSION_HELLO,
  GREETING_HEADER_BYTES,
  PROTOCOL_VERSION,
  type Role,
} from '../../src/main/remoteBridge/sessionCrypto'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const H = new Uint8Array([FRAME_SESSION])

/** Build a greeting the way a SECOND implementation would, with a payload of the
 *  test's choosing.
 *
 *  Both ends of the real `Handshake` hardcode agreeing values, so nothing driving
 *  it can reach the version or role checks. Those checks exist for the peer that
 *  does NOT agree -- the phone client, a stale build, a hostile reimplementation
 *  -- and this is what that peer looks like on the wire. */
function forgeGreeting(
  ownSecretKey: string,
  peerPublicKey: string,
  role: Role,
  payload: unknown,
): Uint8Array {
  const ephemeral = x25519.utils.randomSecretKey()
  const header = new Uint8Array(GREETING_HEADER_BYTES)
  header[0] = FRAME_SESSION_HELLO
  header.set(x25519.getPublicKey(ephemeral), 1)
  const root = hkdf(
    sha256,
    x25519.getSharedSecret(fromHex(ownSecretKey), fromHex(peerPublicKey)),
    undefined,
    bytes('termpolis-handshake-v2'),
    32,
  )
  return SealedSession.fromRoot(root, role).seal(header, bytes(JSON.stringify(payload)))
}

function handshake() {
  const desktop = generateIdentity()
  const device = generateIdentity()
  const d = new Handshake({
    ownSecretKey: desktop.secretKey,
    peerPublicKey: device.publicKey,
    role: 'desktop',
  })
  const p = new Handshake({
    ownSecretKey: device.secretKey,
    peerPublicKey: desktop.publicKey,
    role: 'device',
  })
  return { desktop, device, d, p, ds: d.accept(p.greeting), ps: p.accept(d.greeting) }
}

describe('Handshake', () => {
  it('agrees on a session both ends can use', () => {
    const { ds, ps } = handshake()
    expect(text(ps.open(ds.seal(H, bytes('down')), 1))).toBe('down')
    expect(text(ds.open(ps.seal(H, bytes('up')), 1))).toBe('up')
  })

  it('gives every connection a different key', () => {
    // THE fix. The old channel was static-static: one key for the life of a
    // pairing, with counters that reset to zero on every bridge restart. A relay
    // that recorded a session replayed it verbatim after any restart and the
    // commands re-executed -- and the supervisor tolerates three crashes a
    // minute, so the window was attacker-triggerable, not incidental.
    const a = handshake()
    const b = handshake()
    const frame = a.ds.seal(H, bytes('replay me'))
    expect(() => b.ps.open(frame, 1)).toThrow()
  })

  it('cannot be replayed into a fresh connection between the same two identities', () => {
    // The sharper version of the test above: same desktop, same phone, same
    // identity keys -- only the connection is new. Recorded traffic must still be
    // useless, because the ephemeral half of the key agreement is not in it.
    const desktop = generateIdentity()
    const device = generateIdentity()
    const connect = () => {
      const d = new Handshake({
        ownSecretKey: desktop.secretKey,
        peerPublicKey: device.publicKey,
        role: 'desktop',
      })
      const p = new Handshake({
        ownSecretKey: device.secretKey,
        peerPublicKey: desktop.publicKey,
        role: 'device',
      })
      return { ds: d.accept(p.greeting), ps: p.accept(d.greeting) }
    }
    const recorded = connect().ds.seal(H, bytes('run_command rm -rf /'))
    expect(() => connect().ps.open(recorded, 1)).toThrow()
  })

  it('is not derivable from stolen identity keys plus recorded traffic', () => {
    // Forward secrecy, stated as the adversary it exists to stop: someone who
    // later steals BOTH long-term private keys and has every byte the relay saw.
    //
    // The ephemeral public keys are in the clear -- they are the greeting headers,
    // and they have to be, since each end needs the other's. So if they reached
    // the KDF only as salt, that adversary could recompute every past session key
    // and read months of recorded traffic. Putting the ephemeral DH in the IKM is
    // what makes the stolen identity keys insufficient: the reconstruction below
    // is everything the adversary can reach, and it must not open a real frame.
    const desktop = generateIdentity()
    const device = generateIdentity()
    const d = new Handshake({
      ownSecretKey: desktop.secretKey,
      peerPublicKey: device.publicKey,
      role: 'desktop',
    })
    const p = new Handshake({
      ownSecretKey: device.secretKey,
      peerPublicKey: desktop.publicKey,
      role: 'device',
    })
    const frame = d.accept(p.greeting).seal(H, bytes('secret'))

    const staticDh = x25519.getSharedSecret(fromHex(desktop.secretKey), fromHex(device.publicKey))
    const ikm = new Uint8Array(64)
    ikm.set(staticDh, 0)
    ikm.set(staticDh, 32)
    const [lo, hi] = [d.greeting, p.greeting].map((g) => toHex(g.subarray(1, 33))).sort()
    const root = hkdf(sha256, ikm, sha256(bytes(`${lo}${hi}`)), bytes('termpolis-session-v2'), 32)

    expect(() => SealedSession.fromRoot(root, 'device').open(frame, 1)).toThrow()
  })

  it('refuses a greeting from a third party', () => {
    // The static DH term is the authentication. Someone who does not hold one of
    // the two identity private keys cannot produce an openable greeting.
    const { desktop, device } = handshake()
    const impostor = generateIdentity()
    const d = new Handshake({
      ownSecretKey: desktop.secretKey,
      peerPublicKey: device.publicKey,
      role: 'desktop',
    })
    const x = new Handshake({
      ownSecretKey: impostor.secretKey,
      peerPublicKey: desktop.publicKey,
      role: 'device',
    })
    expect(() => d.accept(x.greeting)).toThrow()
  })

  it('refuses a greeting whose ephemeral key was substituted', () => {
    // Without the header as associated data this is the whole attack: swap in an
    // ephemeral public key you hold the secret for, and the session agrees on a
    // key you know while both users see a handshake that "worked".
    const { desktop, device } = handshake()
    const d = new Handshake({
      ownSecretKey: desktop.secretKey,
      peerPublicKey: device.publicKey,
      role: 'desktop',
    })
    const p = new Handshake({
      ownSecretKey: device.secretKey,
      peerPublicKey: desktop.publicKey,
      role: 'device',
    })
    const forged = Uint8Array.from(p.greeting)
    forged[1] ^= 0xff // first byte of the ephemeral public key, inside the AAD
    expect(() => d.accept(forged)).toThrow()
  })

  it('refuses a frame that is not a greeting', () => {
    const { d, ds } = handshake()
    expect(() => d.accept(ds.seal(H, bytes('not a greeting')))).toThrow(/greeting/)
    expect(() => d.accept(new Uint8Array([FRAME_SESSION_HELLO, 1, 2]))).toThrow(/short/)
  })

  it('refuses its own greeting reflected back at it', () => {
    // A relay is positioned to echo. Reflection has to fail at the crypto rather
    // than be caught by a role check that a rewritten payload could dodge -- so
    // the greeting opens under the peer's direction key, which the sender does
    // not seal with.
    const d = new Handshake({
      ownSecretKey: generateIdentity().secretKey,
      peerPublicKey: generateIdentity().publicKey,
      role: 'desktop',
    })
    expect(() => d.accept(d.greeting)).toThrow()
  })

  it('names the version when a peer speaks a different one', () => {
    // The greeting authenticates fine -- this peer holds a real identity key. It
    // just speaks a protocol this build does not. Saying so is the whole point:
    // without the check, a future payload with renamed fields would be accepted,
    // the session would derive, and the failure would surface somewhere far from
    // its cause. An old phone should read "unsupported protocol version", not
    // "decryption failed".
    const desktop = generateIdentity()
    const device = generateIdentity()
    const d = new Handshake({
      ownSecretKey: desktop.secretKey,
      peerPublicKey: device.publicKey,
      role: 'desktop',
    })
    const greeting = forgeGreeting(device.secretKey, desktop.publicKey, 'device', {
      v: PROTOCOL_VERSION + 97,
      role: 'device',
    })
    expect(() => d.accept(greeting)).toThrow(/unsupported protocol version/)
  })

  it('refuses an authentic greeting that claims its own role', () => {
    // A relay cannot forge this -- it would need an identity key -- but a broken
    // second implementation can. Two ends that both believe they are the desktop
    // seal with the SAME directional key, so every frame each sends decrypts at
    // the other under the key meant for the opposite direction: the reflection
    // wedge, arrived at by agreement rather than by attack.
    const desktop = generateIdentity()
    const device = generateIdentity()
    const d = new Handshake({
      ownSecretKey: desktop.secretKey,
      peerPublicKey: device.publicKey,
      role: 'desktop',
    })
    const greeting = forgeGreeting(device.secretKey, desktop.publicKey, 'device', {
      v: PROTOCOL_VERSION,
      role: 'desktop',
    })
    expect(() => d.accept(greeting)).toThrow(/claims role desktop/)
  })

  it('refuses a greeting that claims the wrong role', () => {
    // Belt and braces over the directional keys: two desktops that somehow met
    // must not agree on a session, and the error should name the reason.
    const a = generateIdentity()
    const b = generateIdentity()
    const one = new Handshake({
      ownSecretKey: a.secretKey,
      peerPublicKey: b.publicKey,
      role: 'desktop',
    })
    const two = new Handshake({
      ownSecretKey: b.secretKey,
      peerPublicKey: a.publicKey,
      role: 'desktop',
    })
    expect(() => one.accept(two.greeting)).toThrow()
  })

  it('separates the two directions', () => {
    // A relay that echoes a peer's frame back at it must fail to open, not wedge
    // the counter. Sealing and opening on the SAME end is exactly that echo.
    const { ds } = handshake()
    const own = ds.seal(H, bytes('mine'))
    expect(() => ds.open(own, 1)).toThrow()
  })

  it('keeps a long conversation in both directions at once', () => {
    // Each direction carries its own counter, so interleaving must not make
    // either end look like a replay to the other.
    const { ds, ps } = handshake()
    for (let i = 0; i < 50; i++) {
      expect(text(ps.open(ds.seal(H, bytes(`down ${i}`)), 1))).toBe(`down ${i}`)
      expect(text(ds.open(ps.seal(H, bytes(`up ${i}`)), 1))).toBe(`up ${i}`)
    }
  })
})

describe('wire format', () => {
  it('matches a pinned golden vector, byte for byte', () => {
    // The phone client is a SECOND implementation of this schedule, in another
    // language runtime, and it has to derive byte-identical frames from identical
    // inputs. Nothing else in this file would catch a change that both ends make
    // together -- swap two HKDF labels, reverse the salt sort, seal with the
    // other direction key, and every test above still passes while every shipped
    // phone stops talking to every shipped desktop.
    //
    // Fixed ephemerals are what make that pinnable; production draws them at
    // random and this is the only caller that does not.
    const desktopSk = '11'.repeat(32)
    const deviceSk = '22'.repeat(32)
    const desktopPk = toHex(x25519.getPublicKey(fromHex(desktopSk)))
    const devicePk = toHex(x25519.getPublicKey(fromHex(deviceSk)))

    const d = new Handshake({
      ownSecretKey: desktopSk,
      peerPublicKey: devicePk,
      role: 'desktop',
      ephemeralSecretKey: '33'.repeat(32),
    })
    const p = new Handshake({
      ownSecretKey: deviceSk,
      peerPublicKey: desktopPk,
      role: 'device',
      ephemeralSecretKey: '44'.repeat(32),
    })

    const frame = d.accept(p.greeting).seal(H, bytes('{"kind":"ok","id":1}'))
    expect(toHex(frame)).toBe(
      '04000000000000bffaf517d1df8789618e3ca2997945eb3c91932ae72c393604c0b18de4c58139fe45ac41',
    )
    // Pinned to a value that is actually the message, not merely a stable digest
    // of the wrong thing.
    expect(text(p.accept(d.greeting).open(frame, 1))).toBe('{"kind":"ok","id":1}')
  })
})

describe('SealedSession', () => {
  it('gives the two roles opposite directions from one root', () => {
    const root = new Uint8Array(32).fill(3)
    const desktop = SealedSession.fromRoot(root, 'desktop')
    const device = SealedSession.fromRoot(root, 'device')
    expect(text(device.open(desktop.seal(H, bytes('hi')), 1))).toBe('hi')
    expect(text(desktop.open(device.seal(H, bytes('yo')), 1))).toBe('yo')
  })

  it('does not open what it sealed itself', () => {
    const root = new Uint8Array(32).fill(3)
    const desktop = SealedSession.fromRoot(root, 'desktop')
    expect(() => desktop.open(desktop.seal(H, bytes('hi')), 1)).toThrow()
  })
})

/** A public key from a fixed secret, so the vector below is reproducible.
 *  `generateIdentity` mints a random secret and cannot pin anything. */
function pub(secretKey: string): string {
  return toHex(x25519.getPublicKey(fromHex(secretKey)))
}

describe('deriveSessionRoomId', () => {
  it('is the same on both ends and hides from everyone else', () => {
    const desktop = generateIdentity()
    const device = generateIdentity()
    const mine = deriveSessionRoomId(desktop.secretKey, device.publicKey)
    const theirs = deriveSessionRoomId(device.secretKey, desktop.publicKey)
    expect(mine).toBe(theirs)
    expect(mine).toMatch(/^[0-9a-f]{32}$/)
  })

  it('matches a frozen vector, so a phone port lands in the same room', () => {
    // A room both ends compute independently is only a room if they compute it
    // IDENTICALLY. Nothing in the protocol announces it, so a React Native port
    // that changed the HKDF label -- or skipped the HKDF and used the raw DH --
    // would not fail a handshake. It would sit in an empty room forever, and the
    // only symptom would be a phone that never connects. This vector is what such
    // a port is checked against; see docs/remote-wire-format.md.
    const a = '11'.repeat(32)
    const b = '22'.repeat(32)
    const A = pub(a)
    const B = pub(b)
    expect(deriveSessionRoomId(a, B)).toBe('c9dc49b87f0dc983be61f034ceab7c52')
    expect(deriveSessionRoomId(b, A)).toBe('c9dc49b87f0dc983be61f034ceab7c52')
  })

  it('differs per pairing', () => {
    // The QR's pairingId is a room NAME, and a name is not a credential: anyone
    // who photographed a QR could squat that room forever and answer the real
    // phone with a 409, with no TTL touching it because the exposure was never
    // the secret. A room only the two parties can compute has no such photograph.
    const desktop = generateIdentity()
    expect(deriveSessionRoomId(desktop.secretKey, generateIdentity().publicKey)).not.toBe(
      deriveSessionRoomId(desktop.secretKey, generateIdentity().publicKey),
    )
  })

  it('is not the handshake key', () => {
    // Same shared secret, different HKDF info. If the labels were ever collapsed
    // the room id -- which the relay sees in the URL -- would BE key material.
    const desktop = generateIdentity()
    const device = generateIdentity()
    const room = deriveSessionRoomId(desktop.secretKey, device.publicKey)
    const root = pairingRoot(desktop.secretKey, device.publicKey, 'p'.repeat(32))
    expect(Buffer.from(root).toString('hex')).not.toContain(room)
  })
})

describe('pairingRoot', () => {
  it('agrees on both ends for the same pairing id', () => {
    const desktop = generateIdentity()
    const device = generateIdentity()
    const id = 'a'.repeat(32)
    expect(Buffer.from(pairingRoot(desktop.secretKey, device.publicKey, id)).toString('hex')).toBe(
      Buffer.from(pairingRoot(device.secretKey, desktop.publicKey, id)).toString('hex'),
    )
  })

  it('binds the pairing id, so a hello is valid in one room only', () => {
    // Without the salt, a hello captured from one pairing offer replays into the
    // next one the same desktop shows -- the identity keys have not changed.
    const desktop = generateIdentity()
    const device = generateIdentity()
    expect(
      Buffer.from(pairingRoot(desktop.secretKey, device.publicKey, 'a'.repeat(32))).toString('hex'),
    ).not.toBe(
      Buffer.from(pairingRoot(desktop.secretKey, device.publicKey, 'b'.repeat(32))).toString('hex'),
    )
  })
})
