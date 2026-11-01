// App.tsx's part in the account switch (§7.1, R7, R10): Ctrl+Shift+N opens the dialog for the
// active terminal; the prompt poller answers nothing in a terminal a relaunch types into, and
// leaves the login-method picker to the user once the agent has more than one account. Same
// harness as AppMcpTerminals.test.tsx: every child that isn't under test is a stub.
import React from 'react'
import { render, act, fireEvent, cleanup, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@sentry/react', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  init: vi.fn(),
  captureException: vi.fn(),
  setTag: vi.fn(),
  addBreadcrumb: vi.fn(),
}))

vi.mock('../../src/renderer/src/components/TitleBar/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../../src/renderer/src/components/Sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('../../src/renderer/src/components/TabView/TabView', () => ({ TabView: () => null }))
vi.mock('../../src/renderer/src/components/SplitView/SplitView', () => ({ SplitView: () => null }))
vi.mock('../../src/renderer/src/components/StatusBar/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../../src/renderer/src/components/UpdateBanner/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../../src/renderer/src/components/SecretSentBanner/SecretSentBanner', () => ({ SecretSentBanner: () => null }))
vi.mock('../../src/renderer/src/components/ShieldScanFailedBanner/ShieldScanFailedBanner', () => ({ ShieldScanFailedBanner: () => null }))
vi.mock('../../src/renderer/src/components/Welcome/Welcome', () => ({ Welcome: () => null }))
vi.mock('../../src/renderer/src/components/Onboarding/OnboardingModal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/Onboarding/OnboardingModal')>()),
  OnboardingModal: () => null,
}))
vi.mock('../../src/renderer/src/components/AgentIntegration/AgentReviewModal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/AgentIntegration/AgentReviewModal')>()),
  agentReviewNeeded: () => false,
}))
vi.mock('../../src/renderer/src/components/ConsentReview/ConsentReviewModal', () => ({
  consentNeedsReview: async () => false,
  ConsentReviewModal: () => null,
}))
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ startRepoResweep: () => () => {} }))
// The dialog has its own suite: here only whether App mounts it for the terminal asked.

import App from '../../src/renderer/src/App'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { _resetLimitWatchForTest } from '../../src/renderer/src/lib/limitWatch'
import type { AccountsView } from '../../src/shared/agentAccounts'

/** Claude Code's login-method picker, as the poller reads a screen. */
const PICKER = 'Select login method:\r\n❯ 1. Claude account with subscription\r\n  2. Anthropic Console account\r\n'

function bridge(output: string) {
  const api: Record<string, any> = {
    loadSession: vi.fn(async () => ({ success: true, data: { terminals: [], workspaces: [] } })),
    saveSession: vi.fn(),
    readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output } })),
    writeToTerminal: vi.fn(),
  }
  ;(window as any).termpolis = new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (!(prop in target)) {
        target[prop] = prop.startsWith('on')
          ? vi.fn(() => () => {})
          : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
      }
      return target[prop]
    },
  })
  ;(window as any).mcpEvents = { onTerminalCreated: vi.fn(() => () => {}), onTerminalClosed: vi.fn(() => () => {}) }
  return api
}

function view(n: number): AccountsView {
  const accounts = Array.from({ length: n }, (_, i) => ({ id: `acc_${i}`, agent: 'claude', label: `a${i}` })) as never
  return { accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' }
}

const T = { id: 't1', name: 'Claude Code — repo', color: '', shellType: 'gitbash' as const, cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude' }

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  // App saves the session a second after a change, on a timer it never clears: a fake one, which
  // teardown drops, so it can't fire once window.termpolis is gone.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear()
  localStorage.setItem('termpolis.onboarding.seen.v1', '1')
  _resetLimitWatchForTest()
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null, accountSwitch: null, relaunching: {}, accountsView: null, limitBanners: [], accountMenu: null, switchRuns: {}, queuedSwitches: {} })
})

