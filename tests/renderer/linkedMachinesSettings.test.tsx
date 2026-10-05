// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LinkedMachinesSettings } from '../../src/renderer/src/components/SettingsPane/LinkedMachinesSettings'
import type {
  LinkedActivityView,
  LinkedEvent,
  LinkedMachineView,
  LinkedStatusView,
} from '../../src/renderer/src/types'
import { DEFAULT_RELAY_URL } from '../../src/main/remoteBridge/protocol'

const ok = <T,>(data: T) => ({ success: true as const, data })
const fail = (error: string) => ({ success: false as const, error })

const machine = (over: Partial<LinkedMachineView> = {}): LinkedMachineView => ({
  ref: 'link:aaaa',
  name: 'linux',
  online: true,
  confirmed: true,
  grants: { run: true, write: false },
  linkedAt: Date.now() - 86_400_000,
  ...over,
})

const job = (over: Partial<LinkedActivityView> = {}): LinkedActivityView => ({
  id: 'j1',
  direction: 'out',
  machine: 'linux',
  agent: 'codex',
  summary: 'Implement the parser',
  status: 'done',
  startedAt: Date.now() - 120_000,
  durationMs: 65_000,
  ...over,
})

const statusView = (over: Partial<LinkedStatusView> = {}): LinkedStatusView => ({
  enabled: true,
  running: true,
  relayUrl: DEFAULT_RELAY_URL,
  thisMachine: 'laptop',
  code: null,
  joining: false,
  machines: [],
  activity: [],
  ...over,
})

const CODE = `termpolis-link:${'e'.repeat(120)}`
const offer = (ttlMs = 300_000) => ({ code: CODE, expiresAt: Date.now() + ttlMs })
const PHRASE = 'anchor basil cobra delta ember fable grove harbor'
const pending = (over: Partial<Extract<LinkedEvent, { kind: 'pending' }>> = {}): LinkedEvent => ({
  kind: 'pending',
  ref: 'device:bbbb',
  phrase: PHRASE,
  suggestedName: 'linux-box',
  ...over,
})

let api: Record<string, ReturnType<typeof vi.fn>>
let pushStatus: (s: LinkedStatusView) => void
let pushEvent: (e: LinkedEvent) => void
const offStatus = vi.fn()
const offEvent = vi.fn()

type TestWindow = { linked?: unknown; termpolis?: unknown }
const win = window as unknown as TestWindow

function setClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

beforeEach(() => {
  offStatus.mockClear()
  offEvent.mockClear()
  api = {
    status: vi.fn().mockResolvedValue(ok(statusView())),
    setEnabled: vi.fn().mockResolvedValue(ok(statusView())),
    createCode: vi.fn().mockResolvedValue(ok(statusView({ code: offer() }))),
    cancelCode: vi.fn().mockResolvedValue(ok(statusView())),
    join: vi.fn().mockResolvedValue(ok(statusView({ joining: true }))),
    cancelJoin: vi.fn().mockResolvedValue(ok(statusView())),
    confirm: vi.fn().mockResolvedValue(ok(statusView())),
    rename: vi.fn().mockResolvedValue(ok(statusView())),
    setGrants: vi.fn().mockResolvedValue(ok(statusView())),
    unlink: vi.fn().mockResolvedValue(ok(statusView())),
    onStatus: vi.fn((cb: (s: LinkedStatusView) => void) => {
      pushStatus = cb
      return offStatus
    }),
    onEvent: vi.fn((cb: (e: LinkedEvent) => void) => {
      pushEvent = cb
      return offEvent
    }),
  }
  win.linked = api
})

afterEach(() => {
  cleanup()
  delete win.linked
  delete win.termpolis
  delete (navigator as unknown as { clipboard?: unknown }).clipboard
})

/** Render and wait out the initial `linked:status` round trip. */
async function mount(): Promise<void> {
  render(<LinkedMachinesSettings />)
  await waitFor(() => expect(screen.getByTestId('linked-enable')).toBeTruthy())
}

const input = (testId: string): HTMLInputElement => screen.getByTestId(testId) as HTMLInputElement
const button = (testId: string): HTMLButtonElement => screen.getByTestId(testId) as HTMLButtonElement

