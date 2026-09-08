import type { PairedDesktop } from '../src/storage/identity'

import { fireEvent, render, screen } from '@testing-library/react-native'

const PK_A = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const PK_B = 'b1'.repeat(32)
const PK_C = 'c2'.repeat(32)

const DESK_A: PairedDesktop = {
  desktopPublicKey: PK_A,
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  relayUrl: 'wss://relay.test',
  deviceId: '12faa049f0ec7720',
  label: 'Windows box',
  pairedAt: 1_700_000_000_000,
}
const DESK_B: PairedDesktop = {
  desktopPublicKey: PK_B,
  sessionRoomId: 'a1'.repeat(16),
  relayUrl: 'wss://relay-b.test',
  deviceId: 'b0'.repeat(8),
  label: 'Workshop Linux box',
  pairedAt: 1_700_000_100_000,
}
const DESK_C: PairedDesktop = {
  desktopPublicKey: PK_C,
  sessionRoomId: 'a2'.repeat(16),
  relayUrl: 'wss://relay-c.test',
  deviceId: 'c0'.repeat(8),
  label: 'Basement server',
  pairedAt: 1_700_000_200_000,
}

const mockNav = { navigate: jest.fn(), goBack: jest.fn() }

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
}))

jest.mock('../src/state/remoteStore', () => {
  const { create } = require('zustand')
  return {
    useRemoteStore: create(() => ({
      pairings: [],
      paired: null,
      selectDesktop: jest.fn(async () => undefined),
      renameDesktop: jest.fn(async () => undefined),
      forgetDesktop: jest.fn(async () => undefined),
    })),
  }
})

import DesktopsScreen from '../src/screens/DesktopsScreen'
import { useRemoteStore } from '../src/state/remoteStore'
import { MAX_PAIRINGS } from '../src/storage/identity'

function fn(name: 'selectDesktop' | 'renameDesktop' | 'forgetDesktop'): jest.Mock {
  return useRemoteStore.getState()[name] as unknown as jest.Mock
}

/** As many desktops as this phone will hold, so the screen's ceiling can be
 *  checked against the real constant rather than against a number typed here. */
function full(): PairedDesktop[] {
  return Array.from({ length: MAX_PAIRINGS }, (_, i) => ({
    ...DESK_A,
    desktopPublicKey: i.toString(16).padStart(2, '0').repeat(32),
    label: `Desktop ${i}`,
  }))
}

beforeEach(() => {
  mockNav.navigate.mockReset()
  mockNav.goBack.mockReset()
  for (const name of ['selectDesktop', 'renameDesktop', 'forgetDesktop'] as const) {
    const m = fn(name)
    m.mockReset()
    m.mockResolvedValue(undefined)
  }
  useRemoteStore.setState({ pairings: [DESK_A, DESK_B, DESK_C], paired: DESK_A })
})

describe('DesktopsScreen -- the list', () => {
  it('names every desktop this phone is paired with', async () => {
    await render(<DesktopsScreen />)
    for (const d of [DESK_A, DESK_B, DESK_C]) expect(screen.getByText(d.label)).toBeTruthy()
  })

  it('marks the one on screen, and only that one', async () => {
    await render(<DesktopsScreen />)
    expect(screen.getByTestId(`desktop-active-${PK_A}`)).toBeTruthy()
    expect(screen.queryByTestId(`desktop-active-${PK_B}`)).toBeNull()
    expect(screen.queryByTestId(`desktop-active-${PK_C}`)).toBeNull()
  })

  it('marks nothing while no desktop is on screen', async () => {
    // Reachable for a moment after the active desktop is removed: the list has
    // redrawn and the next one has not been dialled yet.
    useRemoteStore.setState({ paired: null })
    await render(<DesktopsScreen />)
    for (const pk of [PK_A, PK_B, PK_C]) {
      expect(screen.queryByTestId(`desktop-active-${pk}`)).toBeNull()
    }
  })

  it('shows each desktop the id it lists this phone under', async () => {
    // The id differs per desktop, because the key does. Showing one desktop's id
    // on another's row would send the user to the wrong device list to revoke.
    await render(<DesktopsScreen />)
    expect(screen.getByText(DESK_A.deviceId)).toBeTruthy()
    expect(screen.getByText(DESK_B.deviceId)).toBeTruthy()
  })

  it('draws an empty list rather than failing when nothing is paired', async () => {
    useRemoteStore.setState({ pairings: [], paired: null })
    await render(<DesktopsScreen />)
    expect(screen.getByTestId('desktops-page')).toBeTruthy()
    expect(screen.getByTestId('desktops-add')).toBeTruthy()
  })
})