afterEach(() => {
  // App goes first: the store reset below, under a mounted App, would schedule one more save.
  cleanup()
  vi.useRealTimers()
  delete (window as any).termpolis
  delete (window as any).mcpEvents
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null, accountSwitch: null, relaunching: {}, accountsView: null, limitBanners: [], accountMenu: null, switchRuns: {}, queuedSwitches: {} })
})

describe('App: the account switch', () => {
  it('opens the account menu for the active terminal on Ctrl+Shift+N, for none without one, and never with no account (D13)', async () => {
    bridge('')
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1', accountsView: null, accountMenu: null }) })
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true })
    expect(useTerminalStore.getState().accountMenu).toBeNull()
    act(() => { useTerminalStore.setState({ terminals: [], activeTerminalId: null, accountsView: view(2) }) })
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true })
    expect(useTerminalStore.getState().accountMenu).toBeNull()
    act(() => { useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1' }) })
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true })
    expect(useTerminalStore.getState().accountMenu).toEqual({ terminalId: 't1' })
  })

  it('leaves Ctrl+Shift+N to a terminal that runs no agent with an account, though accounts are registered', async () => {
    bridge('')
    render(<App />)
    await settle()
    for (const terminal of [{ ...T, id: 'p1', agentCommand: undefined }, { ...T, id: 'c1', agentCommand: 'codex' }, { ...T, id: 'w1', agentCommand: 'claude-sandbox' }]) {
      act(() => { useTerminalStore.setState({ terminals: [terminal], activeTerminalId: terminal.id, accountsView: view(2), accountMenu: null }) })
      fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true })
      expect(useTerminalStore.getState().accountMenu, terminal.id).toBeNull()
    }
  })

  it('answers the palette\'s Switch account… with a notice, not silence, when the active terminal has no account to switch', async () => {
    bridge('')
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [{ ...T, agentCommand: undefined }], activeTerminalId: 't1', accountsView: view(2), accountMenu: null, memoryNotice: null }) })
    await act(async () => { (window as any).__openCommandPalette(true) })
    fireEvent.change(await screen.findByPlaceholderText('Type a command...'), { target: { value: 'switch account' } })
    fireEvent.click(await screen.findByText('Switch account…'))
    expect(useTerminalStore.getState().accountMenu).toBeNull()
    expect(useTerminalStore.getState().memoryNotice).toBe('Open an agent terminal whose agent has an account to switch it.')
  })

  it.each([
    ['answers the login picker for an agent with one account, as before accounts', 1, {}, '\r'],
    ['leaves the login picker to the user once the agent has two accounts (R10)', 2, {}, null],
    ['answers nothing in a terminal a relaunch types into (R7)', 1, { t1: 'account' as const }, null],
  ])('%s', async (_name, accounts, relaunching, expected) => {
    const api = bridge(PICKER)
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1', accountsView: view(accounts), relaunching }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    const answers = api.writeToTerminal.mock.calls.filter((c: unknown[]) => c[0] === 't1').map((c: unknown[]) => c[1])
    expect(answers).toEqual(expected === null ? [] : [expected])
  })

  // A swarm worker restarted on another account can land on that account's login picker (R10):
  // what its agent is comes from main's record of run_command, not from the name the conductor
  // gave its terminal.
  it.each([
    ['leaves the login picker to the user in a worker whose agent has two accounts, whatever the worker is named', 'claude' as const, null],
    ['answers it in a worker whose recorded agent has one account', 'codex' as const, '\r'],
  ])('%s', async (_name, swarmAgent, expected) => {
    const api = bridge(PICKER)
    ;(window as any).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: [] })), sendMessage: vi.fn(async () => ({ success: true })) }
    render(<App />)
    await settle()
    act(() => {
      useTerminalStore.setState({
        terminals: [{ ...T, id: 'w1', isSwarm: true, hidden: true, agentCommand: undefined, swarmAgent }], accountsView: view(2),
        swarmAgents: [{ terminalId: 'w1', agentName: 'Backend Dev', role: 'API', status: 'working' }],
      })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    await settle()
    const answers = api.writeToTerminal.mock.calls.filter((c: unknown[]) => c[0] === 'w1').map((c: unknown[]) => c[1])
    expect(answers).toEqual(expected === null ? [] : [expected])
    delete (window as any).swarmAPI
  })
})

