import type { Capabilities } from '../src/wire/protocol'

import { act, fireEvent, render, screen } from '@testing-library/react-native'

const GRANTS: Capabilities = {
  read: true,
  createTerminal: true,
  writeToTerminal: true,
  closeTerminal: true,
}

const NOTHING: Capabilities = {
  read: false,
  createTerminal: false,
  writeToTerminal: false,
  closeTerminal: false,
}

const mockRoute = { params: { terminalId: 't1', name: 'claude' } }

/** The escape byte itself, built rather than typed so the source stays ASCII. */
const ESC = String.fromCharCode(27)

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useRoute: () => mockRoute,
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
        read: false,
        createTerminal: false,
        writeToTerminal: false,
        closeTerminal: false,
      },
      error: null,
      subscribe: jest.fn(async () => undefined),
      unsubscribe: jest.fn(async () => undefined),
      send: jest.fn(async () => undefined),
    })),
  }
})

import TerminalScreen from '../src/screens/TerminalScreen'
import { useRemoteStore } from '../src/state/remoteStore'

function fn(name: 'subscribe' | 'unsubscribe' | 'send'): jest.Mock {
  return useRemoteStore.getState()[name] as unknown as jest.Mock
}

beforeEach(() => {
  for (const name of ['subscribe', 'unsubscribe', 'send'] as const) {
    const f = fn(name)
    f.mockReset()
    f.mockResolvedValue(undefined)
  }
  useRemoteStore.setState({
    stale: false,
    output: {},
    agentStatus: {},
    capabilities: { ...GRANTS },
    error: null,
  })
})

describe('TerminalScreen -- the subscription', () => {
  it('subscribes once on mount, for the terminal it was opened on', async () => {
    await render(<TerminalScreen />)
    expect(fn('subscribe')).toHaveBeenCalledTimes(1)
    expect(fn('subscribe')).toHaveBeenCalledWith('t1')
  })

  it('unsubscribes once on unmount', async () => {
    const view = await render(<TerminalScreen />)
    await view.unmount()
    expect(fn('unsubscribe')).toHaveBeenCalledTimes(1)
    expect(fn('unsubscribe')).toHaveBeenCalledWith('t1')
  })

  it('does not resubscribe when unrelated state changes', async () => {
    await render(<TerminalScreen />)
    await act(async () => {
      useRemoteStore.setState({ output: { t1: 'hello' } })
    })
    await act(async () => {
      useRemoteStore.setState({ output: { t1: 'hello world' } })
    })
    expect(fn('subscribe')).toHaveBeenCalledTimes(1)
    expect(screen.getByText('hello world')).toBeTruthy()
  })

  it('does not take the screen down when the subscribe is refused', async () => {
    fn('subscribe').mockRejectedValue(new Error('read is not granted'))
    await render(<TerminalScreen />)
    expect(screen.getByTestId('terminal-output')).toBeTruthy()
  })

  it('still tries to unsubscribe when the subscribe failed', async () => {
    // The desktop is the authority on whether a subscription exists. Skipping
    // the unsubscribe because our own call threw would leave output streaming
    // to a screen nobody is looking at.
    fn('subscribe').mockRejectedValue(new Error('read is not granted'))
    const view = await render(<TerminalScreen />)
    await view.unmount()
    expect(fn('unsubscribe')).toHaveBeenCalledWith('t1')
  })
})

describe('TerminalScreen -- the output', () => {
  it('renders the scrollback for this terminal only', async () => {
    useRemoteStore.setState({ output: { t1: 'building...', t2: 'other terminal' } })
    await render(<TerminalScreen />)
    expect(screen.getByText('building...')).toBeTruthy()
    expect(screen.queryByText('other terminal')).toBeNull()
  })

  it('renders the desktop skipped-output marker rather than closing the gap', async () => {
    // Section 5.2 sends this marker precisely so the phone never presents a gap
    // as if the output were continuous.
    useRemoteStore.setState({ output: { t1: 'a\n[... 4 lines skipped ...]\nb' } })
    await render(<TerminalScreen />)
    expect(screen.getByText(/4 lines skipped/)).toBeTruthy()
  })

  it('shows the agent state the desktop reported for this terminal', async () => {
    useRemoteStore.setState({
      agentStatus: { t1: { terminalId: 't1', status: 'waiting_for_input', summary: 'needs you' } },
    })
    await render(<TerminalScreen />)
    expect(screen.getByTestId('terminal-agent-status')).toBeTruthy()
    expect(screen.getByText('needs you')).toBeTruthy()
  })

  it('renders no escape bytes, only the text they styled', async () => {
    useRemoteStore.setState({ output: { t1: `${ESC}[31mred${ESC}[0m plain` } })
    await render(<TerminalScreen />)
    expect(JSON.stringify(screen.toJSON())).not.toContain(ESC)
    expect(screen.getByText('red')).toBeTruthy()
  })

  it('colours the styled run rather than dropping the style with the escape', async () => {
    useRemoteStore.setState({ output: { t1: `${ESC}[31mred${ESC}[0m plain` } })
    await render(<TerminalScreen />)
    expect(JSON.stringify(screen.toJSON())).toContain('#cd3131')
  })
})

