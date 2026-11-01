// The usage-limit chooser's card (src/renderer/src/components/Accounts/LimitCard.tsx, the in-app
// account UI §2.6): at the top of the stopped terminal's pane, it says what ran out in the CLI's
// words and offers the first way out in one click (the in-place switch, accountSwitchRun here
// mocked), the rest under Other account, a new terminal, another agent, or a model's way out
// (R15); never the work account (D14), and a work terminal's first choice a fresh session (R17).
// It takes no key. Main is the preload's mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { TerminalSession } from '../../src/renderer/src/types'
import type { LimitContext } from '../../src/renderer/src/lib/limitWatch'

vi.mock('uuid', () => ({ v4: () => 'new-term' }))
vi.mock('../../src/renderer/src/lib/accountSwitchRun', () => ({
  startSwitch: vi.fn(async () => undefined),
  newTerminalOn: vi.fn(async () => ({ ok: true, id: 'n1' })),
}))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { newTerminalOn, startSwitch } from '../../src/renderer/src/lib/accountSwitchRun'
import { LimitCard } from '../../src/renderer/src/components/Accounts/LimitCard'
import { beginModelSwitch, endModelSwitch, modelSwitchTarget, resetModelSwitches } from '../../src/renderer/src/lib/modelSwitchState'
import { CLAUDE_EXIT_AFTER_A_TURN, CLAUDE_SESSION_ID } from '../fixtures/agentExitOutput'


function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test', connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, email: 'a@example.test', ...over,
  }
}
const A = row({})
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, email: 'b@example.test', lastEmail: 'b@example.test', order: 1, color: '#7ee2a3' })
const C = row({ id: 'acc_c', label: 'spare', profile: '/h/.claude-c', folder: '/h/.claude-c', isDefault: false, email: 'c@example.test', lastEmail: 'c@example.test', order: 2 })
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
const st = useTerminalStore.getState

let accounts: Record<string, ReturnType<typeof vi.fn>>
let termpolis: Record<string, ReturnType<typeof vi.fn>>
const identity = (r: AccountRowView, signedIn: boolean | null) =>
  ({ success: true, data: { ...r, identity: { email: signedIn ? r.email : null, signedIn, checkedAt: 1, source: 'auth-status' } } })

beforeEach(() => {
  vi.mocked(startSwitch).mockClear()
  vi.mocked(newTerminalOn).mockClear()
  accounts = {
    check: vi.fn(async (id: string) => identity(id === 'acc_b' ? B : C, true)),
    modelHold: vi.fn(async () => ({ success: true, data: { key: 'k' } })),
    modelRelease: vi.fn(async () => ({ success: true, data: true })),
  }
  termpolis = {
    createTerminal: vi.fn(async () => ({ success: true })),
    writeToTerminal: vi.fn(),
    detectAgents: vi.fn(async () => ({ success: true, data: { claude: true, codex: true, agy: false } })),
  }
  ;(window as never as Record<string, unknown>).accounts = accounts
  ;(window as never as Record<string, unknown>).termpolis = termpolis
  useTerminalStore.setState({
    terminals: [T('t1'), T('t2')], activeTerminalId: 't1', accountsView: view([A, B, C, W]), accountsByHand: {}, accountSwitch: null,
    relaunching: {}, memoryNotice: null, showSettings: false, signInSheet: null, agySwitchSheet: null, addAccountSheet: null,
  })
})
afterEach(() => {
  vi.useRealTimers()
  resetModelSwitches()
})

const openLimit = (c: LimitContext = ctx()) => act(() => { st().openLimitChooser(c) })
const card = (id = 't1') => render(<LimitCard terminalId={id} />)
const click = (id: string) => fireEvent.click(screen.getByTestId(id))

