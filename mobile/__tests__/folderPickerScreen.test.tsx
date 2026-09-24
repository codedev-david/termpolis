import type { Capabilities, DirectoryListing, LaunchedAgent, RemoteAgent } from '../src/wire/protocol'

import { act, fireEvent, render, screen } from '@testing-library/react-native'

const GRANTS: Capabilities = {
  read: true,
  createTerminal: true,
  writeToTerminal: true,
  closeTerminal: true,
}

/** A listing two levels down, so both the up-row and the entry rows have
 *  something real to point at. */
const LISTING: DirectoryListing = {
  path: '/home/dev/termpolis',
  parent: '/home/dev',
  entries: [
    { name: 'relay', path: '/home/dev/termpolis/relay' },
    { name: 'mobile', path: '/home/dev/termpolis/mobile' },
  ],
}

const mockReplace = jest.fn()
const mockRoute: { params: { agent: RemoteAgent } } = { params: { agent: 'claude' } }

jest.mock('@react-navigation/native', () => ({
  __esModule: true,
  useNavigation: () => ({ replace: mockReplace }),
  useRoute: () => mockRoute,
}))

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      directory: null,
      directoryLoading: false,
      capabilities: {
        read: false,
        createTerminal: false,
        writeToTerminal: false,
        closeTerminal: false,
      },
      stale: false,
      error: null,
      listDirectory: jest.fn(async () => undefined),
      launchAgent: jest.fn(async () => null),
    })),
  }
})

import FolderPickerScreen from '../src/screens/FolderPickerScreen'
import { useRemoteStore } from '../src/state/remoteStore'

function fn(name: 'listDirectory' | 'launchAgent'): jest.Mock {
  return useRemoteStore.getState()[name] as unknown as jest.Mock
}

