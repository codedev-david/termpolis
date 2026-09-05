import { openPairingAck, sealPairingHello } from '../wire/pairing'
import { deriveVerificationPhrase } from '../wire/safetyNumber'
import { FRAME_KEEPALIVE, deriveSessionRoomId } from '../wire/sessionCrypto'
import type { RelayControlFrame } from '../wire/protocol'
import type { QrPayload } from '../wire/qr'
import type { PairedDesktop } from '../storage/identity'
import type { SocketLike } from './relaySocket'

/** Longer than the desktop's 90 s offer TTL would be a phone still hoping for an
 *  answer from a code that has already expired. Shorter than a user can walk back
 *  to their desk. */
export const PAIRING_TIMEOUT_MS = 60_000

/** The QR carries no name for the desktop -- there is nowhere on the wire to put
 *  one -- and the phone pairs with exactly one machine, so the stored label is
 *  decoration until Settings offers a rename. */
export const DEFAULT_DESKTOP_LABEL = 'Termpolis desktop'

const ROOM_ID_RE = /^[0-9a-f]{32}$/

export interface PairingDeps {
  open(url: string): SocketLike
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

export interface PairingOutcome {
  desktop: PairedDesktop
  /** Shown on both screens. The user comparing them is what rules out a relay
   *  that put itself in the middle of this pairing. */
  safetyPhrase: string
}

/**
 * One pairing attempt, from scanned code to a desktop this phone can reach.
 *
 * Lives here rather than in the store because it is socket lifecycle, and because
 * it is the one flow with no second chance: the code is single-use, so an attempt
 * that half-fails costs the user a trip back to their desk.
 *
 * Resolves once or rejects once, and closes its socket either way.
 */
export function pairWithDesktop(opts: {
  offer: QrPayload
  identity: { secretKey: string; publicKey: string }
  /** What this phone will be called in the desktop's device list. */
  label: string
  deps: PairingDeps
}): Promise<PairingOutcome> {
  const { offer, identity, deps } = opts

  // Checked before a socket exists, so a mangled scan is an error at the call
  // site rather than a Durable Object named after the mangling, waited in until
  // the timeout.
  if (!ROOM_ID_RE.test(offer.pairingId)) {
    return Promise.reject(new Error('That pairing code is not readable. Scan it again.'))
  }

  return new Promise<PairingOutcome>((resolve, reject) => {
    const sock = deps.open(`${offer.relayUrl}/v1/pair/${offer.pairingId}?role=device`)
    // Before any handler can fire. React Native defaults to 'blob' and send()
    // coerces a Blob to the literal string "[object Blob]", which would destroy
    // every byte of the hello while leaving the frame count and timing right.
    sock.binaryType = 'arraybuffer'

    let settled = false
    let greeted = false
    const timer = deps.setTimer(() => {
      finish(null, new Error('Pairing timed out. Show the code again and rescan.'))
    }, PAIRING_TIMEOUT_MS)

    function finish(outcome: PairingOutcome | null, err: Error | null): void {
      if (settled) return
      settled = true
      // A live timer holds the JS context awake, and on a phone that keeps the
      // radio from idling long after the screen is off.
      deps.clearTimer(timer)
      sock.onopen = null
      sock.onmessage = null
      sock.onclose = null
      sock.onerror = null
      sock.close()
      if (outcome !== null) resolve(outcome)
      else reject(err ?? new Error('Pairing failed.'))
    }

    /** Send the hello, but only once the desktop is actually in the room.
     *
     *  The relay DROPS a frame sent to a room with no partner rather than queuing
     *  it, so an early hello is not early -- it is gone, and the pairing then
     *  fails for a reason neither screen can explain. */
    function greet(): void {
      if (greeted || settled) return
      greeted = true
      sock.send(
        sealPairingHello({
          deviceSecretKey: identity.secretKey,
          devicePublicKey: identity.publicKey,
          desktopPublicKey: offer.desktopPublicKey,
          pairingId: offer.pairingId,
          label: opts.label,
          oneTimeSecret: offer.oneTimeSecret,
        }),
      )
    }

    sock.onmessage = (event) => {
      const { data } = event
      // Text is the relay speaking for itself; peers speak binary only.
      if (typeof data === 'string') {
        control(data)
        return
      }
      const frame = toBytes(data)
      if (frame === null) return
      // Dropped by tag. The pairing root would refuse a keepalive anyway, but
      // only after a decrypt whose failure looks exactly like a forgery.
      if (frame[0] === FRAME_KEEPALIVE) return

      const ack = openPairingAck({
        frame,
        deviceSecretKey: identity.secretKey,
        desktopPublicKey: offer.desktopPublicKey,
        pairingId: offer.pairingId,
      })
      // A frame that will not open is a forgery, a stray, or an older desktop.
      // None of those is worth abandoning a single-use code for -- the real ack
      // may still be one frame behind it.
      if (ack === null) return

      finish(
        {
          desktop: {
            desktopPublicKey: offer.desktopPublicKey,
            // Derived, never announced: the room this phone will meet the
            // desktop in from now on is not a thing the relay is told.
            sessionRoomId: deriveSessionRoomId(identity.secretKey, offer.desktopPublicKey),
            relayUrl: offer.relayUrl,
            // The desktop's id for this phone, not one computed here: it is the
            // handle the user revokes by, and it must match what they see.
            deviceId: ack.deviceId,
            label: DEFAULT_DESKTOP_LABEL,
            pairedAt: deps.now(),
          },
          safetyPhrase: deriveVerificationPhrase(identity.publicKey, offer.desktopPublicKey),
        },
        null,
      )
    }

    function control(text: string): void {
      let frame: RelayControlFrame
      try {
        frame = JSON.parse(text)
      } catch {
        return
      }
      if (typeof frame !== 'object' || frame === null) return

      switch (frame.kind) {
        case 'hello':
          if (frame.peer) greet()
          return
        case 'peer-joined':
          greet()
          return
        case 'peer-gone':
          // The desktop closed the QR. Unlike a session, there is nothing to wait
          // for: the code it was showing is spent either way.
          finish(null, new Error('The desktop stopped showing that code.'))
          return
        case 'quota-exceeded':
          finish(null, new Error(`The relay refused the connection (${frame.limit}).`))
          return
        default:
          return
      }
    }

    const down = (): void => {
      finish(null, new Error('Lost the connection before the desktop answered.'))
    }
    sock.onclose = down
    sock.onerror = down
  })
}

/** React Native hands up an ArrayBuffer once binaryType is 'arraybuffer'; a Blob
 *  slips through when it is not, and is dropped here rather than mishandled. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}
