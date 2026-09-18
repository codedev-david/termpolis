import type { PairedDesktop } from '../src/storage/identity'

import { act, fireEvent, render, screen } from '@testing-library/react-native'
import React from 'react'

const PAIRED: PairedDesktop = {
  desktopPublicKey: '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  relayUrl: 'wss://relay.test',
  deviceId: '12faa049f0ec7720',
  label: 'Termpolis desktop',
  pairedAt: 1_700_000_000_000,
}

const PAIRED_B: PairedDesktop = {
  desktopPublicKey: 'b1'.repeat(32),
  sessionRoomId: 'a1'.repeat(16),
  relayUrl: 'wss://relay-b.test',
  deviceId: 'b0'.repeat(8),
  label: 'Workshop Linux box',
  pairedAt: 1_700_000_100_000,
}

/** Each screen stands in for itself. The shell's job is deciding which one is
 *  on top, and the real screens drag in the camera, the socket and the store. */
function mockStub(testID: string): { __esModule: true; default: () => React.JSX.Element } {
  const React = require('react')
  const { Text } = require('react-native')
  // Named, because React Navigation warns on a component called `default` --
  // and a suite that prints warnings teaches you to stop reading them.
  function Screen(): React.JSX.Element {
    return React.createElement(Text, { testID }, testID)
  }
  return { __esModule: true, default: Screen }
}

jest.mock('../src/screens/PairScreen', () => mockStub('screen-pair'))
/** The list is the only way into a terminal, so its stand-in carries the one
 *  thing the shell needs from it: a `navigate` with real route params. The
 *  shell reads the terminal's name off those params for the header title. */
jest.mock('../src/screens/TerminalListScreen', () => {
  const React = require('react')
  const { Pressable, Text, View } = require('react-native')
  const { useNavigation } = require('@react-navigation/native')
  function Screen(): React.JSX.Element {
    const nav = useNavigation()
    return React.createElement(
      View,
      null,
      React.createElement(Text, { testID: 'screen-terminals' }, 'screen-terminals'),
      React.createElement(
        Pressable,
        {
          testID: 'stub-open-terminal',
          onPress: () => nav.navigate('Terminal', { terminalId: 't1', name: 'claude -- api' }),
        },
        React.createElement(Text, null, 'open'),
      ),
    )
  }
  return { __esModule: true, default: Screen }
})
jest.mock('../src/screens/TerminalScreen', () => mockStub('screen-terminal'))
/** The words screen ends in a back tap ("they match"), and where that lands is
 *  the whole reason the shell resets rather than pushes. */
jest.mock('../src/screens/SafetyNumberScreen', () => {
  const React = require('react')
  const { Pressable, Text, View } = require('react-native')
  const { useNavigation } = require('@react-navigation/native')
  function Screen(): React.JSX.Element {
    const nav = useNavigation()
    return React.createElement(
      View,
      null,
      React.createElement(Text, { testID: 'screen-safety' }, 'screen-safety'),
      React.createElement(
        Pressable,
        { testID: 'stub-safety-back', onPress: () => nav.goBack() },
        React.createElement(Text, null, 'they match'),
      ),
    )
  }
  return { __esModule: true, default: Screen }
})
jest.mock('../src/screens/SettingsScreen', () => mockStub('screen-settings'))
/** The switcher's stand-in carries the one route the shell owns on its behalf:
 *  pairing another machine from inside the paired stack. */
jest.mock('../src/screens/DesktopsScreen', () => {
  const React = require('react')
  const { Pressable, Text, View } = require('react-native')
  const { useNavigation } = require('@react-navigation/native')
  function Screen(): React.JSX.Element {
    const nav = useNavigation()
    return React.createElement(
      View,
      null,
      React.createElement(Text, { testID: 'screen-desktops' }, 'screen-desktops'),
      React.createElement(
        Pressable,
        { testID: 'stub-pair-another', onPress: () => nav.navigate('Pair') },
        React.createElement(Text, null, 'pair another'),
      ),
    )
  }
  return { __esModule: true, default: Screen }
})

/** The paywall is the whole stack when relay access has not been paid for, so
 *  the shell has to be able to render it without StoreKit underneath. */
jest.mock('../src/screens/PaywallScreen', () => mockStub('screen-paywall'))

