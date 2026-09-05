import * as SecureStore from 'expo-secure-store'
import { generateIdentity, publicKeyFor } from '../wire/sessionCrypto'

/** Versioned so a future format change is a fresh pairing rather than a phone
 *  that reads an old record as a new one and fails every handshake. */
const IDENTITY_KEY = 'termpolis.remote.identity.v1'
const PAIRED_KEY = 'termpolis.remote.paired.v1'

/** Everything written here is the phone's authority or the address of a live
 *  connection to someone's desktop, so none of it belongs in a cloud backup.
 *
 *  `THIS_DEVICE_ONLY` is the load-bearing half. Without it a restored iCloud
 *  keychain produces a second handset holding the same private key -- two devices
 *  the desktop cannot tell apart, where revoking one does not revoke the other. */
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

const SECRET_KEY_RE = /^[0-9a-f]{64}$/
const ROOM_ID_RE = /^[0-9a-f]{32}$/
const DEVICE_ID_RE = /^[0-9a-f]{16}$/

export interface Identity {
  secretKey: string
  publicKey: string
}

export interface PairedDesktop {
  desktopPublicKey: string
  /** Derived from the two identity keys and never announced. */
  sessionRoomId: string
  relayUrl: string
  /** What the desktop calls this phone in its device list. */
  deviceId: string
  /** What this phone calls that desktop, for the screen. */
  label: string
  pairedAt: number
}

/** Read a key, treating a keystore that refuses as an empty one.
 *
 *  SecureStore throws on a locked keychain, and both callers run at launch --
 *  before any screen exists to catch it. Null means the pair screen; a throw
 *  means an app that will not start. */
async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key)
  } catch {
    return null
  }
}

/** This phone's long-term keypair, minted on first use.
 *
 *  The private key IS the phone's authority: whoever holds it is the paired
 *  device. Minting a second one silently unpairs the handset -- the desktop still
 *  trusts a key the phone no longer has, and nothing tells the user -- so a
 *  stored key is only replaced when it is unusable. */
export async function loadIdentity(): Promise<Identity> {
  const raw = await read(IDENTITY_KEY)
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      const secretKey = (parsed as { secretKey?: unknown } | null)?.secretKey
      // A truncated key is not a key. Trusting one produces a phone that fails
      // every handshake with no explanation available anywhere in the UI.
      if (typeof secretKey === 'string' && SECRET_KEY_RE.test(secretKey)) {
        return { secretKey, publicKey: publicKeyFor(secretKey) }
      }
    } catch {
      // Falls through to minting.
    }
  }

  const identity = generateIdentity()
  // Only the private half is stored. The public key is a pure function of it, and
  // storing both invites them to disagree -- which would be a phone that greets
  // under one identity and is trusted under another.
  await SecureStore.setItemAsync(
    IDENTITY_KEY,
    JSON.stringify({ secretKey: identity.secretKey }),
    KEYCHAIN,
  )
  return identity
}

export async function loadPaired(): Promise<PairedDesktop | null> {
  const raw = await read(PAIRED_KEY)
  if (raw === null) return null
  try {
    return validatePaired(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function savePaired(desktop: PairedDesktop): Promise<void> {
  // Written field by field rather than as the caller's object, so a value that
  // picked up an extra property -- the one-time secret above all -- cannot ride
  // along into the keystore. Wire format section 7.5 requires that secret be
  // discarded the moment the hello is sealed.
  const record: PairedDesktop = {
    desktopPublicKey: desktop.desktopPublicKey,
    sessionRoomId: desktop.sessionRoomId,
    relayUrl: desktop.relayUrl,
    deviceId: desktop.deviceId,
    label: desktop.label,
    pairedAt: desktop.pairedAt,
  }
  await SecureStore.setItemAsync(PAIRED_KEY, JSON.stringify(record), KEYCHAIN)
}

/** Forget the desktop, keep the identity.
 *
 *  Re-pairing then arrives at the desktop as the same device rather than as a
 *  second entry the user has to reason about. */
export async function clearPaired(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_KEY)
}

/** Forget everything. Only the explicit "forget this phone" path calls this. */
export async function wipeIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_KEY)
  await SecureStore.deleteItemAsync(IDENTITY_KEY)
}

function validatePaired(value: unknown): PairedDesktop | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (typeof r.desktopPublicKey !== 'string' || !SECRET_KEY_RE.test(r.desktopPublicKey)) return null
  if (typeof r.sessionRoomId !== 'string' || !ROOM_ID_RE.test(r.sessionRoomId)) return null
  if (typeof r.relayUrl !== 'string' || r.relayUrl.length === 0) return null
  if (typeof r.deviceId !== 'string' || !DEVICE_ID_RE.test(r.deviceId)) return null
  if (typeof r.label !== 'string') return null
  if (typeof r.pairedAt !== 'number' || !Number.isFinite(r.pairedAt)) return null
  return {
    desktopPublicKey: r.desktopPublicKey,
    sessionRoomId: r.sessionRoomId,
    relayUrl: r.relayUrl,
    deviceId: r.deviceId,
    label: r.label,
    pairedAt: r.pairedAt,
  }
}
