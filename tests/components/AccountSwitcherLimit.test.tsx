// The switch dialog in limit mode (src/renderer/src/components/Accounts/AccountSwitcherDialog.tsx,
// §8.4): what ran out and on which sign-in (R23), in the CLI's own words; the accounts that are a
// way out, each asked whether it is signed in now, never one not offered automatically (D14); the
// rest with why not; a model's own way out first (R15); Wait, Add an account and Use another agent;
// one terminal at a time when a limit stopped several (R22). Main is the preload's mock.
import React from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('uuid', () => ({ v4: () => 'new-term' }))

import { AccountSwitcherDialog } from '../../src/renderer/src/components/Accounts/AccountSwitcherDialog'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'
import type { LimitContext } from '../../src/renderer/src/lib/limitWatch'
import * as settingsNav from '../../src/renderer/src/lib/settingsNav'

const SID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test', connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, email: 'a@example.test', ...over,
  }
}
const A = row({})
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, email: 'b@example.test', lastEmail: 'b@example.test', order: 1 })
const C = row({ id: 'acc_c', label: 'spare', profile: '/h/.claude-c', folder: '/h/.claude-c', isDefault: false, email: 'c@example.test', lastEmail: 'c@example.test', order: 2, connect: false })
const W = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, autoOffer: false, connect: false, email: 'w@example.test', lastEmail: 'w@example.test', order: 3 })

