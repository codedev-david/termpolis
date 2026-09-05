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
import * as fs from 'fs'
import * as path from 'path'
import { x25519 } from '@noble/curves/ed25519.js'
import { readSecret, writeSecret } from './secureKeyStore'
import { fromHex, generateIdentity, toHex } from './remoteBridge/sealedChannel'

const IDENTITY_FILE = 'remote-identity-key'

export interface RemoteIdentity {
  /** X25519 private key, 64 hex chars. Never leaves main except into the bridge. */
  secretKey: string
  /** Derived, not stored. Safe to show the user -- it is half of the safety number. */
  publicKey: string
}

export function remoteIdentityPath(userDataDir: string): string {
  return path.join(userDataDir, IDENTITY_FILE)
}

const isSecretKey = (s: string | null): s is string => /^[0-9a-f]{64}$/.test(s ?? '')

/**
 * The identity for this desktop, minting one on first use.
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
export function getOrCreateRemoteIdentity(userDataDir: string): RemoteIdentity {
  const keyPath = remoteIdentityPath(userDataDir)
  try {
    const existing = readSecret(keyPath)
    if (isSecretKey(existing)) return { secretKey: existing, publicKey: derive(existing) }
  } catch {
    /* unreadable is the same as absent -- mint below */
  }

  const minted = generateIdentity()
  try {
    writeSecret(keyPath, minted.secretKey)
  } catch {
    /* ephemeral for this run; see the doc comment */
  }
  return minted
}

function derive(secretKey: string): string {
  return toHex(x25519.getPublicKey(fromHex(secretKey)))
}

/** Forget this desktop's identity. Every paired device is orphaned by it -- their
 *  session rooms are derived from this key -- so callers must revoke alongside. */
export function clearRemoteIdentity(userDataDir: string): void {
  try {
    fs.rmSync(remoteIdentityPath(userDataDir), { force: true })
  } catch {
    /* already gone */
  }
}
