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
import * as path from 'path'
import * as crypto from 'crypto'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only in Electron: the store it picked ('basic_text' when it found no keyring). */
  getSelectedStorageBackend?(): string
}

const OSK_PREFIX = 'osk:v1:' // marks an OS-keychain-encrypted blob vs a legacy plaintext value

let impl: SafeStorageLike | null = null
let backend: string | null = null

/** Wire up the OS keychain. Pass Electron's `safeStorage` in production; a fake
 *  (or null) in tests. Stored only if encryption is actually available. */
export function setSafeStorage(s: SafeStorageLike | null): void {
  try {
    impl = s && s.isEncryptionAvailable() ? s : null
  } catch {
    impl = null
  }
  // Small print only: whether keys are wrapped is decided by `impl` above, never by this name.
  // Asked once, here, inside `whenReady` -- before ready Electron can only answer 'unknown'.
  try {
    backend = s?.getSelectedStorageBackend?.() || null
  } catch {
    backend = null
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

/** Where a new secret would be kept: wrapped by the OS keychain, or in the clear. */
export function keyStorageMode(): 'keychain' | 'plaintext' {
  return impl ? 'keychain' : 'plaintext'
}

/** Electron's own name for the key store it uses -- Linux only ('basic_text', 'gnome_libsecret',
 *  'kwallet6', ...), null elsewhere. Diagnostic text beside a plaintext warning, never a decision. */
export function keyStorageBackend(): string | null {
  return backend
}

// ── Key files: inspect, create exclusively, retire. Never overwrite, never delete. ────────────────
//
// writeSecret REPLACES whatever is at the path, and readSecret answers null both for "no file" and for
// "a file this process can't open right now". For a key that encrypts data, those are opposite facts.
// A blob the keychain refuses today (keyring not unlocked yet, a DPAPI hiccup after a password reset)
// is still the only thing that opens everything written under it, so minting a replacement over it
// makes that data unreadable for good. The verbs below keep the two facts apart and cannot destroy a
// key: inspect reports which case it is, create refuses to touch an existing file, retire renames a
// key aside and proves the bytes survived, and wrap replaces a file only with the same secret, sealed.

export type SecretState = 'absent' | 'plaintext' | 'encrypted' | 'locked'

export interface SecretInspection {
  state: SecretState
  /** The secret itself, for 'plaintext' and 'encrypted'. */
  value?: string
  /** Why a 'locked' file can't be opened now. None of these mean the secret is gone. */
  reason?: 'no-keychain' | 'unwrap-failed' | 'unreadable'
}

/** What is at `filePath`, without ever treating "can't open it now" as "nothing there". */
export function inspectSecret(filePath: string): SecretInspection {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8').trim()
  } catch (err) {
    // Only ENOENT means absent. A file the OS won't hand over (locked, permissions, a directory in the
    // way) still exists, and minting over it is the exact failure this function is here to prevent.
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'absent' } : { state: 'locked', reason: 'unreadable' }
  }
  if (!raw.startsWith(OSK_PREFIX)) return { state: 'plaintext', value: raw }
  if (!impl) return { state: 'locked', reason: 'no-keychain' }
  try {
    return { state: 'encrypted', value: impl.decryptString(Buffer.from(raw.slice(OSK_PREFIX.length), 'base64')) }
  } catch {
    return { state: 'locked', reason: 'unwrap-failed' }
  }
}

