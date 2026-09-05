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
jest.mock('../src/screens/SafetyNumberScreen', () => mockStub('screen-safety'))
jest.mock('../src/screens/SettingsScreen', () => mockStub('screen-settings'))

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      paired: null,
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
  useRemoteStore.setState({ paired: null, status: 'offline' })
})

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
    bootFn().mockImplementation(async () => {
      useRemoteStore.setState({ paired: PAIRED })
    })
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
      useRemoteStore.setState({ paired: PAIRED })
    })
    expect(screen.getByTestId('screen-safety')).toBeTruthy()
  })

  it('returns to pairing when the desktop is unpaired', async () => {
    bootFn().mockImplementation(async () => {
      useRemoteStore.setState({ paired: PAIRED })
    })
    await render(<App />)
    await settle()
    expect(screen.getByTestId('screen-terminals')).toBeTruthy()

    await act(async () => {
      useRemoteStore.setState({ paired: null })
    })
    expect(screen.getByTestId('screen-pair')).toBeTruthy()
    expect(screen.queryByTestId('screen-terminals')).toBeNull()
  })

  it('offers a way into settings from the terminal list', async () => {
    bootFn().mockImplementation(async () => {
      useRemoteStore.setState({ paired: PAIRED })
    })
    await render(<App />)
    await settle()
    await fireEvent.press(screen.getByTestId('header-settings'))
    expect(screen.getByTestId('screen-settings')).toBeTruthy()
  })

  it('does not reach a paired screen while unpaired, whatever is pushed', async () => {
    await render(<App />)
    await settle()
    for (const id of ['screen-terminals', 'screen-terminal', 'screen-safety', 'screen-settings']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })
})

describe('App -- naming the terminal screen', () => {
  it('titles the header with the terminal that was opened', async () => {
    // Four agent terminals look identical once you are inside one. The header
    // is the only thing on the screen that says which of them you are typing
    // into, and a mistyped line goes to a real shell on a real machine.
    bootFn().mockImplementation(async () => {
      useRemoteStore.setState({ paired: PAIRED })
    })
    await render(<App />)
    await settle()

    await fireEvent.press(screen.getByTestId('stub-open-terminal'))
    expect(screen.getByTestId('screen-terminal')).toBeTruthy()

    // Not the static route name, and not the desktop's label: the name the
    // list handed over in the route params.
    expect(JSON.stringify(screen.toJSON())).toContain('claude -- api')
  })
})
