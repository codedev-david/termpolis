// The account menu (src/renderer/src/components/Accounts/AccountMenu.tsx, the in-app account UI
// §2.1): a popover from the terminal's chip, one row per account of its agent with the current one
// checked; picking one starts the switch in place (accountSwitchRun, here mocked), a busy agent's
// waits for its turn, a signed-out one signs in first, the work account asks again (D14); its
// footer opens a new terminal on another account or Settings ▸ Accounts. Keyboard: arrows,
// Home/End, type-ahead, Enter/Space, Esc back to the terminal. Nothing at all with no account (D13).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { TerminalSession } from '../../src/renderer/src/types'

vi.mock('../../src/renderer/src/lib/accountSwitchRun', () => ({
  startSwitch: vi.fn(async () => undefined),
  queueSwitch: vi.fn(),
  newTerminalOn: vi.fn(async () => ({ ok: true, id: 'n1' })),
}))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { newTerminalOn, queueSwitch, startSwitch } from '../../src/renderer/src/lib/accountSwitchRun'
import { consumePendingSettingsTab } from '../../src/renderer/src/lib/settingsNav'
import { AccountMenu } from '../../src/renderer/src/components/Accounts/AccountMenu'
import { MENU_WIDTH, focusTerminal, menuPosition } from '../../src/renderer/src/lib/accountMenu'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test',
    connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[]): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
  }
}

const A = row({ id: 'acc_a', label: 'personal' })
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, lastEmail: 'b@example.test', order: 1 })
const C = row({ id: 'acc_c', label: 'contoso', profile: '/h/.claude-c', folder: '/h/.claude-c', isDefault: false, lastEmail: null, order: 2 })
const GONE = row({ id: 'acc_g', label: 'gone', profile: '/h/.claude-g', folder: '/h/.claude-g', isDefault: false, folderExists: false, order: 3 })
const W = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, autoOffer: false, connect: false, lastEmail: 'w@corp.test', order: 4 })
const G1 = row({ id: 'g1', agent: 'agy', label: 'me', email: 'me@example.test', folder: null, connection: null, folderExists: false, lastEmail: null })
const G2 = row({ id: 'g2', agent: 'agy', label: 'other', email: 'o@example.test', folder: null, connection: null, folderExists: false, lastEmail: null, isDefault: false })
const T: TerminalSession = { id: 't1', name: 'Claude Code — repo', color: '#D97706', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude', agentAccountId: 'acc_a' }
const st = useTerminalStore.getState

const limitLook = vi.fn(async (_id: string) => ({ success: true as const, data: { live: true, status: { status: 'idle' } } }))
const list = vi.fn(async () => ({ success: true as const, data: st().accountsView! }))

function openMenu(over: { terminals?: TerminalSession[]; accounts?: AccountRowView[] | null; id?: string; byHand?: boolean } = {}) {
  const accounts = over.accounts === undefined ? [A, B, C, GONE, W] : over.accounts
  useTerminalStore.setState({
    terminals: over.terminals ?? [T], accountsView: accounts ? view(accounts) : null, accountsByHand: over.byHand ? { t1: true } : {},
    queuedSwitches: {}, accountMenu: { terminalId: over.id ?? 't1' }, signInSheet: null, agySwitchSheet: null, showSettings: false, addAccountSheet: null,
  })
  return render(<AccountMenu />)
}
const rows = () => screen.getAllByTestId('account-menu-row')
// The row whose label is `label` (its avatar's initial comes first in its text).
const rowOf = (label: string) => rows().find((r) => Array.from(r.querySelectorAll('span')).some((x) => x.textContent === label))!
const key = (k: string) => fireEvent.keyDown(screen.getByTestId('account-menu'), { key: k })
const settle = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.mocked(startSwitch).mockClear()
  vi.mocked(queueSwitch).mockClear()
  vi.mocked(newTerminalOn).mockClear()
  limitLook.mockClear()
  list.mockClear()
  ;(window as unknown as { accounts: unknown }).accounts = { limitLook, list }
})

afterEach(() => {
  useTerminalStore.setState({ accountMenu: null })
  // React's tree first: emptying the body under a mounted portal leaves React removing a node
  // that is no longer there, an uncaught error that fails the whole run.
  cleanup()
  document.body.innerHTML = ''
})