describe('LinkedMachinesSettings states', () => {
  it('says the feature is unavailable when the preload does not provide it', async () => {
    // The Settings suites mount every tab without a `window.linked`; that must
    // read as "not here", never as a crash that takes Settings down with it.
    delete win.linked
    render(<LinkedMachinesSettings />)
    const note = await screen.findByTestId('linked-unavailable')
    expect(note.textContent).toContain('not available')
    expect(api.status).not.toHaveBeenCalled()
  })

  it('shows why when the status call is refused', async () => {
    api.status.mockResolvedValue(fail('Linked machines is not running in this session'))
    render(<LinkedMachinesSettings />)
    expect((await screen.findByTestId('linked-unavailable')).textContent).toContain(
      'not running in this session',
    )
  })

  it('shows a loading line until the first status arrives', () => {
    api.status.mockReturnValue(new Promise(() => {}))
    render(<LinkedMachinesSettings />)
    expect(screen.getByTestId('linked-settings').textContent).toContain('Loading')
  })

  it('recovers from a refused status as soon as a status is pushed', async () => {
    api.status.mockResolvedValue(fail('not yet'))
    render(<LinkedMachinesSettings />)
    await screen.findByTestId('linked-unavailable')
    act(() => pushStatus(statusView()))
    expect(screen.getByTestId('linked-enable')).toBeTruthy()
    expect(screen.queryByTestId('linked-unavailable')).toBeNull()
  })

  it('ignores an event kind it does not know', async () => {
    await mount()
    act(() => pushEvent({ kind: 'mystery', ref: 'link:aaaa' } as unknown as LinkedEvent))
    expect(screen.queryByTestId('linked-error')).toBeNull()
    expect(screen.queryByTestId('linked-pending-link:aaaa')).toBeNull()
  })

  it('unsubscribes on unmount', async () => {
    await mount()
    cleanup()
    expect(offStatus).toHaveBeenCalledTimes(1)
    expect(offEvent).toHaveBeenCalledTimes(1)
  })

  it('drops a status that lands after unmount', async () => {
    let settle: (v: unknown) => void = () => {}
    api.status.mockReturnValue(
      new Promise((r) => {
        settle = r
      }),
    )
    render(<LinkedMachinesSettings />)
    cleanup()
    await act(async () => {
      settle(ok(statusView()))
      await Promise.resolve()
    })
    // Nothing to see: the point is that the `live` flag stops a state update
    // on a component that is gone.
    expect(offStatus).toHaveBeenCalledTimes(1)
  })
})

describe('LinkedMachinesSettings switch and relay', () => {
  it('renders the switch, the explanation, the relay and this computer’s name', async () => {
    api.status.mockResolvedValue(ok(statusView({ enabled: false, running: false })))
    await mount()
    expect(input('linked-enable').checked).toBe(false)
    expect(screen.getByText('Let this computer link with my other computers')).toBeTruthy()
    const pane = screen.getByTestId('linked-settings')
    expect(pane.textContent).toContain('behind the scenes')
    expect(pane.textContent).toContain('Termpolis running')
    expect(pane.textContent).toContain('end-to-end encrypted')
    expect(screen.getByTestId('linked-relay').textContent).toBe(DEFAULT_RELAY_URL)
    expect(pane.textContent).toContain('Uses the Remote relay')
    expect(screen.getByTestId('linked-this-machine').textContent).toBe('laptop')
    // Nothing to say about a connection while the feature is off.
    expect(screen.getByTestId('linked-running').textContent).toBe('')
    // And nothing to pair with: the code and join blocks wait for the switch.
    expect(screen.getByTestId('linked-off-note')).toBeTruthy()
    expect(screen.queryByTestId('linked-create-code')).toBeNull()
    expect(screen.queryByTestId('linked-join-input')).toBeNull()
  })

  it('turns linking on and adopts the status that comes back', async () => {
    api.status.mockResolvedValue(ok(statusView({ enabled: false, running: false })))
    await mount()
    fireEvent.click(screen.getByTestId('linked-enable'))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true))
    await waitFor(() =>
      expect(screen.getByTestId('linked-running').textContent).toBe('(connected to the relay)'),
    )
    expect(screen.getByTestId('linked-create-code')).toBeTruthy()
    expect(screen.queryByTestId('linked-off-note')).toBeNull()
  })

  it('says so when the bridge is not connected', async () => {
    api.status.mockResolvedValue(ok(statusView({ running: false })))
    await mount()
    expect(screen.getByTestId('linked-running').textContent).toBe('(not connected)')
  })

  it('turns linking off again', async () => {
    await mount()
    api.setEnabled.mockResolvedValue(ok(statusView({ enabled: false, running: false })))
    fireEvent.click(screen.getByTestId('linked-enable'))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(false))
    await waitFor(() => expect(input('linked-enable').checked).toBe(false))
  })

  it('shows a refused switch as an error', async () => {
    api.setEnabled.mockResolvedValue(fail('Could not start the bridge'))
    await mount()
    fireEvent.click(screen.getByTestId('linked-enable'))
    expect((await screen.findByTestId('linked-error')).textContent).toContain('Could not start')
  })

  it('clears an old error once a call succeeds', async () => {
    await mount()
    act(() => pushEvent({ kind: 'error', message: 'relay refused the connection' }))
    expect(screen.getByTestId('linked-error').textContent).toContain('relay refused')
    fireEvent.click(screen.getByTestId('linked-enable'))
    await waitFor(() => expect(screen.queryByTestId('linked-error')).toBeNull())
  })
})

