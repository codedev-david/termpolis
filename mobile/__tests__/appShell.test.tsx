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

function bootFn(): jest.Mock {
  return useRemoteStore.getState().boot as unknown as jest.Mock
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
