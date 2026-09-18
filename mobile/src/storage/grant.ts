import * as SecureStore from 'expo-secure-store'

/** Where the last answer the App Store gave us is kept. */
const GRANT_KEY = 'termpolis.remote.relay-grant.v1'
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

/**
 * The last thing the App Store said about relay access, and when.
 *
 * Not a convenience, and not a source of truth -- StoreKit is. It exists for
 * the launch where StoreKit cannot be asked: a cold start on a plane, a
 * keychain still locked behind Face ID, an Apple outage, a call that times out.
 * Without it the app's answer in all of those is "you have not paid", shown to
 * somebody who has, which is the one-star review this whole feature can
 * produce.
 *
 * Its own module, in `storage/` rather than in the subscription store, so that
 * an erase can destroy it without importing StoreKit. `remoteStore` calls
 * `forgetGrant` from `forgetEverything`, and pulling `expo-iap` into that file
 * would put a native module behind every test in the app that already mocks it.
 */
export interface Grant {
  entitled: boolean
  at: number
}

/**
 * Read the grant back, or null.
 *
 * Anything unrecognised is null rather than repaired. A grant is a claim about
 * money, and a half-understood one should be re-asked -- the cost of getting
 * that wrong is either giving the app away or billing somebody twice.
 */
export async function readGrant(): Promise<Grant | null> {
  try {
    const raw = await SecureStore.getItemAsync(GRANT_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec = parsed as Record<string, unknown>
    if (typeof rec.entitled !== 'boolean' || typeof rec.at !== 'number') return null
    return { entitled: rec.entitled, at: rec.at }
  } catch {
    // A locked keychain, or a value something else wrote. Neither is worth
    // failing a launch over; the App Store is about to be asked anyway.
    return null
  }
}

/**
 * Record what the App Store just said.
 *
 * Failures are swallowed. A grant that could not be cached costs one extra
 * lookup on the next launch; a boot that threw over it costs the whole app.
 */
export async function writeGrant(entitled: boolean): Promise<void> {
  try {
    const grant: Grant = { entitled, at: Date.now() }
    await SecureStore.setItemAsync(GRANT_KEY, JSON.stringify(grant), KEYCHAIN)
  } catch {
    return
  }
}

/**
 * Destroy the cached grant.
 *
 * Part of erasing the app rather than of unpairing: an erase that left a
 * paid-up flag behind would hand whoever holds the phone next a few days of
 * access on somebody else's card.
 */
export async function forgetGrant(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(GRANT_KEY, KEYCHAIN)
  } catch {
    return
  }
}
