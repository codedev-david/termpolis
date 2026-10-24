// The account chip in a terminal's header, the Settings line about the active terminal, and the
// renderer's copy of main's accounts view and of its word on each terminal's account.
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AccountChip } from '../../src/renderer/src/components/Accounts/AccountChip'
import { ActiveTerminalAccount } from '../../src/renderer/src/components/Accounts/ActiveTerminalAccount'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { noteTerminalAccount, refreshAccounts, watchAccounts } from '../../src/renderer/src/lib/accountsState'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { TerminalSession } from '../../src/renderer/src/types'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/home/me/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}

const VIEW: AccountsView = {
  accounts: [row({}), row({ id: 'acc_b', label: 'codedev', profile: '/home/me/.claude-b', folder: '/home/me/.claude-b', isDefault: false, color: '#123456', order: 1 })],
  preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/home/me',
}

function term(over: Partial<TerminalSession>): TerminalSession {
  return { id: 't1', name: 'Claude Code — repo', color: '', shellType: 'bash', cwd: '/repo', fontSize: 12, theme: '', fontFamily: '', agentCommand: 'claude', ...over }
}

beforeEach(() => {
  useTerminalStore.setState({ terminals: [term({ agentAccountId: 'acc_b' })], activeTerminalId: 't1', accountsView: VIEW, accountsByHand: {}, accountSwitch: null, accountMenu: null, queuedSwitches: {} })
})

afterEach(() => { delete (window as { accounts?: unknown }).accounts })

describe('AccountChip', () => {
  it('shows the account and opens the switch dialog for its terminal', () => {
    render(<AccountChip terminalId="t1" />)
    const chip = screen.getByTestId('account-chip')
    expect(chip).toHaveTextContent('codedev')
    expect(chip).toHaveAttribute('data-alert', 'false')
    expect(chip.getAttribute('title')).toMatch(/^Claude Code on codedev/)
    fireEvent.click(chip)
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
  })

  it('turns red with "?" once main says the account was changed by hand', () => {
    render(<AccountChip terminalId="t1" />)
    act(() => { noteTerminalAccount({ terminalId: 't1', accountId: 'acc_b', byHand: true }) })
    expect(screen.getByTestId('account-chip')).toHaveTextContent('?')
    expect(screen.getByTestId('account-chip')).toHaveAttribute('data-alert', 'true')
  })

  it('shows nothing for a plain shell, or before the view is read', () => {
    useTerminalStore.setState({ terminals: [term({ agentCommand: undefined })] })
    const { rerender } = render(<AccountChip terminalId="t1" />)
    expect(screen.queryByTestId('account-chip')).toBeNull()
    useTerminalStore.setState({ terminals: [term({})], accountsView: null })
    rerender(<AccountChip terminalId="t1" />)
    expect(screen.queryByTestId('account-chip')).toBeNull()
  })
})

