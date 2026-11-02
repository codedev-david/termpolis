// The swarm restart offers (§9, src/renderer/src/components/Accounts/SwarmRestartOffers.tsx): one
// card per account that ran out, each phase's words and buttons, and what each button does through
// swarmRestart.ts, with main's bridges faked. It takes no key, and it is installed as the swarm
// loop's offer while it is mounted.
import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SwarmRestartList, SwarmRestartOffers, SwarmRestartPaneCard } from '../../src/renderer/src/components/Accounts/SwarmRestartOffers'
import { _resetSwarmRestartForTest, liveRestartDeps } from '../../src/renderer/src/lib/swarmRestart'
import type { RestartDeps, SwarmRestartGroup } from '../../src/renderer/src/lib/swarmRestart'
import { _resetLimitWatchForTest, noteSwarmStop } from '../../src/renderer/src/lib/limitWatch'
import { _resetStopReportsForTest } from '../../src/renderer/src/lib/swarmStopReports'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_m', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true, order: 0,
    connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test',
    connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}
const VIEW: AccountsView = {
  accounts: [row({}), row({ id: 'acc_c', label: 'codedev', profile: '/h/.claude-codedev', isDefault: false, order: 1, lastEmail: 'c@example.test' })],
  preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
}
const W1 = { terminalId: 'w1', agentName: 'Claude', role: 'Build UI', summary: 'usage limit reached (resets 3pm)' }
const W2 = { terminalId: 'w2', agentName: 'Claude', role: 'Tests', summary: 'usage limit reached (resets 3pm)' }
const group = (over: Partial<SwarmRestartGroup> = {}): SwarmRestartGroup => ({
  id: 'g1', agent: 'claude', accountId: 'acc_m', words: "You've hit your session limit · resets 3pm", resetsAt: null,
  workers: [W1], targets: ['acc_c'], phase: { kind: 'offered' }, ...over,
})
const worker = (id: string) => ({
  id, name: `Claude (${id})`, color: '', shellType: 'powershell' as const, cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono',
  isSwarm: true, hidden: true, swarmAgent: 'claude' as const, agentAccountId: 'acc_m',
})

let deps: RestartDeps
const makeDeps = (): RestartDeps => ({
  store: useTerminalStore.getState,
  swarm: { getTasks: vi.fn(async () => ({ success: true, data: [] })), sendMessage: vi.fn(async () => ({ success: true }) as never) },
  accounts: {
    switchAccount: vi.fn(async () => ({ success: true as const, data: { kind: 'switched' as const, resumed: true } })),
    check: vi.fn(async (id: string) => ({ success: true as const, data: { ...row({ id }), identity: { email: `${id}@example.test`, signedIn: true, checkedAt: 0, source: 'auth-status' as const } } })),
    noteLimit: vi.fn(async () => ({ success: true as const, data: undefined })),
    limitLook: vi.fn(async () => ({ success: true as const, data: { turned: false } as never })),
  },
  termpolis: { claudeTrustWorkspace: vi.fn(async () => ({ success: true })) as never, memoryPrepareCodexContext: vi.fn(async () => ({ success: true, data: null })) as never },
  primerEnabled: () => false,
  now: () => 0,
  newId: () => 'g1',
  focused: () => true,
  notify: vi.fn(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
})
const messages = (): string[] => (deps.swarm.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3] as string)
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

beforeEach(() => {
  _resetSwarmRestartForTest()
  _resetLimitWatchForTest()
  _resetStopReportsForTest()
  deps = makeDeps()
  ;(window as any).swarmAPI = deps.swarm
  ;(window as any).accounts = deps.accounts
  useTerminalStore.setState({ terminals: [worker('w1'), worker('w2')], accountsView: VIEW, accountsByHand: {}, relaunching: {}, swarmRestarts: [] })
})

afterEach(() => {
  cleanup()
  delete (window as any).swarmAPI
  delete (window as any).accounts
  useTerminalStore.setState({ terminals: [], accountsView: null, swarmRestarts: [], relaunching: {} })
})

