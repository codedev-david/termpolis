import type { PairedDesktop } from '../src/storage/identity'

import { fireEvent, render, screen } from '@testing-library/react-native'

const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'

const PAIRED: PairedDesktop = {
  desktopPublicKey: DESKTOP_PK,
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

/** expo-camera reduced to the two things the screen touches. */
const mockCamera: {
  permission: { granted: boolean; canAskAgain: boolean; status: string } | null
  request: jest.Mock
} = { permission: null, request: jest.fn() }

jest.mock('expo-camera', () => {
  const react = require('react')
  const { View } = require('react-native')
  return {
    __esModule: true,
    useCameraPermissions: () => [mockCamera.permission, mockCamera.request],
    // A host View carrying the same callback prop. Firing the event on it is
    // exactly what the real CameraView does when a code comes into frame.
    CameraView: (props: { onBarcodeScanned?: unknown }) =>
      react.createElement(View, {
        testID: 'camera-view',
        onBarcodeScanned: props.onBarcodeScanned,
      }),
  }
})

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      paired: null,
      pairings: [],
      safetyPhrase: null,
      error: null,
      pairFromQr: jest.fn(async () => undefined),
      unpair: jest.fn(async () => undefined),
    })),
  }
})

import PairScreen from '../src/screens/PairScreen'
import { useRemoteStore } from '../src/state/remoteStore'

function pairFn(): jest.Mock {
  return useRemoteStore.getState().pairFromQr as unknown as jest.Mock
}

/** A pairing attempt that succeeds: the store ends up holding these desktops.
 *  What the screen watches is the newest `pairedAt`, because that is the only
 *  signal that survives re-pairing a desktop already on the list. */
function pairsInto(...pairings: PairedDesktop[]): void {
  pairFn().mockImplementation(async () => {
    useRemoteStore.setState({ pairings, paired: pairings[pairings.length - 1] ?? null })
  })
}

/** Every 64-hex run the rendered tree contains. The desktop public key is the
 *  only one that may legitimately appear; anything else is a leaked secret. */
function hexRunsInTree(): string[] {
  return JSON.stringify(screen.toJSON()).match(/[0-9a-f]{64}/g) ?? []
}

beforeEach(() => {
  mockCamera.permission = null
  mockCamera.request.mockReset()
  const fn = pairFn()
  fn.mockReset()
  fn.mockResolvedValue(undefined)
  useRemoteStore.setState({ paired: null, pairings: [], error: null })
})

describe('PairScreen — permission not yet granted', () => {
  it('explains why the camera is needed and offers a button', async () => {
    await render(<PairScreen />)
    expect(screen.getByTestId('pair-rationale')).toBeTruthy()
    expect(screen.getByTestId('pair-request-permission')).toBeTruthy()
    expect(screen.queryByTestId('camera-view')).toBeNull()
  })

  it('treats a still-loading permission as not yet granted', async () => {
    mockCamera.permission = null
    await render(<PairScreen />)
    expect(screen.getByTestId('pair-rationale')).toBeTruthy()
  })

  it('asks for permission only when the button is pressed', async () => {
    mockCamera.permission = { granted: false, canAskAgain: true, status: 'undetermined' }
    await render(<PairScreen />)
    expect(mockCamera.request).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByTestId('pair-request-permission'))
    expect(mockCamera.request).toHaveBeenCalledTimes(1)
  })

  it('still offers the button when the platform will allow another prompt', async () => {
    // Android returns denied-but-askable after a single "Deny". Sending the
    // user to Settings there would be wrong -- the prompt still works.
    mockCamera.permission = { granted: false, canAskAgain: true, status: 'denied' }
    await render(<PairScreen />)
    expect(screen.getByTestId('pair-request-permission')).toBeTruthy()
    expect(screen.queryByTestId('pair-manual-input')).toBeNull()
  })
})

describe('PairScreen — permission denied for good', () => {
  beforeEach(() => {
    mockCamera.permission = { granted: false, canAskAgain: false, status: 'denied' }
  })

  it('explains the fix and offers manual entry instead', async () => {
    await render(<PairScreen />)
    expect(screen.getByTestId('pair-denied')).toBeTruthy()
    expect(screen.getByTestId('pair-manual-input')).toBeTruthy()
    expect(screen.queryByTestId('camera-view')).toBeNull()
    expect(screen.queryByTestId('pair-request-permission')).toBeNull()
  })

  it('pairs from the typed payload', async () => {
    await render(<PairScreen />)
    await fireEvent.changeText(screen.getByTestId('pair-manual-input'), '{"v":1,"typed":true}')
    await fireEvent.press(screen.getByTestId('pair-manual-submit'))
    expect(pairFn()).toHaveBeenCalledTimes(1)
    expect(pairFn()).toHaveBeenCalledWith('{"v":1,"typed":true}', expect.any(String))
  })

  it('trims a pasted payload, which arrives with whitespace around it', async () => {
    await render(<PairScreen />)
    await fireEvent.changeText(screen.getByTestId('pair-manual-input'), '   {"v":1}   ')
    await fireEvent.press(screen.getByTestId('pair-manual-submit'))
    expect(pairFn()).toHaveBeenCalledWith('{"v":1}', expect.any(String))
  })

  it('does nothing when the field is empty', async () => {
    await render(<PairScreen />)
    await fireEvent.press(screen.getByTestId('pair-manual-submit'))
    expect(pairFn()).not.toHaveBeenCalled()
  })
})

