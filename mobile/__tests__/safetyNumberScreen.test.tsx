import { fireEvent, render, screen } from '@testing-library/react-native'

const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const PHRASE = 'hurdle desert ember kelp velvet tundra thicket pebble'

const mockGoBack = jest.fn()

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useNavigation: () => ({ goBack: mockGoBack }),
}))

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

import SafetyNumberScreen from '../src/screens/SafetyNumberScreen'
import { useRemoteStore } from '../src/state/remoteStore'

function unpairFn(): jest.Mock {
  return useRemoteStore.getState().unpair as unknown as jest.Mock
}

beforeEach(() => {
  mockGoBack.mockReset()
  const fn = unpairFn()
  fn.mockReset()
  fn.mockResolvedValue(undefined)
  useRemoteStore.setState({ safetyPhrase: PHRASE })
})

describe('SafetyNumberScreen', () => {
  it('renders all eight words', async () => {
    await render(<SafetyNumberScreen />)
    for (const word of PHRASE.split(' ')) {
      expect(screen.getByText(word)).toBeTruthy()
    }
    expect(screen.getAllByTestId(/^safety-word-/)).toHaveLength(8)
  })

  it('carries the instruction to compare, not merely to admire', async () => {
    await render(<SafetyNumberScreen />)
    expect(screen.getByTestId('safety-instruction')).toBeTruthy()
  })

  it('offers both answers, so tapping through is not the only path', async () => {
    await render(<SafetyNumberScreen />)
    expect(screen.getByTestId('safety-match')).toBeTruthy()
    expect(screen.getByTestId('safety-mismatch')).toBeTruthy()
  })

  it('dismisses itself when the words match', async () => {
    await render(<SafetyNumberScreen />)
    await fireEvent.press(screen.getByTestId('safety-match'))
    expect(mockGoBack).toHaveBeenCalledTimes(1)
    expect(unpairFn()).not.toHaveBeenCalled()
  })

  it('unpairs immediately when they do not, with nothing to confirm', async () => {
    await render(<SafetyNumberScreen />)
    await fireEvent.press(screen.getByTestId('safety-mismatch'))
    expect(unpairFn()).toHaveBeenCalledTimes(1)
    expect(mockGoBack).not.toHaveBeenCalled()
  })

  it('says so when there is no phrase to compare', async () => {
    useRemoteStore.setState({ safetyPhrase: null })
    await render(<SafetyNumberScreen />)
    expect(screen.getByTestId('safety-none')).toBeTruthy()
    expect(screen.queryByTestId('safety-mismatch')).toBeNull()
  })

  it('renders no key material', async () => {
    useRemoteStore.setState({ safetyPhrase: PHRASE })
    await render(<SafetyNumberScreen />)
    const hex = JSON.stringify(screen.toJSON()).match(/[0-9a-f]{64}/g) ?? []
    expect(hex.filter((run) => run !== DESKTOP_PK)).toEqual([])
  })
})