describe('when there is a menu', () => {
  it('drops a request it cannot show, so it does not pop up by itself when an account is added later', async () => {
    for (const setup of [
      () => openMenu({ accounts: [] }),
      () => openMenu({ terminals: [{ ...T, agentCommand: undefined }] }),
      () => openMenu({ terminals: [{ ...T, agentCommand: 'codex' }], accounts: [A] }),
    ]) {
      const { unmount } = setup()
      await settle()
      expect(useTerminalStore.getState().accountMenu).toBeNull()
      unmount()
    }
    // Accounts arrive afterwards: no menu appears that nobody asked for now.
    useTerminalStore.setState({ terminals: [T], accountsView: view([A, B]) })
    render(<AccountMenu />)
    await settle()
    expect(screen.queryByTestId('account-menu')).toBeNull()
  })

  it('keeps a request for a terminal or a view that may yet arrive: only one that can never show is dropped', async () => {
    const first = openMenu({ id: 'nope' })
    await settle()
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 'nope' })
    first.unmount()
    openMenu({ accounts: null })
    await settle()
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
  })

  it('is none with no account registered, or for a terminal, agent or view it doesn\'t know (D13)', async () => {
    for (const setup of [
      () => openMenu({ accounts: [] }),
      () => openMenu({ accounts: null }),
      () => openMenu({ id: 'nope' }),
      () => openMenu({ terminals: [{ ...T, agentCommand: undefined }] }),
      () => openMenu({ terminals: [{ ...T, isConductor: true }] }),
    ]) {
      const { unmount } = setup()
      expect(screen.queryByTestId('account-menu')).toBeNull()
      unmount()
    }
    useTerminalStore.setState({ accountMenu: null, accountsView: view([A]) })
    render(<AccountMenu />)
    expect(screen.queryByTestId('account-menu')).toBeNull()
    await settle()
  })
})

