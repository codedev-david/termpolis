// A swarm worker switched to another account by hand (§9, T11): its chip in the swarm dashboard
// (SwarmWorkerAccounts.tsx) opens the account menu for it, which offers only the accounts that can
// take a worker over and no new terminal; the restart's progress shows beside the chip, and the
// conductor is told how it went, as after the restart offer's. Never the conductor's terminal. Main
// is the preload's mock.
import React from 'react'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AccountMenu } from '../../src/renderer/src/components/Accounts/AccountMenu'
import { SwarmWorkerAccounts } from '../../src/renderer/src/components/Accounts/SwarmWorkerAccounts'
import { _resetSwarmRestartForTest } from '../../src/renderer/src/lib/swarmRestart'
import { _resetStopReportsForTest } from '../../src/renderer/src/lib/swarmStopReports'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'
import type { SwitchOutcome } from '../../src/shared/accountSwitch'
import type { TerminalSession } from '../../src/renderer/src/types'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test',
    connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false, email: 'a@example.test', ...over,
  }
}
const A = row({})
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, email: 'b@example.test', lastEmail: 'b@example.test', order: 1 })
const NOBYPASS = row({ id: 'acc_n', label: 'nobypass', profile: '/h/.claude-n', isDefault: false, bypassReady: false, order: 2 })
const LOOSE = row({ id: 'acc_l', label: 'loose', profile: '/h/.claude-l', isDefault: false, connect: false, connection: null, order: 3 })
const view = (accounts: AccountRowView[]): AccountsView => ({
  accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
  advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
})
const WORKER: TerminalSession = {
  id: 'w1', name: 'Claude (Build UI)', color: '', shellType: 'powershell', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono',
  isSwarm: true, hidden: true, swarmAgent: 'claude', agentAccountId: 'acc_a',
}

let sendMessage: ReturnType<typeof vi.fn>
let switchAccount: ReturnType<typeof vi.fn>

beforeEach(() => {
  _resetSwarmRestartForTest()
  _resetStopReportsForTest()
  sendMessage = vi.fn(async () => ({ success: true }))
  switchAccount = vi.fn(async () => ({ success: true, data: { kind: 'switched', resumed: true, sessionId: 's' } as SwitchOutcome }))
  ;(window as any).swarmAPI = { sendMessage, getTasks: vi.fn(async () => ({ success: true, data: [] })) }
  ;(window as any).accounts = {
    list: vi.fn(async () => ({ success: true, data: useTerminalStore.getState().accountsView })),
    check: vi.fn(async (id: string) => ({ success: true, data: { ...row({ id }), identity: { email: `${id}@example.test`, signedIn: true, checkedAt: 1, source: 'auth-status' } } })),
    switchAccount,
    onSwitchProgress: vi.fn(() => () => {}),
    limitLook: vi.fn(async () => ({ success: true, data: { turned: false } })),
  }
  ;(window as any).termpolis = { claudeTrustWorkspace: vi.fn(async () => ({ success: true })), memoryPrepareCodexContext: vi.fn(async () => ({ success: true, data: null })) }
  useTerminalStore.setState({
    terminals: [WORKER, { ...WORKER, id: 'c1', name: 'Swarm Conductor', isConductor: true, swarmAgent: undefined, agentCommand: 'claude' }],
    swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'blocked' }],
    accountsView: view([A, B, NOBYPASS, LOOSE]), accountsByHand: {}, accountSwitch: null, relaunching: {}, swarmRestarts: [], memoryNotice: null,
    accountMenu: null, switchRuns: {}, queuedSwitches: {},
  })
})

afterEach(() => {
  cleanup()
  delete (window as any).accounts
  delete (window as any).swarmAPI
  useTerminalStore.setState({ terminals: [], swarmAgents: [], accountsView: null, accountSwitch: null, swarmRestarts: [], accountMenu: null, switchRuns: {} })
})