describe('TerminalScreen -- the composer', () => {
  it('offers no input at all without writeToTerminal', async () => {
    useRemoteStore.setState({ capabilities: { ...GRANTS, writeToTerminal: false } })
    await render(<TerminalScreen />)
    expect(screen.queryByTestId('terminal-input')).toBeNull()
    expect(screen.queryByTestId('terminal-send')).toBeNull()
  })

  it('offers no input when nothing at all is granted', async () => {
    useRemoteStore.setState({ capabilities: NOTHING })
    await render(<TerminalScreen />)
    expect(screen.queryByTestId('terminal-input')).toBeNull()
  })

  it('sends exactly what was typed and clears the box', async () => {
    await render(<TerminalScreen />)
    await fireEvent.changeText(screen.getByTestId('terminal-input'), 'npm test')
    await fireEvent.press(screen.getByTestId('terminal-send'))
    expect(fn('send')).toHaveBeenCalledWith('t1', 'npm test')
    expect(screen.getByTestId('terminal-input').props.value).toBe('')
  })

  it('sends leading and trailing whitespace untouched', async () => {
    // A terminal is not a form. Trimming would silently change what the user
    // typed, and indentation is meaningful to a REPL sitting on the far end.
    await render(<TerminalScreen />)
    await fireEvent.changeText(screen.getByTestId('terminal-input'), '  indented  ')
    await fireEvent.press(screen.getByTestId('terminal-send'))
    expect(fn('send')).toHaveBeenCalledWith('t1', '  indented  ')
  })

  it('sends nothing when the box is empty', async () => {
    await render(<TerminalScreen />)
    await fireEvent.press(screen.getByTestId('terminal-send'))
    expect(fn('send')).not.toHaveBeenCalled()
  })

  it('keeps the text in the box when the send is refused', async () => {
    // Clearing it would lose what the user typed at the exact moment they have
    // to type it again.
    fn('send').mockRejectedValue(new Error('The desktop is offline.'))
    await render(<TerminalScreen />)
    await fireEvent.changeText(screen.getByTestId('terminal-input'), 'npm test')
    await fireEvent.press(screen.getByTestId('terminal-send'))
    expect(screen.getByTestId('terminal-input').props.value).toBe('npm test')
  })
})

describe('TerminalScreen -- offline', () => {
  it('says the desktop is offline and disables the composer while stale', async () => {
    useRemoteStore.setState({ stale: true })
    await render(<TerminalScreen />)
    expect(screen.getByTestId('terminal-offline')).toBeTruthy()
    expect(screen.getByTestId('terminal-input').props.editable).toBe(false)
  })

  it('sends nothing while stale, even with text already in the box', async () => {
    await render(<TerminalScreen />)
    await fireEvent.changeText(screen.getByTestId('terminal-input'), 'npm test')
    await act(async () => {
      useRemoteStore.setState({ stale: true })
    })
    await fireEvent.press(screen.getByTestId('terminal-send'))
    expect(fn('send')).not.toHaveBeenCalled()
  })

  it('keeps the last-known scrollback while stale', async () => {
    useRemoteStore.setState({ stale: true, output: { t1: 'last thing it said' } })
    await render(<TerminalScreen />)
    expect(screen.getByText('last thing it said')).toBeTruthy()
  })

  it('shows the last error the store recorded', async () => {
    useRemoteStore.setState({ error: 'The desktop refused that.' })
    await render(<TerminalScreen />)
    expect(screen.getByText('The desktop refused that.')).toBeTruthy()
  })
})