describe('LinkedMachinesSettings link a computer', () => {
  it('offers run, and only run, before a code is made', async () => {
    await mount()
    expect(input('linked-grant-new-run').checked).toBe(true)
    expect(input('linked-grant-new-write').checked).toBe(false)
    const section = within(screen.getByTestId('linked-link-section'))
    expect(section.getByText('Run agents here (read-only)')).toBeTruthy()
    expect(section.getByText('Let agents edit files and run commands here')).toBeTruthy()
    // The risky grant says what it risks, in amber, where it is granted.
    const risk = screen.getByTestId('linked-grant-new-write-risk')
    expect(risk.textContent).toContain('without asking')
    expect(risk.className).toContain('e5c07b')
  })

  it('creates a code with exactly the grants ticked', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('linked-grant-new-write'))
    // Write implies run, so ticking write leaves run ticked.
    expect(input('linked-grant-new-run').checked).toBe(true)
    fireEvent.click(screen.getByTestId('linked-create-code'))
    await waitFor(() => expect(api.createCode).toHaveBeenCalledWith({ run: true, write: true }))
  })

  it('takes write away with run', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('linked-grant-new-write'))
    fireEvent.click(screen.getByTestId('linked-grant-new-run'))
    expect(input('linked-grant-new-write').checked).toBe(false)
    fireEvent.click(screen.getByTestId('linked-create-code'))
    await waitFor(() => expect(api.createCode).toHaveBeenCalledWith({ run: false, write: false }))
  })

  it('shows the code with a countdown, Copy and Cancel', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('linked-create-code'))
    expect((await screen.findByTestId('linked-code')).textContent).toBe(CODE)
    expect(screen.getByTestId('linked-countdown').textContent).toMatch(/Expires in [45]:\d\d/)
    expect(screen.getByTestId('linked-copy').textContent).toContain('Copy')
    expect(screen.getByTestId('linked-cancel-code')).toBeTruthy()
    expect(screen.queryByTestId('linked-create-code')).toBeNull()
    // The grants were sent with the code; changing the boxes now would change nothing.
    expect(input('linked-grant-new-run').disabled).toBe(true)
    expect(input('linked-grant-new-write').disabled).toBe(true)
  })

  it('waits visibly for a code the bridge has not minted yet', async () => {
    // `linked:create-code` answers with the status as it stands, before the
    // bridge has produced the offer -- the code itself arrives as a push.
    api.createCode.mockResolvedValue(ok(statusView()))
    await mount()
    fireEvent.click(screen.getByTestId('linked-create-code'))
    expect(await screen.findByTestId('linked-code-waiting')).toBeTruthy()
    expect(input('linked-grant-new-run').disabled).toBe(true)
    act(() => pushStatus(statusView({ code: offer() })))
    expect(screen.getByTestId('linked-code').textContent).toBe(CODE)
    expect(screen.queryByTestId('linked-code-waiting')).toBeNull()
    // Spent or cancelled later, the block goes back to offering a new code
    // instead of waiting for one that was already delivered.
    act(() => pushStatus(statusView()))
    expect(screen.getByTestId('linked-create-code')).toBeTruthy()
    expect(screen.queryByTestId('linked-code-waiting')).toBeNull()
  })

  it('does not wait when the code request is refused', async () => {
    api.createCode.mockResolvedValue(fail('Linked machines is off.'))
    await mount()
    fireEvent.click(screen.getByTestId('linked-create-code'))
    expect((await screen.findByTestId('linked-error')).textContent).toContain('off')
    expect(screen.queryByTestId('linked-code-waiting')).toBeNull()
    expect(screen.getByTestId('linked-create-code')).toBeTruthy()
  })

  it('stops waiting when the bridge reports an error', async () => {
    api.createCode.mockResolvedValue(ok(statusView()))
    await mount()
    fireEvent.click(screen.getByTestId('linked-create-code'))
    await screen.findByTestId('linked-code-waiting')
    act(() => pushEvent({ kind: 'error', message: 'relay refused the connection' }))
    expect(screen.getByTestId('linked-error').textContent).toContain('relay refused')
    expect(screen.queryByTestId('linked-code-waiting')).toBeNull()
    expect(screen.getByTestId('linked-create-code')).toBeTruthy()
  })

  it('does not keep waiting once linking is switched off', async () => {
    api.createCode.mockResolvedValue(ok(statusView()))
    await mount()
    fireEvent.click(screen.getByTestId('linked-create-code'))
    await screen.findByTestId('linked-code-waiting')
    act(() => pushStatus(statusView({ enabled: false })))
    act(() => pushStatus(statusView()))
    expect(screen.queryByTestId('linked-code-waiting')).toBeNull()
  })

  it('withdraws a live code', async () => {
    api.status.mockResolvedValue(ok(statusView({ code: offer() })))
    await mount()
    fireEvent.click(screen.getByTestId('linked-cancel-code'))
    await waitFor(() => expect(api.cancelCode).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('linked-code')).toBeNull())
  })

  it('withdraws a code it is still waiting for', async () => {
    api.createCode.mockResolvedValue(ok(statusView()))
    await mount()
    fireEvent.click(screen.getByTestId('linked-create-code'))
    await screen.findByTestId('linked-code-waiting')
    fireEvent.click(screen.getByTestId('linked-cancel-code'))
    await waitFor(() => expect(api.cancelCode).toHaveBeenCalled())
    expect(screen.queryByTestId('linked-code-waiting')).toBeNull()
  })

  it('counts down, then says the code expired and offers a new one', async () => {
    vi.useFakeTimers()
    try {
      api.status.mockResolvedValue(ok(statusView({ code: offer(3_000) })))
      render(<LinkedMachinesSettings />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId('linked-countdown').textContent).toBe('Expires in 0:03')
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(screen.getByTestId('linked-countdown').textContent).toBe('Expires in 0:02')
      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(screen.queryByTestId('linked-code')).toBeNull()
      expect(screen.getByTestId('linked-code-expired').textContent).toContain('expired')
      expect(screen.getByTestId('linked-create-code')).toBeTruthy()
      expect(input('linked-grant-new-run').disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies through the main-process clipboard and says so briefly', async () => {
    // navigator.clipboard is refused from a button click in Electron (see
    // lib/clipboard.ts), so the main-process path goes first.
    const clipboardWriteText = vi.fn().mockResolvedValue({ success: true })
    win.termpolis = { clipboardWriteText }
    const writeText = vi.fn()
    setClipboard(writeText)
    api.status.mockResolvedValue(ok(statusView({ code: offer() })))
    await mount()
    fireEvent.click(screen.getByTestId('linked-copy'))
    await waitFor(() => expect(screen.getByTestId('linked-copy').textContent).toContain('Copied'))
    expect(clipboardWriteText).toHaveBeenCalledWith(CODE)
    expect(writeText).not.toHaveBeenCalled()
    await waitFor(
      () => expect(screen.getByTestId('linked-copy').textContent).not.toContain('Copied'),
      { timeout: 3_000 },
    )
  })

  it('falls back to navigator.clipboard when the main-process path is missing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard(writeText)
    api.status.mockResolvedValue(ok(statusView({ code: offer() })))
    await mount()
    fireEvent.click(screen.getByTestId('linked-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE))
    await waitFor(() => expect(screen.getByTestId('linked-copy').textContent).toContain('Copied'))
  })

  it('says so when neither clipboard takes the code', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    api.status.mockResolvedValue(ok(statusView({ code: offer() })))
    await mount()
    fireEvent.click(screen.getByTestId('linked-copy'))
    expect((await screen.findByTestId('linked-copy-failed')).textContent).toContain('copy it by hand')
    expect(screen.getByTestId('linked-copy').textContent).not.toContain('Copied')
  })

  it('explains the limit instead of offering a seventeenth link', async () => {
    const machines = Array.from({ length: 16 }, (_, i) => machine({ ref: `link:${i}`, name: `m${i}` }))
    api.status.mockResolvedValue(ok(statusView({ machines })))
    await mount()
    expect(screen.getByTestId('linked-limit').textContent).toContain('16')
    expect(button('linked-create-code').disabled).toBe(true)
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: CODE } })
    expect(button('linked-join-button').disabled).toBe(true)
  })
})

