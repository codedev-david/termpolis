// The account switch dialog (src/renderer/src/components/Accounts/AccountSwitcherDialog.tsx, §7.1):
// its rows, what it asks before a switch, the sign-in check, the run with its steps, each outcome's
// words and next step, "New terminal on <account>", and agy's card. Main is the preload's mock.
import React from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('uuid', () => ({ v4: () => 'new-term' }))

import { AccountSwitcherDialog } from '../../src/renderer/src/components/Accounts/AccountSwitcherDialog'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SwitchOutcome, SwitchProgress } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test', connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, email: 'a@example.test', ...over,
  }
}

const A = row({})
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, email: 'b@example.test', lastEmail: 'b@example.test', order: 1, color: '#123456' })
const W = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, autoOffer: false, connect: false, email: 'w@example.test', lastEmail: 'w@example.test', order: 2 })

function view(accounts: AccountRowView[]): AccountsView {
  return { accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' }
}

const T: TerminalSession = { id: 't1', name: 'Claude Code — repo', color: '#D97706', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude', agentAccountId: 'acc_a' }

let progress: ((p: SwitchProgress) => void) | null
let accounts: Record<string, ReturnType<typeof vi.fn>>
let termpolis: Record<string, ReturnType<typeof vi.fn>>

function signedIn(r: AccountRowView, signed: boolean | null = true) {
  return { success: true, data: { ...r, identity: { email: signed ? r.email : null, signedIn: signed, checkedAt: 1, source: 'auth-status' } } }
}

beforeEach(() => {
  progress = null
  accounts = {
    list: vi.fn(async () => ({ success: true, data: useTerminalStore.getState().accountsView })),
    check: vi.fn(async (id: string) => signedIn(id === 'acc_b' ? B : id === 'acc_w' ? W : A)),
    switchAccount: vi.fn(async () => ({ success: true, data: { kind: 'switched', resumed: true, sessionId: 's' } as SwitchOutcome })),
    onSwitchProgress: vi.fn((cb: (p: SwitchProgress) => void) => { progress = cb; return () => { progress = null } }),
    launchAccount: vi.fn(async (_agent: string, id: string | null) => ({ success: true, data: { accountId: id } })),
    launchLine: vi.fn(async (req: { command: string; accountId: string | null }) => ({ success: true, data: { line: req.command, accountId: req.accountId, explicit: true } })),
  }
  termpolis = {
    claudeTrustWorkspace: vi.fn(async () => ({ success: true, data: { changed: true, keys: [] } })),
    memoryPrepareCodexContext: vi.fn(async () => ({ success: true, data: { developerInstructions: null, approvals: 0 } })),
    createTerminal: vi.fn(async () => ({ success: true })),
    writeToTerminal: vi.fn(),
    clipboardWriteText: vi.fn(async () => ({ success: true })),
  }
  ;(window as never as Record<string, unknown>).accounts = accounts
  ;(window as never as Record<string, unknown>).termpolis = termpolis
  useTerminalStore.setState({
    terminals: [T], activeTerminalId: 't1', accountsView: view([A, B, W]), accountsByHand: {}, accountSwitch: null,
    relaunching: {}, memoryNotice: null, showSettings: false,
  })
})

afterEach(() => { delete (window as { accounts?: unknown }).accounts })

const openFor = (id = 't1') => act(() => { useTerminalStore.getState().openAccountSwitch(id) })

describe('AccountSwitcherDialog', () => {
  it('renders nothing until it is opened, and lists the terminal\'s other accounts', async () => {
    render(<AccountSwitcherDialog />)
    expect(screen.queryByTestId('account-switcher')).toBeNull()
    openFor()
    expect(screen.getByTestId('account-switcher-current')).toHaveTextContent('Claude Code — repo runs on personal')
    const rows = screen.getAllByTestId('account-switcher-row')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('codedev'),
      expect.stringMatching(/work.*not offered automatically.*not connected: loses Termpolis's tools/),
    ])
    await waitFor(() => expect(accounts.list).toHaveBeenCalled())
  })

  it('switches here after checking the target is signed in, then closes with the toast', async () => {
    render(<AccountSwitcherDialog />)
    openFor()
    let release!: (v: unknown) => void
    accounts.switchAccount.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(accounts.check).toHaveBeenCalledWith('acc_b')
    expect(screen.getByTestId('account-switcher-running')).toHaveTextContent('Switching to codedev…')
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'account' })
    // The close button waits for the run, and so does Escape.
    expect(screen.getByTestId('account-switcher-close')).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('account-switcher')).toBeInTheDocument()
    act(() => { progress!({ terminalId: 't1', step: 'exiting' }) })
    expect(screen.getByTestId('account-switcher-running')).toHaveTextContent('Exiting Claude Code…')
    act(() => { progress!({ terminalId: 'other', step: 'typing' }) })
    expect(screen.getByTestId('account-switcher-running')).toHaveTextContent('Exiting Claude Code…')
    act(() => { progress!({ terminalId: 't1', step: 'carrying' }) })
    expect(screen.getByTestId('account-switcher-running')).toHaveTextContent('Copying the conversation to codedev…')
    await act(async () => { release({ success: true, data: { kind: 'switched', resumed: true } }) })
    expect(termpolis.claudeTrustWorkspace).toHaveBeenCalledWith('/repo', 'acc_b')
    expect(accounts.switchAccount).toHaveBeenCalledWith({ terminalId: 't1', targetId: 'acc_b', shellType: 'gitbash', reason: 'by hand' })
    expect(screen.queryByTestId('account-switcher')).toBeNull()
    expect(useTerminalStore.getState().memoryNotice).toMatch(/^Now on codedev\./)
    expect(useTerminalStore.getState().relaunching).toEqual({})
  })

  it.each([
    ['confirming', 'Waiting for Claude Code to exit…'],
    ['typing', 'Typing the account line…'],
    ['waiting', 'Waiting for Claude Code to start on codedev…'],
  ] as const)('says the %s step', async (step, words) => {
    render(<AccountSwitcherDialog />)
    openFor()
    accounts.switchAccount.mockImplementationOnce(() => new Promise(() => undefined))
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    act(() => { progress!({ terminalId: 't1', step }) })
    expect(screen.getByTestId('account-switcher-running')).toHaveTextContent(words)
  })

  it('asks its second confirmation for an account not offered automatically, and Back goes back', async () => {
    render(<AccountSwitcherDialog />)
    openFor()
    fireEvent.click(screen.getAllByTestId('account-switcher-switch')[1])
    expect(screen.getByTestId('account-switcher-confirm')).toHaveTextContent('work isn\'t offered automatically. Switch this terminal to work?')
    expect(accounts.check).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getAllByTestId('account-switcher-row')).toHaveLength(2)
    fireEvent.click(screen.getAllByTestId('account-switcher-switch')[1])
    await act(async () => { fireEvent.click(screen.getByTestId('account-switcher-confirm-yes')) })
    expect(accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_w' }))
  })

  it('offers a fresh session first from an account not offered automatically', async () => {
    useTerminalStore.setState({ terminals: [{ ...T, agentAccountId: 'acc_w' }] })
    render(<AccountSwitcherDialog />)
    openFor()
    const first = screen.getAllByTestId('account-switcher-row')[0].querySelectorAll('button')
    expect(first[0]).toHaveTextContent('New terminal')
    expect(first[1]).toHaveTextContent('Switch here')
    await act(async () => { fireEvent.click(first[0]) })
    expect(termpolis.createTerminal).toHaveBeenCalledWith('new-term', 'gitbash', '/repo', undefined, true, 'acc_a')
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 'new-term')).toEqual(expect.objectContaining({ agentAccountId: 'acc_a' }))
    expect(screen.queryByTestId('account-switcher')).toBeNull()
  })

  it('says why a new terminal couldn\'t open', async () => {
    termpolis.createTerminal.mockResolvedValueOnce({ success: false, error: 'No shell available' })
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-new')[0]) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('Termpolis couldn\'t open the terminal: No shell available')
  })

  it('sends a signed-out target to its sign-in in Settings ▸ Accounts', async () => {
    accounts.check.mockResolvedValueOnce(signedIn(B, false))
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(screen.getByTestId('account-switcher-signed-out')).toHaveTextContent('codedev is signed out')
    fireEvent.click(screen.getByText('Sign in to codedev…'))
    expect(useTerminalStore.getState().showSettings).toBe(true)
    expect(screen.queryByTestId('account-switcher')).toBeNull()
    expect(accounts.switchAccount).not.toHaveBeenCalled()
  })

  it('asks before switching to a target whose sign-in it couldn\'t tell', async () => {
    const unknown = row({ ...B, id: 'acc_u', label: 'unknown', lastEmail: null })
    useTerminalStore.setState({ accountsView: view([A, unknown]) })
    accounts.check.mockResolvedValue({ success: false, error: 'a check could refresh its sign-in' })
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(screen.getByTestId('account-switcher-unknown-sign-in')).toHaveTextContent('Termpolis couldn\'t tell whether unknown is signed in: a check could refresh its sign-in')
    fireEvent.click(screen.getByText('Back'))
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    await act(async () => { fireEvent.click(screen.getByTestId('account-switcher-anyway')) })
    expect(accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_u' }))
  })

  it('shows an outcome that needs an answer, and runs again with it', async () => {
    accounts.switchAccount.mockResolvedValueOnce({ success: true, data: { kind: 'busy' } })
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(screen.getByTestId('account-switcher-result')).toHaveTextContent('Claude Code is working. Stop it and switch?')
    await act(async () => { fireEvent.click(screen.getByTestId('account-switcher-retry')) })
    expect(accounts.switchAccount).toHaveBeenLastCalledWith(expect.objectContaining({ stopBusy: true }))
    expect(screen.queryByTestId('account-switcher')).toBeNull()
  })

  it('offers the line to copy when it never showed, and Back to the list', async () => {
    accounts.switchAccount.mockResolvedValueOnce({ success: true, data: { kind: 'didnt-start', line: 'export X=1 && claude' } })
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    await act(async () => { fireEvent.click(screen.getByTestId('account-switcher-copy')) })
    expect(termpolis.clipboardWriteText).toHaveBeenCalledWith('export X=1 && claude')
    expect(screen.getByTestId('account-switcher-copy')).toHaveTextContent('Copied')
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getAllByTestId('account-switcher-row')).toHaveLength(2)
  })

  it('keeps an outcome that ended badly open, with no Back once it is done', async () => {
    accounts.switchAccount.mockResolvedValueOnce({ success: true, data: { kind: 'sign-in' } })
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(screen.getByTestId('account-switcher-result')).toHaveTextContent('codedev needs a sign-in')
    expect(screen.queryByText('Back')).toBeNull()
    fireEvent.click(screen.getByTestId('account-switcher-close'))
    expect(screen.queryByTestId('account-switcher')).toBeNull()
  })

  it('refuses while another relaunch holds the terminal', async () => {
    useTerminalStore.setState({ relaunching: { t1: 'model' } })
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent('A model change or another switch is running in Claude Code — repo: wait for it to finish.')
    expect(accounts.switchAccount).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'model' })
  })

  it('says a target is signed in to another email, and lists every account for a terminal changed by hand', () => {
    useTerminalStore.setState({ accountsView: view([A, row({ ...B, lastEmail: 'x@example.test' }), row({ ...W, email: undefined })]), accountsByHand: { t1: true } })
    render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-current')).toHaveTextContent('runs on an account changed by hand')
    const rows = screen.getAllByTestId('account-switcher-row')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent('signed in to x@example.test instead!')
    expect(rows[2]).toHaveTextContent('work · last signed in as w@example.test')
  })

  it('says it is asking whether the target is signed in, and goes back from a signed-out one', async () => {
    let answer!: (v: unknown) => void
    accounts.check.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    render(<AccountSwitcherDialog />)
    openFor()
    // A step reported while nothing runs changes nothing.
    act(() => { progress!({ terminalId: 't1', step: 'typing' }) })
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(screen.getByTestId('account-switcher-checking')).toHaveTextContent('Asking Claude Code whether codedev is signed in…')
    expect(screen.getByTestId('account-switcher-close')).toBeDisabled()
    await act(async () => { answer(signedIn(B, false)) })
    fireEvent.click(screen.getByText('Back'))
    expect(screen.getAllByTestId('account-switcher-row')).toHaveLength(2)
  })

  it('says what a terminal it can\'t switch is, and offers to add an account when there is no other', () => {
    useTerminalStore.setState({ terminals: [{ ...T, agentCommand: undefined }] })
    const { unmount } = render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-none')).toBeInTheDocument()
    unmount()
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    // A terminal with no record: on its default profile, probably, and every account listed.
    useTerminalStore.setState({ terminals: [{ ...T, agentAccountId: undefined }], accountsView: view([A]) })
    const second = render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-current')).toHaveTextContent('runs on its default profile, probably')
    expect(screen.getAllByTestId('account-switcher-row')).toHaveLength(1)
    second.unmount()
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    useTerminalStore.setState({ terminals: [T] })
    render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-empty')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Open Settings ▸ Accounts'))
    expect(useTerminalStore.getState().showSettings).toBe(true)
  })

  it('shows agy\'s card for an agy terminal, and closes on Escape', () => {
    const G = row({ id: 'g1', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false })
    useTerminalStore.setState({ terminals: [{ ...T, agentCommand: 'agy', agentAccountId: 'g1' }], accountsView: view([G]) })
    render(<AccountSwitcherDialog />)
    openFor()
    expect(screen.getByTestId('account-switcher-agy')).toHaveTextContent('one Google sign-in for your whole computer user')
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByTestId('account-switcher')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('account-switcher')).toBeNull()
  })

  it('works with a preload that reports no steps', async () => {
    delete accounts.onSwitchProgress
    render(<AccountSwitcherDialog />)
    openFor()
    await act(async () => { fireEvent.click(screen.getAllByTestId('account-switcher-switch')[0]) })
    expect(accounts.switchAccount).toHaveBeenCalled()
  })
})
