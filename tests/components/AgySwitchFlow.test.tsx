// agy's guided switch in the account switch dialog (src/renderer/src/components/Accounts/
// AgySwitchFlow.tsx): the confirmation that every agy terminal on this computer moves, each step in
// main, the sign-in left to the user in a card beside the terminal while the pollers stay away, the
// resume once agy's box is back, and the exact words wherever a step was the user's to take.
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AccountSwitcherDialog } from '../../src/renderer/src/components/Accounts/AccountSwitcherDialog'
import { SIGN_IN_POLL_MS } from '../../src/renderer/src/components/Accounts/AgySwitchFlow'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { AgyStepOutcome, AgyStepRequest } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

const ID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'g1', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false, autoOffer: true, order: 0,
    connect: false, origin: 'label', folderExists: false, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, email: 'home@example.test', ...over,
  }
}
const G1 = row({})
const G2 = row({ id: 'g2', label: 'work', email: 'work@example.test', order: 1 })

function view(accounts: AccountRowView[]): AccountsView {
  return { accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' }
}

const T: TerminalSession = { id: 't1', name: 'agy — repo', color: '', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'agy', agentAccountId: 'g1' }

let steps: AgyStepRequest[]
let answers: Partial<Record<AgyStepRequest['step'], AgyStepOutcome[]>>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  steps = []
  answers = {
    'sign-out': [{ kind: 'signing-in', conversationId: ID, mark: 40 }],
    check: [{ kind: 'waiting' }, { kind: 'signed-in' }],
    resume: [{ kind: 'switched', fresh: false, conversationId: ID, shownEmail: 'work@example.test' }],
  }
  ;(window as never as Record<string, unknown>).accounts = {
    list: vi.fn(async () => ({ success: true, data: useTerminalStore.getState().accountsView })),
    onSwitchProgress: vi.fn(() => () => undefined),
    agySwitch: vi.fn(async (req: AgyStepRequest) => {
      steps.push(req)
      const list = answers[req.step]!
      return { success: true, data: list.length > 1 ? list.shift() : list[0] }
    }),
  }
  ;(window as never as Record<string, unknown>).termpolis = { clipboardWriteText: vi.fn(async () => ({ success: true })) }
  useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1', accountsView: view([G1, G2]), accountsByHand: {}, accountSwitch: null, relaunching: {}, memoryNotice: null })
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as { accounts?: unknown }).accounts
})

