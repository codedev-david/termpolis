const mockInitConnection = jest.fn()
const mockGetActiveSubscriptions = jest.fn()
const mockRequestPurchase = jest.fn()
const mockFinishTransaction = jest.fn()
const mockFetchRelayProduct = jest.fn()
const mockReadGrant = jest.fn()
const mockWriteGrant = jest.fn()

/** The callbacks the store hands StoreKit, captured so a test can be the
 *  store: a purchase approved an hour later arrives through exactly these. */
let mockOnPurchase: ((purchase: unknown) => void) | null = null
let mockOnError: ((err: unknown) => void) | null = null
const mockAttached: string[] = []
const mockRemoved: string[] = []

let mockPlatform = 'ios'

jest.mock('react-native', () => ({
  Platform: {
    get OS(): string {
      // A getter, because the store reads `Platform.OS` at call time and a
      // plain value captured here would freeze every test onto one platform.
      return mockPlatform
    },
  },
}))

jest.mock('expo-iap', () => ({
  ErrorCode: {
    UserCancelled: 'user-cancelled',
    Pending: 'pending',
    DeferredPayment: 'deferred-payment',
    AlreadyOwned: 'already-owned',
    NetworkError: 'network-error',
  },
  initConnection: (...a: unknown[]) => mockInitConnection(...a),
  getActiveSubscriptions: (...a: unknown[]) => mockGetActiveSubscriptions(...a),
  requestPurchase: (...a: unknown[]) => mockRequestPurchase(...a),
  finishTransaction: (...a: unknown[]) => mockFinishTransaction(...a),
  purchaseUpdatedListener: (cb: (purchase: unknown) => void) => {
    mockOnPurchase = cb
    mockAttached.push('purchased')
    return {
      remove: () => {
        mockRemoved.push('purchased')
      },
    }
  },
  purchaseErrorListener: (cb: (err: unknown) => void) => {
    mockOnError = cb
    mockAttached.push('failed')
    return {
      remove: () => {
        mockRemoved.push('failed')
      },
    }
  },
}))

jest.mock('../src/state/subscriptionCatalog', () => ({
  fetchRelayProduct: (...a: unknown[]) => mockFetchRelayProduct(...a),
}))

jest.mock('../src/storage/grant', () => ({
  readGrant: (...a: unknown[]) => mockReadGrant(...a),
  writeGrant: (...a: unknown[]) => mockWriteGrant(...a),
}))

import {
  GRACE_MS,
  PRODUCT_ID,
  STORE_TIMEOUT_MS,
  teardownSubscription,
  useSubscription,
} from '../src/state/subscription'

const NOW = 1_700_000_000_000

/** An active subscription to this product, as StoreKit reports it. */
const OWNED = [{ productId: PRODUCT_ID, isActive: true }]

function state(): ReturnType<typeof useSubscription.getState> {
  return useSubscription.getState()
}

