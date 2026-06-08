// At-rest encryption for synced memory shards.
//
// When the user enables encryption, every shard LINE is independently encrypted
// with AES-256-GCM under a key derived (scrypt) from the user's passphrase + a
// per-store salt. The salt lives in the sync folder (it isn't secret); the
// derived key is cached locally on each device (outside the synced folder), so
// the sync provider (Dropbox/iCloud/…) only ever sees ciphertext while Termpolis
// — holding the passphrase-derived key — reads it normally.
//
// Per-LINE (not whole-file) encryption keeps the append-only model: a new write
// is one encrypted line appended, no rewrite. Plaintext and ciphertext lines are
// both tolerated on read, so enabling/disabling encryption never corrupts a
// store and devices can migrate gradually.
import * as crypto from 'crypto'

const ENC_PREFIX = 'enc:v1:'
// ~16 MiB / tens of ms — a deliberate one-time KDF cost (well under Node's 32 MiB
// scrypt default so we don't need a custom maxmem).
const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16

export function newSalt(): Buffer {
  return crypto.randomBytes(16)
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LEN, SCRYPT)
}

export function isEncryptedLine(line: string): boolean {
  return line.startsWith(ENC_PREFIX)
}

export function encryptLine(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
}

// Returns the plaintext, passes through an unencrypted line unchanged, or null
// when an encrypted line can't be decrypted (wrong key / corruption) — callers
// skip nulls so a wrong passphrase degrades gracefully instead of crashing.
export function decryptLine(key: Buffer, line: string): string | null {
  if (!isEncryptedLine(line)) return line
  try {
    const raw = Buffer.from(line.slice(ENC_PREFIX.length), 'base64')
    const iv = raw.subarray(0, IV_LEN)
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ct = raw.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