describe('LinkedMachinesSettings enter a code', () => {
  it('links with the pasted code, trimmed, and the grants ticked', async () => {
    await mount()
    expect(input('linked-join-grant-run').checked).toBe(true)
    expect(input('linked-join-grant-write').checked).toBe(false)
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: `  ${CODE}\n` } })
    fireEvent.click(screen.getByTestId('linked-join-button'))
    await waitFor(() => expect(api.join).toHaveBeenCalledWith(CODE, { run: true, write: false }))
    expect(await screen.findByTestId('linked-joining')).toBeTruthy()
  })

  it('keeps Link disabled until there is a code to send', async () => {
    await mount()
    expect(button('linked-join-button').disabled).toBe(true)
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: '   ' } })
    expect(button('linked-join-button').disabled).toBe(true)
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: CODE } })
    expect(button('linked-join-button').disabled).toBe(false)
  })

  it('applies write-implies-run to the joining grants too', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('linked-join-grant-write'))
    expect(input('linked-join-grant-run').checked).toBe(true)
    expect(input('linked-join-grant-write').checked).toBe(true)
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: CODE } })
    fireEvent.click(screen.getByTestId('linked-join-button'))
    await waitFor(() => expect(api.join).toHaveBeenCalledWith(CODE, { run: true, write: true }))
    expect(screen.getByTestId('linked-join-grant-write-risk').className).toContain('e5c07b')
  })

  it('shows progress while joining, and cancels it', async () => {
    api.status.mockResolvedValue(ok(statusView({ joining: true })))
    await mount()
    expect(screen.getByTestId('linked-joining').textContent).toContain('Contacting')
    expect(screen.queryByTestId('linked-join-button')).toBeNull()
    expect(input('linked-join-input').disabled).toBe(true)
    expect(input('linked-join-grant-run').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('linked-cancel-join'))
    await waitFor(() => expect(api.cancelJoin).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('linked-joining')).toBeNull())
  })

  it('shows a refused join and keeps the code for another try', async () => {
    api.join.mockResolvedValue(fail('That is not a link code.'))
    await mount()
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: 'nonsense' } })
    fireEvent.click(screen.getByTestId('linked-join-button'))
    expect((await screen.findByTestId('linked-error')).textContent).toContain('not a link code')
    expect(input('linked-join-input').value).toBe('nonsense')
  })

  it('clears the code once the link it made is waiting for confirmation', async () => {
    await mount()
    fireEvent.change(screen.getByTestId('linked-join-input'), { target: { value: CODE } })
    // A pending link this computer hosts says nothing about the code typed here.
    act(() => pushEvent(pending({ ref: 'device:bbbb' })))
    expect(input('linked-join-input').value).toBe(CODE)
    // The joined side's link is the one that code produced: it is spent.
    act(() => pushEvent(pending({ ref: 'link:cccc' })))
    expect(input('linked-join-input').value).toBe('')
  })
})