function alreadyExists(target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path.basename(target)} already exists — refusing to overwrite it`), { code: 'EEXIST' })
}

/** Make a directory entry durable. POSIX needs the directory itself fsync'd after a link or rename;
 *  Windows can't open a directory for that at all, and NTFS journals the rename. Best effort. */
function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  try {
    const fd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch { /* best effort */ }
}

/**
 * Create a secret file that did not exist, and never touch one that did.
 *
 * The bytes go to a temp file first (written, fsync'd), which is then hard-linked to the real name:
 * link is atomic and fails with EEXIST if anything is already there, so even two processes racing to
 * mint cannot clobber each other. Where hard links don't exist (FAT/exFAT, some network shares) it
 * falls back to a rename, made only after checking that the target is still absent.
 *
 * With no OS keychain the secret would land in the clear, so that is refused unless the caller says
 * plaintext is acceptable for this particular secret. Throws an error with code EEXIST when the file
 * already exists, and leaves that file byte-for-byte as it was.
 */
export function createSecretExclusive(filePath: string, secret: string, opts: { allowPlaintext?: boolean } = {}): void {
  if (!impl && !opts.allowPlaintext) {
    throw new Error('no OS keychain — refusing to write a secret in plaintext')
  }
  // Wrap BEFORE touching the disk: a keychain that refuses must leave nothing behind, not a temp file.
  const payload = impl ? OSK_PREFIX + impl.encryptString(secret).toString('base64') : secret
  const tmp = `${filePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'wx')
  try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try {
    try {
      fs.linkSync(tmp, filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') throw alreadyExists(filePath)
      if (fs.existsSync(filePath)) throw alreadyExists(filePath)
      fs.renameSync(tmp, filePath)
    }
  } finally {
    // After a link the temp name is a second link to the same bytes; after a rename it is already gone.
    try { fs.rmSync(tmp, { force: true }) } catch { /* the published name holds the bytes */ }
  }
  fsyncDir(path.dirname(filePath))
  // Read it back the way the next launch will — a plaintext file comes back trimmed, a wrapped one
  // exactly. A wrapped blob that does not open is a key nothing has been encrypted under yet, so it is
  // moved aside rather than left to block the next mint.
  if (inspectSecret(filePath).value !== (impl ? secret : secret.trim())) {
    retireSecretFile(filePath, 'unreadable-after-create')
    throw new Error(`${path.basename(filePath)} was written but could not be read back`)
  }
}

/**
 * Move a secret file aside — to `<name>.retired-<epochMs>` — and prove the bytes survived. Never
 * deletes. A retired key may be the only thing that can still open older data, so it stays on disk
 * for good: the read ring retries every retired key on every launch. Returns the retired path.
 */
export function retireSecretFile(filePath: string, reason: string): string {
  const before = fs.readFileSync(filePath) // throws if there is nothing to retire — the caller decides
  let ts = Date.now()
  let target = `${filePath}.retired-${ts}`
  while (fs.existsSync(target)) target = `${filePath}.retired-${++ts}`
  fs.renameSync(filePath, target)
  fsyncDir(path.dirname(filePath))
  if (!fs.readFileSync(target).equals(before)) {
    throw new Error(`retiring ${path.basename(filePath)} (${reason}): ${path.basename(target)} does not match the original bytes`)
  }
  return target
}

/**
 * Seal a secret that was saved in the clear with the OS keychain, in place -- asked for by the user,
 * never done on the side: once sealed it opens only where the keychain does.
 *
 * The sealed copy is created beside it (exclusively, and read back the way the next launch reads it)
 * and then renamed over the original in one step, so the name never holds anything but a working
 * secret: not nothing, and not half of one. Returns false, touching nothing, when there is nothing to
 * seal -- no file, an empty one, one already sealed, or one this process can't open. Throws with no
 * keychain to seal with, or when the sealed copy can't be put in place, and then the original is
 * exactly as it was.
 */
export function wrapSecretInPlace(filePath: string): boolean {
  const found = inspectSecret(filePath)
  if (found.state !== 'plaintext' || !found.value) return false
  if (!impl) throw new Error('no OS keychain to encrypt it with')
  const sealed = `${filePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.sealed`
  createSecretExclusive(sealed, found.value)
  try {
    fs.renameSync(sealed, filePath)
  } catch (err) {
    try { fs.rmSync(sealed, { force: true }) } catch { /* a sealed copy of what is still in place */ }
    throw err
  }
  fsyncDir(path.dirname(filePath))
  return true
}

/** Every retired copy of `filePath`, newest first. */
export function listRetiredSecrets(filePath: string): string[] {
  const dir = path.dirname(filePath)
  const prefix = path.basename(filePath) + '.retired-'
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
    .map((n) => path.join(dir, n))
}