describe('when the card shows', () => {
  it('shows on each pane the limit stopped, and nowhere else', async () => {
    const { unmount } = card('t2')
    openLimit()
    expect(screen.queryByTestId('limit-card')).toBeNull()
    unmount()
    card('t1')
    expect(screen.getByTestId('limit-card')).toBeInTheDocument()
    await act(async () => undefined)
  })

  it('shows none with no chooser, or one opened for no limit, a terminal or view it lacks, or another agent now', () => {
    const cases: Array<() => void> = [
      () => undefined,
      () => useTerminalStore.setState({ accountSwitch: { terminalId: 't1' } }),
      () => { st().openLimitChooser(ctx()); useTerminalStore.setState({ terminals: [] }) },
      () => { st().openLimitChooser(ctx()); useTerminalStore.setState({ accountsView: null }) },
      () => { st().openLimitChooser(ctx()); useTerminalStore.setState({ terminals: [T('t1', { agentCommand: 'codex' })] }) },
    ]
    for (const setup of cases) {
      act(setup)
      const { unmount } = card()
      expect(screen.queryByTestId('limit-card')).toBeNull()
      unmount()
      act(() => useTerminalStore.setState({ accountSwitch: null, terminals: [T('t1'), T('t2')], accountsView: view([A, B, C, W]) }))
    }
  })
})