// The usage-limit chooser in the 2 s loop (§8.1, R22): main's look at each agent terminal Termpolis
// launched whose screen changed, never the conductor's; a new limit records itself and opens the
// chooser, or a banner while a key is being typed. A swarm worker's stop still goes to the
// conductor, as v1.54.0 sends it.
describe('App: the usage-limit chooser', () => {
  const LOOK = {
    agent: 'claude', live: true, turned: true, startAt: 10, accountId: 'acc_0', byHand: false,
    status: { status: 'blocked', summary: 'usage limit reached (resets 3pm (America/New_York))' },
    words: "You've hit your session limit · resets 3pm (America/New_York)",
  }
  function accounts(look: unknown = LOOK) {
    const api = { limitLook: vi.fn(async () => ({ success: true, data: look })), noteLimit: vi.fn(async () => ({ success: true })) }
    ;(window as any).accounts = new Proxy(api as Record<string, any>, {
      get(target, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined
        if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
        return target[prop]
      },
    })
    return api
  }
  afterEach(() => { delete (window as any).accounts })

  it('opens the chooser for a limit in a terminal in view, recording it against the account first', async () => {
    bridge('a screen')
    const a = accounts()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1', accountsView: view(2) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(a.limitLook).toHaveBeenCalledWith('t1')
    expect(a.noteLimit).toHaveBeenCalledWith('acc_0', expect.objectContaining({ text: LOOK.words, scope: 'account', window: 'session' }))
    expect(useTerminalStore.getState().accountSwitch).toMatchObject({ terminalId: 't1', limit: { agent: 'claude', accountId: 'acc_0', terminals: ['t1'] } })
  })

  it('opens its card even while a key is being typed: the card never takes a key meant for the terminal', async () => {
    bridge('a screen')
    accounts()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1', accountsView: view(2) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    fireEvent.keyDown(window, { key: 'a' })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    await settle()
    expect(useTerminalStore.getState().accountSwitch).toMatchObject({ terminalId: 't1', limit: { terminals: ['t1'] } })
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })

  it("never looks at the conductor's terminal", async () => {
    bridge('a screen')
    const a = accounts()
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [{ ...T, isConductor: true }], activeTerminalId: 't1', accountsView: view(2) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(a.limitLook).not.toHaveBeenCalled()
  })

  it("tells the conductor of a swarm worker's limit, opening no chooser for it", async () => {
    // Claude Code's limit reply above its box, as the real captures draw it.
    const rows = ['❯ Build the login page.', "  ⎿ \u00a0You've hit your session limit · resets 3pm (America/New_York)", '', '─'.repeat(80), '❯ ', '─'.repeat(80)]
    bridge(`\x1b[H\x1b[2J${rows.map((r, i) => `\x1b[${i + 1};1H${r}`).join('')}`)
    const a = accounts()
    const sendMessage = vi.fn(async () => ({ success: true }))
    ;(window as any).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: [] })), sendMessage }
    render(<App />)
    await settle()
    act(() => {
      useTerminalStore.setState({
        terminals: [{ ...T, id: 'w1', isSwarm: true, hidden: true, agentCommand: undefined }], accountsView: view(2),
        swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status: 'working' }],
      })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    await settle()
    expect(sendMessage).toHaveBeenCalledWith('system', 'conductor', 'info', expect.stringMatching(/^Claude \(Build UI, terminal w1\) is blocked: usage limit reached/))
    expect(a.limitLook).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
    delete (window as any).swarmAPI
  })
})