function view(accounts: AccountRowView[]): AccountsView {
  return { accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' }
}
const T = (id: string, over: Partial<TerminalSession> = {}): TerminalSession => ({
  id, name: `Claude Code — ${id}`, color: '#D97706', shellType: 'gitbash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono',
  agentCommand: 'claude', agentAccountId: 'acc_a', ...over,
})
const WORDS = "You've hit your session limit · resets 3pm (America/New_York)"
const ctx = (over: Partial<LimitContext> = {}): LimitContext => ({
  agent: 'claude', accountId: 'acc_a', terminals: ['t1'], words: WORDS, resetsAt: null, kind: { scope: 'account', window: 'session' }, ...over,
})

let accounts: Record<string, ReturnType<typeof vi.fn>>
let termpolis: Record<string, ReturnType<typeof vi.fn>>

const identity = (r: AccountRowView, signedIn: boolean | null, email: string | null = r.email ?? null) =>
  ({ success: true, data: { ...r, identity: { email: signedIn ? email : null, signedIn, checkedAt: 1, source: 'auth-status' } } })

beforeEach(() => {
  accounts = {
    list: vi.fn(async () => ({ success: true, data: useTerminalStore.getState().accountsView })),
    check: vi.fn(async (id: string) => identity(id === 'acc_b' ? B : id === 'acc_c' ? C : A, true)),
    switchAccount: vi.fn(async () => ({ success: true, data: { kind: 'switched', resumed: true, sessionId: 's' } as SwitchOutcome })),
    onSwitchProgress: vi.fn(() => () => {}),
    launchAccount: vi.fn(async (_agent: string, id: string | null) => ({ success: true, data: { accountId: id } })),
    launchLine: vi.fn(async (req: { command: string; accountId: string | null }) => ({ success: true, data: { line: req.command, accountId: req.accountId, explicit: true } })),
    modelHold: vi.fn(async () => ({ success: true, data: { key: 'k' } })),
    modelRelease: vi.fn(async () => ({ success: true, data: true })),
    agySwitch: vi.fn(async () => ({ success: true, data: { kind: 'refused', why: 'not part of this test' } })),
  }
  termpolis = {
    claudeTrustWorkspace: vi.fn(async () => ({ success: true, data: { changed: true, keys: [] } })),
    memoryPrepareCodexContext: vi.fn(async () => ({ success: true, data: { developerInstructions: null, approvals: 0 } })),
    createTerminal: vi.fn(async () => ({ success: true })),
    writeToTerminal: vi.fn(),
    detectAgents: vi.fn(async () => ({ success: true, data: { claude: true, codex: true, agy: false } })),
  }
  ;(window as never as Record<string, unknown>).accounts = accounts
  ;(window as never as Record<string, unknown>).termpolis = termpolis
  useTerminalStore.setState({
    terminals: [T('t1'), T('t2')], activeTerminalId: 't1', accountsView: view([A, B, C, W]), accountsByHand: {}, accountSwitch: null,
    relaunching: {}, memoryNotice: null, showSettings: false, limitBanners: [],
  })
})
afterEach(() => {
  delete (window as { accounts?: unknown }).accounts
  vi.restoreAllMocks()
})

const openLimit = (c: LimitContext = ctx()) => act(() => { useTerminalStore.getState().openLimitChooser(c) })
const states = () => screen.getAllByTestId('limit-row').map((r) => [r.textContent!.split(/(?=[a-z]+@)| · /)[0].replace(/[^a-z]/g, ''), r.getAttribute('data-state')])

describe('AccountSwitcherDialog in limit mode', () => {
  it("says what ran out, on which sign-in, in the CLI's words, and lists the ways out in failover order", async () => {
    render(<AccountSwitcherDialog />)
    openLimit()
    expect(screen.getByTestId('limit-header')).toHaveTextContent('Claude Code ran out of usage')
    expect(screen.getByTestId('limit-header')).toHaveTextContent('Claude Code — t1 on personal (a@example.test)')
    expect(screen.getByTestId('limit-words')).toHaveTextContent(`“${WORDS}”`)
    // work is never offered (D14); the stopped account comes last, with the CLI's words.
    expect(screen.getAllByTestId('limit-row').map((r) => r.getAttribute('data-state'))).toEqual(['available', 'available', 'this'])
    expect(screen.queryByText(/work/)).toBeNull()
    expect(screen.getAllByTestId('limit-row')[2]).toHaveTextContent(`personalthis terminal's account · ${WORDS}`)
    // Each account offered asked, all at once, whether it is signed in now; the one that ran out isn't.
    await waitFor(() => expect(accounts.check.mock.calls.map((c) => c[0]).sort()).toEqual(['acc_b', 'acc_c']))
    await waitFor(() => expect(screen.getAllByTestId('limit-row')[0]).toHaveTextContent('codedevsigned in as b@example.test'))
    expect(screen.getAllByTestId('limit-row')[1]).toHaveTextContent("not connected: loses Termpolis's tools")
  })

  it("names the sign-in the profile actually has when it isn't the account's own (R23), and never offers that login", async () => {
    // The default profile is signed in to codedev's address: personal ran out means codedev did.
    useTerminalStore.setState({ accountsView: view([row({ lastEmail: 'b@example.test' }), B, C]) })
    render(<AccountSwitcherDialog />)
    openLimit()
    expect(screen.getByTestId('limit-header')).toHaveTextContent('on personal (signed in as b@example.test, not a@example.test)')
    expect(screen.getAllByTestId('limit-row').map((r) => r.getAttribute('data-state'))).toEqual(['same-sign-in', 'available', 'this'])
    await waitFor(() => expect(accounts.check).toHaveBeenCalledWith('acc_c'))
    expect(accounts.check).not.toHaveBeenCalledWith('acc_b')
  })

  it('switches here without asking again what the chooser just asked, and goes on to the next terminal', async () => {
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ terminals: ['t1', 't2'] }))
    expect(screen.getByTestId('limit-group')).toHaveTextContent('1 more Claude Code terminal ran out on personal too')
    await waitFor(() => expect(screen.getAllByTestId('limit-row')[0]).toHaveTextContent('signed in as b@example.test'))
    accounts.check.mockClear()
    let checksBefore = -1
    accounts.switchAccount.mockImplementationOnce(async () => {
      checksBefore = accounts.check.mock.calls.length
      return { success: true, data: { kind: 'switched', resumed: true } }
    })
    await act(async () => { fireEvent.click(screen.getAllByTestId('limit-switch')[0]) })
    expect(checksBefore).toBe(0)
    expect(accounts.switchAccount).toHaveBeenCalledWith({ terminalId: 't1', targetId: 'acc_b', shellType: 'gitbash', reason: 'usage limit' })
    expect(useTerminalStore.getState().memoryNotice).toMatch(/^Now on codedev\./)
    // On to t2, the same limit's other terminal, asked again from the start.
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't2', limit: ctx({ terminals: ['t2'] }) })
    await waitFor(() => expect(accounts.check).toHaveBeenCalledWith('acc_b'))
    expect(screen.getByTestId('limit-header')).toHaveTextContent('Claude Code — t2')
    expect(screen.queryByTestId('limit-group')).toBeNull()
  })

  it('opens a new terminal on a way out beside the stopped one, a fresh session there', async () => {
    render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(screen.getAllByTestId('limit-row')[0]).toHaveTextContent('signed in as b@example.test'))
    const first = screen.getAllByTestId('limit-row')[0].querySelectorAll('button')
    expect(Array.from(first).map((b) => b.textContent)).toEqual(['Switch here', 'New terminal'])
    await act(async () => { fireEvent.click(screen.getAllByTestId('limit-new')[0]) })
    expect(termpolis.createTerminal).toHaveBeenCalledWith('new-term', 'gitbash', '/repo', undefined, true, 'acc_b', 'claude')
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 'new-term')).toMatchObject({ agentAccountId: 'acc_b' })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
  })

  it("asks the second question onto an account that isn't connected, then switches with what it knew", async () => {
    render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(screen.getAllByTestId('limit-row')[1]).toHaveTextContent('signed in as c@example.test'))
    accounts.check.mockClear()
    await act(async () => { fireEvent.click(screen.getAllByTestId('limit-switch')[1]) })
    expect(screen.getByTestId('account-switcher-confirm')).toHaveTextContent("spare isn't connected to Termpolis")
    await act(async () => { fireEvent.click(screen.getByTestId('account-switcher-confirm-yes')) })
    expect(accounts.check).not.toHaveBeenCalled()
    expect(accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'acc_c', reason: 'usage limit' }))
  })

  it('offers a signed-out account only as Sign in, and one it could not ask after asking again', async () => {
    accounts.check.mockImplementation(async (id: string) => (id === 'acc_b' ? identity(B, false) : { success: false, error: 'no answer' }))
    // spare names no sign-in of its own, so "couldn't tell" stands.
    useTerminalStore.setState({ accountsView: view([A, B, row({ ...C, lastEmail: null })]) })
    const req = vi.spyOn(settingsNav, 'requestSettingsTab')
    render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(screen.getAllByTestId('limit-row').map((r) => r.getAttribute('data-state'))).toEqual(['signed-out', 'unknown', 'this']))
    expect(screen.getAllByTestId('limit-row')[1]).toHaveTextContent("couldn't tell whether it is signed in: no answer")
    // The unknown one: asked once more when chosen, then the user's word.
    await act(async () => { fireEvent.click(screen.getByTestId('limit-switch')) })
    expect(screen.getByTestId('account-switcher-confirm')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByTestId('account-switcher-confirm-yes')) })
    expect(screen.getByTestId('account-switcher-unknown-sign-in')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Back'))
    fireEvent.click(screen.getByTestId('limit-sign-in'))
    expect(req).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().signInSheet).toEqual({ accountId: 'acc_b' })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
  })

  it("takes an answer younger than a minute as it stands, asking no agent for it (§3.4)", async () => {
    const fresh = { email: 'b@example.test', signedIn: true, checkedAt: Date.now() - 5_000, source: 'auth-status' as const }
    useTerminalStore.setState({ accountsView: view([A, row({ ...B, identity: fresh }), C]) })
    render(<AccountSwitcherDialog />)
    openLimit()
    expect(screen.getAllByTestId('limit-row')[0]).toHaveTextContent('codedevsigned in as b@example.test')
    await waitFor(() => expect(accounts.check).toHaveBeenCalledWith('acc_c'))
    expect(accounts.check).not.toHaveBeenCalledWith('acc_b')
  })

  it('says when nothing is a way out, and which account frees up first', async () => {
    const soon = Date.now() + 3_600_000
    const later = Date.now() + 7_200_000
    useTerminalStore.setState({ accountsView: view([A, row({ ...B, limit: { seenAt: 1, resetsAt: later, text: 'x', scope: 'account' } }), row({ ...C, limit: { seenAt: 1, resetsAt: soon, text: 'x', scope: 'account' } })]) })
    render(<AccountSwitcherDialog />)
    openLimit()
    expect(screen.getByTestId('limit-none')).toHaveTextContent(/^No other Claude Code account is free\. spare is out of usage until /)
    expect(screen.queryByTestId('limit-switch')).toBeNull()
    expect(accounts.check).not.toHaveBeenCalled()
  })

  it('waits for the reset on Wait, Escape and Close, for this terminal only', async () => {
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ terminals: ['t1', 't2'] }))
    fireEvent.click(screen.getByTestId('limit-wait'))
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't2', limit: ctx({ terminals: ['t2'] }) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
    openLimit()
    fireEvent.click(screen.getByTestId('account-switcher-close'))
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
  })

  it('keeps its Escape from the terminal under it, which keeps the focus: the agent never gets that Esc', () => {
    const pane = document.createElement('textarea')
    document.body.appendChild(pane)
    const reached = vi.fn()
    pane.addEventListener('keydown', reached)
    render(<AccountSwitcherDialog />)
    openLimit()
    fireEvent.keyDown(pane, { key: 'Escape' })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
    expect(reached).not.toHaveBeenCalled()
    // With the dialog gone, Escape is the terminal's again; and any other key always was.
    fireEvent.keyDown(pane, { key: 'Escape' })
    openLimit()
    fireEvent.keyDown(pane, { key: 'a' })
    expect(reached).toHaveBeenCalledTimes(2)
    expect(useTerminalStore.getState().accountSwitch).not.toBeNull()
    pane.remove()
  })

  it('opens Settings ▸ Accounts to add an account, and another installed agent beside the terminal', async () => {
    const req = vi.spyOn(settingsNav, 'requestSettingsTab')
    render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(screen.getByTestId('limit-other-codex')).toBeInTheDocument())
    expect(screen.queryByTestId('limit-other-agy')).toBeNull()
    expect(screen.queryByTestId('limit-other-claude')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('limit-other-codex')) })
    expect(termpolis.createTerminal).toHaveBeenCalledWith('new-term', 'gitbash', '/repo', undefined, false, undefined, 'codex')
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 'new-term')).toMatchObject({ agentCommand: 'codex', name: 'Claude Code — t1 · Codex' })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
    openLimit()
    fireEvent.click(screen.getByTestId('limit-add'))
    expect(req).toHaveBeenCalledWith('accounts', false)
    expect(useTerminalStore.getState().showSettings).toBe(true)
  })

  it('says why another agent could not open, and offers none where none was detected', async () => {
    termpolis.createTerminal.mockImplementation(async () => ({ success: false, error: 'no shell' }))
    render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(screen.getByTestId('limit-other-codex')).toBeInTheDocument())
    await act(async () => { fireEvent.click(screen.getByTestId('limit-other-codex')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent("Termpolis couldn't open the terminal: no shell")
  })

  it('offers no other agent when detection fails or the bridge lacks it', async () => {
    termpolis.detectAgents.mockImplementation(async () => { throw new Error('x') })
    const { unmount } = render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalled())
    expect(screen.queryByTestId('limit-other-codex')).toBeNull()
    unmount()
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    termpolis.detectAgents.mockImplementation(() => { throw new Error('y') })
    render(<AccountSwitcherDialog />)
    openLimit()
    await waitFor(() => expect(screen.getByTestId('limit-header')).toBeInTheDocument())
    expect(screen.queryByTestId('limit-other-codex')).toBeNull()
  })

  it("moves the terminal to the model Claude Code advises for one model's limit, by its own session (R15)", async () => {
    useTerminalStore.setState({ terminals: [T('t1', { agentSessionId: SID }), T('t2')] })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ words: "You've hit your Opus limit · resets Oct 24, 4pm (UTC)", kind: { scope: 'model', window: 'weekly', model: 'Opus' } }))
    expect(screen.getByTestId('limit-model-row')).toHaveTextContent('Claude Code ran out on this model only.')
    await act(async () => { fireEvent.click(screen.getByTestId('limit-model')) })
    expect(screen.getByTestId('limit-model-running')).toHaveTextContent('Moving Claude Code — t1 to sonnet…')
    expect(useTerminalStore.getState().relaunching).toEqual({ t1: 'model' })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    vi.useRealTimers()
    expect(accounts.modelHold).toHaveBeenCalledWith({ terminalId: 't1', line: `claude --model sonnet --resume ${SID}` })
    expect(termpolis.writeToTerminal).toHaveBeenLastCalledWith('t1', `claude --model sonnet --resume ${SID}\r`, 'k')
    expect(useTerminalStore.getState().memoryNotice).toBe('Moving Claude Code — t1 to sonnet: the conversation continues there.')
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
    expect(useTerminalStore.getState().relaunching).toEqual({})
  })

  it("says why the model didn't change, and only advises it where the terminal's session isn't known", async () => {
    accounts.modelHold.mockImplementation(async () => ({ success: false, error: 'an account switch or another model change is running in this terminal' }))
    useTerminalStore.setState({ terminals: [T('t1', { agentSessionId: SID }), T('t2')] })
    render(<AccountSwitcherDialog />)
    const opus = ctx({ kind: { scope: 'model', window: 'weekly', model: 'Opus' } })
    openLimit(opus)
    await act(async () => { fireEvent.click(screen.getByTestId('limit-model')) })
    expect(screen.getByTestId('account-switcher-error')).toHaveTextContent("Termpolis didn't change the model: an account switch or another model change is running in this terminal.")
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    openLimit({ ...opus, terminals: ['t2'] })
    expect(screen.getByTestId('limit-model-advice')).toHaveTextContent("pick Sonnet in this terminal's model picker")
    expect(screen.queryByTestId('limit-model')).toBeNull()
    // A model Claude Code gives no advice for: no row.
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    openLimit(ctx({ kind: { scope: 'model', window: 'other', model: 'Haiku' } }))
    expect(screen.queryByTestId('limit-model-advice')).toBeNull()
  })

  it('gives a terminal on an account not offered automatically a fresh session first (R17)', async () => {
    useTerminalStore.setState({ terminals: [T('t1', { agentAccountId: 'acc_w' })] })
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ accountId: 'acc_w' }))
    await waitFor(() => expect(screen.getAllByTestId('limit-row')[0]).toHaveTextContent('signed in as a@example.test'))
    const first = screen.getAllByTestId('limit-row')[0].querySelectorAll('button')
    expect(Array.from(first).map((b) => b.textContent)).toEqual(['New terminal', 'Switch here'])
    await act(async () => { fireEvent.click(screen.getAllByTestId('limit-new')[0]) })
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 'new-term')).toMatchObject({ agentAccountId: 'acc_a', agentCommand: 'claude' })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
  })

  it('names no account for a terminal changed by hand, or one Termpolis does not know', async () => {
    useTerminalStore.setState({ accountsByHand: { t1: true } })
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ accountId: null }))
    expect(screen.getByTestId('limit-header')).toHaveTextContent('on an account changed by hand')
    // Every account offered automatically is listed, none as this terminal's.
    expect(screen.getAllByTestId('limit-row').map((r) => r.getAttribute('data-state'))).toEqual(['available', 'available', 'available'])
    act(() => { useTerminalStore.getState().closeAccountSwitch() })
    useTerminalStore.setState({ accountsByHand: {} })
    openLimit(ctx({ accountId: 'acc_gone' }))
    expect(screen.getByTestId('limit-header')).toHaveTextContent("on an account Termpolis doesn't know")
  })

  it('moves on when the terminal it was opened for closed, or runs another agent now', async () => {
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ terminals: ['gone', 't1'] }))
    await waitFor(() => expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't1', limit: ctx({ terminals: ['t1'] }) }))
    act(() => { useTerminalStore.setState({ terminals: [T('t1', { agentCommand: 'codex' })] }) })
    await waitFor(() => expect(useTerminalStore.getState().accountSwitch).toBeNull())
  })

  it("keeps a switch under way when another terminal joins, and the manual dialog as it was", async () => {
    render(<AccountSwitcherDialog />)
    openLimit()
    let release!: (v: unknown) => void
    accounts.switchAccount.mockImplementationOnce(() => new Promise((r) => { release = r }))
    await waitFor(() => expect(screen.getAllByTestId('limit-row')[0]).toHaveTextContent('signed in as b@example.test'))
    await act(async () => { fireEvent.click(screen.getAllByTestId('limit-switch')[0]) })
    expect(screen.getByTestId('account-switcher-running')).toBeInTheDocument()
    act(() => { useTerminalStore.getState().joinLimitChooser('t2') })
    expect(screen.getByTestId('account-switcher-running')).toBeInTheDocument()
    await act(async () => { release({ success: true, data: { kind: 'switched', resumed: true } }) })
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't2', limit: ctx({ terminals: ['t2'] }) })
  })

  it("offers agy's guided switch to the agy accounts that are a way out, and ends the whole prompt", async () => {
    const g1 = row({ id: 'g1', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'g1@example.test', order: 0 })
    const g2 = row({ id: 'g2', agent: 'agy', label: 'school', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'g2@example.test', order: 1 })
    const g3 = row({ id: 'g3', agent: 'agy', label: 'old', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'g1@example.test', order: 2 })
    useTerminalStore.setState({ accountsView: view([g1, g2, g3]), terminals: [T('a1', { agentCommand: 'agy', agentAccountId: 'g1' }), T('a2', { agentCommand: 'agy', agentAccountId: 'g1' })] })
    render(<AccountSwitcherDialog />)
    openLimit(ctx({ agent: 'agy', accountId: 'g1', terminals: ['a1', 'a2'], words: 'You have exhausted your quota on this model.', kind: { scope: 'model', window: 'other' } }))
    expect(screen.getByTestId('limit-header')).toHaveTextContent('Gemini / Antigravity CLI ran out of usage')
    // Only school: old is signed in to the same Google account that ran out.
    expect(screen.getAllByTestId('account-switcher-row').map((r) => r.textContent)).toEqual([expect.stringContaining('school')])
    expect(accounts.check).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('account-switcher-close'))
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
  })
})