describe('the rows', () => {
  it('lists the agent\'s accounts in order, the current one checked and focused, each with its email and status', async () => {
    openMenu()
    await settle()
    const menu = screen.getByRole('menu', { name: 'Claude Code accounts for Claude Code — repo' })
    expect(menu).toHaveTextContent('Claude Code · Claude Code — repo')
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false'])
    expect(rowOf('personal')).toHaveTextContent('personala@example.testSigned in')
    expect(rowOf('codedev')).toHaveTextContent('codedevb@example.testSigned in')
    expect(rowOf('contoso')).toHaveTextContent('contosoSigned outSign in to contoso and switch')
    expect(rowOf('gone')).toHaveAttribute('aria-disabled', 'true')
    expect(rowOf('gone')).toHaveTextContent('Its profile folder is missing')
    expect(rowOf('work')).toHaveTextContent('Not offered automaticallyNot connected: loses Termpolis\'s tools')
    expect(document.activeElement).toBe(rowOf('personal'))
    // The statuses as main has them now, behind the menu.
    expect(list).toHaveBeenCalled()
    expect(limitLook).toHaveBeenCalledWith('t1')
  })

  it('focuses the first item when the terminal\'s account isn\'t known', async () => {
    openMenu({ byHand: true })
    await settle()
    expect(rows().every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(document.activeElement).toBe(rowOf('personal'))
  })

  it('switches in place on a click, Enter or Space, and closes back to the terminal', async () => {
    const pane = document.createElement('div')
    pane.setAttribute('data-terminal-id', 't1')
    const input = document.createElement('textarea')
    pane.appendChild(input)
    document.body.appendChild(pane)
    openMenu()
    await settle()
    fireEvent.click(rowOf('codedev'))
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_b')
    expect(st().accountMenu).toBeNull()
    expect(document.activeElement).toBe(input)
    for (const k of ['Enter', ' ']) {
      act(() => { useTerminalStore.setState({ accountMenu: { terminalId: 't1' } }) })
      await settle()
      key('ArrowDown')
      key(k)
      expect(st().accountMenu).toBeNull()
    }
    expect(startSwitch).toHaveBeenCalledTimes(3)
  })

  it('closes on the current account, and does nothing on one it can\'t switch to', async () => {
    openMenu()
    await settle()
    fireEvent.click(rowOf('gone'))
    expect(st().accountMenu).toEqual({ terminalId: 't1' })
    fireEvent.click(rowOf('personal'))
    expect(st().accountMenu).toBeNull()
    expect(startSwitch).not.toHaveBeenCalled()
  })

  it('waits for a busy agent\'s turn to end: the switch is queued', async () => {
    limitLook.mockResolvedValueOnce({ success: true, data: { live: true, status: { status: 'working' } } })
    openMenu()
    await waitFor(() => expect(rowOf('codedev')).toHaveTextContent('Switch when it finishes'))
    fireEvent.click(rowOf('codedev'))
    expect(queueSwitch).toHaveBeenCalledWith('t1', 'acc_b')
    expect(startSwitch).not.toHaveBeenCalled()
  })

  it('is not busy when it can\'t look, or the agent isn\'t live', async () => {
    for (const answer of [
      () => limitLook.mockRejectedValueOnce(new Error('gone')),
      () => limitLook.mockResolvedValueOnce({ success: false, error: 'x' } as never),
      () => limitLook.mockResolvedValueOnce({ success: true, data: { live: false, status: { status: 'working' } } }),
    ]) {
      answer()
      const { unmount } = openMenu()
      await settle()
      expect(rowOf('codedev')).not.toHaveTextContent('Switch when it finishes')
      unmount()
    }
    // An answer after it closed changes nothing.
    let late!: (v: unknown) => void
    limitLook.mockImplementationOnce(() => new Promise((resolve) => { late = resolve }) as never)
    const { unmount } = openMenu()
    unmount()
    late({ success: true, data: { live: true, status: { status: 'working' } } })
    await settle()
    // With no bridge, it doesn't look.
    ;(window as unknown as { accounts: unknown }).accounts = undefined
    openMenu()
    expect(screen.getByTestId('account-menu')).toBeInTheDocument()
  })

  it('signs a signed-out account in first, then switches; or just signs it in', async () => {
    openMenu()
    await settle()
    fireEvent.click(rowOf('contoso'))
    expect(st().signInSheet?.accountId).toBe('acc_c')
    expect(startSwitch).not.toHaveBeenCalled()
    st().signInSheet!.then!()
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_c', { known: { kind: 'signed-in', email: null } })
    act(() => { useTerminalStore.setState({ accountMenu: { terminalId: 't1' }, signInSheet: null }) })
    await settle()
    fireEvent.click(screen.getByTestId('account-menu-sign-in'))
    expect(st().signInSheet).toEqual({ accountId: 'acc_c' })
    expect(st().accountMenu).toBeNull()
  })

  it('asks the work account\'s second confirmation onto it (D14), and goes back on Cancel or Esc', async () => {
    openMenu()
    await settle()
    fireEvent.click(rowOf('work'))
    expect(screen.getByTestId('account-menu-confirm')).toHaveTextContent('work isn\'t offered automatically. Switch this terminal to work?')
    expect(screen.queryByTestId('account-menu-confirm-new')).toBeNull()
    fireEvent.click(screen.getByTestId('account-menu-confirm-no'))
    expect(screen.queryByTestId('account-menu-confirm')).toBeNull()
    fireEvent.click(rowOf('work'))
    // A key other than Esc in it is the buttons'.
    key('ArrowDown')
    expect(screen.getByTestId('account-menu-confirm')).toBeInTheDocument()
    key('Escape')
    expect(screen.queryByTestId('account-menu-confirm')).toBeNull()
    expect(st().accountMenu).toEqual({ terminalId: 't1' })
    fireEvent.click(rowOf('work'))
    fireEvent.click(screen.getByTestId('account-menu-confirm-yes'))
    // Main refuses the switch without the user's yes (D14, R17): it travels with the call.
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_w', { confirmed: true })
  })

  it('carries the yes through a queued switch (D14, R17)', async () => {
    // A busy agent: the work row becomes "Switch when it finishes", and its yes rides in the queue.
    limitLook.mockResolvedValueOnce({ success: true, data: { live: true, status: { status: 'working' } } })
    openMenu()
    await waitFor(() => expect(rowOf('work')).toHaveTextContent('Switch when it finishes'))
    fireEvent.click(rowOf('work'))
    fireEvent.click(screen.getByTestId('account-menu-confirm-yes'))
    expect(queueSwitch).toHaveBeenCalledWith('t1', 'acc_w', 'by hand', true)
    expect(startSwitch).not.toHaveBeenCalled()
  })

  it('asks about the account the conversation may be on when the terminal was changed by hand, before any switch (D14, R17)', async () => {
    // Termpolis's record says personal, but the user pointed the shell at another profile: it may be work's.
    openMenu({ byHand: true })
    await settle()
    fireEvent.click(rowOf('codedev'))
    expect(screen.getByTestId('account-menu-confirm')).toHaveTextContent('This conversation may be on work, which isn\'t offered automatically. Carry it to codedev?')
    expect(startSwitch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('account-menu-confirm-no'))
    expect(screen.queryByTestId('account-menu-confirm')).toBeNull()
    fireEvent.click(rowOf('codedev'))
    fireEvent.click(screen.getByTestId('account-menu-confirm-yes'))
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_b', { confirmed: true })
  })

  it('offers a fresh session in a new terminal instead, from that question', async () => {
    openMenu({ byHand: true })
    await settle()
    fireEvent.click(rowOf('codedev'))
    fireEvent.click(screen.getByTestId('account-menu-confirm-new'))
    expect(newTerminalOn).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_b' }))
    expect(startSwitch).not.toHaveBeenCalled()
  })

  it('asks it too for an agent that has no record, and carries the yes through a queued switch', async () => {
    limitLook.mockResolvedValueOnce({ success: true, data: { live: true, status: { status: 'working' } } })
    openMenu({ terminals: [{ ...T, agentAccountId: undefined }] })
    await waitFor(() => expect(rowOf('codedev')).toHaveTextContent('Switch when it finishes'))
    fireEvent.click(rowOf('codedev'))
    expect(screen.getByTestId('account-menu-confirm')).toHaveTextContent('This conversation may be on work')
    fireEvent.click(screen.getByTestId('account-menu-confirm-yes'))
    expect(queueSwitch).toHaveBeenCalledWith('t1', 'acc_b', 'by hand', true)
  })

  it('asks nothing extra of a terminal changed by hand when no account is kept from the offers', async () => {
    openMenu({ byHand: true, accounts: [A, B] })
    await settle()
    fireEvent.click(rowOf('codedev'))
    expect(screen.queryByTestId('account-menu-confirm')).toBeNull()
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_b')
  })

  it('signs a signed-out work account in only after the second question, and the switch that follows carries the yes (D14, R17)', async () => {
    openMenu({ accounts: [A, B, row({ ...W, lastEmail: null })] })
    await settle()
    fireEvent.click(rowOf('work'))
    expect(st().signInSheet).toBeNull()
    fireEvent.click(screen.getByTestId('account-menu-confirm-yes'))
    expect(st().signInSheet?.accountId).toBe('acc_w')
    expect(startSwitch).not.toHaveBeenCalled()
    st().signInSheet!.then!()
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_w', { known: { kind: 'signed-in', email: null }, confirmed: true })
  })

  it('asks it carrying a conversation off work, offering a new terminal instead (D14, R17)', async () => {
    openMenu({ terminals: [{ ...T, agentAccountId: 'acc_w' }] })
    await settle()
    fireEvent.click(rowOf('personal'))
    expect(screen.getByTestId('account-menu-confirm')).toHaveTextContent('This conversation is on work, which isn\'t offered automatically. Carry it to personal?')
    expect(screen.getByTestId('account-menu-confirm-yes')).toHaveTextContent('Carry it to personal')
    fireEvent.click(screen.getByTestId('account-menu-confirm-new'))
    expect(newTerminalOn).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_a' }))
    expect(startSwitch).not.toHaveBeenCalled()
    expect(st().accountMenu).toBeNull()
  })

  it('moves every Gemini terminal for an agy account, in its own sheet', async () => {
    openMenu({ terminals: [{ ...T, agentCommand: 'agy', agentAccountId: 'g1' }], accounts: [G1, G2] })
    await settle()
    expect(rowOf('other')).toHaveTextContent('Moves every Gemini terminal')
    // agy has no New terminal on: its one sign-in is every agy terminal's.
    expect(screen.queryByTestId('account-menu-new-terminal')).toBeNull()
    fireEvent.click(rowOf('other'))
    expect(st().agySwitchSheet).toEqual({ targetId: 'g2' })
    expect(st().accountMenu).toBeNull()
  })
})

describe('the keyboard', () => {
  it('moves over the enabled items with the arrows, Home and End', async () => {
    openMenu()
    await settle()
    key('ArrowDown')
    expect(document.activeElement).toBe(rowOf('codedev'))
    key('ArrowDown')
    expect(document.activeElement).toBe(rowOf('contoso'))
    key('ArrowDown')
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-sign-in'))
    // The disabled row is passed over.
    key('ArrowDown')
    expect(document.activeElement).toBe(rowOf('work'))
    key('ArrowUp')
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-sign-in'))
    key('End')
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-manage'))
    key('Home')
    expect(document.activeElement).toBe(rowOf('personal'))
    key('ArrowUp')
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-manage'))
  })

  it('finds a row by its first letters', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(10_000)
    openMenu()
    await settle()
    key('c')
    expect(document.activeElement).toBe(rowOf('codedev'))
    now.mockReturnValue(10_100)
    key('o')
    expect(document.activeElement).toBe(rowOf('codedev'))
    now.mockReturnValue(10_200)
    key('n')
    expect(document.activeElement).toBe(rowOf('contoso'))
    // Later, a letter starts a new search; one nothing starts with stays put.
    now.mockReturnValue(20_000)
    key('w')
    expect(document.activeElement).toBe(rowOf('work'))
    now.mockReturnValue(30_000)
    key('z')
    expect(document.activeElement).toBe(rowOf('work'))
    now.mockRestore()
  })

  it('leaves keys it has no use for alone', async () => {
    openMenu()
    await settle()
    const e = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true })
    screen.getByTestId('account-menu').dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(st().accountMenu).toEqual({ terminalId: 't1' })
  })

  it('closes on Esc or Tab, back to the terminal', async () => {
    for (const k of ['Escape', 'Tab']) {
      const { unmount } = openMenu()
      await settle()
      key(k)
      expect(st().accountMenu).toBeNull()
      unmount()
    }
  })
})

