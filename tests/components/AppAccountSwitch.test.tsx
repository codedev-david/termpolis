// App.tsx's part in the account switch (§7.1, R7, R10): Ctrl+Shift+N opens the dialog for the
// active terminal; the prompt poller answers nothing in a terminal a relaunch types into, and
// leaves the login-method picker to the user once the agent has more than one account. Same
// harness as AppMcpTerminals.test.tsx: every child that isn't under test is a stub.
import React from 'react'
import { render, act, fireEvent, cleanup } from '@testing-library/react'
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
vi.mock('../../src/renderer/src/components/Accounts/AccountSwitcherDialog', () => ({ AccountSwitcherDialog: () => null }))

import App from '../../src/renderer/src/App'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
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
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null, accountSwitch: null, relaunching: {}, accountsView: null })
})

afterEach(() => {
  // App goes first: the store reset below, under a mounted App, would schedule one more save.
  cleanup()
  vi.useRealTimers()
  delete (window as any).termpolis
  delete (window as any).mcpEvents
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null, accountSwitch: null, relaunching: {}, accountsView: null })
})

describe('App: the account switch', () => {
  it('opens the switch dialog for the active terminal on Ctrl+Shift+N, and for none without one', async () => {
    bridge('')
    render(<App />)
    await settle()
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true })
    expect(useTerminalStore.getState().accountSwitch).toBeNull()
    act(() => { useTerminalStore.setState({ terminals: [T], activeTerminalId: 't1' }) })
    fireEvent.keyDown(window, { key: 'N', ctrlKey: true, shiftKey: true })
    expect(useTerminalStore.getState().accountSwitch).toEqual({ terminalId: 't1' })
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
})