describe('what it says', () => {
  it('says what ran out, on which sign-in, until when, in the CLI\'s words', async () => {
    card()
    openLimit(ctx({ resetsAt: Date.now() + 3_600_000 }))
    expect(screen.getByTestId('limit-card-headline').textContent).toMatch(/^Claude Code is out of usage on personal \(a@example\.test\) until .+\.$/)
    expect(screen.getByTestId('limit-card-words')).toHaveTextContent(`“${WORDS}”`)
    expect(screen.queryByTestId('limit-card-group')).toBeNull()
    await act(async () => undefined)
  })

  it('says how many more terminals the same limit stopped', async () => {
    card()
    openLimit(ctx({ terminals: ['t1', 't2'] }))
    expect(screen.getByTestId('limit-card-group')).toHaveTextContent('1 more Claude Code terminal ran out on personal too.')
    expect(screen.getByTestId('limit-card-headline')).toHaveTextContent('Claude Code is out of usage on personal (a@example.test).')
    await act(async () => undefined)
  })

  it('names an account changed by hand as such', async () => {
    useTerminalStore.setState({ accountsByHand: { t1: true }, terminals: [T('t1', { agentAccountId: undefined })] })
    card()
    openLimit(ctx({ accountId: null }))
    expect(screen.getByTestId('limit-card-headline')).toHaveTextContent('Claude Code is out of usage on an account changed by hand.')
    await act(async () => undefined)
  })

  it('takes no focus and no key: it is a status, not a dialog', async () => {
    const pane = document.createElement('textarea')
    document.body.appendChild(pane)
    pane.focus()
    card()
    openLimit()
    expect(document.activeElement).toBe(pane)
    expect(screen.getByTestId('limit-card').querySelector('[role="status"]')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    pane.remove()
    await act(async () => undefined)
  })
})

describe('its ways out', () => {
  it('asks each way out, all at once, whether it is signed in now, never the one that ran out or work (D14)', async () => {
    card()
    openLimit()
    await waitFor(() => expect(accounts.check.mock.calls.map((c) => c[0]).sort()).toEqual(['acc_b', 'acc_c']))
    expect(screen.queryByText(/work/)).toBeNull()
  })

  it('takes an answer younger than a minute as it stands, asking no agent for it', async () => {
    const fresh = { email: 'b@example.test', signedIn: true, checkedAt: Date.now() - 5_000, source: 'auth-status' as const }
    useTerminalStore.setState({ accountsView: view([A, row({ ...B, identity: fresh }), C]) })
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledWith('acc_c'))
    expect(accounts.check).not.toHaveBeenCalledWith('acc_b')
  })

  it('continues on the first way out in one click, with the sign-in it just checked', async () => {
    card()
    openLimit(ctx({ terminals: ['t1', 't2'] }))
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    await act(async () => undefined)
    expect(screen.getByTestId('limit-card-continue')).toHaveTextContent('Continue on codedev')
    click('limit-card-continue')
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_b', { reason: 'usage limit', known: { kind: 'signed-in', email: 'b@example.test' } })
    // This terminal's part is over: the chooser goes on for the other one.
    expect(st().accountSwitch).toEqual({ terminalId: 't2', limit: ctx({ terminals: ['t2'] }) })
  })

  it('leaves the sign-in to the switch when its answer hasn\'t come yet', async () => {
    accounts.check.mockImplementation(() => new Promise(() => undefined))
    card()
    openLimit()
    click('limit-card-continue')
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_b', { reason: 'usage limit' })
  })

  it('offers an account the Check could not answer for as a way out all the same: Continue on it, and the switch finds out', async () => {
    // The agent could not say who is signed in (offline, a slow CLI) and its profile names no sign-in either. "No way out" would be a dead end, so the account stays on offer.
    useTerminalStore.setState({ accountsView: view([A, row({ ...B, lastEmail: null }), C, W]) })
    accounts.check.mockImplementation(async (id: string) => (id === 'acc_b' ? { success: false, error: 'the CLI did not answer' } : identity(C, true)))
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    await act(async () => undefined)
    expect(screen.getByTestId('limit-card-continue')).toHaveTextContent('Continue on codedev')
    expect(screen.queryByTestId('limit-card-none')).toBeNull()
    click('limit-card-continue')
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_b', { reason: 'usage limit' })
  })

  it('lists an account the Check could not answer for under Other account with a Switch too, saying why it is not sure', async () => {
    useTerminalStore.setState({ accountsView: view([A, B, row({ ...C, lastEmail: null }), W]) })
    accounts.check.mockImplementation(async (id: string) => (id === 'acc_c' ? { success: false, error: 'the CLI did not answer' } : identity(B, true)))
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    await act(async () => undefined)
    click('limit-card-more')
    const spare = screen.getAllByTestId('limit-card-other').find((o) => o.getAttribute('data-state') === 'unknown')!
    expect(spare.textContent).toContain("couldn't tell whether it is signed in: the CLI did not answer")
    fireEvent.click(spare.querySelector('[data-testid="limit-card-switch"]')!)
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_c', { reason: 'usage limit' })
  })

  it('drops an answer that comes after the card closed', async () => {
    let answer!: (v: unknown) => void
    accounts.check.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const { unmount } = card()
    openLimit()
    unmount()
    answer(identity(B, true))
    await act(async () => undefined)
    expect(startSwitch).not.toHaveBeenCalled()
  })

  it('lists the rest under Other account: a switch, a sign-in first, a new terminal, and why the others aren\'t', async () => {
    const later = Date.now() + 7_200_000
    const D = row({ id: 'acc_d', label: 'spent', profile: '/h/.claude-d', folder: '/h/.claude-d', isDefault: false, email: 'd@example.test', lastEmail: 'd@example.test', order: 4, limit: { seenAt: 1, resetsAt: later, text: 'x', scope: 'account' } })
    const E = row({ id: 'acc_e', label: 'spare2', profile: '/h/.claude-e', folder: '/h/.claude-e', isDefault: false, email: 'e@example.test', lastEmail: 'e@example.test', order: 5 })
    useTerminalStore.setState({ accountsView: view([A, B, C, W, D, E]) })
    accounts.check.mockImplementation(async (id: string) => identity(st().accountsView!.accounts.find((r) => r.id === id)!, id !== 'acc_c'))
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(3))
    await act(async () => undefined)
    expect(screen.getByTestId('limit-card-more')).toHaveAttribute('aria-expanded', 'false')
    click('limit-card-more')
    expect(screen.getByTestId('limit-card-more')).toHaveAttribute('aria-expanded', 'true')
    const others = screen.getAllByTestId('limit-card-other')
    // The first way out is the card's own button; the one that ran out isn't listed.
    expect(others.map((o) => [o.textContent?.split(/(?=signed|out of)/)[0], o.getAttribute('data-state')])).toEqual([
      ['spare', 'signed-out'],
      ['spent', 'limited'],
      ['spare2', 'available'],
    ])
    expect(others[0].querySelector('[data-testid="limit-card-sign-in"]')).not.toBeNull()
    expect(others[0].querySelector('[data-testid="limit-card-switch"]')).toBeNull()
    expect(others[1].querySelectorAll('button')).toHaveLength(0)
    fireEvent.click(others[2].querySelector('[data-testid="limit-card-switch"]')!)
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_e', { reason: 'usage limit', known: { kind: 'signed-in', email: 'e@example.test' } })
  })

  it('signs a signed-out account in from the list, then switches', async () => {
    accounts.check.mockImplementation(async (id: string) => (id === 'acc_c' ? identity(C, false) : identity(B, true)))
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    await act(async () => undefined)
    click('limit-card-more')
    click('limit-card-sign-in')
    expect(st().accountSwitch).toBeNull()
    expect(st().signInSheet?.accountId).toBe('acc_c')
    st().signInSheet!.then!()
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_c', { reason: 'usage limit', known: { kind: 'signed-in', email: null } })
  })

  it('opens a new terminal on a way out beside this one, from the list or for the first', async () => {
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    click('limit-card-more')
    fireEvent.click(screen.getAllByTestId('limit-card-fresh')[0])
    expect(newTerminalOn).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_c' }))
    await waitFor(() => expect(st().accountSwitch).toBeNull())
    openLimit()
    click('limit-card-more')
    click('limit-card-fresh-first')
    expect(newTerminalOn).toHaveBeenLastCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_b' }))
  })

  it('stays, with why, when the new terminal could not be opened: the stop keeps its card and its other ways out', async () => {
    vi.mocked(newTerminalOn).mockResolvedValueOnce({ ok: false, error: "Termpolis couldn't open the terminal: no shell" })
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    click('limit-card-more')
    click('limit-card-fresh-first')
    expect(await screen.findByTestId('limit-card-error')).toHaveTextContent("Termpolis couldn't open the terminal: no shell")
    expect(st().accountSwitch).not.toBeNull()
    expect(screen.getByTestId('limit-card')).toBeInTheDocument()
    // The way out is still there to try again.
    click('limit-card-fresh-first')
    await waitFor(() => expect(st().accountSwitch).toBeNull())
  })

  it('waits for the reset on Not now, for this terminal only', async () => {
    card()
    openLimit(ctx({ terminals: ['t1', 't2'] }))
    click('limit-card-not-now')
    expect(st().accountSwitch).toEqual({ terminalId: 't2', limit: ctx({ terminals: ['t2'] }) })
    expect(startSwitch).not.toHaveBeenCalled()
    await act(async () => undefined)
  })

  it('says when nothing is a way out, and which account frees up first', async () => {
    const soon = Date.now() + 3_600_000
    useTerminalStore.setState({ accountsView: view([A, row({ ...B, limit: { seenAt: 1, resetsAt: soon, text: 'x', scope: 'account' } })]) })
    card()
    openLimit()
    expect(screen.getByTestId('limit-card-none')).toHaveTextContent(/^No other Claude Code account is free\. codedev is out of usage until /)
    expect(screen.queryByTestId('limit-card-continue')).toBeNull()
    click('limit-card-more')
    expect(screen.queryByTestId('limit-card-fresh-first')).toBeNull()
    expect(accounts.check).not.toHaveBeenCalled()
    await act(async () => undefined)
  })
})