describe('where the offer shows (the in-app account UI, §2.6)', () => {
  const put = (gs: SwarmRestartGroup[]) => act(() => { useTerminalStore.setState({ swarmRestarts: gs }) })

  it('shows at the window\'s bottom right only while no other place shows it', () => {
    const { rerender } = render(<SwarmRestartOffers deps={() => deps} />)
    put([group(), group({ id: 'g2', workers: [W2] })])
    expect(screen.getAllByTestId('swarm-restart-offer')).toHaveLength(2)
    // The swarm dashboard is open: it shows them all itself.
    rerender(<SwarmRestartOffers deps={() => deps} dashboardOpen />)
    expect(screen.queryByTestId('swarm-restart-offers')).toBeNull()
    // A worker's pane on screen shows its own: the stack shows the rest.
    rerender(<SwarmRestartOffers deps={() => deps} />)
    act(() => { useTerminalStore.setState({ terminals: [{ ...worker('w1'), hidden: false }, worker('w2')], viewMode: 'tabs', activeTerminalId: 'w1', showSettings: false }) })
    expect(screen.getAllByTestId('swarm-restart-offer').map((o) => o.textContent)).toEqual([expect.stringContaining('Claude (Tests), a swarm worker, ran out of usage on personal.')])
  })

  it('lists every offer inside the swarm dashboard, and none without one', () => {
    const { container } = render(<SwarmRestartList deps={() => deps} />)
    expect(container.innerHTML).toBe('')
    put([group(), group({ id: 'g2', workers: [W2] })])
    expect(screen.getByTestId('swarm-restart-list').querySelectorAll('[data-testid="swarm-restart-offer"]')).toHaveLength(2)
  })

  it('shows a worker\'s own offer at the top of its pane, in the same card, and none on another pane', async () => {
    render(<><SwarmRestartPaneCard terminalId="w1" deps={() => deps} /><SwarmRestartPaneCard terminalId="t9" deps={() => deps} /></>)
    expect(screen.queryByTestId('swarm-restart-pane')).toBeNull()
    put([group({ workers: [W1, W2] })])
    const card = screen.getByTestId('swarm-restart-pane')
    expect(card).toHaveTextContent("2 of the swarm's workers ran out of usage on personal.")
    expect(screen.getAllByTestId('swarm-restart-pane')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('swarm-restart-decline'))
    await flush()
    expect(deps.swarm.sendMessage).toHaveBeenCalled()
  })

  it('shows none in a store that holds no offers', () => {
    act(() => { useTerminalStore.setState({ swarmRestarts: undefined as never, accountsView: undefined as never }) })
    const { container } = render(<><SwarmRestartPaneCard terminalId="w1" /><SwarmRestartList /></>)
    expect(container.innerHTML).toBe('')
  })

  it('names the account in a pane\'s card with no accounts read yet as "that account"', () => {
    act(() => { useTerminalStore.setState({ swarmRestarts: [group()], accountsView: undefined as never }) })
    render(<><SwarmRestartPaneCard terminalId="w1" deps={() => deps} /><SwarmRestartList deps={() => deps} /></>)
    expect(screen.getAllByTestId('swarm-restart-on').map((b) => b.textContent)).toEqual(['Restart it on that account', 'Restart it on that account'])
  })
})

