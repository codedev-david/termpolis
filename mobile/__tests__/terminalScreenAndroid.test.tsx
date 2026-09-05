import { render, screen } from '@testing-library/react-native'
import { Platform } from 'react-native'

/** A file of its own because the keyboard behaviour is read at module scope.
 *
 *  `KEYBOARD_BEHAVIOR` is a `const` initialised from `Platform.OS`, so the
 *  platform has to be android BEFORE the screen module is first evaluated.
 *  Mutating it inside a test would be too late -- the other terminal-screen file
 *  has already imported the screen by then, and jest hoists every `import` above
 *  every statement in the file that writes it. Hence the `require` below. */
;(Platform as unknown as { OS: string }).OS = 'android'

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => ({ params: { terminalId: 't1', name: 'claude' } }),
  useNavigation: () => ({ goBack: jest.fn(), setOptions: jest.fn() }),
}))

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      stale: false,
      output: {},
      agentStatus: {},
      capabilities: {
        read: true,
        createTerminal: false,
        writeToTerminal: true,
        closeTerminal: false,
      },
      error: null,
      subscribe: jest.fn(async () => undefined),
      unsubscribe: jest.fn(async () => undefined),
      send: jest.fn(async () => undefined),
    })),
  }
})

const TerminalScreen = require('../src/screens/TerminalScreen') as {
  default: React.ComponentType
  KEYBOARD_BEHAVIOR: string | undefined
}

describe('TerminalScreen on Android', () => {
  it('is still running as android, which is the whole point of this file', () => {
    expect(Platform.OS).toBe('android')
  })

  it('leaves the keyboard to the platform', () => {
    // Android resizes the window for the keyboard already. Padding on top of
    // that double-counts it: the composer ends up above the keyboard by the
    // height of the keyboard, which on a short screen is off the top entirely.
    expect(TerminalScreen.KEYBOARD_BEHAVIOR).toBeUndefined()
  })

  it('still renders the terminal it was opened on', async () => {
    // Proves the constant above came from a module that actually evaluated
    // under android, rather than from an import that happened to be cached.
    const Screen = TerminalScreen.default
    await render(<Screen />)
    expect(screen.getByTestId('terminal-output')).toBeTruthy()
  })
})