describe('the other ways', () => {
  it('opens the Add account wizard for the agent', async () => {
    card()
    openLimit()
    click('limit-card-more')
    click('limit-card-add')
    expect(st().addAccountSheet).toEqual({ agent: 'claude' })
    expect(st().showSettings).toBe(false)
    expect(st().accountSwitch).toBeNull()
    await act(async () => undefined)
  })

  it('opens another installed agent beside the terminal, or says why it couldn\'t', async () => {
    card()
    openLimit()
    click('limit-card-more')
    await waitFor(() => expect(screen.getByTestId('limit-card-other-codex')).toHaveTextContent('Use Codex here instead'))
    expect(screen.queryByTestId('limit-card-other-agy')).toBeNull()
    termpolis.createTerminal.mockResolvedValueOnce({ success: false, error: 'no shell' })
    await act(async () => { click('limit-card-other-codex') })
    expect(screen.getByTestId('limit-card-error')).toHaveTextContent('Termpolis couldn\'t open the terminal: no shell')
    expect(st().accountSwitch).not.toBeNull()
    await act(async () => { click('limit-card-other-codex') })
    expect(termpolis.createTerminal).toHaveBeenLastCalledWith('new-term', 'gitbash', '/repo', undefined, false, undefined, 'codex')
    expect(st().terminals.find((t) => t.id === 'new-term')).toMatchObject({ agentCommand: 'codex', name: 'Claude Code — t1 · Codex' })
    expect(st().accountSwitch).toBeNull()
  })

  it('offers no other agent when detection fails, throws, or the bridge lacks it', async () => {
    for (const setup of [
      () => termpolis.detectAgents.mockRejectedValueOnce(new Error('x')),
      () => termpolis.detectAgents.mockImplementationOnce(() => { throw new Error('y') }),
      () => termpolis.detectAgents.mockResolvedValueOnce({ success: false, error: 'z' }),
      () => { delete termpolis.detectAgents },
    ]) {
      setup()
      const { unmount } = card()
      openLimit()
      click('limit-card-more')
      await act(async () => undefined)
      expect(screen.queryByTestId('limit-card-other-codex')).toBeNull()
      unmount()
      act(() => st().closeAccountSwitch())
    }
  })

  /** What the OS says about the terminal, in order, the last repeating (false: the agent runs; true:
   *  only the shell is left), and what the quit prints: the engine reads both off the preload. */
  function agentQuits(answers: boolean[], output: string): void {
    let i = 0
    termpolis.terminalShellAlone = vi.fn(async () => ({ success: true, data: answers[Math.min(i++, answers.length - 1)] }))
    termpolis.readTerminalBuffer = vi.fn(async (_id: string, from?: number) => (from === undefined
      ? { success: true, data: { output: '', nextOffset: 10, length: 0, missed: 0 } }
      : { success: true, data: { output, nextOffset: 99, length: output.length, missed: 0 } }))
  }
  const OPUS = (over: Partial<LimitContext> = {}): LimitContext =>
    ctx({ words: "You've hit your Opus limit · resets Oct 24, 4pm (UTC)", kind: { scope: 'model', window: 'weekly', model: 'Opus' }, ...over })

  it('moves the terminal to the model Claude Code advises for one model\'s limit, resuming the session Claude Code names as it exits (R15)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    agentQuits([false, false, true], CLAUDE_EXIT_AFTER_A_TURN)
    card()
    openLimit(OPUS())
    expect(screen.getByTestId('limit-card-model')).toHaveTextContent('Switch this terminal to Sonnet')
    // The model is the first way out; the account switch is still there.
    expect(screen.getByTestId('limit-card-model').className).toContain('bg-')
    expect(screen.getByTestId('limit-card-continue')).toBeInTheDocument()
    await act(async () => { click('limit-card-model') })
    // Held at once, on the store's side: the pane takes no keys, an account switch waits.
    expect(st().relaunching).toEqual({ t1: 'model' })
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    // main's side: asked for with no line (what is typed is only known once Claude Code has exited), and every key carries its key.
    expect(accounts.modelHold).toHaveBeenCalledWith({ terminalId: 't1' })
    expect(termpolis.writeToTerminal.mock.calls).toEqual([
      ['t1', '\x03', 'k'], ['t1', '\x03', 'k'], ['t1', '\x03', 'k'],
      ['t1', `claude --model sonnet --resume ${CLAUDE_SESSION_ID}\r`, 'k'],
    ])
    expect(accounts.modelRelease).toHaveBeenCalledWith('t1', 'k')
    expect(st().accountSwitch).toBeNull()
    expect(st().relaunching).toEqual({})
  })

  it('carries what the terminal was started with into the relaunch, and says when it had to leave an option out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    agentQuits([false, true], CLAUDE_EXIT_AFTER_A_TURN)
    useTerminalStore.setState({ terminals: [T('t1', { agentCommand: 'claude --dangerously-skip-permissions --append-system-prompt "be brief"' })] })
    card()
    openLimit(OPUS())
    await act(async () => { click('limit-card-model') })
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    // A quoted prompt can't be repeated safely: the bare agent comes back, and the user is told.
    expect(termpolis.writeToTerminal).toHaveBeenLastCalledWith('t1', `claude --model sonnet --resume ${CLAUDE_SESSION_ID}\r`, 'k')
    expect(st().memoryNotice).toMatch(/^⚠️ Claude restarted on Sonnet\..*cannot repeat safely.*came back with its defaults/)
    expect(st().accountSwitch).toBeNull()
  })

  it('says why the model didn\'t change when something else holds the terminal, and types nothing', async () => {
    accounts.modelHold.mockResolvedValueOnce({ success: false, error: 'an account switch or another model change is running in this terminal' })
    card()
    openLimit(OPUS())
    await act(async () => { click('limit-card-model') })
    expect(screen.getByTestId('limit-card-error')).toHaveTextContent('Termpolis didn\'t change the model: an account switch or another model change is running in this terminal.')
    expect(termpolis.writeToTerminal).not.toHaveBeenCalled()
    expect(st().relaunching).toEqual({})
    // The card stays, for another try or another way out.
    expect(st().accountSwitch).not.toBeNull()
  })

  it('says why the model didn\'t change when the store says another relaunch holds the terminal', async () => {
    useTerminalStore.setState({ relaunching: { t1: 'account' } })
    card()
    openLimit(OPUS())
    await act(async () => { click('limit-card-model') })
    expect(screen.getByTestId('limit-card-error')).toHaveTextContent('Termpolis didn\'t change the model: an account switch or another model change is running in this terminal.')
    expect(accounts.modelHold).not.toHaveBeenCalled()
    expect(termpolis.writeToTerminal).not.toHaveBeenCalled()
    expect(st().relaunching).toEqual({ t1: 'account' })
  })

  it('leaves the card up with the reason when the agent would not quit, and when the relaunch fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    agentQuits([false], CLAUDE_EXIT_AFTER_A_TURN) // never goes
    card()
    openLimit(OPUS())
    await act(async () => { click('limit-card-model') })
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    expect(screen.getByTestId('limit-card-error')).toHaveTextContent(/Claude had not quit after 30 s.*left it alone.*typed nothing else/)
    expect(termpolis.writeToTerminal.mock.calls.map((c) => c[1])).toEqual(['\x03', '\x03', '\x03'])
    expect(st().relaunching).toEqual({})
    expect(accounts.modelRelease).toHaveBeenCalledWith('t1', 'k')

    termpolis.writeToTerminal = vi.fn(() => { throw new Error('pty closed') })
    await act(async () => { click('limit-card-model') })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByTestId('limit-card-error')).toHaveTextContent('Switching Claude to Sonnet failed, so nothing more was typed. The terminal is as the failure left it.')
    expect(st().relaunching).toEqual({})
  })

  it('claims the terminal\'s model switch for as long as it runs, so the menu shows "Restarting on …" and no second pick overlaps it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    agentQuits([false, false, true], CLAUDE_EXIT_AFTER_A_TURN)
    card()
    openLimit(OPUS())
    await act(async () => { click('limit-card-model') })
    expect(modelSwitchTarget('t1')).toBe('sonnet')
    // A pick from the header's menu meanwhile is refused by the same guard.
    expect(beginModelSwitch('t1', 'haiku')).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(modelSwitchTarget('t1')).toBeUndefined()
    expect(beginModelSwitch('t1', 'haiku')).toBe(true)
    endModelSwitch('t1')
  })

  it('types nothing when the header\'s menu has a model switch under way on this terminal', async () => {
    expect(beginModelSwitch('t1', 'haiku')).toBe(true)
    card()
    openLimit(OPUS())
    await act(async () => { click('limit-card-model') })
    expect(screen.getByTestId('limit-card-error')).toHaveTextContent('Termpolis didn\'t change the model: an account switch or another model change is running in this terminal.')
    expect(accounts.modelHold).not.toHaveBeenCalled()
    expect(termpolis.writeToTerminal).not.toHaveBeenCalled()
    // The header's switch is still the terminal's.
    expect(modelSwitchTarget('t1')).toBe('haiku')
    endModelSwitch('t1')
  })

  it('offers the one click for any terminal that runs plain claude, its .exe included, and no card at all for a wrapper (it has no account)', async () => {
    useTerminalStore.setState({ terminals: [T('t1', { agentCommand: 'claude.exe --dangerously-skip-permissions' }), T('t2', { agentCommand: 'claude-sandbox' })] })
    const { unmount } = card()
    openLimit(OPUS())
    expect(screen.getByTestId('limit-card-model')).toHaveTextContent('Switch this terminal to Sonnet')
    expect(screen.queryByTestId('limit-card-model-advice')).toBeNull()
    unmount()
    act(() => st().closeAccountSwitch())
    // A wrapper adds what a relaunch of the bare agent would drop (a sandbox): it is none of the account
    // agents, so nothing offers to move it.
    card('t2')
    openLimit(OPUS({ terminals: ['t2'] }))
    expect(screen.queryByTestId('limit-card')).toBeNull()
    await act(async () => undefined)
  })

  it('only advises for a terminal it cannot relaunch itself: a swarm worker has no command of its own to repeat', async () => {
    useTerminalStore.setState({ terminals: [T('t2', { agentCommand: undefined, isSwarm: true, swarmAgent: 'claude' })] })
    card('t2')
    openLimit(OPUS({ terminals: ['t2'] }))
    expect(screen.getByTestId('limit-card-model-advice')).toHaveTextContent("Claude Code ran out on this model only: pick Sonnet in this terminal's model picker to go on here.")
    expect(screen.queryByTestId('limit-card-model')).toBeNull()
    await act(async () => undefined)
  })
  it('offers no model for a model Claude Code gives no advice for', async () => {
    card()
    openLimit(ctx({ kind: { scope: 'model', window: 'other', model: 'Haiku' } }))
    expect(screen.queryByTestId('limit-card-model')).toBeNull()
    expect(screen.queryByTestId('limit-card-model-advice')).toBeNull()
    await act(async () => undefined)
  })
})

