import type { PairedDesktop } from '../storage/identity'

/**
 * When the newest pairing was made, or 0 when there are none.
 *
 * What "a pairing just happened" is measured by, so the safety words can be put
 * in front of the user exactly then. A count would miss re-pairing a desktop
 * that is already in the list: that mints a fresh key for it, and therefore
 * fresh safety words, which have to be compared like any other -- a
 * verification skipped because the desktop's name was already on the list is a
 * verification not done.
 *
 * Zero rather than -Infinity for the empty case, so a seeded value can be
 * compared against it without a special case at the call site.
 *
 * Its own module rather than a member of the store, because the two screens
 * that ask the question -- the shell deciding whether to show the words, and
 * the pair screen deciding whether the code was spent -- both mock the store
 * wholesale in their tests. A helper reached through that mock would be a
 * second copy of this rule, free to drift from the one the app runs.
 */
export function pairingStamp(pairings: PairedDesktop[]): number {
  let newest = 0
  for (const p of pairings) {
    if (p.pairedAt > newest) newest = p.pairedAt
  }
  return newest
}