describe('LinkedMachinesSettings confirmation', () => {
  it('asks to compare the safety words when a pending event arrives', async () => {
    await mount()
    act(() => pushEvent(pending()))
    const card = screen.getByTestId('linked-pending-device:bbbb')
    expect(card.textContent).toContain('linux-box')
    expect(within(card).getByTestId('linked-phrase').textContent).toBe(PHRASE)
    expect((within(card).getByTestId('linked-name-input') as HTMLInputElement).value).toBe('linux-box')
    expect(within(card).getByTestId('linked-confirm').textContent).toBe('They match — link')
  })

  it('confirms with the name the user chose', async () => {
    api.confirm.mockResolvedValue(
      ok(statusView({ machines: [machine({ ref: 'device:bbbb', name: 'Build box' })] })),
    )
    await mount()
    act(() => pushEvent(pending()))
    const card = screen.getByTestId('linked-pending-device:bbbb')
    fireEvent.change(within(card).getByTestId('linked-name-input'), { target: { value: '  Build box ' } })
    fireEvent.click(within(card).getByTestId('linked-confirm'))
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('device:bbbb', 'Build box'))
    await waitFor(() => expect(screen.queryByTestId('linked-pending-device:bbbb')).toBeNull())
    expect(screen.getByTestId('linked-machine-device:bbbb')).toBeTruthy()
  })

  it('confirms under the suggested name when the field is left empty', async () => {
    await mount()
    act(() => pushEvent(pending()))
    const card = screen.getByTestId('linked-pending-device:bbbb')
    fireEvent.change(within(card).getByTestId('linked-name-input'), { target: { value: '   ' } })
    fireEvent.click(within(card).getByTestId('linked-confirm'))
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('device:bbbb', 'linux-box'))
  })

  it('removes the card on a confirmed link even if the status does not list it', async () => {
    // The default confirm answer lists no machines at all.
    await mount()
    act(() => pushEvent(pending()))
    fireEvent.click(screen.getByTestId('linked-confirm'))
    await waitFor(() => expect(screen.queryByTestId('linked-pending-device:bbbb')).toBeNull())
  })

  it('keeps the card when confirming fails', async () => {
    api.confirm.mockResolvedValue(fail('That link is gone.'))
    await mount()
    act(() => pushEvent(pending()))
    fireEvent.click(screen.getByTestId('linked-confirm'))
    expect((await screen.findByTestId('linked-error')).textContent).toContain('gone')
    expect(screen.getByTestId('linked-pending-device:bbbb')).toBeTruthy()
  })

  it('cancelling unlinks the pending link', async () => {
    await mount()
    act(() => pushEvent(pending()))
    fireEvent.click(screen.getByTestId('linked-cancel-pending'))
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith('device:bbbb'))
    await waitFor(() => expect(screen.queryByTestId('linked-pending-device:bbbb')).toBeNull())
  })

  it('treats every unconfirmed machine as pending, even without an event', async () => {
    // Settings reopened after the event fired: the status alone must bring the
    // confirmation back, or the link would sit unconfirmed with no way to finish it.
    api.status.mockResolvedValue(
      ok(statusView({ machines: [machine({ confirmed: false, phrase: PHRASE })] })),
    )
    await mount()
    const card = screen.getByTestId('linked-pending-link:aaaa')
    expect(within(card).getByTestId('linked-phrase').textContent).toBe(PHRASE)
    expect((within(card).getByTestId('linked-name-input') as HTMLInputElement).value).toBe('linux')
    expect(screen.getByTestId('linked-waiting-link:aaaa').textContent).toBe('waiting for confirmation')
  })

  it('does not offer "They match" without words to compare', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine({ confirmed: false })] })))
    await mount()
    const card = screen.getByTestId('linked-pending-link:aaaa')
    expect(within(card).getByTestId('linked-phrase-missing').textContent).toContain('Cancel it')
    expect(within(card).queryByTestId('linked-confirm')).toBeNull()
    expect(within(card).queryByTestId('linked-name-input')).toBeNull()
    expect(within(card).getByTestId('linked-cancel-pending')).toBeTruthy()
  })

  it('clears the card when the link is reported as made', async () => {
    await mount()
    act(() => pushEvent(pending()))
    expect(screen.getByTestId('linked-pending-device:bbbb')).toBeTruthy()
    act(() => pushEvent({ kind: 'linked', ref: 'device:bbbb', name: 'linux-box' }))
    expect(screen.queryByTestId('linked-pending-device:bbbb')).toBeNull()
  })

  it('keeps an announced link through a status that predates it', async () => {
    await mount()
    act(() => pushEvent(pending()))
    act(() => pushStatus(statusView()))
    expect(screen.getByTestId('linked-pending-device:bbbb')).toBeTruthy()
  })

  it('drops the card when the link goes, even if its status came before its event', async () => {
    // Main may push the status listing the new link before the 'pending' event.
    // The event must not then pin a card that no later status can clear.
    const listed = statusView({
      machines: [machine({ ref: 'device:bbbb', confirmed: false, phrase: PHRASE })],
    })
    await mount()
    act(() => pushStatus(listed))
    act(() => pushEvent(pending()))
    expect(screen.getByTestId('linked-pending-device:bbbb')).toBeTruthy()
    act(() => pushStatus(statusView()))
    expect(screen.queryByTestId('linked-pending-device:bbbb')).toBeNull()
  })

  it('drops the card when the other computer cancels', async () => {
    await mount()
    act(() => pushEvent(pending()))
    act(() =>
      pushStatus(
        statusView({ machines: [machine({ ref: 'device:bbbb', confirmed: false, phrase: PHRASE })] }),
      ),
    )
    expect(screen.getByTestId('linked-pending-device:bbbb')).toBeTruthy()
    act(() => pushStatus(statusView()))
    expect(screen.queryByTestId('linked-pending-device:bbbb')).toBeNull()
  })
})