describe('a terminal on the work account (R17)', () => {
  it('offers a fresh session first, and asks before carrying the conversation off it', async () => {
    useTerminalStore.setState({ terminals: [T('t1', { agentAccountId: 'acc_w' })] })
    card()
    openLimit(ctx({ accountId: 'acc_w' }))
    await waitFor(() => expect(accounts.check).toHaveBeenCalled())
    await act(async () => undefined)
    expect(screen.getByTestId('limit-card-new')).toHaveTextContent('New terminal on personal')
    expect(screen.getByTestId('limit-card-continue')).toHaveTextContent('Continue on personal')
    click('limit-card-continue')
    expect(screen.getByTestId('limit-card-carry')).toHaveTextContent('This conversation is on work, which isn\'t offered automatically. Carry it to personal?')
    expect(startSwitch).not.toHaveBeenCalled()
    click('limit-card-carry-no')
    expect(screen.queryByTestId('limit-card-carry')).toBeNull()
    click('limit-card-continue')
    click('limit-card-carry-yes')
    // Main refuses a switch off work that doesn't carry the user's yes (D14, R17).
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_a', expect.objectContaining({ reason: 'usage limit', confirmed: true }))
    expect(st().accountSwitch).toBeNull()
  })

  it('asks the same question before signing a signed-out account in, and opens the sheet only on yes', async () => {
    useTerminalStore.setState({ terminals: [T('t1', { agentAccountId: 'acc_w' })] })
    accounts.check.mockImplementation(async (id: string) => (id === 'acc_c' ? identity(C, false) : identity(B, true)))
    card()
    openLimit(ctx({ accountId: 'acc_w' }))
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(3))
    await act(async () => undefined)
    click('limit-card-more')
    click('limit-card-sign-in')
    // The question comes first: no sheet, no switch, and no new terminal on an account with no session.
    expect(screen.getByTestId('limit-card-carry')).toHaveTextContent('This conversation is on work, which isn\'t offered automatically. Carry it to spare?')
    expect(screen.queryByTestId('limit-card-carry-new')).toBeNull()
    expect(st().signInSheet).toBeNull()
    expect(startSwitch).not.toHaveBeenCalled()
    // No: nothing opens, nothing is carried, and the card is still there for another way out.
    click('limit-card-carry-no')
    expect(screen.queryByTestId('limit-card-carry')).toBeNull()
    expect(st().signInSheet).toBeNull()
    expect(st().accountSwitch).not.toBeNull()
    // Yes: the sheet opens; the sign-in finishing carries the conversation, with the yes main insists on.
    click('limit-card-sign-in')
    expect(screen.getByTestId('limit-card-carry-yes')).toHaveTextContent('Sign in and carry it to spare')
    click('limit-card-carry-yes')
    expect(st().signInSheet?.accountId).toBe('acc_c')
    expect(startSwitch).not.toHaveBeenCalled()
    st().signInSheet!.then!()
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_c', { reason: 'usage limit', known: { kind: 'signed-in', email: null }, confirmed: true })
  })

  it('asks nothing before a sign-in for a terminal on an account that is offered automatically', async () => {
    accounts.check.mockImplementation(async (id: string) => (id === 'acc_c' ? identity(C, false) : identity(B, true)))
    card()
    openLimit()
    await waitFor(() => expect(accounts.check).toHaveBeenCalledTimes(2))
    await act(async () => undefined)
    click('limit-card-more')
    click('limit-card-sign-in')
    expect(screen.queryByTestId('limit-card-carry')).toBeNull()
    expect(st().signInSheet?.accountId).toBe('acc_c')
    st().signInSheet!.then!()
    expect(startSwitch).toHaveBeenCalledWith('t1', 'acc_c', { reason: 'usage limit', known: { kind: 'signed-in', email: null } })
  })

  it('opens the fresh session from its first button, or from the question', async () => {
    useTerminalStore.setState({ terminals: [T('t1', { agentAccountId: 'acc_w' })] })
    card()
    openLimit(ctx({ accountId: 'acc_w' }))
    click('limit-card-new')
    expect(newTerminalOn).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 'acc_a' }))
    openLimit(ctx({ accountId: 'acc_w' }))
    click('limit-card-continue')
    click('limit-card-carry-new')
    expect(newTerminalOn).toHaveBeenCalledTimes(2)
    expect(startSwitch).not.toHaveBeenCalled()
    await act(async () => undefined)
  })
})