describe('the footer', () => {
  it('opens a new terminal on another account from its submenu, by click or keys', async () => {
    openMenu()
    await settle()
    fireEvent.click(screen.getByTestId('account-menu-new-terminal'))
    const sub = screen.getByTestId('account-menu-submenu')
    expect(sub).toHaveAttribute('aria-label', 'New terminal on another Claude Code account')
    // Every other account but the one with no folder; a signed-out one signs in first.
    expect(screen.getAllByTestId('account-menu-new-on').map((b) => b.textContent)).toEqual(['codedev', 'contosoSigns in first', 'work'])
    expect(screen.getByTestId('account-menu-new-terminal')).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(screen.getAllByTestId('account-menu-new-on')[0])
    key('ArrowDown')
    expect(document.activeElement).toBe(screen.getAllByTestId('account-menu-new-on')[1])
    key('ArrowUp')
    key('ArrowUp')
    expect(document.activeElement).toBe(screen.getAllByTestId('account-menu-new-on')[2])
    // A key the submenu has no use for is left alone.
    key('x')
    key('ArrowLeft')
    expect(screen.queryByTestId('account-menu-submenu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-new-terminal'))
    key('ArrowRight')
    expect(screen.getByTestId('account-menu-submenu')).toBeInTheDocument()
    key('Escape')
    expect(screen.queryByTestId('account-menu-submenu')).toBeNull()
    expect(st().accountMenu).toEqual({ terminalId: 't1' })
    key('Enter')
    key('Enter')
    expect(newTerminalOn).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_b' }))
    expect(st().accountMenu).toBeNull()
  })

  it('signs a signed-out account in before its new terminal opens', async () => {
    openMenu()
    await settle()
    fireEvent.click(screen.getByTestId('account-menu-new-terminal'))
    fireEvent.click(screen.getAllByTestId('account-menu-new-on')[1])
    expect(newTerminalOn).not.toHaveBeenCalled()
    expect(st().signInSheet?.accountId).toBe('acc_c')
    st().signInSheet!.then!()
    expect(newTerminalOn).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_c' }))
  })

  it('offers no new terminal to a swarm worker, or with no other account', async () => {
    const { unmount } = openMenu({ terminals: [{ ...T, agentCommand: undefined, isSwarm: true, swarmAgent: 'claude' }] })
    await settle()
    expect(screen.queryByTestId('account-menu-new-terminal')).toBeNull()
    unmount()
    openMenu({ accounts: [A, GONE] })
    await settle()
    expect(screen.queryByTestId('account-menu-new-terminal')).toBeNull()
    // ArrowRight on another item opens nothing.
    key('ArrowRight')
    expect(screen.queryByTestId('account-menu-submenu')).toBeNull()
  })

  it('opens the Add account wizard for the terminal\'s agent, and Settings ▸ Accounts for Manage accounts…', async () => {
    const { unmount } = openMenu()
    await settle()
    fireEvent.click(screen.getByTestId('account-menu-add'))
    expect(st().accountMenu).toBeNull()
    expect(st().addAccountSheet).toEqual({ agent: 'claude' })
    expect(st().showSettings).toBe(false)
    unmount()
    openMenu()
    await settle()
    fireEvent.click(screen.getByTestId('account-menu-manage'))
    expect(st().accountMenu).toBeNull()
    expect(st().showSettings).toBe(true)
    expect(consumePendingSettingsTab()).toBe('accounts')
  })

  it('shows a waiting switch with Cancel', async () => {
    openMenu()
    act(() => { useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'acc_b', reason: 'by hand' } } }) })
    await settle()
    expect(screen.getByTestId('account-menu')).toHaveTextContent('Switching to codedev when Claude Code finishes')
    const cancel = screen.getByTestId('account-menu-cancel-queued')
    // The queued switch showed up above the rows: the focus stayed on the current account.
    expect(document.activeElement).toBe(rowOf('personal'))
    expect(cancel).toHaveAttribute('tabindex', '-1')
    fireEvent.mouseEnter(cancel)
    expect(cancel).toHaveAttribute('tabindex', '0')
    key('Enter')
    expect(st().queuedSwitches).toEqual({})
    expect(st().accountMenu).toBeNull()
  })

  it('names no account it no longer has for a waiting switch', async () => {
    openMenu()
    act(() => { useTerminalStore.setState({ queuedSwitches: { t1: { targetId: 'gone', reason: 'by hand' } } }) })
    await settle()
    expect(screen.getByTestId('account-menu')).toHaveTextContent('Switching to another account when Claude Code finishes')
    fireEvent.click(screen.getByTestId('account-menu-cancel-queued'))
    expect(st().queuedSwitches).toEqual({})
  })
})

