// What a pane shows while its account is switched in place (src/renderer/src/components/Accounts/
// SwitchOverlay.tsx, the in-app account UI §2.2): the overlay with the two accounts and the three
// steps, "your keys are held" after a key; then the toast with Switch back (its 10 s are
// accountSwitchRun's); or the error card, what happened and what the terminal shows now, with its buttons and Show steps. A
// swarm worker's one line in the swarm dashboard. The buttons' work (actOnRun) is mocked here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../../src/renderer/src/lib/accountSwitchRun', async (orig) => ({
  ...(await orig<object>()),
  actOnRun: vi.fn(async () => undefined),
}))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { actOnRun } from '../../src/renderer/src/lib/accountSwitchRun'
import type { SwitchRun } from '../../src/renderer/src/lib/accountSwitchRun'
import { HELD_HINT_MS, SwitchOverlay, SwitchStatusLine } from '../../src/renderer/src/components/Accounts/SwitchOverlay'

const run = (over: Partial<SwitchRun> = {}): SwitchRun => ({
  terminalId: 't1', agent: 'claude', from: { id: 'acc_a', label: 'personal', color: '#22D3EE' }, to: { id: 'acc_b', label: 'codedev', color: '#7ee2a3' },
  reason: 'by hand', status: 'running', steps: ['done', 'working', 'pending'], answers: {}, ...over,
})
const put = (r: SwitchRun | null) => act(() => { useTerminalStore.setState({ switchRuns: r ? { [r.terminalId]: r } : {} }) })
const st = useTerminalStore.getState

