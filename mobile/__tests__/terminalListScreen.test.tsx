import type { Capabilities, TerminalSummary } from '../src/wire/protocol'

import { act, fireEvent, render, screen } from '@testing-library/react-native'

const TERMINALS: TerminalSummary[] = [
  { id: 't1', name: 'claude', shellType: 'claude', cwd: '/home/dev/termpolis' },
  { id: 't2', name: 'build', shellType: 'bash', cwd: '/home/dev/termpolis/relay' },
]

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

const mockNavigate = jest.fn()

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate }),
}))

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      status: 'attached',
      stale: false,
      terminals: [],
      capabilities: {
        read: false,
        createTerminal: false,
        writeToTerminal: false,
        closeTerminal: false,
      },
      agentStatus: {},
      error: null,
      refreshTerminals: jest.fn(async () => undefined),
      createTerminal: jest.fn(async () => undefined),
    })),
  }
})

import TerminalListScreen from '../src/screens/TerminalListScreen'
import { useRemoteStore } from '../src/state/remoteStore'

function fn(name: 'refreshTerminals' | 'createTerminal'): jest.Mock {
  return useRemoteStore.getState()[name] as unknown as jest.Mock
}

beforeEach(() => {
  mockNavigate.mockReset()
  for (const name of ['refreshTerminals', 'createTerminal'] as const) {
    const f = fn(name)
    f.mockReset()
    f.mockResolvedValue(undefined)
  }
  useRemoteStore.setState({
    status: 'attached',
    stale: false,
    terminals: [],
    capabilities: NOTHING,
    agentStatus: {},
    error: null,
  })
})

describe('TerminalListScreen -- the rows', () => {
  it('renders one row per terminal, with its name and cwd', async () => {
    useRemoteStore.setState({ terminals: TERMINALS })
    await render(<TerminalListScreen />)

    expect(screen.getByTestId('terminal-row-t1')).toBeTruthy()
    expect(screen.getByTestId('terminal-row-t2')).toBeTruthy()
    expect(screen.getByText('claude')).toBeTruthy()
    expect(screen.getByText('/home/dev/termpolis')).toBeTruthy()
    expect(screen.getByText('build')).toBeTruthy()
  })

  it('says so when the desktop is running nothing, rather than showing a blank page', async () => {
    await render(<TerminalListScreen />)
    expect(screen.getByTestId('terminal-list-empty')).toBeTruthy()
    expect(screen.queryByTestId('terminal-row-t1')).toBeNull()
  })

  it('shows the busy state the desktop reported', async () => {
    useRemoteStore.setState({
      terminals: TERMINALS,
      agentStatus: { t1: { terminalId: 't1', status: 'thinking', summary: 'reading files' } },
    })
    await render(<TerminalListScreen />)
    expect(screen.getByTestId('terminal-status-t1')).toBeTruthy()
    expect(screen.getByText('reading files')).toBeTruthy()
    // Nothing was reported for t2, and absence is not idleness, so the row
    // claims nothing about it.
    expect(screen.queryByTestId('terminal-status-t2')).toBeNull()
  })

  it('opens the terminal it was tapped on', async () => {
    useRemoteStore.setState({ terminals: TERMINALS })
    await render(<TerminalListScreen />)
    await fireEvent.press(screen.getByTestId('terminal-row-t2'))
    expect(mockNavigate).toHaveBeenCalledWith('Terminal', { terminalId: 't2', name: 'build' })
  })
})

/** Pull to refresh. The RefreshControl is a prop of the scroll view rather than
 *  a child with a testID of its own, so the handler is reached through it. */
async function pullToRefresh(): Promise<void> {
  const list = screen.getByTestId('terminal-list') as unknown as {
    props: { refreshControl: { props: { onRefresh: () => void } } }
  }
  await act(async () => {
    list.props.refreshControl.props.onRefresh()
  })
}

describe('TerminalListScreen -- refreshing', () => {
  it('asks the desktop again on pull-to-refresh', async () => {
    await render(<TerminalListScreen />)
    await pullToRefresh()
    expect(fn('refreshTerminals')).toHaveBeenCalledTimes(1)
  })

  it('does not take the screen down when the refresh is refused', async () => {
    fn('refreshTerminals').mockRejectedValue(new Error('The desktop is offline.'))
    await render(<TerminalListScreen />)
    await pullToRefresh()
    // The store already recorded the error. An unhandled rejection here would
    // cost the user the whole screen for a failure they can see anyway.
    expect(screen.getByTestId('terminal-list')).toBeTruthy()
  })
})

