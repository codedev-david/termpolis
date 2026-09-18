const mockFetchProducts = jest.fn()

jest.mock('expo-iap', () => ({
  fetchProducts: (...args: unknown[]) => mockFetchProducts(...args),
}))

import { describeIntro, fetchRelayProduct } from '../src/state/subscriptionCatalog'

const SKU = 'com.termpolis.remote.relay.monthly'

/** A subscription as StoreKit hands it over, with a free week on it. */
function product(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SKU,
    displayPrice: '$4.99',
    introductoryPricePaymentModeIOS: 'free-trial',
    introductoryPriceNumberOfPeriodsIOS: '1',
    introductoryPriceSubscriptionPeriodIOS: 'week',
    ...over,
  }
}

beforeEach(() => {
  mockFetchProducts.mockReset()
})

describe('the introductory offer, in words', () => {
  it('names the free period and what follows it', () => {
    expect(describeIntro(product(), '$4.99')).toBe('1 week free, then $4.99 a month')
  })

  it('pluralises a period longer than one', () => {
    const rec = product({ introductoryPriceNumberOfPeriodsIOS: '3' })
    expect(describeIntro(rec, '$4.99')).toBe('3 weeks free, then $4.99 a month')
    // The unit comes from the store too, so the word being pluralised is
    // StoreKit's -- not one this app chose and has to keep in step with
    // whatever is configured in App Store Connect.
    expect(describeIntro({ ...rec, introductoryPriceSubscriptionPeriodIOS: 'day' }, '$4.99')).toBe(
      '3 days free, then $4.99 a month',
    )
  })

  it('offers nothing to an Apple ID that has already used the trial', () => {
    // 'empty' is how StoreKit says "no offer, or not for you". It is a string
    // rather than an absence, so it has to be excluded by name -- and a
    // paywall that promised a free week to somebody ineligible would be
    // advertising something Apple will refuse to sell them.
    expect(describeIntro(product({ introductoryPricePaymentModeIOS: 'empty' }), '$4.99')).toBeNull()
  })

  it('offers nothing when the store sends no payment mode at all', () => {
    expect(describeIntro({ displayPrice: '$4.99' }, '$4.99')).toBeNull()
  })

  it.each([
    ['a period unit of empty', { introductoryPriceSubscriptionPeriodIOS: 'empty' }],
    ['no period unit', { introductoryPriceSubscriptionPeriodIOS: undefined }],
    ['a count that is not a number', { introductoryPriceNumberOfPeriodsIOS: 'lots' }],
    ['a count of zero', { introductoryPriceNumberOfPeriodsIOS: '0' }],
  ])('says nothing rather than something wrong given %s', (_name, over) => {
    // Silence is the safe failure. "0 weeks free" and "NaN weeks free" are
    // both worse than a plain Subscribe button.
    expect(describeIntro(product(over), '$4.99')).toBeNull()
  })

  it('reports a paid introductory price when one is configured instead', () => {
    // Not what is on sale today. It costs two lines to handle, and the day
    // somebody sets up a discounted first month in App Store Connect the
    // paywall would otherwise quietly advertise the full price.
    const rec = product({
      introductoryPricePaymentModeIOS: 'pay-up-front',
      introductoryPriceIOS: '$1.99',
    })
    expect(describeIntro(rec, '$4.99')).toBe('$1.99 to start, then $4.99 a month')
  })

  it.each([
    ['the price is missing', undefined],
    ['the price is blank', ''],
  ])('says nothing about a paid offer when %s', (_name, intro) => {
    const rec = product({
      introductoryPricePaymentModeIOS: 'pay-as-you-go',
      introductoryPriceIOS: intro,
    })
    expect(describeIntro(rec, '$4.99')).toBeNull()
  })
})

describe('looking the product up', () => {
  it('asks the store for subscriptions, by sku', async () => {
    mockFetchProducts.mockResolvedValue([product()])
    await fetchRelayProduct(SKU)
    expect(mockFetchProducts).toHaveBeenCalledWith({ skus: [SKU], type: 'subs' })
  })

  it('returns the price the store formatted, not one this app built', async () => {
    // The store knows the storefront, the currency and the tax. A price the
    // app composed would disagree with the purchase sheet somewhere in the
    // world, which is a 3.1.2 rejection.
    mockFetchProducts.mockResolvedValue([product({ displayPrice: '£4.49' })])
    await expect(fetchRelayProduct(SKU)).resolves.toEqual({
      price: '£4.49',
      intro: '1 week free, then £4.49 a month',
    })
  })

  it('picks its own product out of a catalogue holding others', async () => {
    // "Owns something" is not "owns this", and neither is "the store returned
    // something".
    mockFetchProducts.mockResolvedValue([
      { id: 'com.termpolis.remote.something.else', displayPrice: '$99.99' },
      product(),
    ])
    const found = await fetchRelayProduct(SKU)
    expect(found?.price).toBe('$4.99')
  })

  it('returns nothing when the store has never heard of the product', async () => {
    // What a misconfigured App Store Connect looks like from in here. The
    // paywall falls back to wording with no figure in it rather than showing a
    // price it invented.
    mockFetchProducts.mockResolvedValue([{ id: 'other', displayPrice: '$1.00' }])
    await expect(fetchRelayProduct(SKU)).resolves.toBeNull()
  })

  it.each([
    ['the store answers with nothing at all', null],
    ['the store answers with something that is not a list', { id: SKU }],
  ])('returns nothing when %s', async (_name, answer) => {
    mockFetchProducts.mockResolvedValue(answer)
    await expect(fetchRelayProduct(SKU)).resolves.toBeNull()
  })

  it.each([
    ['an entry that is not an object', 'a string'],
    ['an entry that is null', null],
  ])('steps over %s in the catalogue', async (_name, junk) => {
    mockFetchProducts.mockResolvedValue([junk, product()])
    const found = await fetchRelayProduct(SKU)
    expect(found?.price).toBe('$4.99')
  })

  it.each([
    ['carries no price', { displayPrice: undefined }],
    ['carries a blank price', { displayPrice: '' }],
  ])('returns nothing when the product %s', async (_name, over) => {
    mockFetchProducts.mockResolvedValue([product(over)])
    await expect(fetchRelayProduct(SKU)).resolves.toBeNull()
  })

  it('returns nothing rather than throwing when the store cannot be reached', async () => {
    // The entitlement has already been decided by the time this runs. A
    // catalogue lookup must never be able to cost somebody access they paid
    // for, so it has no failure mode louder than null.
    mockFetchProducts.mockRejectedValue(new Error('offline'))
    await expect(fetchRelayProduct(SKU)).resolves.toBeNull()
  })

  it('reports a price with no offer beside it for a returning subscriber', async () => {
    mockFetchProducts.mockResolvedValue([
      product({ introductoryPricePaymentModeIOS: 'empty' }),
    ])
    await expect(fetchRelayProduct(SKU)).resolves.toEqual({ price: '$4.99', intro: null })
  })
})
