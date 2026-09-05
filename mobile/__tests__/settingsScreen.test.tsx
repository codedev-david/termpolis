import type { PairedDesktop } from '../src/storage/identity'
import type { Capabilities } from '../src/wire/protocol'

import { act, fireEvent, render, screen } from '@testing-library/react-native'

const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const IDENTITY_SK = '9f'.repeat(32)

const PAIRED: PairedDesktop = {
  desktopPublicKey: DESKTOP_PK,
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  relayUrl: 'wss://relay.test',
  deviceId: '12faa049f0ec7720',
  label: 'Termpolis desktop',
  pairedAt: 1_700_000_000_000,
}

const NOTHING: Capabilities = {
  read: false,
  createTerminal: false,
  writeToTerminal: false,
  closeTerminal: false,
}

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' } },
}))

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      status: 'attached',
      stale: false,
      paired: null,
      safetyPhrase: null,
      capabilities: {
        read: false,
        createTerminal: false,
        writeToTerminal: false,
        closeTerminal: false,
      },
      error: null,
      unpair: jest.fn(async () => undefined),
    })),
  }
})

import Constants from 'expo-constants'
import SettingsScreen from '../src/screens/SettingsScreen'
import { useRemoteStore } from '../src/state/remoteStore'

function unpairFn(): jest.Mock {
  return useRemoteStore.getState().unpair as unknown as jest.Mock
}

/** Every 64-hex run in the rendered tree. The desktop public key is the only one
 *  that may legitimately appear; this phone's own secret must never reach a
 *  screen at all. */
function hexRunsInTree(): string[] {
  return JSON.stringify(screen.toJSON()).match(/[0-9a-f]{64}/g) ?? []
}

beforeEach(() => {
  const fn = unpairFn()
  fn.mockReset()
  fn.mockResolvedValue(undefined)
  useRemoteStore.setState({
    status: 'attached',
    stale: false,
    paired: PAIRED,
    safetyPhrase: 'denim saddle jade ocean pigeon opal sapphire obsidian',
    capabilities: NOTHING,
    error: null,
  })
})

describe('SettingsScreen -- what it reports', () => {
  it('names the desktop this phone is paired with', async () => {
    await render(<SettingsScreen />)
    expect(screen.getByText('Termpolis desktop')).toBeTruthy()
  })

  it('shows the safety words so they can be compared again later', async () => {
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-safety-phrase')).toBeTruthy()
    expect(screen.getByText(/denim saddle jade ocean/)).toBeTruthy()
  })

  it('shows the id the desktop lists this phone under', async () => {
    await render(<SettingsScreen />)
    expect(screen.getByText('12faa049f0ec7720')).toBeTruthy()
  })

  it('shows the relay it is paired through and the connection state', async () => {
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-connection')).toBeTruthy()
    expect(screen.getByText('wss://relay.test')).toBeTruthy()
  })

  it('says the desktop is offline while stale', async () => {
    useRemoteStore.setState({ stale: true, status: 'offline' })
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-offline')).toBeTruthy()
  })

  it('shows the app version', async () => {
    await render(<SettingsScreen />)
    expect(screen.getByText('1.0.0')).toBeTruthy()
  })

  it('shows the relay state verbatim when it is one this build does not name', async () => {
    // A state added by the desktop and not yet worded here still says something
    // true. Falling through to a blank line would read as "connected".
    useRemoteStore.setState({ status: 'draining' as never })
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-connection').props.children).toBe('draining')
  })

  it('says the words are not derived yet rather than showing an empty box', async () => {
    useRemoteStore.setState({ safetyPhrase: null })
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-safety-phrase').props.children).toMatch(/not derived/i)
  })

  it('says the version is unknown when the manifest is missing', async () => {
    const real = Constants.expoConfig
    ;(Constants as { expoConfig: unknown }).expoConfig = null
    try {
      await render(<SettingsScreen />)
      expect(screen.getByText('unknown')).toBeTruthy()
    } finally {
      ;(Constants as { expoConfig: unknown }).expoConfig = real
    }
  })

  it('says nothing is paired when nothing is', async () => {
    useRemoteStore.setState({ paired: null, safetyPhrase: null })
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-unpaired')).toBeTruthy()
    expect(screen.queryByTestId('settings-unpair')).toBeNull()
  })
})