describe('PairScreen — scanning', () => {
  beforeEach(() => {
    mockCamera.permission = { granted: true, canAskAgain: false, status: 'granted' }
  })

  it('shows the camera once permission is granted', async () => {
    await render(<PairScreen />)
    expect(screen.getByTestId('camera-view')).toBeTruthy()
    expect(screen.queryByTestId('pair-rationale')).toBeNull()
  })

  it('hands the scanned string to the store untouched', async () => {
    const raw = '   {"v":1,"relayUrl":"wss://relay.test"}   '
    await render(<PairScreen />)
    await fireEvent(screen.getByTestId('camera-view'), 'barcodeScanned', { data: raw })
    expect(pairFn()).toHaveBeenCalledTimes(1)
    expect(pairFn()).toHaveBeenCalledWith(raw, expect.any(String))
  })

  it('names this phone so the desktop device list is readable', async () => {
    await render(<PairScreen />)
    await fireEvent(screen.getByTestId('camera-view'), 'barcodeScanned', { data: '{}' })
    expect(pairFn()).toHaveBeenCalledWith('{}', expect.stringMatching(/[a-zA-Z]/))
  })

  it('ignores the repeat fire that both platforms produce', async () => {
    // The scanner keeps firing while the code stays in frame.
    pairFn().mockReturnValue(new Promise<void>(() => undefined))
    await render(<PairScreen />)
    const view = screen.getByTestId('camera-view')
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    expect(pairFn()).toHaveBeenCalledTimes(1)
  })

  it('scans for a phone that is already paired with something else', async () => {
    // This screen is reached from the switcher as well as from the empty state.
    // Refusing here is how a phone ends up able to hold exactly one desktop.
    useRemoteStore.setState({ paired: PAIRED, pairings: [PAIRED] })
    await render(<PairScreen />)
    await fireEvent(screen.getByTestId('camera-view'), 'barcodeScanned', { data: '{"v":1}' })
    expect(pairFn()).toHaveBeenCalledTimes(1)
  })

  it('stops scanning once a code has actually been spent', async () => {
    // The camera keeps firing while the code is held in frame. Without this the
    // frame after a success re-submits a code the desktop has already burned,
    // and the user watches their own success turn into an error banner.
    pairsInto(PAIRED)
    await render(<PairScreen />)
    const view = screen.getByTestId('camera-view')
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    expect(pairFn()).toHaveBeenCalledTimes(1)
  })

  it('stops scanning after re-pairing a desktop it already knew', async () => {
    // The list is the same length before and after, so a count would read this
    // as a failure and go on scanning a spent code.
    useRemoteStore.setState({ paired: PAIRED, pairings: [PAIRED] })
    pairsInto({ ...PAIRED, pairedAt: PAIRED.pairedAt + 60_000 })
    await render(<PairScreen />)
    const view = screen.getByTestId('camera-view')
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    expect(pairFn()).toHaveBeenCalledTimes(1)
  })

  it('keeps scanning when the attempt failed', async () => {
    // `pairFromQr` reports failure through the banner rather than by rejecting,
    // so a screen that locked itself on the first attempt would need to be
    // backed out of and re-entered to try a code that timed out.
    await render(<PairScreen />)
    const view = screen.getByTestId('camera-view')
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    await fireEvent(view, 'barcodeScanned', { data: '{"v":1}' })
    expect(pairFn()).toHaveBeenCalledTimes(2)
  })

  it('ignores a scan carrying no data', async () => {
    await render(<PairScreen />)
    await fireEvent(screen.getByTestId('camera-view'), 'barcodeScanned', {})
    expect(pairFn()).not.toHaveBeenCalled()
  })
})

describe('PairScreen — reporting and secrecy', () => {
  it('surfaces a pairing failure from the store', async () => {
    useRemoteStore.setState({ error: 'That pairing code has expired.' })
    await render(<PairScreen />)
    expect(screen.getByTestId('pair-error')).toBeTruthy()
    expect(screen.getByText('That pairing code has expired.')).toBeTruthy()
  })

  it('renders no key material at all before pairing', async () => {
    await render(<PairScreen />)
    expect(hexRunsInTree()).toEqual([])
  })

  it('renders no key material once paired either', async () => {
    mockCamera.permission = { granted: true, canAskAgain: false, status: 'granted' }
    useRemoteStore.setState({ paired: PAIRED, pairings: [PAIRED] })
    await render(<PairScreen />)
    expect(hexRunsInTree().filter((hex) => hex !== DESKTOP_PK)).toEqual([])
  })
})

describe('PairScreen — which pairing this is', () => {
  it('greets a phone that has never paired', async () => {
    await render(<PairScreen />)
    expect(screen.getByText('Pair with your desktop')).toBeTruthy()
  })

  it('says it is adding another when the phone already has one', async () => {
    // Reached from the switcher, "Pair with your desktop" reads as though the
    // desktop already paired is about to be replaced.
    useRemoteStore.setState({ paired: PAIRED, pairings: [PAIRED, PAIRED_B] })
    await render(<PairScreen />)
    expect(screen.getByText('Pair another desktop')).toBeTruthy()
  })
})

describe('PairScreen — while the pairing is in flight', () => {
  beforeEach(() => {
    mockCamera.permission = { granted: false, canAskAgain: false, status: 'denied' }
  })

  it('says so on the button, so the user does not press it again', async () => {
    // Pairing crosses a relay and waits on a desktop. Left reading "Pair", the
    // button looks like nothing happened, and a second press starts a second
    // attempt against a code that is now spent.
    pairFn().mockReturnValue(new Promise<void>(() => undefined))
    await render(<PairScreen />)
    await fireEvent.changeText(screen.getByTestId('pair-manual-input'), '{"v":1}')
    expect(screen.getByText('Pair')).toBeTruthy()

    await fireEvent.press(screen.getByTestId('pair-manual-submit'))
    expect(screen.queryByText('Pair')).toBeNull()
    expect(screen.getByText('Pairing…')).toBeTruthy()
  })
})