beforeEach(() => {
  vi.mocked(actOnRun).mockClear()
  useTerminalStore.setState({ switchRuns: {} })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SwitchOverlay', () => {
  it('shows nothing without a switch, or in a store that holds none', () => {
    render(<SwitchOverlay terminalId="t1" />)
    expect(screen.queryByTestId('switch-overlay')).toBeNull()
    act(() => { useTerminalStore.setState({ switchRuns: undefined as never }) })
    expect(screen.queryByTestId('switch-overlay')).toBeNull()
  })

  it('shows the two accounts and the steps, each in its own state, while it runs', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run())
    const overlay = screen.getByTestId('switch-overlay')
    expect(overlay).toHaveTextContent('Switching Claude Code to codedev')
    expect(overlay.querySelector('[title="personal"]')).toHaveTextContent('P')
    expect(overlay.querySelector('[title="codedev"]')).toHaveTextContent('C')
    const steps = Array.from(screen.getByTestId('switch-steps').querySelectorAll('li'))
    expect(steps.map((s) => [s.textContent, s.getAttribute('data-state')])).toEqual([
      ['Ending this sessiondone', 'done'],
      ['Starting Claude Code on codedevworking', 'working'],
      ['Resuming your conversationpending', 'pending'],
    ])
    expect(screen.getByRole('status')).toBe(overlay.querySelector('[role="status"]'))
    expect(screen.queryByTestId('switch-keys-held')).toBeNull()
  })

  it('says it checks the sign-in first, and names an account it didn\'t know as unknown', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'checking', from: null, to: { id: 'acc_b', label: '', color: '#fff' } }))
    expect(screen.getByTestId('switch-checking')).toHaveTextContent('Checking ’s sign-in…'.replace('’', '\''))
    expect(screen.getByTestId('switch-overlay').querySelector('[title="unknown account"]')).toHaveTextContent('?')
    expect(screen.queryByTestId('switch-steps')).toBeNull()
  })

  it('says the keys are held after a key, for a few seconds', () => {
    vi.useFakeTimers()
    render(<SwitchOverlay terminalId="t1" />)
    put(run())
    act(() => { st().noteHeldKey('t1') })
    expect(screen.getByTestId('switch-keys-held')).toHaveTextContent('Switching accounts: your keys are held until it finishes')
    act(() => { vi.advanceTimersByTime(HELD_HINT_MS) })
    expect(screen.queryByTestId('switch-keys-held')).toBeNull()
  })

  it('shows the toast when it\'s done, with Switch back, and goes on its close', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'done', steps: ['done', 'done', 'done'], toast: { text: 'Claude Code is on codedev now. Conversation resumed.', until: Date.now() + 10_000, back: 'acc_a' } }))
    expect(screen.getByTestId('switch-toast')).toHaveTextContent('Claude Code is on codedev now. Conversation resumed.')
    expect(screen.queryByTestId('switch-overlay')).toBeNull()
    fireEvent.click(screen.getByTestId('switch-back'))
    expect(actOnRun).toHaveBeenCalledWith('t1', 'back')
    put(run({ status: 'done', toast: { text: 'x', until: Date.now() + 10_000, back: null } }))
    expect(screen.queryByTestId('switch-back')).toBeNull()
    fireEvent.click(screen.getByTestId('switch-toast-close'))
    expect(st().switchRuns).toEqual({})
    expect(screen.queryByTestId('switch-toast')).toBeNull()
  })

  it('turns into the error card, with its buttons, the first one at hand, and the steps on request', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({
      status: 'failed', steps: ['failed', 'pending', 'pending'],
      card: { what: 'Claude Code didn\'t confirm it exited, so Termpolis typed nothing more.', now: 'Claude Code may still be running here, on personal.', actions: [{ kind: 'exited', label: 'It has exited, switch now' }, { kind: 'retry', label: 'Try again' }, { kind: 'close', label: 'Close' }] },
    }))
    const card = screen.getByTestId('switch-error')
    expect(card).toHaveTextContent('Claude Code didn\'t confirm it exited, so Termpolis typed nothing more.Claude Code may still be running here, on personal.')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByTestId('switch-action-exited'))
    expect(screen.getByTestId('switch-action-exited').className).not.toBe(screen.getByTestId('switch-action-retry').className)
    fireEvent.click(screen.getByTestId('switch-action-retry'))
    expect(actOnRun).toHaveBeenCalledWith('t1', 'retry')
    expect(screen.queryByTestId('switch-steps')).toBeNull()
    fireEvent.click(screen.getByTestId('switch-show-steps'))
    expect(screen.getByTestId('switch-steps').querySelector('li')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('switch-show-steps')).toHaveTextContent('Hide steps')
    fireEvent.click(screen.getByTestId('switch-show-steps'))
    expect(screen.queryByTestId('switch-steps')).toBeNull()
  })

  it('draws a lone Close as a plain button', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'failed', card: { what: 'w', now: 'n', actions: [{ kind: 'close', label: 'Close' }] } }))
    expect(screen.getByTestId('switch-action-close').className).toBe(screen.getByTestId('switch-show-steps').className)
  })
})

describe('where the keyboard goes when the card or the toast goes (UI-R1-F)', () => {
  let pane: HTMLElement
  beforeEach(() => {
    pane = document.createElement('div')
    pane.setAttribute('data-terminal-id', 't1')
    pane.innerHTML = '<textarea></textarea>'
    document.body.appendChild(pane)
  })
  afterEach(() => pane.remove())

  it('is the terminal when a button of the error card is pressed', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'failed', card: { what: 'w', now: 'n', actions: [{ kind: 'close', label: 'Close' }] } }))
    fireEvent.click(screen.getByTestId('switch-action-close'))
    expect(actOnRun).toHaveBeenCalledWith('t1', 'close')
    expect(document.activeElement).toBe(pane.querySelector('textarea'))
  })

  it('is the terminal when Switch back is pressed on the toast (UI2-3)', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'done', steps: ['done', 'done', 'done'], toast: { text: 'Claude Code is on codedev now.', until: Date.now() + 10_000, back: 'acc_a' } }))
    const back = screen.getByTestId('switch-back')
    back.focus()
    expect(document.activeElement).toBe(back)
    fireEvent.click(back)
    expect(actOnRun).toHaveBeenCalledWith('t1', 'back')
    expect(document.activeElement).toBe(pane.querySelector('textarea'))
  })

  // UI R3-2: `left-1/2` gave the toast half the pane to be in, so a sentence of three lines (the new-session words, a worktree left,
  // options not carried) stood 226 px tall in a 260 px pane, over the input line.
  it('is as wide as its words need up to most of the pane, centred between its insets, not squeezed into half of it (R3-2)', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'done', steps: ['done', 'done', 'done'], toast: { text: 'Claude Code is on codedev now. '.repeat(8), until: Date.now() + 10_000, back: null } }))
    const el = screen.getByTestId('switch-toast')
    expect(el.className).toContain('inset-x-3')
    expect(el.className).toContain('mx-auto')
    expect(el.className).toContain('w-fit')
    expect(el.className).toMatch(/max-w-\[90%\]/)
    expect(el.className).not.toMatch(/left-1\/2|-translate-x-1\/2/)
  })

  it('is the terminal when the toast is dismissed', () => {
    render(<SwitchOverlay terminalId="t1" />)
    put(run({ status: 'done', steps: ['done', 'done', 'done'], toast: { text: 'Claude Code is on codedev now.', until: Date.now() + 10_000, back: 'acc_a' } }))
    fireEvent.click(screen.getByTestId('switch-toast-close'))
    expect(document.activeElement).toBe(pane.querySelector('textarea'))
  })
})