describe('SwarmRestartOffers', () => {
  it('shows nothing with no offer', () => {
    const { container } = render(<SwarmRestartOffers deps={() => deps} />)
    expect(container.innerHTML).toBe('')
  })

  it('offers one worker\'s restart on each account that is a way out, in the CLI\'s words, and restarts it on a click', async () => {
    useTerminalStore.setState({ swarmRestarts: [group()] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByText('Claude (Build UI), a swarm worker, ran out of usage on personal.')).toBeTruthy()
    expect(screen.getByText('“You\'ve hit your session limit · resets 3pm”')).toBeTruthy()
    expect(screen.getByText(/It keeps its conversation and its task\. With no answer in 5 minutes, the conductor gives its task to another agent\./)).toBeTruthy()
    expect(screen.getByTestId('swarm-restart-on').textContent).toBe('Restart it on codedev')
    fireEvent.click(screen.getByTestId('swarm-restart-on'))
    expect(screen.getByTestId('swarm-restart-running').textContent).toBe('Restarting on codedev…')
    await flush()
    expect(deps.accounts.switchAccount).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'w1', targetId: 'acc_c' }))
    expect(screen.getByTestId('swarm-restart-done').textContent).toBe('Claude (Build UI): on codedev, its conversation resumed.')
    // Done: the close takes it down, telling the conductor nothing more.
    const sent = messages().length
    fireEvent.click(screen.getByTestId('swarm-restart-close'))
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
    expect(messages()).toHaveLength(sent)
  })

  it('offers several workers\' restart as one, and lets the conductor reassign them', async () => {
    useTerminalStore.setState({ swarmRestarts: [group({ workers: [W1, W2] })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByText("2 of the swarm's workers ran out of usage on personal.")).toBeTruthy()
    expect(screen.getByTestId('swarm-restart-on').textContent).toBe('Restart all on codedev')
    expect(screen.getByText(/They keep their conversations and their tasks\. With no answer in 5 minutes, the conductor gives their tasks to another agent\./)).toBeTruthy()
    fireEvent.click(screen.getByTestId('swarm-restart-decline'))
    await flush()
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
    expect(messages()).toHaveLength(2)
    expect(messages()[0]).toMatch(/^Claude \(Build UI, terminal w1\) is blocked: usage limit reached \(resets 3pm\)\. Check its screen/)
  })

  it('takes the close of an open offer for "don\'t restart"', async () => {
    useTerminalStore.setState({ swarmRestarts: [group()] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByTestId('swarm-restart-close').getAttribute('aria-label')).toBe('Don\'t restart: the conductor reassigns')
    fireEvent.click(screen.getByTestId('swarm-restart-close'))
    await flush()
    expect(messages()).toHaveLength(1)
  })

  it('asks the second question (R17), and restarts or reassigns on the answer', async () => {
    useTerminalStore.setState({ swarmRestarts: [group({ phase: { kind: 'confirm', targetId: 'acc_c', question: 'personal isn\'t offered automatically. Carry this worker\'s conversation to codedev?' } })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByTestId('swarm-restart-question').textContent).toBe('personal isn\'t offered automatically. Carry this worker\'s conversation to codedev?')
    expect(screen.getByTestId('swarm-restart-confirm').textContent).toBe('Restart on codedev')
    fireEvent.click(screen.getByTestId('swarm-restart-confirm'))
    await flush()
    expect(deps.accounts.switchAccount).toHaveBeenCalledTimes(1)
    cleanup()
    useTerminalStore.setState({ swarmRestarts: [group({ phase: { kind: 'confirm', targetId: 'acc_c', question: 'q' } })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    fireEvent.click(screen.getByTestId('swarm-restart-decline'))
    await flush()
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
  })

  it('shows a restart under way with no close, and an account gone by a name it can still say', () => {
    useTerminalStore.setState({ swarmRestarts: [group({ phase: { kind: 'restarting', targetId: 'acc_gone' } })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByTestId('swarm-restart-running').textContent).toBe('Restarting on that account…')
    expect(screen.queryByTestId('swarm-restart-close')).toBeNull()
    cleanup()
    useTerminalStore.setState({ accountsView: null, swarmRestarts: [group()] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByText('Claude (Build UI), a swarm worker, ran out of usage.')).toBeTruthy()
  })

  // P2: the conductor's own limit. Running it again is conductorManager's; with no conductor to run,
  // the card says so.
  it('offers to run the conductor again, with no reassigning, and says how it went', async () => {
    useTerminalStore.setState({ swarmRestarts: [group({ conductor: true, workers: [] })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByText('The swarm\'s conductor ran out of usage on personal.')).toBeTruthy()
    expect(screen.getByText(/It resumes its conversation where that account can see it, or starts again with the same goal\. The swarm's workers and tasks stay\./)).toBeTruthy()
    expect(screen.queryByTestId('swarm-restart-decline')).toBeNull()
    expect(screen.getByTestId('swarm-restart-close').getAttribute('aria-label')).toBe('Close')
    expect(screen.getByTestId('swarm-restart-on').textContent).toBe('Run the conductor again on codedev')
    fireEvent.click(screen.getByTestId('swarm-restart-on'))
    expect(screen.getByTestId('swarm-restart-running').textContent).toBe('Running the conductor again on codedev…')
    await flush()
    expect(screen.getByTestId('swarm-restart-done').textContent).toBe('The conductor wasn\'t run again: the conductor is gone: start the swarm again from its dashboard.')
    fireEvent.click(screen.getByTestId('swarm-restart-close'))
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
    expect(messages()).toEqual([])
  })

  it('asks the conductor\'s second question, and runs it or not on the answer', async () => {
    useTerminalStore.setState({ swarmRestarts: [group({ conductor: true, workers: [], phase: { kind: 'confirm', targetId: 'acc_c', question: 'q' } })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByTestId('swarm-restart-confirm').textContent).toBe('Run it on codedev')
    expect(screen.getByTestId('swarm-restart-decline').textContent).toBe('Don\'t run it again')
    fireEvent.click(screen.getByTestId('swarm-restart-confirm'))
    await flush()
    expect(screen.getByTestId('swarm-restart-done')).toBeTruthy()
    cleanup()
    useTerminalStore.setState({ swarmRestarts: [group({ conductor: true, workers: [], phase: { kind: 'confirm', targetId: 'acc_c', question: 'q' } })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    fireEvent.click(screen.getByTestId('swarm-restart-decline'))
    await flush()
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
    expect(messages()).toEqual([])
  })

  it('takes no key: a key pressed anywhere changes nothing', () => {
    useTerminalStore.setState({ swarmRestarts: [group()] })
    render(<SwarmRestartOffers deps={() => deps} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(useTerminalStore.getState().swarmRestarts).toHaveLength(1)
    expect(document.activeElement).toBe(document.body)
  })

  it('is the swarm loop\'s offer while mounted, where main can switch accounts, and not after', async () => {
    const { unmount } = render(<SwarmRestartOffers deps={() => deps} />)
    await act(async () => { await noteSwarmStop(W1, { status: 'blocked', summary: W1.summary }) })
    expect(useTerminalStore.getState().swarmRestarts).toHaveLength(1)
    unmount()
    await noteSwarmStop(W2, { status: 'blocked', summary: W2.summary })
    expect(useTerminalStore.getState().swarmRestarts).toHaveLength(1)
    expect(messages().pop()).toMatch(/^Claude \(Tests, terminal w2\) is blocked: .* close its terminal/)
    // No switch in main: nothing installed.
    delete (window as any).accounts
    render(<SwarmRestartOffers deps={() => deps} />)
    _resetStopReportsForTest()
    useTerminalStore.setState({ swarmRestarts: [] })
    await noteSwarmStop(W1, { status: 'blocked', summary: W1.summary })
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
  })
})

describe('liveRestartDeps', () => {
  it('reads the app\'s store, bridges and clock', () => {
    const d = liveRestartDeps()
    expect(d.store).toBe(useTerminalStore.getState)
    expect(d.swarm).toBe(window.swarmAPI)
    expect(d.accounts).toBe(window.accounts)
    expect(typeof d.newId()).toBe('string')
    expect(d.focused()).toBe(document.hasFocus())
    vi.useFakeTimers()
    const fn = vi.fn()
    const h = d.setTimer(fn, 10)
    d.clearTimer(h)
    vi.advanceTimersByTime(20)
    expect(fn).not.toHaveBeenCalled()
    vi.useRealTimers()
    expect(d.now()).toBeGreaterThan(0)
    expect(d.primerEnabled()).toBe(true)
  })
})

// WHOLE-R1-F2 / UI-R1-J: the offer's way to the sign-in sheet (account-switcher-ui.md 2.3).
describe('SwarmRestartOffers: an account to sign in to', () => {
  it('offers "Sign in to <it> and restart" beside the accounts it can restart on, and opens the sheet on a click', async () => {
    useTerminalStore.setState({
      accountsView: { ...VIEW, accounts: [...VIEW.accounts, row({ id: 'acc_w', label: 'work', profile: '/h/.claude-work', isDefault: false, order: 2 })] },
      swarmRestarts: [group({ signIn: ['acc_w'] })],
    })
    render(<SwarmRestartOffers deps={() => deps} />)
    const buttons = screen.getAllByTestId('swarm-restart-sign-in')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Sign in to work and restart')
    // The other ways are still there, and so is the decline.
    expect(screen.getByText('Restart it on codedev')).toBeTruthy()
    expect(screen.getByTestId('swarm-restart-decline')).toBeTruthy()
    fireEvent.click(buttons[0])
    expect(useTerminalStore.getState().signInSheet).toMatchObject({ accountId: 'acc_w', doneLabel: 'Restart it on work' })
  })

  it('offers it alone when no account is signed in, with the decline beside it', () => {
    useTerminalStore.setState({ swarmRestarts: [group({ targets: [], signIn: ['acc_c'] })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.queryByTestId('swarm-restart-on')).toBeNull()
    expect(screen.getByTestId('swarm-restart-sign-in').textContent).toBe('Sign in to codedev and restart')
    expect(screen.getByTestId('swarm-restart-decline')).toBeTruthy()
  })

  it('says "restart all" for several workers, and shows nothing of it once the offer moved on', () => {
    useTerminalStore.setState({ swarmRestarts: [group({ workers: [W1, W2], signIn: ['acc_c'] })] })
    const { rerender } = render(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.getByTestId('swarm-restart-sign-in').textContent).toBe('Sign in to codedev and restart all')
    act(() => { useTerminalStore.setState({ swarmRestarts: [group({ workers: [W1, W2], signIn: ['acc_c'], phase: { kind: 'restarting', targetId: 'acc_c' } })] }) })
    rerender(<SwarmRestartOffers deps={() => deps} />)
    expect(screen.queryByTestId('swarm-restart-sign-in')).toBeNull()
  })

  it('opens the sheet for the conductor\'s run-again card too, and runs the conductor when it is done', async () => {
    useTerminalStore.setState({ swarmRestarts: [group({ conductor: true, workers: [], targets: [], signIn: ['acc_c'] })] })
    render(<SwarmRestartOffers deps={() => deps} />)
    const button = screen.getByTestId('swarm-restart-sign-in')
    expect(button.textContent).toBe('Sign in to codedev and run the conductor again')
    fireEvent.click(button)
    const sheet = useTerminalStore.getState().signInSheet!
    expect(sheet).toMatchObject({ accountId: 'acc_c', doneLabel: 'Run the conductor again on codedev' })
    // No clock runs for the conductor, so closing the sheet unsigned leaves nothing to restart.
    expect(sheet.cancelled).toBeUndefined()
  })
})
