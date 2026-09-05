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
  useRemoteStore.setState({ paired: null, error: null })
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

  it('ignores a scan once a desktop is already paired', async () => {
    useRemoteStore.setState({ paired: PAIRED })
    await render(<PairScreen />)
    await fireEvent(screen.getByTestId('camera-view'), 'barcodeScanned', { data: '{"v":1}' })
    expect(pairFn()).not.toHaveBeenCalled()
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
    useRemoteStore.setState({ paired: PAIRED })
    await render(<PairScreen />)
    expect(hexRunsInTree().filter((hex) => hex !== DESKTOP_PK)).toEqual([])
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
