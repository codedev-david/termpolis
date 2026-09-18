import { fireEvent, render, screen } from '@testing-library/react-native'

/** Apple checks for both of these on the purchase screen itself. Written out
 *  here rather than imported so that changing either one in the screen has to
 *  be a deliberate edit in two places -- a 3.1.2 rejection is the most common
 *  one there is, and a link that quietly moved is how you earn it. */
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/'
const PRIVACY_URL = 'https://termpolis.com/privacy.html'

jest.mock('../src/state/subscription', () => {
  const { create } = require('zustand')
  return {
    useSubscription: create(() => ({
      entitlement: 'none',
      price: '$4.99',
      intro: '1 week free, then $4.99 a month',
      busy: false,
      error: null,
      buy: jest.fn(async () => undefined),
      restore: jest.fn(async () => undefined),
      clearError: jest.fn(),
    })),
  }
})

import { Linking } from 'react-native'

import PaywallScreen from '../src/screens/PaywallScreen'
import { useSubscription } from '../src/state/subscription'

type Store = {
  price: string | null
  intro: string | null
  busy: boolean
  error: string | null
  buy: jest.Mock
  restore: jest.Mock
  clearError: jest.Mock
}

function store(): Store {
  return useSubscription.getState() as unknown as Store
}

/** Put the store in the shape a particular customer would see. */
function showing(over: Partial<Store> = {}): void {
  useSubscription.setState(over)
}

let openURL: jest.SpyInstance

beforeEach(() => {
  showing({
    price: '$4.99',
    intro: '1 week free, then $4.99 a month',
    busy: false,
    error: null,
    buy: jest.fn(async () => undefined),
    restore: jest.fn(async () => undefined),
    clearError: jest.fn(),
  })
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the paywall -- what it costs', () => {
  it('quotes the price the store formatted', async () => {
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-price')).toHaveTextContent('$4.99 a month')
  })

  it('names no figure at all until the store has given one', async () => {
    // The catalogue lookup can fail or simply be slow. "Monthly" is true while
    // that is happening; "$0.00 a month" for half a second is a price the app
    // has told somebody and cannot honour.
    // Both go together: the offer is described in terms of the price, so a
    // catalogue that could not supply one supplied neither.
    showing({ price: null, intro: null })
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-price')).toHaveTextContent('Monthly')
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('shows the offer in the store own words', async () => {
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-intro')).toHaveTextContent(
      '1 week free, then $4.99 a month',
    )
  })

  it('promises nothing to an Apple ID that has already used the trial', async () => {
    // The commonest case for anyone reinstalling. Advertising a free week to
    // somebody the store will charge immediately is the kind of thing App
    // Review opens the app to check.
    showing({ intro: null })
    await render(<PaywallScreen />)
    expect(screen.queryByTestId('paywall-intro')).toBeNull()
    expect(screen.queryByTestId('paywall-trial-terms')).toBeNull()
    expect(screen.getByTestId('paywall-buy')).toHaveTextContent('Subscribe')
  })

  it('offers the free week on the button when there is one', async () => {
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-buy')).toHaveTextContent('Start free week')
    expect(screen.getByTestId('paywall-trial-terms')).toBeTruthy()
  })

  it('states the renewal terms whether or not there is an offer', async () => {
    // 3.1.2 wants duration and renewal on the screen, not in a linked
    // document, and not only for the trial path.
    showing({ intro: null })
    await render(<PaywallScreen />)
    expect(screen.getByText(/renews\s+each month unless you cancel/)).toBeTruthy()
    expect(screen.getByText(/Settings/)).toBeTruthy()
  })
})

describe('the paywall -- buying', () => {
  it('opens the purchase sheet when tapped', async () => {
    await render(<PaywallScreen />)
    fireEvent.press(screen.getByTestId('paywall-buy'))
    expect(store().buy).toHaveBeenCalledTimes(1)
  })

  it('survives a purchase that rejects instead of reporting', async () => {
    // The store records failures on `error`; a rejection escaping this handler
    // would take down the only screen the app is showing.
    showing({ buy: jest.fn(async () => { throw new Error('boom') }) })
    await render(<PaywallScreen />)
    expect(() => fireEvent.press(screen.getByTestId('paywall-buy'))).not.toThrow()
  })

  it('goes quiet while a purchase is in flight', async () => {
    // Quiet, not gone. A button that disappears under a thumb mid-tap looks
    // like a crash, and the tap lands on whatever moved up into its place.
    showing({ busy: true })
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-busy')).toBeTruthy()
    fireEvent.press(screen.getByTestId('paywall-buy'))
    fireEvent.press(screen.getByTestId('paywall-restore'))
    expect(store().buy).not.toHaveBeenCalled()
    expect(store().restore).not.toHaveBeenCalled()
  })
})

describe('the paywall -- restoring', () => {
  it('is on the screen, because Apple requires it to be', async () => {
    // 3.1.1. Somebody who subscribed, deleted the app and reinstalled it has
    // no other way back in.
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-restore')).toHaveTextContent('Restore purchases')
  })

  it('re-asks the store when tapped', async () => {
    await render(<PaywallScreen />)
    fireEvent.press(screen.getByTestId('paywall-restore'))
    expect(store().restore).toHaveBeenCalledTimes(1)
  })

  it('survives a restore that rejects instead of reporting', async () => {
    showing({ restore: jest.fn(async () => { throw new Error('boom') }) })
    await render(<PaywallScreen />)
    expect(() => fireEvent.press(screen.getByTestId('paywall-restore'))).not.toThrow()
  })
})

describe('the paywall -- the banner', () => {
  it('stays out of the way when nothing has gone wrong', async () => {
    await render(<PaywallScreen />)
    expect(screen.queryByTestId('paywall-error')).toBeNull()
  })

  it('reports what the store said', async () => {
    showing({ error: 'No subscription was found for this Apple ID.' })
    await render(<PaywallScreen />)
    expect(screen.getByTestId('paywall-error')).toHaveTextContent(
      'No subscription was found for this Apple ID.',
    )
  })

  it('can be dismissed by tapping it', async () => {
    showing({ error: 'Something went wrong.' })
    await render(<PaywallScreen />)
    fireEvent.press(screen.getByTestId('paywall-error'))
    expect(store().clearError).toHaveBeenCalledTimes(1)
  })
})

describe('the paywall -- the legal links', () => {
  it('opens Apple standard licence agreement', async () => {
    await render(<PaywallScreen />)
    fireEvent.press(screen.getByTestId('paywall-terms'))
    expect(openURL).toHaveBeenCalledWith(TERMS_URL)
  })

  it('opens the same privacy policy the store listing points at', async () => {
    await render(<PaywallScreen />)
    fireEvent.press(screen.getByTestId('paywall-privacy'))
    expect(openURL).toHaveBeenCalledWith(PRIVACY_URL)
  })

  it('survives a phone that refuses to open either of them', async () => {
    // Rare, but a promise nobody catches is a crash on exactly the phones that
    // refuse -- and this is the screen where a crash costs a sale.
    openURL.mockRejectedValue(new Error('no browser'))
    await render(<PaywallScreen />)
    expect(() => fireEvent.press(screen.getByTestId('paywall-terms'))).not.toThrow()
    expect(() => fireEvent.press(screen.getByTestId('paywall-privacy'))).not.toThrow()
  })
})