describe('LinkedMachinesSettings machines', () => {
  it('says when nothing is linked', async () => {
    await mount()
    expect(screen.getByTestId('linked-no-machines')).toBeTruthy()
  })

  it('lists each machine with its state, grants and last activity', async () => {
    const now = Date.now()
    api.status.mockResolvedValue(
      ok(
        statusView({
          machines: [
            machine({ lastActivityAt: now - 300_000 }),
            machine({ ref: 'device:bbbb', name: 'mac', online: false, grants: { run: true, write: true } }),
          ],
        }),
      ),
    )
    await mount()
    expect(screen.queryByTestId('linked-no-machines')).toBeNull()
    expect(input('linked-machine-name-link:aaaa').value).toBe('linux')
    expect(screen.getByTestId('linked-online-link:aaaa').textContent).toBe('online')
    expect(screen.getByTestId('linked-online-device:bbbb').textContent).toBe('offline')
    expect(screen.getByTestId('linked-last-link:aaaa').textContent).toBe('last activity 5m ago')
    expect(screen.getByTestId('linked-last-device:bbbb').textContent).toBe('no activity yet')
    expect(screen.queryByTestId('linked-waiting-link:aaaa')).toBeNull()
    expect(input('linked-grant-link:aaaa-run').checked).toBe(true)
    expect(input('linked-grant-link:aaaa-write').checked).toBe(false)
    expect(input('linked-grant-device:bbbb-write').checked).toBe(true)
    const row = screen.getByTestId('linked-machine-device:bbbb')
    expect(row.textContent).toContain('without asking')
  })

  it('renames on Enter and then follows the saved name', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    api.rename.mockResolvedValue(ok(statusView({ machines: [machine({ name: 'Build box' })] })))
    await mount()
    const field = input('linked-machine-name-link:aaaa')
    fireEvent.change(field, { target: { value: ' Build box ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('link:aaaa', 'Build box'))
    await waitFor(() => expect(field.value).toBe('Build box'))
  })

  it('renames on blur', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    await mount()
    const field = input('linked-machine-name-link:aaaa')
    fireEvent.change(field, { target: { value: 'Build box' } })
    fireEvent.blur(field)
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('link:aaaa', 'Build box'))
  })

  it('puts the saved name back on Escape and ignores other keys', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    await mount()
    const field = input('linked-machine-name-link:aaaa')
    fireEvent.change(field, { target: { value: 'oops' } })
    fireEvent.keyDown(field, { key: 'a' })
    expect(field.value).toBe('oops')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field.value).toBe('linux')
    fireEvent.blur(field)
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('does not rename to an empty or unchanged name', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    await mount()
    const field = input('linked-machine-name-link:aaaa')
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field.value).toBe('linux')
    fireEvent.change(field, { target: { value: ' linux ' } })
    fireEvent.blur(field)
    expect(field.value).toBe('linux')
    expect(api.rename).not.toHaveBeenCalled()
  })

  it('sends one rename when Enter is followed by a blur', async () => {
    let settle: (v: unknown) => void = () => {}
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    api.rename.mockReturnValue(
      new Promise((r) => {
        settle = r
      }),
    )
    await mount()
    const field = input('linked-machine-name-link:aaaa')
    fireEvent.change(field, { target: { value: 'Build box' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field)
    // The typed name stays on screen while the rename is in flight.
    expect(field.value).toBe('Build box')
    await act(async () => {
      settle(ok(statusView({ machines: [machine({ name: 'Build box' })] })))
      await Promise.resolve()
    })
    expect(api.rename).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(field.value).toBe('Build box'))
  })

  it('shows a refused rename and goes back to the saved name', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    api.rename.mockResolvedValue(fail('That name is not allowed.'))
    await mount()
    const field = input('linked-machine-name-link:aaaa')
    fireEvent.change(field, { target: { value: 'x' } })
    fireEvent.blur(field)
    expect((await screen.findByTestId('linked-error')).textContent).toContain('not allowed')
    await waitFor(() => expect(field.value).toBe('linux'))
  })

  it('sends the whole grants object, granting run along with write', async () => {
    api.status.mockResolvedValue(
      ok(statusView({ machines: [machine({ grants: { run: false, write: false } })] })),
    )
    await mount()
    fireEvent.click(screen.getByTestId('linked-grant-link:aaaa-write'))
    await waitFor(() =>
      expect(api.setGrants).toHaveBeenCalledWith('link:aaaa', { run: true, write: true }),
    )
  })

  it('takes write away when run is switched off', async () => {
    api.status.mockResolvedValue(
      ok(statusView({ machines: [machine({ grants: { run: true, write: true } })] })),
    )
    api.setGrants.mockResolvedValue(
      ok(statusView({ machines: [machine({ grants: { run: false, write: false } })] })),
    )
    await mount()
    fireEvent.click(screen.getByTestId('linked-grant-link:aaaa-run'))
    await waitFor(() =>
      expect(api.setGrants).toHaveBeenCalledWith('link:aaaa', { run: false, write: false }),
    )
    await waitFor(() => expect(input('linked-grant-link:aaaa-write').checked).toBe(false))
  })

  it('takes two clicks to unlink', async () => {
    api.status.mockResolvedValue(ok(statusView({ machines: [machine()] })))
    await mount()
    fireEvent.click(screen.getByTestId('linked-unlink-link:aaaa'))
    expect(api.unlink).not.toHaveBeenCalled()
    expect(screen.getByTestId('linked-unlink-confirm-link:aaaa').textContent).toBe('Really unlink?')
    fireEvent.click(screen.getByTestId('linked-unlink-confirm-link:aaaa'))
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith('link:aaaa'))
    await waitFor(() => expect(screen.getByTestId('linked-no-machines')).toBeTruthy())
  })
})