/** A promise whose settlement the test controls, for pinning the screen in its
 *  in-flight state. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  mockReplace.mockReset()
  mockRoute.params.agent = 'claude'
  fn('listDirectory').mockReset()
  fn('listDirectory').mockResolvedValue(undefined)
  fn('launchAgent').mockReset()
  fn('launchAgent').mockResolvedValue(null)
  useRemoteStore.setState({
    directory: null,
    directoryLoading: false,
    capabilities: { ...GRANTS },
    stale: false,
    error: null,
  })
})

describe('FolderPickerScreen -- opening', () => {
  it('lists the desktop home on mount, with no path so the desktop picks it', async () => {
    await render(<FolderPickerScreen />)
    // No argument: the bridge answers listDirectory() with the home root. The
    // phone never names the first folder -- it only ever climbs the tree the
    // desktop just handed it.
    expect(fn('listDirectory')).toHaveBeenCalledTimes(1)
    expect(fn('listDirectory')).toHaveBeenCalledWith()
  })

  it('shows a loading path until the first listing arrives', async () => {
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-path').props.children).toBe('Loading…')
  })

  it('shows the desktop path once a listing is in hand', async () => {
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-path').props.children).toBe('/home/dev/termpolis')
  })
})

describe('FolderPickerScreen -- the empty and loading states', () => {
  it('spins while a listing is in flight and there is nothing to show yet', async () => {
    useRemoteStore.setState({ directory: null, directoryLoading: true })
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-loading')).toBeTruthy()
    expect(screen.queryByTestId('folder-empty')).toBeNull()
  })

  it('says a folder has no subfolders once the answer is in and empty', async () => {
    useRemoteStore.setState({
      directory: { path: '/home/dev/leaf', parent: '/home/dev', entries: [] },
      directoryLoading: false,
    })
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-empty')).toBeTruthy()
    expect(screen.queryByTestId('folder-loading')).toBeNull()
  })
})

describe('FolderPickerScreen -- walking the tree', () => {
  it('lists a subfolder it was tapped on', async () => {
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)
    await fireEvent.press(screen.getByTestId('folder-entry-relay'))
    expect(fn('listDirectory')).toHaveBeenLastCalledWith('/home/dev/termpolis/relay')
  })

  it('offers an up-row that climbs to the parent the desktop named', async () => {
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-up')).toBeTruthy()
    await fireEvent.press(screen.getByTestId('folder-up'))
    expect(fn('listDirectory')).toHaveBeenLastCalledWith('/home/dev')
  })

  it('offers no up-row at the root, where the desktop reports no parent', async () => {
    useRemoteStore.setState({
      directory: { path: '/home/dev', parent: null, entries: LISTING.entries },
    })
    await render(<FolderPickerScreen />)
    expect(screen.queryByTestId('folder-up')).toBeNull()
  })

  it('offers no up-row before the first listing lands', async () => {
    // directory is null here: the optional chain short-circuits rather than
    // reaching for a parent that is not there yet.
    await render(<FolderPickerScreen />)
    expect(screen.queryByTestId('folder-up')).toBeNull()
  })

  it('keeps the screen up when a listing is refused, on open or on a tap', async () => {
    // Every listDirectory call is fire-and-forget with the failure swallowed:
    // the store owns the banner, and an unhandled rejection here would cost the
    // user the whole picker for a folder they simply cannot open. This exercises
    // that swallow on the mount, on an entry tap, and on the up-row.
    fn('listDirectory').mockRejectedValue(new Error('read is not granted'))
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)

    await fireEvent.press(screen.getByTestId('folder-entry-relay'))
    await fireEvent.press(screen.getByTestId('folder-up'))

    expect(screen.getByTestId('folder-picker')).toBeTruthy()
    // Once on mount, once per tap -- each rejected, none of them fatal.
    expect(fn('listDirectory')).toHaveBeenCalledTimes(3)
  })
})

describe('FolderPickerScreen -- the start button', () => {
  it('is absent without createTerminal, whatever folder is open', async () => {
    useRemoteStore.setState({ directory: LISTING, capabilities: { ...GRANTS, createTerminal: false } })
    await render(<FolderPickerScreen />)
    expect(screen.queryByTestId('folder-start')).toBeNull()
  })

  it('is absent while the desktop is offline', async () => {
    useRemoteStore.setState({ directory: LISTING, stale: true })
    await render(<FolderPickerScreen />)
    expect(screen.queryByTestId('folder-start')).toBeNull()
  })

  it('names the agent it will start, from the route it was opened with', async () => {
    mockRoute.params.agent = 'codex'
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)
    expect(screen.getByText('Start Codex here')).toBeTruthy()
  })

  it('does nothing before the first listing, when there is no folder to start in', async () => {
    // The button is shown even before the listing lands (there is no folder to
    // disable it against yet), so tapping it must be a no-op rather than a
    // launch in an undefined directory.
    useRemoteStore.setState({ directory: null })
    await render(<FolderPickerScreen />)
    await fireEvent.press(screen.getByTestId('folder-start'))
    expect(fn('launchAgent')).not.toHaveBeenCalled()
  })

  it('launches the agent in the open folder and replaces itself with the terminal', async () => {
    const launched: LaunchedAgent = { terminalId: 't7', name: 'Claude · termpolis' }
    fn('launchAgent').mockResolvedValue(launched)
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)

    await fireEvent.press(screen.getByTestId('folder-start'))

    expect(fn('launchAgent')).toHaveBeenCalledWith('claude', '/home/dev/termpolis')
    // replace, not navigate: Back from the running agent lands on the list, not
    // on a spent folder picker.
    expect(mockReplace).toHaveBeenCalledWith('Terminal', { terminalId: 't7', name: 'Claude · termpolis' })
  })

  it('stays on the picker when the desktop names no terminal', async () => {
    // The store already put the reason on the banner; a null return just keeps
    // the user here rather than navigating to a terminal that was never opened.
    fn('launchAgent').mockResolvedValue(null)
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)

    await fireEvent.press(screen.getByTestId('folder-start'))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('stays on the picker when the launch is refused outright', async () => {
    // A throw (offline mid-tap, grant pulled) is caught to null so the screen
    // survives; the store owns the message.
    fn('launchAgent').mockRejectedValue(new Error('The desktop is offline.'))
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)

    await fireEvent.press(screen.getByTestId('folder-start'))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows a starting label while the launch is in flight', async () => {
    const gate = deferred<LaunchedAgent>()
    fn('launchAgent').mockReturnValue(gate.promise)
    useRemoteStore.setState({ directory: LISTING })
    await render(<FolderPickerScreen />)

    await fireEvent.press(screen.getByTestId('folder-start'))
    // Mid-flight: the button reports it is working rather than looking tappable
    // a second time.
    expect(screen.getByText('Starting…')).toBeTruthy()

    await act(async () => {
      gate.resolve({ terminalId: 't7', name: 'Claude · termpolis' })
    })
    expect(mockReplace).toHaveBeenCalled()
  })
})

describe('FolderPickerScreen -- offline and errors', () => {
  it('says the desktop is offline while stale', async () => {
    useRemoteStore.setState({ directory: LISTING, stale: true })
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-picker-offline')).toBeTruthy()
  })

  it('says nothing about being offline while connected', async () => {
    useRemoteStore.setState({ directory: LISTING, stale: false })
    await render(<FolderPickerScreen />)
    expect(screen.queryByTestId('folder-picker-offline')).toBeNull()
  })

  it('shows the last error the store recorded', async () => {
    useRemoteStore.setState({ directory: LISTING, error: 'The desktop could not start that agent.' })
    await render(<FolderPickerScreen />)
    expect(screen.getByTestId('folder-picker-error')).toBeTruthy()
    expect(screen.getByText('The desktop could not start that agent.')).toBeTruthy()
  })

  it('shows no error banner when there is nothing wrong', async () => {
    useRemoteStore.setState({ directory: LISTING, error: null })
    await render(<FolderPickerScreen />)
    expect(screen.queryByTestId('folder-picker-error')).toBeNull()
  })
})
