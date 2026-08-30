// headroom/receiptStore.ts
//
// The install identity a savings receipt is signed with.
//
// Two values, generated once and never transmitted: a salt that becomes the receipt's
// `installHash`, and an HMAC key. Both are random — the hash is NOT derived from a
// machine id, username, or MAC address, because a receipt is meant to be pasteable into
// a pull request or an expense justification and a hardware-derived identifier would make
// that an accidental disclosure. Two receipts from the same install match; that is the
// only property the hash is required to have.
//
// The key never leaves the machine, which bounds what the signature proves: it shows a
// receipt has not been edited since it was issued, not that a third party attests to the
// numbers. `verifyReceipt` reports those two cases separately and the rendered receipt
// says so in words.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import { buildPayload, signReceipt, verifyReceipt, type SignedReceipt, type VerifyResult } from './receiptArtifact'
import type { UnifiedTotals } from './unifiedReceipt'

interface Identity {
  salt: string
  key: string
}

let dir: string | null = null
let identity: Identity | null = null

function identityPath(): string {
  return join(dir as string, 'receipt-identity.json')
}

function freshIdentity(): Identity {
  return { salt: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex') }
}

export function initReceiptIdentity(userDataPath: string): void {
  if (!userDataPath || typeof userDataPath !== 'string') throw new Error('initReceiptIdentity: userDataPath required')
  dir = join(userDataPath, 'headroom')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* fall through to the in-memory identity below */
  }
  try {
    if (existsSync(identityPath())) {
      const parsed = JSON.parse(readFileSync(identityPath(), 'utf8')) as Partial<Identity>
      if (typeof parsed.salt === 'string' && typeof parsed.key === 'string' && parsed.salt && parsed.key) {
        identity = { salt: parsed.salt, key: parsed.key }
        return
      }
    }
  } catch {
    /* regenerate below — a receipt signed with a lost key simply stops verifying, which
       `verifyReceipt` reports honestly rather than treating as tampering */
  }
  identity = freshIdentity()
  try {
    writeFileSync(identityPath(), JSON.stringify(identity), 'utf8')
  } catch {
    /* an unwritable dir means a new identity each launch; receipts still sign and
       self-verify within a session */
  }
}

function ensure(): Identity {
  if (!identity) identity = freshIdentity()
  return identity
}

export function installHash(): string {
  return createHash('sha256').update(ensure().salt).digest('hex').slice(0, 16)
}

export function issueReceipt(totals: UnifiedTotals, now: number): SignedReceipt {
  const payload = buildPayload(totals, { installHash: installHash(), now })
  return signReceipt(payload, ensure().key)
}

/** Verify a receipt issued by THIS install. A receipt from another machine verifies
 *  `consistent` only — see receiptArtifact.verifyReceipt. */
export function checkReceipt(receipt: SignedReceipt, sameInstall = true): VerifyResult {
  return sameInstall && receipt.payload?.installHash === installHash()
    ? verifyReceipt(receipt, ensure().key)
    : verifyReceipt(receipt)
}

/** Tests only. */
export function resetReceiptIdentity(): void {
  dir = null
  identity = null
}