describe('LinkedMachinesSettings activity', () => {
  it('says when no job has run yet', async () => {
    await mount()
    expect(within(screen.getByTestId('linked-activity')).getByTestId('linked-no-activity')).toBeTruthy()
  })

  it('lists jobs newest first with direction, machine, agent, summary, status and duration', async () => {
    const now = Date.now()
    api.status.mockResolvedValue(
      ok(
        statusView({
          activity: [
            job({ id: 'a', startedAt: now - 120_000, durationMs: 65_000 }),
            job({ id: 'b', direction: 'in', machine: 'mac', agent: 'claude', summary: 'Review it', status: 'failed', startedAt: now - 60_000, durationMs: 500 }),
            job({ id: 'c', direction: 'in', machine: 'mac', agent: 'gemini', summary: 'Long task', status: 'running', startedAt: now - 10_000, durationMs: undefined }),
            job({ id: 'd', agent: 'claude', summary: 'Stopped', status: 'cancelled', startedAt: now - 3 * 3_600_000, durationMs: 4_000 }),
          ],
        }),
      ),
    )
    await mount()
    const list = screen.getByTestId('linked-activity')
    const ids = within(list)
      .getAllByTestId(/^linked-activity-/)
      .map((el) => el.getAttribute('data-testid'))
    expect(ids).toEqual(['linked-activity-c', 'linked-activity-b', 'linked-activity-a', 'linked-activity-d'])

    const a = screen.getByTestId('linked-activity-a')
    expect(a.textContent).toContain('to linux')
    expect(a.textContent).toContain('codex')
    expect(a.textContent).toContain('Implement the parser')
    expect(a.textContent).toContain('1m 5s')
    expect(a.textContent).toContain('2m ago')
    expect(within(a).getByText('done').className).toContain('7ee2a3')
    expect(a.querySelector('i.fa-arrow-up')).toBeTruthy()

    const b = screen.getByTestId('linked-activity-b')
    expect(b.textContent).toContain('from mac')
    expect(b.textContent).toContain('<1s')
    expect(within(b).getByText('failed').className).toContain('f28b82')
    expect(b.querySelector('i.fa-arrow-down')).toBeTruthy()

    const c = screen.getByTestId('linked-activity-c')
    expect(within(c).getByText('running')).toBeTruthy()
    expect(c.textContent).not.toMatch(/\d+s\b/)

    const d = screen.getByTestId('linked-activity-d')
    expect(within(d).getByText('cancelled')).toBeTruthy()
    expect(d.textContent).toContain('4s')
    expect(d.textContent).toContain('3h ago')
  })

  it('shows at most twenty jobs', async () => {
    const activity = Array.from({ length: 25 }, (_, i) => job({ id: `j${i}`, startedAt: i }))
    api.status.mockResolvedValue(ok(statusView({ activity })))
    await mount()
    expect(within(screen.getByTestId('linked-activity')).getAllByTestId(/^linked-activity-/)).toHaveLength(20)
  })
})

describe('LinkedMachinesSettings clock', () => {
  it('refreshes relative times once a minute', async () => {
    vi.useFakeTimers()
    try {
      const base = Date.now()
      api.status.mockResolvedValue(
        ok(statusView({ machines: [machine({ lastActivityAt: base - 5_000 })] })),
      )
      render(<LinkedMachinesSettings />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByTestId('linked-last-link:aaaa').textContent).toBe('last activity just now')
      act(() => {
        vi.advanceTimersByTime(120_000)
      })
      expect(screen.getByTestId('linked-last-link:aaaa').textContent).toBe('last activity 2m ago')
    } finally {
      vi.useRealTimers()
    }
  })
})
