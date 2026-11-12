import * as SecureStore from 'expo-secure-store'
import { Platform, Settings } from 'react-native'

import { forgetGrant } from './grant'
import { wipeEverything } from './identity'

/**
 * Two stamps of the same install, kept in two places that die differently.
 *
 * iOS keeps Keychain items after the app is deleted, but deletes the app's
 * NSUserDefaults (React Native's `Settings`) with it. So a reinstalled app finds
 * the Keychain stamp and no defaults stamp, and that combination is how a
 * reinstall is recognised. Its pairings, keys and cached grant are then wiped
 * before anything reads them, so deleting the app really does forget the
 * desktops it was paired with.
 *
 * The Keychain stamp is what keeps an UPDATE safe. A phone updating from 1.1 or
 * 1.2 has no defaults stamp either, but it has no Keychain stamp, because those
 * builds never wrote one. That phone keeps its pairings and is stamped. The cost
 * is that a 1.2 install deleted and replaced by this build keeps its old
 * pairings once; every install from this build on is covered.
 *
 * Paid status does not depend on the wiped grant: the subscription store asks
 * StoreKit on every launch, and the grant is only a cache for when StoreKit
 * cannot answer.
 */
const DEFAULTS_KEY = 'termpolis.remote.install.v1'
const KEYCHAIN_KEY = 'termpolis.remote.install.v1'
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

/** What `settleInstall` found. Returned for tests and logs; the app ignores it. */
export type InstallOutcome = 'kept' | 'fresh' | 'wiped' | 'skipped'

/**
 * Run once at launch, before the pairing store and the subscription store boot.
 *
 * Never throws. Anything it cannot read or write leaves both stamps as they
 * were, so the next launch tries again rather than guessing: a wipe that could
 * not finish is not recorded as done, and a phone whose Keychain is locked is
 * not mistaken for a reinstall.
 *
 * iOS only. Android removes the app's keystore entries with the app.
 */
export async function settleInstall(): Promise<InstallOutcome> {
  if (Platform.OS !== 'ios') return 'skipped'
  try {
    const stamped = (await SecureStore.getItemAsync(KEYCHAIN_KEY)) !== null
    if (Settings.get(DEFAULTS_KEY) === 1) {
      // The defaults stamp survived a launch, so it is on disk: only now is
      // the Keychain stamp written (or rewritten, after a failed write).
      if (!stamped) await SecureStore.setItemAsync(KEYCHAIN_KEY, '1', KEYCHAIN)
      return 'kept'
    }
    if (stamped) {
      await wipeEverything()
      await forgetGrant()
    }
    // The defaults stamp alone. iOS saves NSUserDefaults to disk some time
    // after the write, while a Keychain write is saved at once: written
    // together, a crash or a kill in between would leave the Keychain stamp
    // without the defaults one, and the next launch would take an update for
    // a reinstall and wipe its pairings. The branch above adds the Keychain
    // stamp on the next launch. The cost: an install deleted after its very
    // first launch keeps its pairings once.
    Settings.set({ [DEFAULTS_KEY]: 1 })
    return stamped ? 'wiped' : 'fresh'
  } catch {
    return 'skipped'
  }
}