/** Entitlement defaults to `active` here. Every test below is about which
 *  screen the shell picks once access is settled; the ones about the gate
 *  itself set it explicitly, and a default of `unknown` would have hidden the
 *  answer behind a spinner in all the others. */
jest.mock('../src/state/subscription', () => {
  const { create } = require('zustand')
  return {
    useSubscription: create(() => ({
      entitlement: 'active',
      boot: jest.fn(async () => undefined),
    })),
  }
})

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      paired: null,
      pairings: [],
      status: 'offline',
      boot: jest.fn(async () => undefined),
    })),
  }
})

import App from '../src/App'
import { useRemoteStore } from '../src/state/remoteStore'
import { useSubscription } from '../src/state/subscription'

function bootFn(): jest.Mock {
  return useRemoteStore.getState().boot as unknown as jest.Mock
}

function bootSubscriptionFn(): jest.Mock {
  return useSubscription.getState().boot as unknown as jest.Mock
}

/** Let the boot promise settle and React commit what it produced. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
  })
}

beforeEach(() => {
  const fn = bootFn()
  fn.mockReset()
  fn.mockResolvedValue(undefined)
  useRemoteStore.setState({ paired: null, pairings: [], status: 'offline' })
  const sub = bootSubscriptionFn()
  sub.mockReset()
  sub.mockResolvedValue(undefined)
  useSubscription.setState({ entitlement: 'active' })
})

/** What boot leaves behind on a phone that is already paired. */
function booted(...pairings: PairedDesktop[]): void {
  bootFn().mockImplementation(async () => {
    useRemoteStore.setState({ pairings, paired: pairings[0] ?? null })
  })
}

describe('App -- booting', () => {
  it('boots the store once', async () => {
    await render(<App />)
    await settle()
    expect(bootFn()).toHaveBeenCalledTimes(1)
  })

  it('boots it once even when the effect is invoked twice', async () => {
    // StrictMode mounts, tears down and mounts again. `boot()` opens a socket
    // and starts a handshake, so running it twice is not a wasted call -- it is
    // a second connection racing the first for the same relay room, where the
    // room admits one device and answers the loser with 409.
    await render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    await settle()
    expect(bootFn()).toHaveBeenCalledTimes(1)
  })

  it('does not boot again when the store changes underneath it', async () => {
    await render(<App />)
    await settle()
    await act(async () => {
      useRemoteStore.setState({ status: 'connecting' })
    })
    await act(async () => {
      useRemoteStore.setState({ status: 'online' })
    })
    expect(bootFn()).toHaveBeenCalledTimes(1)
  })

  it('shows nothing but a holding screen until boot has answered', async () => {
    bootFn().mockReturnValue(new Promise<void>(() => undefined))
    await render(<App />)
    await settle()
    expect(screen.getByTestId('app-loading')).toBeTruthy()
    // Guessing "unpaired" here and swapping later would flash the pairing
    // screen at someone who is already paired.
    expect(screen.queryByTestId('screen-pair')).toBeNull()
    expect(screen.queryByTestId('screen-terminals')).toBeNull()
  })

  it('still opens when boot fails', async () => {
    // A phone whose keychain read failed is a phone with no pairing. That is
    // the pairing screen, not a dead app.
    bootFn().mockRejectedValue(new Error('SecureStore is unavailable'))
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
  })
})

