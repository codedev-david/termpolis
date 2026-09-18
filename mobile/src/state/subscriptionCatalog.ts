import { fetchProducts } from 'expo-iap'

/**
 * What the paywall is allowed to say about the product.
 *
 * Both fields come from the App Store and neither is ever composed here. Apple
 * reviews a paywall against the sheet the customer will actually see, and the
 * app has no idea what that sheet says: the price depends on the storefront,
 * the tax, the currency and any regional adjustment, and eligibility for the
 * introductory offer depends on what this Apple ID has already used -- a fact
 * only the store holds. Printing "$4.99" or "first week free" from a constant is
 * how an app promises a stranger in Japan something it cannot deliver.
 */
export interface RelayProduct {
  /** The price, formatted by the store for this storefront. */
  price: string
  /** The introductory offer in words, or null when this Apple ID cannot have
   *  it. Null is the common case for anyone who has subscribed before. */
  intro: string | null
}

/** The plural of a unit, for "1 week free" against "2 weeks free". */
function plural(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`
}

/**
 * The introductory offer, in a sentence, or null when there isn't one.
 *
 * Exported so it can be tested against the shapes StoreKit really returns --
 * an offer that has run out, one denominated in days, one that is a discount
 * rather than a trial -- without a mock of the whole store for each. The
 * alternative is a private function whose branches are only reachable by
 * building elaborate fake catalogues, which tests the mock rather than the
 * wording.
 *
 * Read off `Record<string, unknown>` rather than `ProductSubscriptionIOS`
 * because that is genuinely what arrives: `fetchProducts` is typed as a union
 * of three array shapes across two platforms, and narrowing it by hand would be
 * a cast that stops meaning anything the first time the library adds a field.
 */
export function describeIntro(rec: Record<string, unknown>, price: string): string | null {
  const mode = rec.introductoryPricePaymentModeIOS
  // 'empty' is how StoreKit says "no offer, or not eligible for one". It is a
  // string rather than an absence, so it has to be excluded by name.
  if (typeof mode !== 'string' || mode === 'empty') return null

  if (mode === 'free-trial') {
    const unit = rec.introductoryPriceSubscriptionPeriodIOS
    const periods = Number(rec.introductoryPriceNumberOfPeriodsIOS)
    if (typeof unit !== 'string' || unit === 'empty') return null
    if (!Number.isFinite(periods) || periods < 1) return null
    return `${plural(periods, unit)} free, then ${price} a month`
  }

  // A paid introductory price -- a discounted first month, or a one-off up
  // front. Not what is on sale today, but an offer the store may start
  // returning the moment one is configured in App Store Connect, and a paywall
  // that silently ignored it would be advertising the wrong price.
  const intro = rec.introductoryPriceIOS
  if (typeof intro !== 'string' || intro === '') return null
  return `${intro} to start, then ${price} a month`
}

/**
 * Look up the one product this app sells.
 *
 * Never throws. The price is decoration on a decision the entitlement check has
 * already made, and a catalogue lookup that failed must not be able to cost
 * somebody access they have paid for -- so every failure here is a null, and
 * the paywall falls back to wording that names no figure at all.
 */
export async function fetchRelayProduct(sku: string): Promise<RelayProduct | null> {
  try {
    // Widened to `unknown[]` deliberately. `fetchProducts` is declared as a
    // union of four product shapes across two platforms, none of which carries
    // an index signature, so every field below would otherwise need the union
    // narrowed by hand -- a cast that stops meaning anything the first time the
    // library adds a platform. The guards underneath are the real check, and
    // they hold whatever the shape turns out to be.
    const products: unknown = await fetchProducts({ skus: [sku], type: 'subs' })
    if (!Array.isArray(products)) return null
    const match = (products as unknown[]).find(
      (p): p is Record<string, unknown> =>
        typeof p === 'object' && p !== null && (p as Record<string, unknown>).id === sku,
    )
    if (match === undefined) return null
    const price = match.displayPrice
    if (typeof price !== 'string' || price === '') return null
    return { price, intro: describeIntro(match, price) }
  } catch {
    return null
  }
}
