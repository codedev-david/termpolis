// The account chip in a terminal's header, the Settings line about the active terminal, and the
// renderer's copy of main's accounts view and of its word on each terminal's account.
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AccountChip } from '../../src/renderer/src/components/Accounts/AccountChip'
import { ActiveTerminalAccount } from '../../src/renderer/src/components/Accounts/ActiveTerminalAccount'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { noteTerminalAccount, refreshAccounts, watchAccounts, watchLimitEnds } from '../../src/renderer/src/lib/accountsState'
import { canSwitchAccount } from '../../src/renderer/src/lib/accountsView'
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

  it('closes its own menu when it is clicked while that is open, and opens another terminal\'s menu for itself (UI-R1-D)', () => {
    render(<AccountChip terminalId="t1" />)
    const chip = screen.getByTestId('account-chip')
    fireEvent.click(chip)
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
    fireEvent.click(chip)
    expect(useTerminalStore.getState().accountMenu).toBeNull()
    fireEvent.click(chip)
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
    // The menu of another terminal is not this chip's to close: it opens its own.
    act(() => { useTerminalStore.setState({ accountMenu: { terminalId: 'other' } }) })
    fireEvent.click(chip)
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
  })

  it('keeps its click from the pane header it sits in, which would take it for its own (UI-R1-I)', () => {
    const header = vi.fn()
    render(<div onClick={header}><AccountChip terminalId="t1" /></div>)
    fireEvent.click(screen.getByTestId('account-chip'))
    expect(header).not.toHaveBeenCalled()
  })

  it('names itself and says whether its menu is open, for assistive technology', () => {
    render(<AccountChip terminalId="t1" />)
    const chip = screen.getByTestId('account-chip')
    expect(chip).toHaveAccessibleName('Claude Code account: codedev. Switch account')
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    act(() => { useTerminalStore.setState({ accountMenu: { terminalId: 't1' } }) })
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    // A menu open for another terminal is no state of this chip.
    act(() => { useTerminalStore.setState({ accountMenu: { terminalId: 'other' } }) })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  it('turns red with "?" once main says the account was changed by hand', () => {
    render(<AccountChip terminalId="t1" />)
    act(() => { noteTerminalAccount({ terminalId: 't1', accountId: 'acc_b', byHand: true }) })
    expect(screen.getByTestId('account-chip')).toHaveTextContent('?')
    expect(screen.getByTestId('account-chip')).toHaveAttribute('data-alert', 'true')
  })

  // UI R3-8: the toolbar row is right-anchored and does not wrap, and the chip is its first item, so a narrow pane clips it first; the label
  // had no width at all (a 40-character label is about 230 px).
  it('keeps its width in a narrow pane, and cuts a long label with an ellipsis (R3-8)', () => {
    act(() => { useTerminalStore.setState({ accountsView: { ...VIEW, accounts: [VIEW.accounts[0], { ...VIEW.accounts[1], label: 'a very long account label of forty chars!!' }] } }) })
    render(<AccountChip terminalId="t1" />)
    const chip = screen.getByTestId('account-chip')
    expect(chip.className).toContain('shrink-0')
    expect(chip.className).toMatch(/max-w-\[10rem\]/)
    const label = screen.getByTestId('account-chip-label')
    expect(label).toHaveTextContent('a very long account label of forty chars!!')
    expect(label.className).toContain('truncate')
    expect(label.className).toContain('min-w-0')
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

  // UI2-5: Settings replaces the main area, so a switch begun from it showed its progress, toast and error card in a
  // pane that was not on screen. The terminal comes first, then the menu opens over it, as from the chip.
  it('shows the terminal before it opens the menu, so the switch is seen from start to end', () => {
    useTerminalStore.setState({ showSettings: true, activeTerminalId: 't1' })
    render(<ActiveTerminalAccount view={VIEW} />)
    fireEvent.click(screen.getByTestId('accounts-switch-active'))
    expect(useTerminalStore.getState().showSettings).toBe(false)
    expect(useTerminalStore.getState().activeTerminalId).toBe('t1')
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
  })

  // UI2-4: the chip, Ctrl+Shift+N and the palette count a swarm worker by the agent run_command started in it, and so does
  // this line (an MCP-created worker has no agentCommand, only swarmAgent).
  it('counts a swarm worker by the agent started in it, as the chip does', () => {
    useTerminalStore.setState({ terminals: [term({ agentCommand: undefined, isSwarm: true, swarmAgent: 'claude', agentAccountId: 'acc_a' })], activeTerminalId: 't1' })
    render(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('Claude Code on personal')
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

  // UI2-3: the × goes with the queue it cancels, and the focus it held would go to <body>, where typing reaches nothing.
  it('gives the keyboard back to the terminal when its × cancels the switch', () => {
    const pane = document.createElement('div')
    pane.setAttribute('data-terminal-id', 't1')
    pane.innerHTML = '<textarea></textarea>'
    document.body.appendChild(pane)
    try {
      render(<AccountChip terminalId="t1" />)
      act(() => { useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'acc_a', reason: 'by hand' } } }) })
      const cancel = screen.getByTestId('account-chip-cancel')
      cancel.focus()
      expect(document.activeElement).toBe(cancel)
      fireEvent.click(cancel)
      expect(useTerminalStore.getState().queuedSwitches).toEqual({})
      expect(document.activeElement).toBe(pane.querySelector('textarea'))
    } finally {
      pane.remove()
    }
  })

  it('names no account it no longer has', () => {
    render(<AccountChip terminalId="t1" />)
    act(() => { useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'gone', reason: 'by hand' } } }) })
    expect(screen.getByTestId('account-chip').getAttribute('title')).toContain('Switching to another account when it finishes.')
    expect(screen.getByTestId('account-chip-cancel')).toHaveAttribute('aria-label', 'Cancel the switch to another account')
  })
})

