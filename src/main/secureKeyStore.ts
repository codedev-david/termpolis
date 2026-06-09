// OS-keychain-backed storage for the small secret that unlocks synced memory
// (the derived encryption key). Uses Electron's built-in `safeStorage` — DPAPI on
// Windows, Keychain on macOS, libsecret/kwallet on Linux — so the key on disk is
// encrypted by the OS, tied to this user account. A local-disk attacker can no
// longer read the key file.
//
// Critically this uses NO third-party native module (safeStorage is part of
// Electron core), so it ships inside the same single executable and keeps the
// no-native-binary / no-Defender-FP property of the rest of the memory stack.
//
// safeStorage is injected (from index.ts at startup) rather than imported here,
// so this module — and swarmMemory, which consumes it — stay unit-testable
// without an Electron runtime. Where OS encryption is unavailable (e.g. a Linux
// box with no keyring) it falls back to plaintext, preserving the feature with a
// queryable capability flag.
import * as fs from 'fs'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const OSK_PREFIX = 'osk:v1:' // marks an OS-keychain-encrypted blob vs a legacy plaintext value

let impl: SafeStorageLike | null = null

/** Wire up the OS keychain. Pass Electron's `safeStorage` in production; a fake
 *  (or null) in tests. Stored only if encryption is actually available. */
export function setSafeStorage(s: SafeStorageLike | null): void {
  try {
    impl = s && s.isEncryptionAvailable() ? s : null
  } catch {
    impl = null
  }
}

export function isOsEncryptionAvailable(): boolean {
  return impl !== null
}

/** Write a secret, OS-encrypted when available, else plaintext (fallback). */
export function writeSecret(filePath: string, secret: string): void {
  if (impl) {
    const enc = impl.encryptString(secret)
    fs.writeFileSync(filePath, OSK_PREFIX + enc.toString('base64'))
  } else {
    fs.writeFileSync(filePath, secret)
  }
}

/**
 * Read a secret. Transparently decrypts an OS-encrypted blob; returns a legacy
 * plaintext value as-is (so key files written before this change keep working).
 * Returns null if the file is missing, or if it's encrypted but we hold no key
 * to decrypt it here.
 */
export function readSecret(filePath: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return null
  }
  if (!raw) return null
  if (raw.startsWith(OSK_PREFIX)) {
    if (!impl) return null
    try {
      return impl.decryptString(Buffer.from(raw.slice(OSK_PREFIX.length), 'base64'))
    } catch {
      return null
    }
  }
  return raw // legacy plaintext
}