/** Let the promises the store started settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW)
  mockPlatform = 'ios'
  mockOnPurchase = null
  mockOnError = null
  mockAttached.length = 0
  mockRemoved.length = 0
  for (const fn of [
    mockInitConnection,
    mockGetActiveSubscriptions,
    mockRequestPurchase,
    mockFinishTransaction,
    mockFetchRelayProduct,
    mockReadGrant,
    mockWriteGrant,
  ]) {
    fn.mockReset()
  }
  mockInitConnection.mockResolvedValue(undefined)
  mockGetActiveSubscriptions.mockResolvedValue([])
  mockRequestPurchase.mockResolvedValue(undefined)
  mockFinishTransaction.mockResolvedValue(undefined)
  mockFetchRelayProduct.mockResolvedValue(null)
  mockReadGrant.mockResolvedValue(null)
  mockWriteGrant.mockResolvedValue(undefined)
  teardownSubscription()
})

afterEach(() => {
  jest.useRealTimers()
  teardownSubscription()
  jest.restoreAllMocks()
})

describe('booting -- asking the App Store', () => {
  it('starts undecided, because nothing has been asked yet', () => {
    // Not `none`. A paywall shown before the question was put is one shown to
    // a paying customer on every single launch.
    expect(state().entitlement).toBe('unknown')
  })

  it('grants access to an Apple ID that owns the subscription', async () => {
    mockGetActiveSubscriptions.mockResolvedValue(OWNED)
    await state().boot()
    expect(mockGetActiveSubscriptions).toHaveBeenCalledWith([PRODUCT_ID])
    expect(state().entitlement).toBe('active')
    expect(mockWriteGrant).toHaveBeenCalledWith(true)
  })

  it('refuses one that does not', async () => {
    await state().boot()
    expect(state().entitlement).toBe('none')
    expect(mockWriteGrant).toHaveBeenCalledWith(false)
  })

  it('is not satisfied by a subscription to something else', async () => {
    // "Owns something" is not "owns this". The day there is a second product,
    // a check that only counted the array would hand out relay access with it.
    mockGetActiveSubscriptions.mockResolvedValue([{ productId: 'com.other.thing', isActive: true }])
    await state().boot()
    expect(state().entitlement).toBe('none')
  })

  it('is not satisfied by a lapsed subscription to the right product', async () => {
    mockGetActiveSubscriptions.mockResolvedValue([{ productId: PRODUCT_ID, isActive: false }])
    await state().boot()
    expect(state().entitlement).toBe('none')
  })

  it('reports the price and the offer once the catalogue answers', async () => {
    mockFetchRelayProduct.mockResolvedValue({ price: '$4.99', intro: '1 week free' })
    await state().boot()
    expect(state().price).toBe('$4.99')
    expect(state().intro).toBe('1 week free')
  })

  it('leaves the price unset when the catalogue has nothing to say', async () => {
    // The paywall has wording for this. What it must not have is a number
    // nobody stands behind.
    mockGetActiveSubscriptions.mockResolvedValue(OWNED)
    await state().boot()
    expect(state().price).toBeNull()
    expect(state().intro).toBeNull()
  })
})

describe('booting -- when the App Store cannot be reached', () => {
  it('honours a recent grant rather than billing a paying customer twice', async () => {
    // The flight case. StoreKit usually answers offline; when it does not, the
    // alternative to this cache is a paywall in front of somebody who paid
    // last week.
    mockReadGrant.mockResolvedValue({ entitled: true, at: NOW - 1_000 })
    mockInitConnection.mockRejectedValue(new Error('offline'))
    await state().boot()
    expect(state().entitlement).toBe('active')
  })

  it('stops honouring it once the grace period has run out', async () => {
    // Long enough for a holiday, short enough that cancelling and staying in
    // aeroplane mode is not a business model.
    mockReadGrant.mockResolvedValue({ entitled: true, at: NOW - GRACE_MS - 1 })
    mockInitConnection.mockRejectedValue(new Error('offline'))
    await state().boot()
    expect(state().entitlement).toBe('none')
  })

  it('never turns a cached refusal into access', async () => {
    mockReadGrant.mockResolvedValue({ entitled: false, at: NOW - 1_000 })
    mockInitConnection.mockRejectedValue(new Error('offline'))
    await state().boot()
    expect(state().entitlement).toBe('none')
  })

  it('shows the paywall when there is no cache to fall back on', async () => {
    // Undecided cannot be left standing: the shell renders nothing at all
    // while it holds. Restore is on the screen this falls through to.
    mockInitConnection.mockRejectedValue(new Error('offline'))
    await state().boot()
    expect(state().entitlement).toBe('none')
  })

  it('says nothing on screen about it', async () => {
    // An error banner on a screen nobody asked to see is noise. The paywall
    // itself is the message.
    mockInitConnection.mockRejectedValue(new Error('offline'))
    await state().boot()
    expect(state().error).toBeNull()
  })

  it('lets a cancellation overwrite a cached grant on the first launch that connects', async () => {
    mockReadGrant.mockResolvedValue({ entitled: true, at: NOW - 1_000 })
    await state().boot()
    expect(state().entitlement).toBe('none')
  })

  it('still looks the price up after a failed entitlement check', async () => {
    // Two separate questions. Somebody looking at the paywall because StoreKit
    // was unreachable a second ago should still see what it costs.
    mockInitConnection.mockRejectedValue(new Error('offline'))
    mockFetchRelayProduct.mockResolvedValue({ price: '$4.99', intro: null })
    await state().boot()
    expect(state().price).toBe('$4.99')
  })

  it('gives up on a call that never returns rather than hanging the app', async () => {
    // The worst failure this feature has: the shell shows nothing while the
    // entitlement is undecided, so a StoreKit call that neither resolves nor
    // rejects is a permanent splash screen.
    jest.useFakeTimers()
    mockInitConnection.mockReturnValue(new Promise(() => undefined))
    const booting = state().boot()
    await Promise.resolve()
    expect(state().entitlement).toBe('unknown')
    jest.advanceTimersByTime(STORE_TIMEOUT_MS)
    await booting
    expect(state().entitlement).toBe('none')
    jest.useRealTimers()
  })
})

describe('booting -- on Android', () => {
  it('does not gate a store that is not selling the subscription yet', async () => {
    // There is no base plan in Play Console, so a paywall on Android would be
    // a locked door with no handle -- and it would strand the closed test that
    // Play's own production timeline depends on.
    mockPlatform = 'android'
    await state().boot()
    expect(state().entitlement).toBe('active')
    expect(mockInitConnection).not.toHaveBeenCalled()
  })
})

describe('buying', () => {
  it('asks for the subscription, by sku, as a subscription', async () => {
    // `type: 'subs'` is not decoration. Requested as a one-off purchase, a
    // renewing product fails at the sheet.
    await state().buy()
    expect(mockRequestPurchase).toHaveBeenCalledWith({
      type: 'subs',
      request: { apple: { sku: PRODUCT_ID }, google: { skus: [PRODUCT_ID] } },
    })
  })

  it('stays busy while the purchase sheet is up', async () => {
    // Clearing `busy` when the request resolves would re-enable the buy button
    // underneath an open sheet. The listener owns the end of the wait.
    let release = (): void => undefined
    mockRequestPurchase.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    void state().buy()
    await settle()
    expect(state().busy).toBe(true)
    release()
    await settle()
    expect(state().busy).toBe(true)
  })

  it('refuses a second tap while the first is still open', async () => {
    let release = (): void => undefined
    mockRequestPurchase.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    void state().buy()
    await settle()
    await state().buy()
    expect(mockRequestPurchase).toHaveBeenCalledTimes(1)
    release()
  })

  it('clears a stale error before opening the sheet', async () => {
    useSubscription.setState({ error: 'something from last time' })
    await state().buy()
    expect(state().error).toBeNull()
  })

  it('reports a sheet that will not open, and frees the button', async () => {
    mockRequestPurchase.mockRejectedValue(new Error('no network'))
    await state().buy()
    expect(state().error).toMatch(/App Store could not be reached/)
    expect(state().busy).toBe(false)
  })
})

describe('what comes back from StoreKit', () => {
  async function connect(): Promise<void> {
    await state().boot()
  }

  it('grants access when a purchase lands', async () => {
    await connect()
    mockOnPurchase?.({ id: 'txn-1' })
    await settle()
    expect(state().entitlement).toBe('active')
    expect(mockWriteGrant).toHaveBeenCalledWith(true)
  })

  it('finishes the transaction before granting anything', async () => {
    // An unfinished transaction is re-delivered by StoreKit on every launch,
    // forever. Finishing it after the UI was already happy means a throw
    // strands it silently.
    await connect()
    mockOnPurchase?.({ id: 'txn-1' })
    await settle()
    expect(mockFinishTransaction).toHaveBeenCalledWith({
      purchase: { id: 'txn-1' },
      isConsumable: false,
    })
  })

  it('still grants access when finishing the transaction fails', async () => {
    // Already finished, or finished by StoreKit itself. Not a reason to
    // withhold access from somebody whose money has been taken.
    mockFinishTransaction.mockRejectedValue(new Error('already finished'))
    await connect()
    mockOnPurchase?.({ id: 'txn-1' })
    await settle()
    expect(state().entitlement).toBe('active')
  })

  it('says nothing at all when the sheet is dismissed', async () => {
    // Cancelling is a decision, not a failure. A message after it reads as an
    // accusation.
    await connect()
    useSubscription.setState({ busy: true })
    mockOnError?.({ code: 'user-cancelled' })
    expect(state().error).toBeNull()
    expect(state().busy).toBe(false)
  })

  it.each([['pending'], ['deferred-payment']])(
    'explains an Ask to Buy waiting on a parent (%s)',
    async (code) => {
      // The purchase is real and may be approved hours later, at which point
      // the purchase listener fires. Reporting it as a failure would send
      // somebody to buy it twice.
      await connect()
      mockOnError?.({ code })
      expect(state().error).toMatch(/Waiting for approval/)
      expect(state().busy).toBe(false)
    },
  )

  it('restores rather than complaining when the subscription is already owned', async () => {
    // Bought on another device, or re-tapped through a slow sheet. The
    // customer is right and the app is behind.
    await connect()
    mockGetActiveSubscriptions.mockResolvedValue(OWNED)
    mockOnError?.({ code: 'already-owned' })
    await settle()
    expect(state().entitlement).toBe('active')
    expect(state().error).toBeNull()
  })

  it('reports anything else in one sentence, with no code in it', async () => {
    // A customer cannot act on a code and support cannot read one back down a
    // phone line. "Nothing has been charged" is the part that matters.
    await connect()
    mockOnError?.({ code: 'network-error' })
    expect(state().error).toBe('That purchase did not go through. Nothing has been charged.')
    expect(state().busy).toBe(false)
  })

  it('reports a failure StoreKit sent with no code at all', async () => {
    // The library's `code` is optional: a failure it could not map arrives
    // without one, and it must fall through to the plain message rather than
    // match whichever comparison `undefined` happens to lose first.
    await connect()
    mockOnError?.({})
    expect(state().error).toMatch(/did not go through/)
  })

  it('keeps one set of listeners across repeated boots', async () => {
    // They outlive every screen, so a second boot attaching a second pair
    // would finish each transaction twice -- and remove only one of each on
    // the way out.
    await connect()
    await state().boot()
    expect(mockAttached).toEqual(['purchased', 'failed'])
    teardownSubscription()
    expect(mockRemoved).toEqual(['purchased', 'failed'])
  })

  it('has nothing to remove when no boot ever connected', () => {
    teardownSubscription()
    expect(mockRemoved).toEqual([])
    expect(state().entitlement).toBe('unknown')
  })
})

describe('restoring', () => {
  it('grants access when the App Store confirms the subscription', async () => {
    mockGetActiveSubscriptions.mockResolvedValue(OWNED)
    await state().restore()
    expect(state().entitlement).toBe('active')
    expect(state().error).toBeNull()
    expect(mockWriteGrant).toHaveBeenCalledWith(true)
  })

  it('says plainly when there is nothing to restore', async () => {
    // The commonest reason to tap it is signing in with the wrong Apple ID, so
    // the message names the Apple ID rather than the app.
    await state().restore()
    expect(state().entitlement).toBe('none')
    expect(state().error).toMatch(/No subscription was found for this Apple ID/)
  })

  it('reports a store it could not reach without withdrawing access', async () => {
    // Somebody already inside the app tapping Restore out of curiosity must
    // not be locked out by a dropped connection.
    useSubscription.setState({ entitlement: 'active' })
    mockGetActiveSubscriptions.mockRejectedValue(new Error('offline'))
    await state().restore()
    expect(state().error).toMatch(/App Store could not be reached/)
    expect(state().entitlement).toBe('active')
  })

  it('frees the button whatever happened', async () => {
    mockGetActiveSubscriptions.mockRejectedValue(new Error('offline'))
    await state().restore()
    expect(state().busy).toBe(false)
  })

  it('refuses a second tap while the first is in flight', async () => {
    let release = (): void => undefined
    mockGetActiveSubscriptions.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([])
      }),
    )
    void state().restore()
    await settle()
    await state().restore()
    expect(mockGetActiveSubscriptions).toHaveBeenCalledTimes(1)
    release()
  })
})

describe('the banner', () => {
  it('can be dismissed', async () => {
    await state().restore()
    expect(state().error).not.toBeNull()
    state().clearError()
    expect(state().error).toBeNull()
  })
})