describe('canSwitchAccount: an account menu, its keys and its line mean something only for an agent that has an account', () => {
  const claude = { agentCommand: 'claude --model opus' }
  it('is true for an account agent whose agent has an account', () => {
    expect(canSwitchAccount(claude, VIEW)).toBe(true)
    expect(canSwitchAccount({ agentCommand: 'codex' }, { accounts: [...VIEW.accounts, row({ id: 'cx', agent: 'codex' })] })).toBe(true)
  })

  it('is false for a plain shell, a wrapper, the conductor, no terminal, and an agent with no account of its own', () => {
    expect(canSwitchAccount({ agentCommand: 'bash' }, VIEW)).toBe(false)
    expect(canSwitchAccount({}, VIEW)).toBe(false)
    expect(canSwitchAccount({ agentCommand: 'claude-sandbox' }, VIEW)).toBe(false)
    expect(canSwitchAccount({ ...claude, isConductor: true }, VIEW)).toBe(false)
    expect(canSwitchAccount(undefined, VIEW)).toBe(false)
    expect(canSwitchAccount({ agentCommand: 'codex' }, VIEW)).toBe(false)
  })

  it('is false with no accounts at all (D13), or before they were read', () => {
    expect(canSwitchAccount(claude, null)).toBe(false)
    expect(canSwitchAccount(claude, undefined)).toBe(false)
    expect(canSwitchAccount(claude, { accounts: [] })).toBe(false)
  })

  it('counts a swarm worker by the agent run_command started in it', () => {
    expect(canSwitchAccount({ isSwarm: true, swarmAgent: 'claude' }, VIEW)).toBe(true)
    expect(canSwitchAccount({ isSwarm: true, swarmAgent: 'codex' }, VIEW)).toBe(false)
  })
})