describe('App -- which screen is on top', () => {
  it('opens on pairing when nothing is stored', async () => {
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
    expect(screen.queryByTestId('screen-terminals')).toBeNull()
  })

  it('opens on the terminal list when a desktop is already paired', async () => {
    booted(PAIRED)
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()
    // Not the safety words: those were compared when the pairing was made.
    expect(screen.queryByTestId('screen-safety')).toBeNull()
  })

  it('goes to the safety words the moment a pairing completes', async () => {
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-pair')).toBeTruthy()

    await act(async () => {
      useRemoteStore.setState({ paired: PAIRED, pairings: [PAIRED] })
    })
    expect(screen.getByTestId('screen-safety')).toBeTruthy()
  })

  it('returns to pairing when the last desktop is unpaired', async () => {
    booted(PAIRED)
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()

    await act(async () => {
      useRemoteStore.setState({ paired: null, pairings: [] })
    })
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
    expect(screen.queryByTestId('screen-terminals')).toBeNull()
  })

  it('offers a way into settings from the terminal list', async () => {
    booted(PAIRED)
    await render(<App />)
    await settle()
    await fireEvent.press(screen.getByTestId('header-settings'))
    expect(screen.getByTestId('screen-settings')).toBeTruthy()
  })

  it('offers a way into the desktop switcher from the terminal list', async () => {
    booted(PAIRED, PAIRED_B)
    await render(<App />)
    await settle()
    await fireEvent.press(screen.getByTestId('header-desktops'))
    expect(screen.getByTestId('screen-desktops')).toBeTruthy()
  })

  it('lets an already-paired phone pair another desktop', async () => {
    // The pairing screen exists in both stacks. Reachable only from the empty
    // one, a second desktop could never be added without unpairing the first.
    booted(PAIRED)
    await render(<App />)
    await settle()
    await fireEvent.press(screen.getByTestId('header-desktops'))
    await fireEvent.press(screen.getByTestId('stub-pair-another'))
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
  })

  it('does not reach a paired screen while unpaired, whatever is pushed', async () => {
    await render(<App />)
    await settle()
    for (const id of ['screen-terminals', 'screen-terminal', 'screen-safety', 'screen-settings']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })
})

describe('App -- a phone paired with several desktops', () => {
  it('titles the list with the desktop on screen', async () => {
    booted(PAIRED, PAIRED_B)
    await render(<App />)
    await settle()
    expect(JSON.stringify(screen.toJSON())).toContain('Termpolis desktop')
  })

  it('re-titles it when the user switches desktop', async () => {
    // The header is the only thing that says which machine the terminals below
    // it belong to, and the two lists look alike.
    booted(PAIRED, PAIRED_B)
    await render(<App />)
    await settle()
    await act(async () => {
      useRemoteStore.setState({ paired: PAIRED_B })
    })
    expect(JSON.stringify(screen.toJSON())).toContain('Workshop Linux box')
  })

  it('does not show the safety words when the user merely switches desktop', async () => {
    // Nothing was paired: the words for both were compared when they were made,
    // and a switcher that ends in a verification screen is one nobody uses.
    booted(PAIRED, PAIRED_B)
    await render(<App />)
    await settle()
    await act(async () => {
      useRemoteStore.setState({ paired: PAIRED_B })
    })
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()
    expect(screen.queryByTestId('screen-safety')).toBeNull()
  })

  it('shows the words when a second desktop is paired', async () => {
    booted(PAIRED)
    await render(<App />)
    await settle()
    await act(async () => {
      useRemoteStore.setState({ paired: PAIRED_B, pairings: [PAIRED, PAIRED_B] })
    })
    expect(screen.getByTestId('screen-safety')).toBeTruthy()
  })

  it('shows them again when a desktop already on the list is re-paired', async () => {
    // Re-pairing mints a fresh key, and therefore fresh words. The list is the
    // same length either way, which is why the shell watches the newest stamp
    // rather than the count.
    booted(PAIRED)
    await render(<App />)
    await settle()
    const again = { ...PAIRED, pairedAt: PAIRED.pairedAt + 60_000 }
    await act(async () => {
      useRemoteStore.setState({ paired: again, pairings: [again] })
    })
    expect(screen.getByTestId('screen-safety')).toBeTruthy()
  })

  it('does not show them again when a desktop is forgotten', async () => {
    booted(PAIRED, PAIRED_B)
    await render(<App />)
    await settle()
    await act(async () => {
      useRemoteStore.setState({ paired: PAIRED, pairings: [PAIRED] })
    })
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()
    expect(screen.queryByTestId('screen-safety')).toBeNull()
  })

  it('leaves the terminal list under the words, not the spent camera', async () => {
    // Pairing a second desktop starts on the Pair screen INSIDE the paired
    // stack. Pushed rather than reset, "they match" would go back to a camera
    // pointed at a code the desktop has already spent -- and the next frame
    // would scan it again.
    booted(PAIRED)
    await render(<App />)
    await settle()
    await fireEvent.press(screen.getByTestId('header-desktops'))
    await fireEvent.press(screen.getByTestId('stub-pair-another'))
    expect(screen.getByTestId('screen-pair')).toBeTruthy()

    await act(async () => {
      useRemoteStore.setState({ paired: PAIRED_B, pairings: [PAIRED, PAIRED_B] })
    })
    expect(screen.getByTestId('screen-safety')).toBeTruthy()

    await fireEvent.press(screen.getByTestId('stub-safety-back'))
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()
    expect(screen.queryByTestId('screen-pair')).toBeNull()
  })
})

describe('App -- naming the terminal screen', () => {
  it('titles the header with the terminal that was opened', async () => {
    // Four agent terminals look identical once you are inside one. The header
    // is the only thing on the screen that says which of them you are typing
    // into, and a mistyped line goes to a real shell on a real machine.
    booted(PAIRED)
    await render(<App />)
    await settle()

    await fireEvent.press(screen.getByTestId('stub-open-terminal'))
    expect(screen.getByTestId('screen-terminal')).toBeTruthy()

    // Not the static route name, and not the desktop's label: the name the
    // list handed over in the route params.
    expect(JSON.stringify(screen.toJSON())).toContain('claude -- api')
  })
})

describe('App -- the relay gate', () => {
  it('boots the subscription alongside the store, not after it', async () => {
    // Started together on purpose. They share nothing, and a phone made to
    // wait for the App Store before it may read its own keychain takes twice
    // as long to show anything on a bad connection.
    await render(<App />)
    await settle()
    expect(bootFn()).toHaveBeenCalledTimes(1)
    expect(bootSubscriptionFn()).toHaveBeenCalledTimes(1)
  })

  it('still opens when the subscription boot fails', async () => {
    // Nothing in the app waits on it: `ready` is about the keychain alone, so a
    // rejection here has no path to the screen except as an unhandled one. The
    // entitlement it could not decide falls to the paywall on its own.
    bootSubscriptionFn().mockRejectedValue(new Error('StoreKit is unavailable'))
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
  })

  it('shows neither the app nor the paywall while entitlement is undecided', async () => {
    // The dangerous moment. Guessing `active` gives the product away; guessing
    // `none` bills a paying customer's goodwill. Showing the same spinner the
    // keychain already gets is the only honest third option.
    useSubscription.setState({ entitlement: 'unknown' })
    booted(PAIRED)
    await render(<App />)
    await settle()
    expect(screen.queryByTestId('screen-paywall')).toBeNull()
    expect(screen.queryByTestId('screen-terminals')).toBeNull()
  })

  it('puts the paywall in front of an unpaired phone', async () => {
    useSubscription.setState({ entitlement: 'none' })
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-paywall')).toBeTruthy()
    expect(screen.queryByTestId('screen-pair')).toBeNull()
  })

  it('puts the paywall in front of a phone that is already paired', async () => {
    // A lapsed subscription, not a new install. The pairing survives -- the
    // keys are still good and unpairing over an unpaid month would make
    // resubscribing mean scanning a QR code again -- but the relay does not.
    useSubscription.setState({ entitlement: 'none' })
    booted(PAIRED)
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-paywall')).toBeTruthy()
    expect(screen.queryByTestId('screen-terminals')).toBeNull()
  })

  it('leaves no route out of the paywall', async () => {
    // The point of rendering it as the entire stack. A paywall listed beside
    // the other screens is one that a stray `navigate` -- or a back gesture
    // from a screen pushed before the subscription lapsed -- eventually walks
    // past.
    useSubscription.setState({ entitlement: 'none' })
    booted(PAIRED)
    await render(<App />)
    await settle()
    const tree = JSON.stringify(screen.toJSON())
    expect(tree).not.toContain('screen-terminals')
    expect(tree).not.toContain('screen-settings')
    expect(tree).not.toContain('screen-desktops')
  })

  it('hands the app back the moment the subscription starts', async () => {
    // The purchase listener flips entitlement from outside React. Nothing
    // navigates: the navigator is rebuilt around the branch it now takes.
    useSubscription.setState({ entitlement: 'none' })
    booted(PAIRED)
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-paywall')).toBeTruthy()

    await act(async () => {
      useSubscription.setState({ entitlement: 'active' })
    })
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()
    expect(screen.queryByTestId('screen-paywall')).toBeNull()
  })

  it('sends a subscriber with no desktop to pairing, not to the terminals', async () => {
    // Paying is not pairing. Someone who subscribes on a fresh install has an
    // entitlement and no keys, and the shell has to fall through to the empty
    // state rather than into a list of nothing.
    useSubscription.setState({ entitlement: 'active' })
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
  })
})
