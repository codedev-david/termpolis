// The launch ask ("Launch on codedev?") picks an account for a launch from the Welcome screen or the command
// palette. The terminal, its proxy step-aside and folder trust are made for that account, so the line that is
// TYPED has to go on it too: this uses the REAL launchAgents (AppLaunchAccount.test.tsx mocks it, so it can't see
// which account the typed line is built for).
import React from 'react'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@sentry/react', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  init: vi.fn(), captureException: vi.fn(), setTag: vi.fn(), addBreadcrumb: vi.fn(),
}))
vi.mock('../../src/renderer/src/components/TitleBar/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../../src/renderer/src/components/Sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('../../src/renderer/src/components/TabView/TabView', () => ({ TabView: () => null }))
vi.mock('../../src/renderer/src/components/SplitView/SplitView', () => ({ SplitView: () => null }))
vi.mock('../../src/renderer/src/components/StatusBar/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../../src/renderer/src/components/UpdateBanner/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../../src/renderer/src/components/SecretSentBanner/SecretSentBanner', () => ({ SecretSentBanner: () => null }))
vi.mock('../../src/renderer/src/components/ShieldScanFailedBanner/ShieldScanFailedBanner', () => ({ ShieldScanFailedBanner: () => null }))
vi.mock('../../src/renderer/src/components/Welcome/Welcome', () => ({
  Welcome: (p: { onLaunchAgent: (id: string) => void }) => <button data-testid="welcome-claude" onClick={() => p.onLaunchAgent('claude')}>claude</button>,
}))
vi.mock('../../src/renderer/src/components/CommandPalette/CommandPalette', () => ({
  CommandPalette: (p: { onAction: (a: string) => void }) => (
    <>
      <button data-testid="palette-claude" onClick={() => p.onAction('launch_claude')}>claude</button>
    </>
  ),
}))
vi.mock('../../src/renderer/src/components/Onboarding/OnboardingModal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/Onboarding/OnboardingModal')>()),
  OnboardingModal: () => null,
}))
vi.mock('../../src/renderer/src/components/AgentIntegration/AgentReviewModal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/AgentIntegration/AgentReviewModal')>()),
  agentReviewNeeded: () => false,
}))
vi.mock('../../src/renderer/src/components/ConsentReview/ConsentReviewModal', () => ({
  consentNeedsReview: async () => false,
  ConsentReviewModal: () => null,
}))
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ startRepoResweep: () => () => {} }))
// NOTE: launchAgents is the REAL one here; only its settle delays are shortened.
vi.mock('../../src/renderer/src/lib/testAgents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/lib/testAgents')>()),
  testDelay: () => 1,
}))

import App from '../../src/renderer/src/App'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { answerLaunchAsk } from '../../src/renderer/src/lib/launchAsk'

let api: Record<string, any>
let created: unknown[][]
let writes: Array<[string, string]>
let launchLineReqs: Array<Record<string, any>>

function bridge() {
  created = []
  writes = []
  api = {
    loadSession: vi.fn(async () => ({ success: true, data: { terminals: [], workspaces: [] } })),
    saveSession: vi.fn(),
    readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: '' } })),
    pickDirectory: vi.fn(async () => ({ success: true, data: '/work/repo' })),
    createTerminal: vi.fn(async (...args: unknown[]) => { created.push(args); return { success: true } }),
    writeToTerminal: vi.fn((id: string, data: string) => { writes.push([id, data]) }),
  }
  ;(window as any).termpolis = new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
      return target[prop]
    },
  })
  ;(window as any).mcpEvents = { onTerminalCreated: vi.fn(() => () => {}), onTerminalClosed: vi.fn(() => () => {}) }
}

// main's accounts:launch-account: `requested` while registered, else the preferred account.
function accountsBridge(preferred: string) {
  launchLineReqs = []
  const accounts: Record<string, any> = {
    launchAccount: vi.fn(async (_agent: string, requested: string | null) => ({ success: true, data: { accountId: requested ?? preferred } })),
    launchLine: vi.fn(async (req: Record<string, any>) => {
      launchLineReqs.push(req)
      return { success: true, data: { line: `LINE-FOR-${req.accountId}`, accountId: req.accountId } }
    }),
  }
  ;(window as any).accounts = new Proxy(accounts, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
      return target[prop]
    },
  })
}

const NOW = Date.now()
const row = (over: Record<string, unknown>) => ({
  id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true, order: 0, connect: true,
  origin: 'adopted', folderExists: true, shares: [], lastEmail: 'a@example.test', connection: null, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
})
const OUT = { seenAt: NOW - 1000, resetsAt: NOW + 3_600_000, text: "You've hit your session limit", scope: 'account' }
const asked = (): void => {
  useTerminalStore.setState({
    accountsView: {
      accounts: [row({ limit: OUT }), row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, order: 1, lastEmail: 'b@example.test' })],
      preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h',
    } as never,
  })
}

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) })
const waitLong = () => act(async () => { await new Promise((r) => setTimeout(r, 1000)) })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('termpolis.onboarding.seen.v1', '1')
  useTerminalStore.setState({ terminals: [], activeTerminalId: null } as never)
  bridge()
})
afterEach(() => {
  cleanup()
  delete (window as any).termpolis
  delete (window as any).mcpEvents
  delete (window as any).accounts
})

describe('the account the launch ask picked is the account the typed line is built for', () => {
  it('Welcome screen: after "Launch on codedev", main builds the line for codedev', async () => {
    accountsBridge('acc_a')
    render(<App />)
    await settle()
    asked()
    fireEvent.click(await screen.findByTestId('welcome-claude'))
    await vi.waitFor(() => expect(useTerminalStore.getState().launchAsk).not.toBeNull())
    await act(async () => { answerLaunchAsk({ kind: 'on', accountId: 'acc_b' }) })
    await settle()
    await waitLong()
    expect(created[0].slice(5)).toEqual(['acc_b', 'claude'])
    expect(launchLineReqs.length).toBeGreaterThan(0)
    // The line must be built for the account the user chose.
    expect(launchLineReqs[0].accountId).toBe('acc_b')
  })

  it('command palette: after "Launch on codedev", main builds the line for codedev', async () => {
    accountsBridge('acc_a')
    render(<App />)
    await settle()
    asked()
    await act(async () => { (window as any).__openCommandPalette(true) })
    fireEvent.click(await screen.findByTestId('palette-claude'))
    await vi.waitFor(() => expect(useTerminalStore.getState().launchAsk).not.toBeNull())
    await act(async () => { answerLaunchAsk({ kind: 'on', accountId: 'acc_b' }) })
    await settle()
    await waitLong()
    expect(created[0].slice(5)).toEqual(['acc_b', 'claude'])
    expect(launchLineReqs.length).toBeGreaterThan(0)
    expect(launchLineReqs[0].accountId).toBe('acc_b')
  })
})