describe('the Settings line about the active terminal, for an agent with no account', () => {
  it('offers no Switch account… that would do nothing, and says why', () => {
    useTerminalStore.setState({ terminals: [term({ agentCommand: 'codex' })], activeTerminalId: 't1' })
    render(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.queryByTestId('accounts-switch-active')).toBeNull()
    expect(screen.getByTestId('accounts-active-terminal')).toHaveTextContent('Active terminal: Claude Code — repo — Codex has no account of its own yet: add one to switch it.')
    expect(useTerminalStore.getState().accountMenu).toBeNull()
  })

  it('keeps the button for an agent that has one', () => {
    useTerminalStore.setState({ terminals: [term({})], activeTerminalId: 't1' })
    render(<ActiveTerminalAccount view={VIEW} />)
    expect(screen.getByTestId('accounts-switch-active')).toBeInTheDocument()
  })
})

// 1.63.1, David's report: "codedev out of usage" stayed in the sidebar after codedev's window had
// passed. The view the renderer holds now drops a limit or a marker the moment it ends, on one timer.
describe('the accounts view keeps itself current as limits end', () => {
  const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
  const H = 3_600_000
  const limited = (over: Partial<AccountRowView>): AccountsView => ({ ...VIEW, accounts: [VIEW.accounts[0], { ...VIEW.accounts[1], ...over }] })
  const codedev = () => useTerminalStore.getState().accountsView!.accounts[1]
  let stop: (() => void) | null = null
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
    useTerminalStore.setState({ accountsView: null })
  })

  it('drops a limit with no reset time when its cooldown ends, and reads main\'s view again', async () => {
    const api = { list: vi.fn(async () => ({ success: true as const, data: VIEW })) }
    useTerminalStore.setState({ accountsView: limited({ limit: { seenAt: NOW, resetsAt: null, text: 'x', scope: 'account' }, limitEnds: NOW + 5 * H }) })
    stop = watchLimitEnds(api as never)
    await vi.advanceTimersByTimeAsync(5 * H - 1)
    expect(codedev().limit).toBeDefined()
    expect(api.list).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(codedev().limit).toBeUndefined()
    expect(api.list).toHaveBeenCalledTimes(1)
  })

  it('drops the failover hook\'s marker when its cooldown ends', async () => {
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW - H, limitedOutsideEnds: NOW + 4 * H }) })
    stop = watchLimitEnds(undefined)
    await vi.advanceTimersByTimeAsync(4 * H - 1)
    expect(codedev().limitedOutside).toBe(NOW - H)
    await vi.advanceTimersByTimeAsync(1000)
    expect(codedev().limitedOutside).toBeUndefined()
  })

  it('sets one timer at a time, to the next end, and none while nothing is limited (no poll)', async () => {
    useTerminalStore.setState({ accountsView: VIEW })
    stop = watchLimitEnds(undefined)
    expect(vi.getTimerCount()).toBe(0)
    useTerminalStore.setState({ accountsView: { ...VIEW, accounts: [{ ...VIEW.accounts[0], limit: { seenAt: NOW, resetsAt: NOW + 2 * H, text: 'x', scope: 'account' }, limitEnds: NOW + 2 * H }, { ...VIEW.accounts[1], limitedOutside: NOW, limitedOutsideEnds: NOW + H }] } })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(H + 1000)
    expect(codedev().limitedOutside).toBeUndefined()
    expect(useTerminalStore.getState().accountsView!.accounts[0].limit).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(H)
    expect(useTerminalStore.getState().accountsView!.accounts[0].limit).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for an end past setTimeout\'s longest delay in steps', async () => {
    const far = NOW + 30 * 24 * H
    useTerminalStore.setState({ accountsView: limited({ limit: { seenAt: NOW, resetsAt: far, text: 'x', scope: 'account' }, limitEnds: far }) })
    stop = watchLimitEnds(undefined)
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
    expect(codedev().limit).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(far - Date.now() + 1000)
    expect(codedev().limit).toBeUndefined()
  })

  it('does nothing when the view went away before the timer fired, and stops on its stop', async () => {
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
    stop = watchLimitEnds(undefined)
    useTerminalStore.setState({ accountsView: null })
    expect(vi.getTimerCount()).toBe(0)
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
    expect(vi.getTimerCount()).toBe(1)
    stop()
    stop = null
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * H)
    expect(codedev().limitedOutside).toBe(NOW)
  })

  it('a newer view moves the timer to its own next end', async () => {
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
    stop = watchLimitEnds(undefined)
    // Main read the hook's marker again: it now ends later.
    const later = limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + 3 * H })
    useTerminalStore.setState({ accountsView: later })
    await vi.advanceTimersByTimeAsync(H + 1000)
    expect(useTerminalStore.getState().accountsView).toBe(later)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('watchAccounts keeps the view current too, and its stop stops the timer', async () => {
    const api = { list: vi.fn(async () => ({ success: true as const, data: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })), onTerminalAccount: vi.fn(() => () => undefined) }
    stop = watchAccounts(api as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(codedev().limitedOutside).toBe(NOW)
    api.list.mockResolvedValue({ success: true as const, data: VIEW })
    await vi.advanceTimersByTimeAsync(H + 1000)
    expect(codedev().limitedOutside).toBeUndefined()
    stop()
    stop = null
    expect(vi.getTimerCount()).toBe(0)
  })

  const showing = (state: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  afterEach(() => { Reflect.deleteProperty(document, 'visibilityState') })

  it('re-checks at once when the window becomes visible or gains focus after a sleep that outlasted a limit (no poll)', async () => {
    const api = { list: vi.fn(async () => ({ success: true as const, data: VIEW })) }
    const wakes = [
      () => { showing('visible'); document.dispatchEvent(new Event('visibilitychange')) },
      () => { window.dispatchEvent(new Event('focus')) },
    ]
    for (const wake of wakes) {
      useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
      api.list.mockClear()
      stop = watchLimitEnds(api as never)
      // The laptop slept: the clock is past the end, and no timer ran.
      vi.setSystemTime(NOW + 2 * H)
      expect(codedev().limitedOutside).toBe(NOW)
      await act(async () => { wake() })
      expect(codedev().limitedOutside).toBeUndefined()
      expect(api.list).toHaveBeenCalledTimes(1)
      stop()
      stop = null
      vi.setSystemTime(NOW)
    }
  })

  it('ignores a hidden window, and a focus with nothing ended makes no list call', async () => {
    const api = { list: vi.fn(async () => ({ success: true as const, data: VIEW })) }
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
    stop = watchLimitEnds(api as never)
    vi.setSystemTime(NOW + 2 * H)
    showing('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(codedev().limitedOutside).toBe(NOW)
    vi.setSystemTime(NOW + 1000)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    expect(codedev().limitedOutside).toBe(NOW)
    expect(api.list).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    // No view at all: nothing to check.
    useTerminalStore.setState({ accountsView: null })
    window.dispatchEvent(new Event('focus'))
    expect(api.list).not.toHaveBeenCalled()
  })

  it('starts and stops without a document or a window to listen on', async () => {
    const api = { list: vi.fn(async () => ({ success: true as const, data: VIEW })) }
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('window', undefined)
    try {
      const s = watchLimitEnds(api as never)
      expect(vi.getTimerCount()).toBe(1)
      s()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('its stop removes both listeners', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const addWin = vi.spyOn(window, 'addEventListener')
    const rem = vi.spyOn(document, 'removeEventListener')
    const remWin = vi.spyOn(window, 'removeEventListener')
    const api = { list: vi.fn(async () => ({ success: true as const, data: VIEW })) }
    useTerminalStore.setState({ accountsView: limited({ limitedOutside: NOW, limitedOutsideEnds: NOW + H }) })
    const s = watchLimitEnds(api as never)
    const onVisible = add.mock.calls.find((c) => c[0] === 'visibilitychange')![1]
    const onFocus = addWin.mock.calls.find((c) => c[0] === 'focus')![1]
    s()
    expect(rem).toHaveBeenCalledWith('visibilitychange', onVisible)
    expect(remWin).toHaveBeenCalledWith('focus', onFocus)
    vi.setSystemTime(NOW + 2 * H)
    showing('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    expect(codedev().limitedOutside).toBe(NOW)
    expect(api.list).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