describe('SwitchStatusLine (a swarm worker\'s, in the swarm dashboard)', () => {
  it('shows nothing without a switch, or in a store that holds none', () => {
    render(<SwitchStatusLine terminalId="t1" />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { useTerminalStore.setState({ switchRuns: undefined as never }) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says it is switching, then that it is done, which can be dismissed', () => {
    render(<SwitchStatusLine terminalId="t1" />)
    put(run())
    expect(screen.getByTestId('switch-status-running')).toHaveTextContent('Switching to codedev…')
    put(run({ status: 'done', toast: { text: 'Claude Code is on codedev now. Conversation resumed.', until: 0, back: 'acc_a' } }))
    expect(screen.getByTestId('switch-status-done')).toHaveTextContent('Claude Code is on codedev now. Conversation resumed.')
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(st().switchRuns).toEqual({})
  })

  it('says what went wrong, with the card\'s buttons', () => {
    render(<SwitchStatusLine terminalId="t1" />)
    put(run({ status: 'failed', card: { what: 'Claude Code didn\'t exit.', now: 'n', actions: [{ kind: 'retry', label: 'Try again' }, { kind: 'close', label: 'Close' }] } }))
    expect(screen.getByTestId('switch-status-failed')).toHaveTextContent('Claude Code didn\'t exit.Try againClose')
    fireEvent.click(screen.getByTestId('switch-status-retry'))
    expect(actOnRun).toHaveBeenCalledWith('t1', 'retry')
  })
})

// UI4-2: a switch that fails while the user types in another pane must not hand their next Space or Enter to this card's Try again.
const FAILED = run({
  status: 'failed', steps: ['failed', 'pending', 'pending'],
  card: { what: 'Claude Code didn\'t confirm it exited, so Termpolis typed nothing more.', now: 'Claude Code may still be running here, on personal.', actions: [{ kind: 'retry', label: 'Try again' }, { kind: 'close', label: 'Close' }] },
})

describe('the error card and the keyboard (UI4-2)', () => {
  it('leaves the focus where the user is typing: in another pane', () => {
    render(<div><textarea data-testid="other-pane" /><div data-terminal-id="t1"><SwitchOverlay terminalId="t1" /></div></div>)
    const other = screen.getByTestId('other-pane')
    other.focus()
    expect(document.activeElement).toBe(other)
    put(FAILED)
    expect(screen.getByTestId('switch-error')).toBeInTheDocument()
    // The user is typing in the other pane: a key they type next must not press this card's "Try again".
    expect(document.activeElement).toBe(other)
  })

  it('takes the keyboard when it was in this pane (the user was waiting on this switch), or nowhere', () => {
    render(<div><div data-terminal-id="t1"><textarea data-testid="own-pane" /><SwitchOverlay terminalId="t1" /></div></div>)
    screen.getByTestId('own-pane').focus()
    put(FAILED)
    expect(document.activeElement).toBe(screen.getByTestId('switch-action-retry'))
  })
})