const openFor = () => act(() => { useTerminalStore.getState().openAccountSwitch('t1') })
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('agy\'s guided switch', () => {
  it('confirms that every agy terminal moves, signs out, waits for the user\'s sign-in, then resumes by id', async () => {
    render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getAllByTestId('account-switcher-row').map((r) => r.textContent)).toEqual([expect.stringContaining('work@example.test')])
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    expect(screen.getByTestId('agy-confirm')).toHaveTextContent('every agy terminal on this computer moves to the account you sign in with (work@example.test)')
    expect(steps).toEqual([])
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(steps[0]).toEqual({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'sign-out' })
    // The sign-in is the user's: a card beside the terminal, which takes their keys, while the
    // pollers answer nothing there.
    expect(screen.getByTestId('agy-signing-in')).toHaveTextContent('Sign in as work@example.test in the agy terminal')
    expect(screen.queryByTestId('account-switcher-overlay')).toBeNull()
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'sign-in' })
    // Esc in the terminal is agy's now, not the dialog's.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('agy-sign-in-card')).toBeInTheDocument()
    await tick(SIGN_IN_POLL_MS)
    expect(steps[1]).toEqual(expect.objectContaining({ step: 'check', mark: 40 }))
    expect(screen.getByTestId('agy-signing-in')).toBeInTheDocument()
    await tick(SIGN_IN_POLL_MS)
    await tick(0)
    expect(steps.map((s) => s.step)).toEqual(['sign-out', 'check', 'check', 'resume'])
    expect(steps[3]).toEqual(expect.objectContaining({ conversationId: ID }))
    expect(screen.queryByTestId('account-switcher')).toBeNull()
    expect(screen.queryByTestId('agy-sign-in-card')).toBeNull()
    expect(useTerminalStore.getState().memoryNotice).toBe('agy is on work now, and this conversation continues. Every agy terminal on this computer moved with it. agy shows work@example.test.')
    expect(useTerminalStore.getState().relaunching).toEqual({})
  })

  it('says when agy shows another email, or started a new conversation', async () => {
    answers['sign-out'] = [{ kind: 'signing-in', conversationId: null, mark: 1 }]
    answers.resume = [{ kind: 'switched', fresh: true, conversationId: null, shownEmail: 'other@example.test' }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    await act(async () => { fireEvent.click(screen.getByTestId('agy-resume-now')) })
    expect(useTerminalStore.getState().memoryNotice).toBe('agy is on work now, with a new conversation: it couldn\'t find this one. agy shows other@example.test, not work@example.test.')
  })

  it('names no email agy didn\'t show, and asks no address of an account that has none', async () => {
    useTerminalStore.setState({ accountsView: view([G1, row({ ...G2, email: undefined })]) })
    answers.resume = [{ kind: 'switched', fresh: false, conversationId: ID }]
    render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-row')).toHaveTextContent('no email given')
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    expect(screen.getByTestId('agy-confirm')).not.toHaveTextContent('(')
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('agy-signing-in')).toHaveTextContent('Sign in in the agy terminal')
    await act(async () => { fireEvent.click(screen.getByTestId('agy-resume-now')) })
    expect(useTerminalStore.getState().memoryNotice).toBe('agy is on work now, and this conversation continues. Every agy terminal on this computer moved with it.')
  })

  it('types /login on the user\'s click when agy showed its box and no sign-in', async () => {
    answers['sign-out'] = [{ kind: 'needs-login', conversationId: ID, mark: 9 }]
    answers.login = [{ kind: 'signing-in', conversationId: ID, mark: 9 }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('agy-needs-login')).toHaveTextContent('Type /login in agy and sign in there.')
    await act(async () => { fireEvent.click(screen.getByTestId('agy-type-login')) })
    expect(steps[1]).toEqual(expect.objectContaining({ step: 'login', conversationId: ID, mark: 9 }))
    expect(screen.getByTestId('agy-signing-in')).toBeInTheDocument()
  })

  it('asks whether agy exited when Termpolis can\'t tell, and goes on with the user\'s word', async () => {
    answers['sign-out'] = [{ kind: 'unknown-exit' }, { kind: 'unknown-exit' }, { kind: 'signing-in', conversationId: ID, mark: 2 }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('agy-unknown-exit')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getByTestId('account-switcher-row')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    fireEvent.click(screen.getByText('Back'))
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    await act(async () => { fireEvent.click(screen.getByTestId('agy-exited')) })
    expect(steps[2]).toEqual(expect.objectContaining({ step: 'sign-out', assumeExited: true }))
    expect(screen.getByTestId('agy-signing-in')).toBeInTheDocument()
  })

  it('refuses the resume and /login while another relaunch holds the terminal', async () => {
    answers['sign-out'] = [{ kind: 'needs-login', conversationId: ID, mark: 9 }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    act(() => { useTerminalStore.setState({ relaunching: { t1: 'model' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('agy-type-login')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('A model change or another switch is running')
    // From the card again: the resume is refused the same way.
    answers['sign-out'] = [{ kind: 'signing-in', conversationId: ID, mark: 9 }]
    act(() => { useTerminalStore.setState({ relaunching: {} }) })
    fireEvent.click(screen.getByTestId('account-switcher-close'))
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    act(() => { useTerminalStore.setState({ relaunching: { t1: 'model' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('agy-resume-now')) })
    expect(screen.getByTestId('account-switcher-error')).toBeInTheDocument()
    expect(steps.filter((s) => s.step === 'resume' || s.step === 'login')).toEqual([])
  })

  it('gives the exact words, and the line to copy, for a step that was the user\'s', async () => {
    answers['sign-out'] = [{ kind: 'do-it-yourself', say: 'Type /exit in agy, then: agy --conversation=x', line: 'agy --conversation=x' }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('agy-diy')).toHaveTextContent('Type /exit in agy, then: agy --conversation=x')
    await act(async () => { fireEvent.click(screen.getByTestId('agy-copy')) })
    expect((window as never as { termpolis: { clipboardWriteText: ReturnType<typeof vi.fn> } }).termpolis.clipboardWriteText).toHaveBeenCalledWith('agy --conversation=x')
    expect(screen.getByTestId('agy-copy')).toHaveTextContent('Copied')
  })

  it('shows the words alone when there is no line', async () => {
    answers['sign-out'] = [{ kind: 'do-it-yourself', say: 'Type /login in agy and sign in there.' }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.queryByTestId('agy-copy')).toBeNull()
  })

  it('says why main refused, and what a stray answer means', async () => {
    answers['sign-out'] = [{ kind: 'refused', why: 'agy signs in with GEMINI_API_KEY from the environment here' }]
    const { unmount } = render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('Termpolis didn\'t switch agy: agy signs in with GEMINI_API_KEY from the environment here.')
    unmount()
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    answers['sign-out'] = [{ kind: 'waiting' }]
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('agy is still at its sign-in.')
  })

  it('turns a failed call into a refusal, and a call main refused into its words', async () => {
    const api = (window as never as { accounts: { agySwitch: ReturnType<typeof vi.fn> } }).accounts
    api.agySwitch.mockRejectedValueOnce(new Error('ipc closed'))
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('Termpolis didn\'t switch agy: ipc closed.')
    api.agySwitch.mockResolvedValueOnce({ success: false, error: 'switching accounts isn\'t available' })
    fireEvent.click(screen.getByTestId('account-switcher-close'))
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('switching accounts isn\'t available')
    api.agySwitch.mockRejectedValueOnce('odd')
    fireEvent.click(screen.getByTestId('account-switcher-close'))
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('odd')
  })

  it('holds the pane while a step types, and refuses while another relaunch holds it', async () => {
    let release!: (v: unknown) => void
    const api = (window as never as { accounts: { agySwitch: ReturnType<typeof vi.fn> } }).accounts
    api.agySwitch.mockImplementationOnce(() => new Promise((r) => { release = r }))
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-running')).toHaveTextContent('Exiting agy and signing it out…')
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'account' })
    expect(screen.getByTestId('account-switcher-close')).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('account-switcher')).toBeInTheDocument()
    await act(async () => { release({ success: true, data: { kind: 'unknown-exit' } }) })
    expect(useTerminalStore.getState().relaunching).toEqual({})
    // Another relaunch holds the terminal: refused, its hold kept.
    act(() => { useTerminalStore.setState({ relaunching: { t1: 'model' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('agy-exited')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('A model change or another switch is running in agy — repo')
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'model' })
  })

  it('lets the terminal go when the card is cancelled, or the dialog closes, while the user signs in', async () => {
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    fireEvent.click(screen.getByTestId('agy-cancel'))
    expect(useTerminalStore.getState().relaunching).toEqual({})
    expect(screen.queryByTestId('agy-sign-in-card')).toBeNull()
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'sign-in' })
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    expect(useTerminalStore.getState().relaunching).toEqual({})
  })

  it('looks once at a time while a look is under way, and stops looking once agy is back', async () => {
    let answer!: (v: unknown) => void
    const api = (window as never as { accounts: { agySwitch: ReturnType<typeof vi.fn> } }).accounts
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getByTestId('account-switcher-switch'))
    await act(async () => { fireEvent.click(screen.getByTestId('agy-confirm-yes')) })
    api.agySwitch.mockImplementationOnce((req: AgyStepRequest) => { steps.push(req); return new Promise((r) => { answer = r }) })
    await tick(SIGN_IN_POLL_MS)
    await tick(SIGN_IN_POLL_MS)
    expect(steps.filter((s) => s.step === 'check')).toHaveLength(1)
    await act(async () => { answer({ success: true, data: { kind: 'signed-in' } }) })
    await tick(0)
    expect(steps.map((s) => s.step)).toEqual(['sign-out', 'check', 'resume'])
  })

  it('offers to add an account when agy has no other', () => {
    useTerminalStore.setState({ accountsView: view([G1]) })
    render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-empty')).toHaveTextContent('agy has no other account here')
  })
})