describe('closing and placing', () => {
  it('closes on a click outside it, or the window losing the focus, and not on one inside', async () => {
    const { unmount } = openMenu()
    await settle()
    fireEvent.mouseDown(screen.getByTestId('account-menu'))
    expect(st().accountMenu).toEqual({ terminalId: 't1' })
    fireEvent.mouseDown(document.body)
    expect(st().accountMenu).toBeNull()
    unmount()
    openMenu()
    await settle()
    fireEvent.blur(window)
    expect(st().accountMenu).toBeNull()
  })

  it('takes the mouse\'s hover as the item at hand, and keeps the context menu off', async () => {
    openMenu()
    await settle()
    fireEvent.mouseEnter(rowOf('work'))
    key('ArrowUp')
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-sign-in'))
    for (const id of ['account-menu-sign-in', 'account-menu-new-terminal', 'account-menu-add']) fireEvent.mouseEnter(screen.getByTestId(id))
    key('ArrowUp')
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-new-terminal'))
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByTestId('account-menu').dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('opens under the chip, else at the top right of the pane, else at the top of the window, inside it', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    expect(menuPosition('t1')).toEqual({ top: 80, left: (1000 - MENU_WIDTH) / 2 })
    const pane = document.createElement('div')
    pane.setAttribute('data-terminal-id', 't1')
    pane.getBoundingClientRect = () => ({ top: 100, right: 900, bottom: 500, left: 0 }) as DOMRect
    document.body.appendChild(pane)
    expect(menuPosition('t1')).toEqual({ top: 132, left: 900 - MENU_WIDTH - 8 })
    const chip = document.createElement('button')
    chip.setAttribute('data-account-chip', 't1')
    chip.getBoundingClientRect = () => ({ top: 10, right: 2000, bottom: 30, left: 1900 }) as DOMRect
    document.body.appendChild(chip)
    // Kept inside the window on the right.
    expect(menuPosition('t1')).toEqual({ top: 34, left: 1000 - MENU_WIDTH - 6 })
    chip.getBoundingClientRect = () => ({ top: -50, right: 10, bottom: -40, left: 0 }) as DOMRect
    expect(menuPosition('t1')).toEqual({ top: 6, left: 6 })
  })

  it('gives the terminal\'s input the keyboard back, when it has one', () => {
    expect(() => focusTerminal('none')).not.toThrow()
    const pane = document.createElement('div')
    pane.setAttribute('data-terminal-id', 't1')
    const input = document.createElement('textarea')
    pane.appendChild(input)
    document.body.appendChild(pane)
    focusTerminal('t1')
    expect(document.activeElement).toBe(input)
  })
})