describe('ActiveTerminalAccount', () => {
  it('names the active terminal\'s agent and account, and opens the switch dialog for it', () => {
    render(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('Active terminal: Claude Code — repo — Claude Code on codedev')
    fireEvent.click(screen.getByTestId('accounts-switch-active'))
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
  })

  it('says how the account stands when it isn\'t a registered one', () => {
    const { rerender } = render(<ActiveTerminalAccount view={VIEW} />)
    act(() => { useTerminalStore.setState({ accountsByHand: { t1: true } }) })
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('on an account changed by hand')
    act(() => { useTerminalStore.setState({ accountsByHand: {}, terminals: [term({ agentAccountId: 'acc_gone' })] }) })
    rerender(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('on a removed account')
    act(() => { useTerminalStore.setState({ terminals: [term({})] }) })
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('on probably its default profile')
  })

  it('asks for an agent terminal when the active one is none, the conductor, or there is no active one', () => {
    useTerminalStore.setState({ terminals: [term({ agentCommand: 'bash' })] })
    const { rerender } = render(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('Open an agent terminal to switch its account.')
    act(() => { useTerminalStore.setState({ terminals: [term({ isConductor: true })] }) })
    rerender(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.queryByTestId('accounts-switch-active')).toBeNull()
    act(() => { useTerminalStore.setState({ activeTerminalId: null }) })
    expect(screen.queryByTestId('accounts-switch-active')).toBeNull()
  })
})

describe('accountsState', () => {
  it('reads main\'s view into the store, and keeps the last one when it can\'t', async () => {
    useTerminalStore.setState({ accountsView: null })
    expect(await refreshAccounts({ list: vi.fn(async () => ({ success: true as const, data: VIEW })) })).toBe(VIEW)
    expect(useTerminalStore.getState().accountsView).toBe(VIEW)
    expect(await refreshAccounts({ list: vi.fn(async () => ({ success: false as const, error: 'unreadable' })) })).toBeNull()
    expect(await refreshAccounts({ list: vi.fn(async () => { throw new Error('gone') }) })).toBeNull()
    expect(await refreshAccounts(undefined)).toBeNull()
    expect(useTerminalStore.getState().accountsView).toBe(VIEW)
  })

  it('reads window.accounts by default', async () => {
    useTerminalStore.setState({ accountsView: null })
    ;(window as { accounts?: unknown }).accounts = { list: vi.fn(async () => ({ success: true, data: VIEW })) }
    expect(await refreshAccounts()).toBe(VIEW)
  })

  it('records the account main put a terminal on, clearing a change by hand', () => {
    useTerminalStore.setState({ accountsByHand: { t1: true } })
    noteTerminalAccount({ terminalId: 't1', accountId: 'acc_a', byHand: false })
    expect(useTerminalStore.getState().accountsByHand).toEqual({})
    expect(useTerminalStore.getState().terminals[0].agentAccountId).toBe('acc_a')
    noteTerminalAccount({ terminalId: 't1', accountId: null, byHand: false })
    expect(useTerminalStore.getState().terminals[0].agentAccountId).toBeUndefined()
  })

  // §9: a swarm worker has no agentCommand; main says which agent run_command started in it.
  it('records a swarm worker\'s agent as main names it, and keeps it while a line typed there changes the account', () => {
    noteTerminalAccount({ terminalId: 't1', accountId: 'acc_a', byHand: false, agent: 'codex' })
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ agentAccountId: 'acc_a', swarmAgent: 'codex' })
    noteTerminalAccount({ terminalId: 't1', accountId: null, byHand: true })
    expect(useTerminalStore.getState().terminals[0].swarmAgent).toBe('codex')
    expect(useTerminalStore.getState().accountsByHand).toEqual({ t1: true })
  })

  it('follows main\'s word and reads the view once, until unsubscribed', async () => {
    let listener: ((e: { terminalId: string; accountId: string | null; byHand: boolean }) => void) | null = null
    const off = vi.fn()
    const api = {
      list: vi.fn(async () => ({ success: true as const, data: VIEW })),
      onTerminalAccount: vi.fn((cb: typeof listener) => { listener = cb; return off }),
    }
    const stop = watchAccounts(api as never)
    expect(api.list).toHaveBeenCalledTimes(1)
    listener!({ terminalId: 't1', accountId: 'acc_b', byHand: true })
    expect(useTerminalStore.getState().accountsByHand).toEqual({ t1: true })
    stop()
    expect(off).toHaveBeenCalled()
    // No bridge: nothing to follow.
    expect(watchAccounts(undefined)()).toBeUndefined()
  })
})

describe('the store\'s switch dialog state', () => {
  it('opens for one terminal and closes', () => {
    useTerminalStore.getState().openAccountSwitch('t9')
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't9' })
    useTerminalStore.getState().closeAccountMenu()
    expect(useTerminalStore.getState().accountMenu).toBeNull()
  })
})

describe('AccountChip: a switch waiting for the agent\'s turn to end', () => {
  it('marks the chip, says where it goes, and cancels it with its ×', () => {
    render(<AccountChip terminalId="t1" />)
    act(() => { useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'acc_a', reason: 'by hand' } } }) })
    expect(screen.getByTestId('account-chip-queued')).toBeInTheDocument()
    const name = useTerminalStore.getState().accountsView!.accounts.find((r) => r.id === 'acc_a')!.label
    expect(screen.getByTestId('account-chip').getAttribute('title')).toContain(`Switching to ${name} when it finishes.`)
    expect(screen.getByTestId('account-chip-cancel')).toHaveAttribute('aria-label', `Cancel the switch to ${name}`)
    fireEvent.click(screen.getByTestId('account-chip-cancel'))
    expect(useTerminalStore.getState().queuedSwitches).toEqual({})
    expect(screen.queryByTestId('account-chip-queued')).toBeNull()
    // The cancel is the chip's own: it opens no menu.
    expect(useTerminalStore.getState().accountMenu).toBeNull()
  })

  it('names no account it no longer has', () => {
    render(<AccountChip terminalId="t1" />)
    act(() => { useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'gone', reason: 'by hand' } } }) })
    expect(screen.getByTestId('account-chip').getAttribute('title')).toContain('Switching to another account when it finishes.')
    expect(screen.getByTestId('account-chip-cancel')).toHaveAttribute('aria-label', 'Cancel the switch to another account')
  })
})
