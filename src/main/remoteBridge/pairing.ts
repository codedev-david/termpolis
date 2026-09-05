import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { deriveVerificationPhrase } from './sealedChannel'
import { deriveSessionRoomId } from './sessionCrypto'
import { NO_CAPABILITIES, type PairedDevice } from './protocol'

const DEFAULT_TTL_MS = 90_000

export interface PairingOffer {
  pairingId: string
  oneTimeSecret: string
  qrPayload: string
  expiresAt: number
}

export function createPairingOffer(opts: {
  relayUrl: string
  desktopPublicKey: string
  now?: number
  ttlMs?: number
}): PairingOffer {
  const now = opts.now ?? Date.now()
  const pairingId = randomBytes(16).toString('hex')
  const oneTimeSecret = randomBytes(32).toString('hex')
  const expiresAt = now + (opts.ttlMs ?? DEFAULT_TTL_MS)
  return {
    pairingId,
    oneTimeSecret,
    expiresAt,
    qrPayload: JSON.stringify({
      v: 1,
      relayUrl: opts.relayUrl,
      pairingId,
      desktopPublicKey: opts.desktopPublicKey,
      oneTimeSecret,
    }),
  }
}

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * One pairing attempt. Single-use and time-boxed: a QR left on screen is a
 * credential, so it stops being one the moment it is used or expires.
 */
export class PairingSession {
  private used = false

  constructor(
    private readonly offer: PairingOffer,
    private readonly desktopPublicKey: string,
    /** The desktop's identity SECRET key.
     *
     *  Needed because the session room is a Diffie-Hellman over the two identities
     *  rather than a value anyone hands out. The public key alone cannot compute
     *  it -- which is exactly why the room name survives a photographed QR. */
    private readonly desktopSecretKey: string,
  ) {}

  accept(input: {
    oneTimeSecret: string
    devicePublicKey: string
    label: string
    now?: number
  }): { device: PairedDevice; verificationPhrase: string } {
    const now = input.now ?? Date.now()
    if (this.used) throw new Error('pairing offer already used')
    if (now > this.offer.expiresAt) throw new Error('pairing offer expired')
    if (!secretsMatch(input.oneTimeSecret, this.offer.oneTimeSecret)) {
      throw new Error('pairing secret mismatch')
    }
    this.used = true

    const device: PairedDevice = {
      id: createHash('sha256').update(input.devicePublicKey).digest('hex').slice(0, 16),
      label: input.label,
      publicKey: input.devicePublicKey,
      sessionRoomId: deriveSessionRoomId(this.desktopSecretKey, input.devicePublicKey),
      capabilities: { ...NO_CAPABILITIES },
      pairedAt: now,
      lastSeenAt: now,
    }

    return {
      device,
      verificationPhrase: deriveVerificationPhrase(this.desktopPublicKey, input.devicePublicKey),
    }
  }
}