describe('DesktopsScreen -- switching', () => {
  it('puts the tapped desktop on screen and goes back to it', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-row-${PK_B}`))
    expect(fn('selectDesktop')).toHaveBeenCalledWith(PK_B)
    expect(mockNav.goBack).toHaveBeenCalledTimes(1)
  })

  it('still goes back when the desktop tapped is the one already showing', async () => {
    // The store treats it as a no-op. Staying on the switcher would look like
    // the tap missed.
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-row-${PK_A}`))
    expect(mockNav.goBack).toHaveBeenCalledTimes(1)
  })

  it('does not take the screen down when the switch rejects', async () => {
    fn('selectDesktop').mockRejectedValue(new Error('SecureStore is unavailable'))
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-row-${PK_B}`))
    expect(screen.getByTestId('desktops-page')).toBeTruthy()
  })
})

describe('DesktopsScreen -- renaming', () => {
  it('opens the field already holding the name it is replacing', async () => {
    // A blank field asks the user to retype a name they only wanted to amend.
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    expect(screen.getByTestId(`desktop-rename-input-${PK_B}`).props.value).toBe(DESK_B.label)
  })

  it('saves what was typed for that desktop', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    await fireEvent.changeText(screen.getByTestId(`desktop-rename-input-${PK_B}`), 'Garage Pi')
    await fireEvent.press(screen.getByTestId(`desktop-rename-save-${PK_B}`))
    expect(fn('renameDesktop')).toHaveBeenCalledWith(PK_B, 'Garage Pi')
  })

  it('closes the field once saved', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-rename-save-${PK_B}`))
    expect(screen.queryByTestId(`desktop-rename-input-${PK_B}`)).toBeNull()
  })

  it('writes nothing when the rename is cancelled', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    await fireEvent.changeText(screen.getByTestId(`desktop-rename-input-${PK_B}`), 'Garage Pi')
    await fireEvent.press(screen.getByTestId(`desktop-rename-cancel-${PK_B}`))
    expect(fn('renameDesktop')).not.toHaveBeenCalled()
    expect(screen.queryByTestId(`desktop-rename-input-${PK_B}`)).toBeNull()
  })

  it('edits one desktop at a time', async () => {
    // Two open fields share one draft, so the second Save would write the first
    // row's text onto the second row.
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_C}`))
    expect(screen.queryByTestId(`desktop-rename-input-${PK_B}`)).toBeNull()
    expect(screen.getByTestId(`desktop-rename-input-${PK_C}`)).toBeTruthy()
  })

  it('caps the field at the length the wire and the keystore agree on', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    expect(screen.getByTestId(`desktop-rename-input-${PK_B}`).props.maxLength).toBe(64)
  })

  it('does not take the screen down when the rename rejects', async () => {
    fn('renameDesktop').mockRejectedValue(new Error('SecureStore is unavailable'))
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-rename-save-${PK_B}`))
    expect(screen.getByTestId('desktops-page')).toBeTruthy()
  })
})

describe('DesktopsScreen -- removing one desktop', () => {
  it('asks first', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    expect(fn('forgetDesktop')).not.toHaveBeenCalled()
    expect(screen.getByTestId(`desktop-remove-confirm-${PK_B}`)).toBeTruthy()
  })

  it('says which desktop goes, and that the others stay', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    expect(screen.getByText(/Forget Workshop Linux box\?/)).toBeTruthy()
    expect(screen.getByText(/others stay paired/)).toBeTruthy()
  })

  it('removes that desktop on confirm', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-remove-confirm-${PK_B}`))
    expect(fn('forgetDesktop')).toHaveBeenCalledWith(PK_B)
    expect(fn('forgetDesktop')).toHaveBeenCalledTimes(1)
  })

  it('removes nothing when the question is dismissed', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-remove-cancel-${PK_B}`))
    expect(fn('forgetDesktop')).not.toHaveBeenCalled()
    expect(screen.queryByTestId(`desktop-remove-confirm-${PK_B}`)).toBeNull()
  })

  it('confirms one removal at a time', async () => {
    // Three open confirmations is a screen where the wrong "Forget it" gets
    // tapped, and the tap erases a key that cannot be recovered.
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_C}`))
    expect(screen.queryByTestId(`desktop-remove-confirm-${PK_B}`)).toBeNull()
    expect(screen.getByTestId(`desktop-remove-confirm-${PK_C}`)).toBeTruthy()
  })

  it('closes a rename that was open when Remove is tapped', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    expect(screen.queryByTestId(`desktop-rename-input-${PK_B}`)).toBeNull()
  })

  it('closes a removal that was open when Rename is tapped', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-rename-${PK_B}`))
    expect(screen.queryByTestId(`desktop-remove-confirm-${PK_B}`)).toBeNull()
  })

  it('does not take the screen down when the removal rejects', async () => {
    fn('forgetDesktop').mockRejectedValue(new Error('SecureStore is unavailable'))
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId(`desktop-remove-${PK_B}`))
    await fireEvent.press(screen.getByTestId(`desktop-remove-confirm-${PK_B}`))
    expect(screen.getByTestId('desktops-page')).toBeTruthy()
  })
})

describe('DesktopsScreen -- pairing another', () => {
  it('offers to pair another desktop', async () => {
    await render(<DesktopsScreen />)
    await fireEvent.press(screen.getByTestId('desktops-add'))
    expect(mockNav.navigate).toHaveBeenCalledWith('Pair')
  })

  it('says why it cannot once the phone is holding as many as it can', async () => {
    // A camera that scans and then reports "no room" has already spent the
    // desktop's single-use code. The button is gone before that can happen.
    useRemoteStore.setState({ pairings: full(), paired: null })
    await render(<DesktopsScreen />)
    expect(screen.queryByTestId('desktops-add')).toBeNull()
    expect(screen.getByTestId('desktops-limit')).toBeTruthy()
  })

  it('offers it again as soon as one is removed', async () => {
    useRemoteStore.setState({ pairings: full().slice(1), paired: null })
    await render(<DesktopsScreen />)
    expect(screen.getByTestId('desktops-add')).toBeTruthy()
    expect(screen.queryByTestId('desktops-limit')).toBeNull()
  })
})

describe('DesktopsScreen -- what it must never show', () => {
  it('renders no 64-hex value beyond the desktop keys it is listing', async () => {
    // This phone holds one private key per desktop. None of them has any
    // business on a screen, and a screenshot of this list outlives the session.
    await render(<DesktopsScreen />)
    const runs = JSON.stringify(screen.toJSON()).match(/[0-9a-f]{64}/g) ?? []
    for (const run of runs) expect([PK_A, PK_B, PK_C]).toContain(run)
  })
})