describe('agy', () => {
  const g1 = row({ id: 'g1', agent: 'agy', label: 'home', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'g1@example.test', order: 0 })
  const g2 = row({ id: 'g2', agent: 'agy', label: 'school', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'g2@example.test', order: 1 })
  const g3 = row({ id: 'g3', agent: 'agy', label: 'old', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'g1@example.test', order: 2 })
  const gw = row({ id: 'gw', agent: 'agy', label: 'work', profile: null, folder: null, isDefault: false, folderExists: false, lastEmail: null, email: 'w@corp.test', autoOffer: false, order: 3 })
  const agyLimit = ctx({ agent: 'agy', accountId: 'g1', terminals: ['a1', 'a2'], words: 'You have exhausted your quota on this model.', kind: { scope: 'model', window: 'other' } })

  it('moves every agy terminal in agy\'s own sheet, asks no agent, and offers no new terminal', async () => {
    useTerminalStore.setState({ accountsView: view([g1, g2, g3, gw]), terminals: [T('a1', { agentCommand: 'agy', agentAccountId: 'g1' }), T('a2', { agentCommand: 'agy', agentAccountId: 'g1' })] })
    card('a1')
    openLimit(agyLimit)
    expect(screen.getByTestId('limit-card-headline')).toHaveTextContent('is out of usage on home (g1@example.test).')
    // old is the same Google account that ran out; work is never offered.
    expect(screen.getByTestId('limit-card-continue')).toHaveTextContent('Continue on school')
    click('limit-card-more')
    expect(screen.getAllByTestId('limit-card-other').map((o) => o.getAttribute('data-state'))).toEqual(['same-sign-in'])
    expect(screen.queryByTestId('limit-card-fresh')).toBeNull()
    expect(screen.queryByTestId('limit-card-fresh-first')).toBeNull()
    expect(accounts.check).not.toHaveBeenCalled()
    click('limit-card-continue')
    expect(st().agySwitchSheet).toEqual({ targetId: 'g2' })
    expect(startSwitch).not.toHaveBeenCalled()
    expect(st().accountSwitch).toEqual({ terminalId: 'a2', limit: { ...agyLimit, terminals: ['a2'] } })
  })

  it('leaves the work question to agy\'s sheet, which asks it for every terminal it moves', async () => {
    useTerminalStore.setState({ accountsView: view([g1, g2, gw]), terminals: [T('a1', { agentCommand: 'agy', agentAccountId: 'gw' })] })
    card('a1')
    openLimit({ ...agyLimit, accountId: 'gw', terminals: ['a1'] })
    expect(screen.queryByTestId('limit-card-new')).toBeNull()
    click('limit-card-continue')
    expect(screen.queryByTestId('limit-card-carry')).toBeNull()
    expect(st().agySwitchSheet).toEqual({ targetId: 'g1' })
    await act(async () => undefined)
  })
})