describe('SwarmWorkerAccounts', () => {
  it('shows each worker\'s account chip, and opens the account menu for the worker', () => {
    render(<SwarmWorkerAccounts />)
    expect(screen.getByTestId('swarm-worker-account').textContent).toBe('Claude (Build UI)personal')
    fireEvent.click(screen.getByTestId('account-chip'))
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 'w1' })
  })

  it('shows nothing where no worker\'s agent has two accounts (D13), nor for a worker whose agent main never named', () => {
    useTerminalStore.setState({ accountsView: view([A]) })
    const { container } = render(<SwarmWorkerAccounts />)
    expect(container.innerHTML).toBe('')
    cleanup()
    useTerminalStore.setState({ accountsView: view([A, B]), terminals: [{ ...WORKER, swarmAgent: undefined }] })
    expect(render(<SwarmWorkerAccounts />).container.innerHTML).toBe('')
  })

  it('shows a worker whose account a line changed as "?"', () => {
    useTerminalStore.setState({ accountsByHand: { w1: true } })
    render(<SwarmWorkerAccounts />)
    expect(screen.getByTestId('account-chip').textContent).toBe('?')
  })
})

describe('the workers\' chips in a store that holds no swarm or accounts state', () => {
  it('shows no chip', () => {
    act(() => { useTerminalStore.setState({ swarmAgents: undefined as never, accountsView: undefined as never }) })
    const { container } = render(<SwarmWorkerAccounts />)
    expect(container.innerHTML).toBe('')
  })
})

describe('the account menu on a swarm worker', () => {
  const openFor = (id: string) => act(() => { useTerminalStore.getState().openAccountSwitch(id) })
  const rows = () => screen.getAllByTestId('account-menu-row')

  it('offers only the accounts that can take a worker over, saying why the others can\'t, and no new terminal', () => {
    render(<AccountMenu />)
    openFor('w1')
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('personal'),
      expect.stringContaining('codedev'),
      expect.stringContaining('Accept bypass mode in it once to take workers'),
      expect.stringContaining('Not connected: a worker needs Termpolis\'s tools'),
    ])
    expect(rows().map((r) => r.getAttribute('aria-disabled'))).toEqual([null, null, 'true', 'true'])
    expect(screen.queryByTestId('account-menu-new-terminal')).toBeNull()
  })

  it('restarts it, shows how it went beside its chip, and tells the conductor it waits at its prompt', async () => {
    render(<><AccountMenu /><SwarmWorkerAccounts /></>)
    openFor('w1')
    fireEvent.click(rows()[1])
    await waitFor(() => expect(sendMessage).toHaveBeenCalled())
    expect(switchAccount).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'w1', targetId: 'acc_b', shellType: 'powershell' }))
    expect(sendMessage).toHaveBeenCalledWith('system', 'conductor', 'info',
      'Claude (Build UI, terminal w1) was restarted on another account and resumed its conversation. It is waiting at its prompt: send it \'Continue your task.\' with submit=true (STEP 5).')
    expect(await screen.findByTestId('switch-status-done')).toHaveTextContent('Claude Code is on codedev now. Conversation resumed.')
  })

  it('tells it to send the task again after a restart without the conversation, and nothing after one that failed', async () => {
    switchAccount.mockResolvedValueOnce({ success: true, data: { kind: 'fresh', why: 'not-found' } })
    render(<><AccountMenu /><SwarmWorkerAccounts /></>)
    openFor('w1')
    fireEvent.click(rows()[1])
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][3]).toMatch(/restarted on another account without its conversation\. Send it its task again/)
    act(() => useTerminalStore.getState().dropSwitchRun('w1'))
    switchAccount.mockResolvedValueOnce({ success: true, data: { kind: 'agent-alive' } })
    openFor('w1')
    fireEvent.click(rows()[1])
    expect(await screen.findByTestId('switch-status-failed')).toHaveTextContent('didn\'t exit')
    // A worker is never offered a new terminal for it.
    expect(screen.queryByTestId('switch-status-new-terminal')).toBeNull()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('is never offered for the conductor\'s terminal', () => {
    render(<AccountMenu />)
    openFor('c1')
    expect(screen.queryByTestId('account-menu')).toBeNull()
  })
})
