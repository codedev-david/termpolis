import { sha256 } from '@noble/hashes/sha2.js'
import { utf8Encode } from './bytes'
import { SAFETY_WORDS } from './wordlist'

/** Eight words: 64 bits of the digest, which is the security of the comparison.
 *
 *  One digest byte per word, no modulo -- SAFETY_WORDS holds exactly 256
 *  entries, so every byte maps to a distinct word and the mapping is uniform by
 *  construction.
 */
export const PHRASE_WORDS = 8

/**
 * Signal-style safety numbers, byte-identical to the desktop's.
 *
 * Both ends render this and the user confirms the words match, which is what
 * stops a malicious relay from MITM-ing the pairing handshake. Sorting the keys
 * makes it order-independent, so both sides derive the same phrase without
 * agreeing on who is who -- neither end can know that.
 *
 * A phrase that differs from the desktop's is worse than no phrase at all: the
 * user compares, sees a mismatch, and reads an attack that is not happening.
 * `deriveVerificationPhrase` is therefore pinned to the golden vector in
 * `docs/remote-wire-format.md` §12 on both sides.
 */
export function deriveVerificationPhrase(aPublicKey: string, bPublicKey: string): string {
  const [lo, hi] = [aPublicKey, bPublicKey].sort()
  const digest = sha256(utf8Encode(`${lo}:${hi}`))
  return Array.from({ length: PHRASE_WORDS }, (_, i) => SAFETY_WORDS[digest[i] as number]).join(' ')
}
