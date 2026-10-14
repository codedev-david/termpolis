// This desktop's long-term X25519 identity, the key every paired phone
// authenticates against.
//
// Stored through secureKeyStore (Electron safeStorage: DPAPI / Keychain /
// libsecret), so it is encrypted at rest and tied to this OS user -- the same
// treatment the memory key and the Groq key get.
//
// MAIN ONLY, and that is a hard constraint rather than a preference:
// `safeStorage` does not exist in a utilityProcess, so the bridge child can
// neither read an encrypted key (it would see the file as empty and mint a
// second identity every launch) nor write one (it would fall back to plaintext).
// Main resolves the identity and hands the secret to the child in `init`.
import * as path from 'path'
import { x25519 } from '@noble/curves/ed25519.js'
import { createSecretExclusive, inspectSecret, retireSecretFile, type SecretInspection } from './secureKeyStore'
import { fromHex, generateIdentity, toHex } from './remoteBridge/sealedChannel'

const IDENTITY_FILE = 'remote-identity-key'

export interface RemoteIdentity {
  /** X25519 private key, 64 hex chars. Never leaves main except into the bridge. */
  secretKey: string
  /** Derived, not stored. Safe to show the user -- it is half of the safety number. */
  publicKey: string
}

/** Why an identity that is on disk can't be used right now. None of these mean it is gone. */
export type IdentityLockReason = NonNullable<SecretInspection['reason']>

/** The identity, or why it can't be opened now. A result rather than a throw: the Remote status
 *  reads it on every call, and a throw there would turn the pane into an exception. */
export type IdentityResolution =
  | { kind: 'ok'; identity: RemoteIdentity }
  | { kind: 'locked'; reason: IdentityLockReason }

export function remoteIdentityPath(userDataDir: string): string {
  return path.join(userDataDir, IDENTITY_FILE)
}

const isSecretKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

/**
 * The identity for this desktop, minting one on first use -- and never over one that is there.
 *
 * A key file this process can't open right now (the keyring is locked or not running, the keychain
 * refuses the blob or opens it to something that isn't a key, the file won't read) is reported as
 * `locked` and left byte for byte. It used to
 * read as "no identity", and the identity minted in its place orphaned every phone and computer
 * paired with the old one, for good: their rooms are derived from it.
 *
 * The public key is DERIVED on every read rather than stored alongside the
 * secret. A stored pair can disagree with itself -- a half-written file, a hand
 * edit, a restore from another machine -- and a public key that does not match
 * the secret is the worst kind of wrong here: pairing succeeds, the QR shows a
 * key nothing holds, and the phone's handshake fails afterwards with no clue
 * pointing back at the file.
 *
 * A key that fails to persist still yields a usable identity for this run. The
 * user gets remote that works until the app restarts, which is a far better
 * failure than a feature that silently refuses to start.
 */
export function resolveRemoteIdentity(userDataDir: string): IdentityResolution {
  const keyPath = remoteIdentityPath(userDataDir)
  const found = readIdentity(keyPath)
  if (found) return found
  const minted = generateIdentity()
  try {
    // In the clear only where there is no keychain at all; both panes warn about that.
    createSecretExclusive(keyPath, minted.secretKey, { allowPlaintext: true })
  } catch (err) {
    // Written first by someone else: that file is the identity, used as found.
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return readIdentity(keyPath) ?? { kind: 'ok', identity: minted }
    /* ephemeral for this run; see the doc comment */
  }
  return { kind: 'ok', identity: minted }
}

/** What is at the key path: the identity, why it can't be opened now, or null when there is nothing
 *  to keep -- no file, or one in the clear that is not a key. That one is renamed aside, never
 *  deleted, to make room. */
function readIdentity(keyPath: string): IdentityResolution | null {
  const found = inspectSecret(keyPath)
  if (found.state === 'locked') return { kind: 'locked', reason: found.reason as IdentityLockReason }
  if (found.state === 'absent') return null
  if (isSecretKey(found.value)) return { kind: 'ok', identity: { secretKey: found.value, publicKey: derive(found.value) } }
  // Sealed, opened, and not a key: what a keychain other than the one that sealed it can hand back
  // instead of refusing. Kept as it is, like any key that won't open.
  if (found.state === 'encrypted') return { kind: 'locked', reason: 'unwrap-failed' }
  try {
    retireSecretFile(keyPath, 'not-a-key')
  } catch {
    /* still in the way: the mint then finds it there and the identity is ephemeral */
  }
  return null
}

function derive(secretKey: string): string {
  return toHex(x25519.getPublicKey(fromHex(secretKey)))
}
