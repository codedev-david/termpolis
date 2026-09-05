import { fireEvent, render, screen } from '@testing-library/react-native'
import { Platform } from 'react-native'

/** A file of its own because the label is read at module scope.
 *
 *  `DEVICE_LABEL` in PairScreen is a `const` initialised from `Platform.OS`, so
 *  the platform has to be android BEFORE the screen module is first evaluated.
 *  Mutating it inside a test would be too late -- the other pair-screen file has
 *  already imported the screen by then, and jest hoists every `import` above
 *  every statement in the file that writes it. Hence the `require` below. */
;(Platform as unknown as { OS: string }).OS = 'android'

jest.mock('expo-camera', () => {
  const react = require('react')
  const { View } = require('react-native')
  return {
    __esModule: true,
    useCameraPermissions: () => [{ granted: true, canAskAgain: false, status: 'granted' }, jest.fn()],
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

const PairScreen = require('../src/screens/PairScreen').default as React.ComponentType
const { useRemoteStore } = require('../src/state/remoteStore') as {
  useRemoteStore: { getState(): { pairFromQr: jest.Mock } }
}

beforeEach(() => {
  const fn = useRemoteStore.getState().pairFromQr
  fn.mockReset()
  fn.mockResolvedValue(undefined)
})

describe('PairScreen on Android', () => {
  it('is still running as android, which is the whole point of this file', () => {
    expect(Platform.OS).toBe('android')
  })

  it('calls itself an Android phone in the desktop device list', async () => {
    // The desktop shows this string next to a revoke button, and the user has
    // to recognise their own phone in it. "iPhone" on a Pixel is worse than no
    // name at all: it names somebody else's device.
    await render(<PairScreen />)
    await fireEvent(screen.getByTestId('camera-view'), 'barcodeScanned', { data: '{"v":1}' })
    expect(useRemoteStore.getState().pairFromQr).toHaveBeenCalledWith('{"v":1}', 'Android phone')
  })
})
