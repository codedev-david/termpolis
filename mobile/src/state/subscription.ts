import {
  ErrorCode,
  finishTransaction,
  getActiveSubscriptions,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap'
import type { ActiveSubscription, Purchase } from 'expo-iap'
import { Platform } from 'react-native'
import { create } from 'zustand'

import { readGrant, writeGrant } from '../storage/grant'

import { fetchRelayProduct } from './subscriptionCatalog'

/** The App Store product, and it really is called `002`.
 *
 *  Not a placeholder, not a typo, and NOT to be tidied into something that
 *  reads better. It is what the subscription was created as in App Store
 *  Connect, and an auto-renewable subscription cannot be renamed OR deleted
 *  once it exists -- the only way to a nicer id is a second subscription and an
 *  abandoned first one, which was considered and declined. A product id is
 *  never shown to a customer; it appears in financial reports, refund requests
 *  and any server-side lookup, and this one is ugly in exactly those places and
 *  nowhere else.
 *
 *  It must match App Store Connect character for character. A mismatch is
 *  silent: `fetchProducts` returns nothing, the paywall falls back to wording
 *  with no price in it, and the buy button fails against a product the store
 *  has never heard of. */
export const PRODUCT_ID = '002'

/** How long a cached grant is honoured when the App Store cannot be reached.
 *
 *  Three days. Long enough to cover a flight, a bad week of signal or an Apple
 *  outage; short enough that a cancelled subscription cannot be ridden
 *  indefinitely by staying offline. The cache only ever survives a FAILURE to
 *  ask -- an answer of "no longer subscribed" overwrites it immediately. */
export const GRACE_MS = 3 * 24 * 60 * 60 * 1000

/** The longest the app waits for the App Store before deciding without it.
 *
 *  The shell shows nothing at all while the entitlement is undecided, so a
 *  StoreKit call that never returns is an app stuck on its splash screen --
 *  which is worse than either answer. Eight seconds, then the cached grant
 *  decides; with no cache that means the paywall, and Restore is on it. */
export const STORE_TIMEOUT_MS = 8_000

/** Run `work`, or reject once `ms` has passed.
 *
 *  The timer is always cleared, so the losing promise cannot reject into
 *  nothing after the race is over -- an unhandled rejection that React Native
 *  reports as a red box some seconds after a screen the user is already done
 *  with. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('store-timeout')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What the phone believes about relay access.
 *
 * `unknown` is not a spinner state, it is a REFUSAL to decide. The shell renders
 * neither the app nor the paywall while it holds, because both wrong answers are
 * expensive: showing the terminals to someone who has not paid gives the product
 * away, and showing a paywall to someone who has pays them back in a refund.
 */
export type Entitlement = 'unknown' | 'active' | 'none'

export interface SubscriptionState {
  /** What relay access the phone is entitled to. See `Entitlement`. */
  entitlement: Entitlement
  /** The price as the App Store formats it for this storefront -- "$4.99",
   *  "£4.49", "¥800". Never built from a number here: the store knows the
   *  customer's currency, tax and region, and a price printed by the app that
   *  disagrees with the one on the sheet is a rejection under 3.1.2. */
  price: string | null
  /** The introductory offer in the store's own words, or null when this Apple
   *  ID has already used it. Apple requires the terms be stated before purchase
   *  -- and requires they not be promised to somebody ineligible. */
  intro: string | null
  /** A purchase or restore is in flight. The buttons go quiet rather than
   *  disappear: a paywall whose button vanishes mid-tap looks broken. */
  busy: boolean
  /** What went wrong, for the banner. Cancelling is not an error and never
   *  lands here -- a message shown after somebody deliberately dismissed the
   *  sheet reads as an accusation. */
  error: string | null

  /** Ask the App Store what this Apple ID owns, and what the product costs. */
  boot(): Promise<void>
  /** Open the purchase sheet. Resolves when the sheet closes, NOT when the
   *  purchase completes -- the listener owns that. */
  buy(): Promise<void>
  /** Re-check with the App Store. Apple requires this control exist on any
   *  screen that sells a subscription (3.1.1): a customer restoring onto a new
   *  phone has no other way in.
   *
   *  Never rejects. Every outcome it has -- found, not found, store unreachable
   *  -- ends on `entitlement` or `error`, which is what lets the already-owned
   *  branch of the purchase-error handler start it and walk away. */
  restore(): Promise<void>
  /** Dismiss the banner. */
  clearError(): void
}

/** The listener handles, kept outside the store because they are not renderable
 *  and must be removed exactly once. Same split as `remoteStore`: state React
 *  reads goes in the store, handles do not. */
let purchased: { remove: () => void } | null = null
let failed: { remove: () => void } | null = null

/** Whether a set of active subscriptions includes ours.
 *
 *  Matched on `productId` rather than on the array being non-empty: the same
 *  Apple ID may hold other subscriptions one day, and "owns something" is not
 *  "owns this". */
function grantsRelay(subs: ActiveSubscription[]): boolean {
  return subs.some((s) => s.productId === PRODUCT_ID && s.isActive)
}

export const useSubscription = create<SubscriptionState>((set, get) => {
  /** Apply an answer from the App Store: the state, and the cache behind it. */
  async function settle(entitled: boolean): Promise<void> {
    set({ entitlement: entitled ? 'active' : 'none' })
    await writeGrant(entitled)
  }

  /** Connect, attach the listeners, and ask what this Apple ID owns.
   *
   *  One function so the whole exchange can be raced against a timeout as a
   *  unit -- connecting, listening and asking are all steps that can hang, and
   *  a deadline on only the last of them is not a deadline. */
  async function ask(): Promise<void> {
    await initConnection()
    // Attached once, here, and they outlive every screen. A purchase can
    // arrive long after the sheet closed -- Ask to Buy, a card that needed a
    // second attempt, an interrupted upgrade -- and a listener attached by the
    // paywall would miss exactly those.
    purchased ??= purchaseUpdatedListener((purchase: Purchase) => {
      void onPurchase(purchase)
    })
    // The listener hands over a `code` that is OPTIONAL -- a StoreKit failure
    // the library could not map to one of its own codes arrives with it
    // missing. `onPurchaseError` is typed for that rather than against it, so
    // the unmapped case falls through to the plain "did not go through"
    // message instead of matching whichever comparison `undefined` happens to
    // lose first.
    failed ??= purchaseErrorListener((err) => {
      onPurchaseError(err)
    })
    await settle(grantsRelay(await getActiveSubscriptions([PRODUCT_ID])))
  }

  /** A purchase landed -- from the sheet, from Ask to Buy approved hours later,
   *  or from a restore on another device.
   *
   *  `finishTransaction` is not cleanup and not optional: an unfinished
   *  transaction is re-delivered by StoreKit on every launch, forever, and an
   *  app that never finishes them is one Apple treats as broken. It runs before
   *  access is granted so a throw cannot strand a transaction behind an already
   *  happy screen. */
  async function onPurchase(purchase: Purchase): Promise<void> {
    try {
      await finishTransaction({ purchase, isConsumable: false })
    } catch {
      // Already finished, or finished by StoreKit itself. Not a reason to
      // withhold access from somebody whose money has been taken.
    }
    set({ entitlement: 'active', busy: false, error: null })
    await writeGrant(true)
  }

  /** A purchase failed, or was dismissed.
   *
   *  Cancelling is deliberately silent. Everything else gets one plain sentence
   *  and no error code -- a customer cannot act on a code, and support cannot
   *  read one back down a phone line. */
  function onPurchaseError(err: { code?: ErrorCode }): void {
    if (err.code === ErrorCode.UserCancelled) {
      set({ busy: false })
      return
    }
    if (err.code === ErrorCode.Pending || err.code === ErrorCode.DeferredPayment) {
      // Ask to Buy. The purchase is real and may be approved later, so this is
      // a status and not a failure -- and `onPurchase` fires when it is.
      set({ busy: false, error: 'Waiting for approval. Access starts once it is approved.' })
      return
    }
    if (err.code === ErrorCode.AlreadyOwned) {
      // Bought on another device, or re-tapped through a slow sheet. Restore
      // rather than complain: the customer is right and the app is behind.
      //
      // Started, not awaited, and deliberately without a `.catch`: `restore`
      // settles every path it has, so a catch here would be a line no test can
      // reach -- and an unreachable line is dead code whether or not it looks
      // careful. The `void` is what says the floating promise is intended.
      set({ busy: false })
      void get().restore()
      return
    }
    set({ busy: false, error: 'That purchase did not go through. Nothing has been charged.' })
  }

  return {
    entitlement: 'unknown',
    price: null,
    intro: null,
    busy: false,
    error: null,

    async boot() {
      // Android is not selling this yet: there is no base plan in Play Console,
      // so a paywall there would be a locked door with no handle -- and it
      // would strand the closed test that Play's production timeline depends
      // on. Android gets its own product in a later version, not a gate it
      // cannot pass.
      if (Platform.OS !== 'ios') {
        set({ entitlement: 'active' })
        return
      }

      // Seeded from the cache first. Whatever the store says overwrites this in
      // a moment; what it buys is that a launch which never gets an answer
      // still shows a paying customer their terminals.
      const cached = await readGrant()
      if (cached !== null && cached.entitled && Date.now() - cached.at < GRACE_MS) {
        set({ entitlement: 'active' })
      }

      try {
        await withTimeout(ask(), STORE_TIMEOUT_MS)
      } catch {
        // No answer. Keep whatever the cache seeded and say nothing -- an error
        // banner on a screen nobody asked to see is noise. Only an entitlement
        // still undecided has to fall somewhere, and it falls to the paywall.
        if (get().entitlement === 'unknown') set({ entitlement: 'none' })
      }

      // Last, and outside the try: the price is decoration on a decision that
      // has already been made, and a catalogue lookup that fails must not cost
      // somebody their entitlement. `fetchRelayProduct` never throws.
      const product = await fetchRelayProduct(PRODUCT_ID)
      if (product !== null) set({ price: product.price, intro: product.intro })
    },

    async buy() {
      if (get().busy) return
      set({ busy: true, error: null })
      try {
        await requestPurchase({
          type: 'subs',
          request: { apple: { sku: PRODUCT_ID }, google: { skus: [PRODUCT_ID] } },
        })
      } catch {
        // The sheet failing to OPEN. A purchase that opens and then fails
        // arrives at the error listener instead, which owns that message.
        set({ busy: false, error: 'The App Store could not be reached. Try again in a moment.' })
      }
      // No `finally`. On a successful request the sheet is still up and the
      // listener decides when the wait is over; clearing `busy` here would
      // re-enable the buy button underneath an open purchase sheet.
    },

    async restore() {
      if (get().busy) return
      set({ busy: true, error: null })
      try {
        const ok = grantsRelay(await getActiveSubscriptions([PRODUCT_ID]))
        await settle(ok)
        if (!ok) set({ error: 'No subscription was found for this Apple ID.' })
      } catch {
        set({ error: 'The App Store could not be reached. Try again in a moment.' })
      } finally {
        set({ busy: false })
      }
    },

    clearError() {
      set({ error: null })
    },
  }
})

/** Drop the listeners and reset the store.
 *
 *  The one place that undoes `boot`, so neither a test nor a sign-out can leave
 *  a listener attached to state that has moved on underneath it. */
export function teardownSubscription(): void {
  purchased?.remove()
  failed?.remove()
  purchased = null
  failed = null
  useSubscription.setState({
    entitlement: 'unknown',
    price: null,
    intro: null,
    busy: false,
    error: null,
  })
}
