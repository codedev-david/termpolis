import type { Capabilities } from '../src/wire/protocol'

import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Platform, ScrollView } from 'react-native'

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

import TerminalScreen, { KEYBOARD_BEHAVIOR } from '../src/screens/TerminalScreen'
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

describe('TerminalScreen -- following the output', () => {
  /** One scroll event, in the shape RN delivers it. */
  function at(offsetY: number): { nativeEvent: Record<string, unknown> } {
    return {
      nativeEvent: {
        contentOffset: { x: 0, y: offsetY },
        layoutMeasurement: { width: 320, height: 400 },
        contentSize: { width: 320, height: 1000 },
      },
    }
  }

  function spyOnScrollToEnd(): jest.SpyInstance {
    const proto = ScrollView.prototype as unknown as { scrollToEnd: () => void }
    return jest.spyOn(proto, 'scrollToEnd').mockImplementation(() => undefined)
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('follows new output while the view is already at the bottom', async () => {
    // The default, and the whole point of the screen: an agent writes
    // continuously and the phone is meant to show the newest line.
    const end = spyOnScrollToEnd()
    await render(<TerminalScreen />)
    const scroll = screen.getByTestId('terminal-output')
    // Laying the scrollback out fires a content-size change of its own. What
    // is under test is what the NEXT one does, so start the count from here.
    end.mockClear()

    await fireEvent.scroll(scroll, at(600))
    await fireEvent(scroll, 'contentSizeChange', 320, 1200)
    expect(end).toHaveBeenCalledWith({ animated: false })
  })

  it('stops following once the user has scrolled up to read', async () => {
    // Yanking the view back to the bottom mid-read is the single most annoying
    // thing a log viewer can do, and output arrives every few hundred ms.
    const end = spyOnScrollToEnd()
    await render(<TerminalScreen />)
    const scroll = screen.getByTestId('terminal-output')
    // Laying the scrollback out fires a content-size change of its own. What
    // is under test is what the NEXT one does, so start the count from here.
    end.mockClear()

    await fireEvent.scroll(scroll, at(100))
    await fireEvent(scroll, 'contentSizeChange', 320, 1200)
    expect(end).not.toHaveBeenCalled()
  })

  it('treats a pixel of rubber-banding as still being at the bottom', async () => {
    // iOS reports a fractional offset at rest after a bounce. Without the slack
    // the view would unpin itself on a scroll the user never made.
    const end = spyOnScrollToEnd()
    await render(<TerminalScreen />)
    const scroll = screen.getByTestId('terminal-output')
    // Laying the scrollback out fires a content-size change of its own. What
    // is under test is what the NEXT one does, so start the count from here.
    end.mockClear()

    await fireEvent.scroll(scroll, at(590))
    await fireEvent(scroll, 'contentSizeChange', 320, 1200)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalScreen -- leaving the screen', () => {
  it('unsubscribes on unmount', async () => {
    // The desktop fans output out per subscriber. A screen that leaves without
    // saying so keeps a stream alive over the relay for a view nobody is looking
    // at, and every later visit adds another.
    const view = await render(<TerminalScreen />)
    expect(fn('subscribe')).toHaveBeenCalledWith('t1')

    await act(async () => {
      view.unmount()
    })
    expect(fn('unsubscribe')).toHaveBeenCalledWith('t1')
  })

  it('swallows a refused unsubscribe rather than raising on the way out', async () => {
    // Unmount usually happens because the desktop went away, which is exactly
    // when this call fails. There is no longer a screen to show an error on.
    fn('unsubscribe').mockRejectedValue(new Error('gone'))
    const view = await render(<TerminalScreen />)
    await act(async () => {
      view.unmount()
    })
    expect(fn('unsubscribe')).toHaveBeenCalledWith('t1')
  })
})

describe('TerminalScreen -- the agent status bar', () => {
  it('shows a status this build has no label for, rather than a blank bar', async () => {
    // The desktop ships on its own schedule. A blank bar reads as a bug in the
    // phone; the raw word is at least true, and says which side is behind.
    useRemoteStore.setState({
      agentStatus: {
        t1: { terminalId: 't1', status: 'compacting' as never, summary: 'squeezing history' },
      },
    })
    await render(<TerminalScreen />)
    expect(screen.getByTestId('terminal-agent-status')).toBeTruthy()
    expect(screen.getByText('compacting')).toBeTruthy()
  })

  it('leaves the summary line out when there is no summary', async () => {
    // An empty Text still occupies a line, so the bar would jump between one and
    // two rows as the agent moves through states that carry no summary.
    useRemoteStore.setState({
      agentStatus: { t1: { terminalId: 't1', status: 'thinking', summary: '' } },
    })
    await render(<TerminalScreen />)
    expect(screen.getByTestId('terminal-agent-status').children).toHaveLength(1)

    await act(async () => {
      useRemoteStore.setState({
        agentStatus: { t1: { terminalId: 't1', status: 'thinking', summary: 'reading' } },
      })
    })
    expect(screen.getByTestId('terminal-agent-status').children).toHaveLength(2)
  })
})

describe('TerminalScreen -- keyboard avoidance', () => {
  it('pads the view up on iOS', () => {
    // The composer is the bottom-most thing on the screen, so without this it
    // sits under the keyboard the moment the user taps it, with nothing to
    // scroll it back into view. The Android half is in its own file, because
    // the platform is read once at module load.
    expect(KEYBOARD_BEHAVIOR).toBe('padding')
    expect(Platform.OS).toBe('ios')
  })
})