describe('SettingsScreen -- the grants are facts, not controls', () => {
  it('reports each capability the desktop granted', async () => {
    useRemoteStore.setState({ capabilities: { ...NOTHING, read: true, writeToTerminal: true } })
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-capability-read').props.children).toMatch(/granted/i)
    expect(
      screen.getByTestId('settings-capability-writeToTerminal').props.children,
    ).toMatch(/granted/i)
    expect(screen.getByTestId('settings-capability-createTerminal').props.children).toMatch(
      /not granted/i,
    )
  })

  it('names every capability, including the ones that are off', async () => {
    await render(<SettingsScreen />)
    for (const name of ['read', 'createTerminal', 'writeToTerminal', 'closeTerminal']) {
      expect(screen.getByTestId(`settings-capability-${name}`)).toBeTruthy()
    }
  })

  it('offers nothing to press on a capability -- the desktop grants, the phone reads', async () => {
    useRemoteStore.setState({ capabilities: { ...NOTHING, read: true } })
    await render(<SettingsScreen />)
    const row = screen.getByTestId('settings-capability-read')
    expect(row.props.onPress).toBeUndefined()
    expect(row.props.accessibilityRole).not.toBe('button')
  })

  it('follows the desktop when a grant is withdrawn mid-session', async () => {
    useRemoteStore.setState({ capabilities: { ...NOTHING, read: true } })
    await render(<SettingsScreen />)
    expect(screen.getByTestId('settings-capability-read').props.children).toMatch(/granted/i)

    await act(async () => {
      useRemoteStore.setState({ capabilities: NOTHING })
    })
    expect(screen.getByTestId('settings-capability-read').props.children).toMatch(/not granted/i)
  })
})

describe('SettingsScreen -- unpairing', () => {
  it('asks before unpairing', async () => {
    await render(<SettingsScreen />)
    await fireEvent.press(screen.getByTestId('settings-unpair'))
    expect(unpairFn()).not.toHaveBeenCalled()
    expect(screen.getByTestId('settings-unpair-confirm')).toBeTruthy()
  })

  it('unpairs on confirm', async () => {
    await render(<SettingsScreen />)
    await fireEvent.press(screen.getByTestId('settings-unpair'))
    await fireEvent.press(screen.getByTestId('settings-unpair-confirm'))
    expect(unpairFn()).toHaveBeenCalledTimes(1)
  })

  it('does not unpair when the question is dismissed', async () => {
    await render(<SettingsScreen />)
    await fireEvent.press(screen.getByTestId('settings-unpair'))
    await fireEvent.press(screen.getByTestId('settings-unpair-cancel'))
    expect(unpairFn()).not.toHaveBeenCalled()
    expect(screen.queryByTestId('settings-unpair-confirm')).toBeNull()
  })

  it('unpairs while the desktop is offline', async () => {
    // A phone that can only be unpaired while online is a phone that cannot be
    // unpaired at the moment it matters. Dropping our own key ends the
    // relationship whether or not anything is reachable.
    useRemoteStore.setState({ stale: true, status: 'offline' })
    await render(<SettingsScreen />)
    await fireEvent.press(screen.getByTestId('settings-unpair'))
    await fireEvent.press(screen.getByTestId('settings-unpair-confirm'))
    expect(unpairFn()).toHaveBeenCalledTimes(1)
  })

  it('does not take the screen down when unpair rejects', async () => {
    unpairFn().mockRejectedValue(new Error('SecureStore is unavailable'))
    await render(<SettingsScreen />)
    await fireEvent.press(screen.getByTestId('settings-unpair'))
    await fireEvent.press(screen.getByTestId('settings-unpair-confirm'))
    expect(screen.getByTestId('settings-page')).toBeTruthy()
  })
})

describe('SettingsScreen -- what it must never show', () => {
  it('renders no 64-hex secret beyond the desktop public key', async () => {
    await render(<SettingsScreen />)
    for (const run of hexRunsInTree()) expect(run).toBe(DESKTOP_PK)
  })

  it('renders nothing resembling the identity secret even if the store held one', async () => {
    // The store has no field for it and never should. This asserts the screen
    // would not surface one anyway -- a leak here is permanent, since a
    // screenshot outlives the session.
    useRemoteStore.setState({
      paired: { ...PAIRED, label: `desk ${IDENTITY_SK}`.slice(0, 12) },
    })
    await render(<SettingsScreen />)
    expect(JSON.stringify(screen.toJSON())).not.toContain(IDENTITY_SK)
  })
})