describe('TerminalListScreen -- what the desktop granted', () => {
  it('offers no new-terminal control without createTerminal', async () => {
    useRemoteStore.setState({ capabilities: { ...GRANTS, createTerminal: false } })
    await render(<TerminalListScreen />)
    expect(screen.queryByTestId('terminal-new')).toBeNull()
  })

  it('offers it once createTerminal is granted', async () => {
    useRemoteStore.setState({ capabilities: GRANTS })
    await render(<TerminalListScreen />)
    expect(screen.getByTestId('terminal-new')).toBeTruthy()
  })

  it('hides the control again when the grant is withdrawn mid-session', async () => {
    useRemoteStore.setState({ capabilities: GRANTS })
    await render(<TerminalListScreen />)
    expect(screen.getByTestId('terminal-new')).toBeTruthy()

    await act(async () => {
      useRemoteStore.setState({ capabilities: { ...GRANTS, createTerminal: false } })
    })
    expect(screen.queryByTestId('terminal-new')).toBeNull()
  })

  it('starts an AI terminal with the name that was typed', async () => {
    useRemoteStore.setState({ capabilities: GRANTS })
    await render(<TerminalListScreen />)
    await fireEvent.press(screen.getByTestId('terminal-new'))
    await fireEvent.changeText(screen.getByTestId('terminal-new-name'), 'claude')
    await fireEvent.press(screen.getByTestId('terminal-new-submit'))
    expect(fn('createTerminal')).toHaveBeenCalledWith('claude')
  })

  it('will not start one with a blank name', async () => {
    useRemoteStore.setState({ capabilities: GRANTS })
    await render(<TerminalListScreen />)
    await fireEvent.press(screen.getByTestId('terminal-new'))
    await fireEvent.changeText(screen.getByTestId('terminal-new-name'), '   ')
    await fireEvent.press(screen.getByTestId('terminal-new-submit'))
    expect(fn('createTerminal')).not.toHaveBeenCalled()
  })
})

describe('TerminalListScreen -- offline', () => {
  it('says the desktop is offline while stale, and keeps the last-known rows', async () => {
    useRemoteStore.setState({ terminals: TERMINALS, stale: true, capabilities: GRANTS })
    await render(<TerminalListScreen />)
    expect(screen.getByTestId('terminal-list-offline')).toBeTruthy()
    expect(screen.getByTestId('terminal-row-t1')).toBeTruthy()
  })

  it('offers no new-terminal control while stale, granted or not', async () => {
    useRemoteStore.setState({ stale: true, capabilities: GRANTS })
    await render(<TerminalListScreen />)
    expect(screen.queryByTestId('terminal-new')).toBeNull()
  })

  it('shows the last error the store recorded', async () => {
    useRemoteStore.setState({ error: 'The desktop refused that.' })
    await render(<TerminalListScreen />)
    expect(screen.getByText('The desktop refused that.')).toBeTruthy()
  })
})

describe('TerminalListScreen -- a status this build has never heard of', () => {
  it('shows the raw status rather than an empty badge', async () => {
    // The desktop ships on its own schedule and will add states this phone has
    // no label for. A blank badge reads as a bug in the app; the raw word is at
    // least true, and tells the user which of the two is behind.
    useRemoteStore.setState({
      capabilities: { ...GRANTS },
      terminals: TERMINALS,
      agentStatus: {
        t1: { terminalId: 't1', status: 'compacting' as never, summary: 'squeezing history' },
      },
    })
    await render(<TerminalListScreen />)
    expect(screen.getByTestId('terminal-status-t1')).toBeTruthy()
    expect(screen.getByText('compacting')).toBeTruthy()
  })
})

describe('TerminalListScreen -- a create the desktop refuses', () => {
  it('clears the field anyway rather than raising an unhandled rejection', async () => {
    // createTerminal rejects when the grant was revoked between render and press.
    // Unhandled, that rejection is a red box in dev and a silent crash in release.
    useRemoteStore.setState({ capabilities: { ...GRANTS }, terminals: TERMINALS })
    fn('createTerminal').mockRejectedValue(new Error('nope'))
    await render(<TerminalListScreen />)

    await fireEvent.press(screen.getByTestId('terminal-new'))
    await fireEvent.changeText(screen.getByTestId('terminal-new-name'), 'build')
    await act(async () => {
      fireEvent.press(screen.getByTestId('terminal-new-submit'))
    })

    expect(fn('createTerminal')).toHaveBeenCalledWith('build')
    expect(screen.queryByTestId('terminal-new-name')).toBeNull()
  })
})
