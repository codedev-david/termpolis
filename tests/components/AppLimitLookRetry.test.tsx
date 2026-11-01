// App.tsx's usage-limit loop (the plain terminals' 2 s tick): a screen is judged once, and a look that
// failed (main busy, an IPC error) is tried again on the next tick instead of being passed by as judged;
// a limit screen does not change, so a stop whose first look failed would otherwise be lost until the
// output moved. The harness is the swarm loop-lock test's.
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
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
vi.mock('../../src/renderer/src/components/Welcome/Welcome', () => ({ Welcome: () => null }))
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

import App from '../../src/renderer/src/App'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import { _resetLimitWatchForTest } from '../../src/renderer/src/lib/limitWatch'
import { _resetStopReportsForTest } from '../../src/renderer/src/lib/swarmStopReports'

const LIMIT_ROWS = ['❯ Build the login page.', "  ⎿  You've hit your session limit · resets 3pm (America/New_York)", '', '─'.repeat(80), '❯ ', '─'.repeat(80)]
const LIMIT_SCREEN = `[H[2J${LIMIT_ROWS.map((r, i) => `[${i + 1};1H${r}`).join('')}`
const NONE = { agent: 'claude', live: true, turned: true, startAt: 0, status: { status: 'idle', summary: 'Waiting at prompt' }, words: null, accountId: 'acc_0', byHand: false }

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
      if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
      return target[prop]
    },
  })
  ;(window as any).mcpEvents = { onTerminalCreated: vi.fn(() => () => {}), onTerminalClosed: vi.fn(() => () => {}) }
  return api
}

function accountsBridge(limitLook: ReturnType<typeof vi.fn>) {
  const api: Record<string, any> = { limitLook, noteLimit: vi.fn(async () => ({ success: true })), list: vi.fn(async () => ({ success: false, error: 'x' })) }
  ;(window as any).accounts = new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
      return target[prop]
    },
  })
  return api
}

const view = (n: number) => ({ accounts: Array.from({ length: n }, (_, i) => ({ id: `acc_${i}`, agent: 'claude', label: `a${i}`, autoOffer: true, order: i })) as never, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' })
const TERM = { id: 't1', name: 'Claude Code', color: '', shellType: 'gitbash' as const, cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'claude', agentAccountId: 'acc_0' }
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const RESET = { terminals: [], swarmAgents: [], activeTerminalId: null, accountSwitch: null, relaunching: {}, accountsView: null, limitBanners: [], accountMenu: null, switchRuns: {}, queuedSwitches: {}, swarmRestarts: [] }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear(); localStorage.setItem('termpolis.onboarding.seen.v1', '1')
  _resetLimitWatchForTest()
  _resetStopReportsForTest()
  useTerminalStore.setState(RESET as never)
})
afterEach(() => {
  cleanup(); vi.useRealTimers()
  delete (window as any).termpolis; delete (window as any).mcpEvents; delete (window as any).accounts
  useTerminalStore.setState(RESET as never)
})

async function ticks(output: string, limitLook: ReturnType<typeof vi.fn>, count: number) {
  bridge(output)
  accountsBridge(limitLook)
  render(<App />)
  await settle()
  act(() => { useTerminalStore.setState({ terminals: [TERM], accountsView: view(2) } as never) })
  for (let i = 0; i < count; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  await settle()
}

describe('App: the usage-limit look is tried again when it failed', () => {
  it('control: a look main answered is made once for a screen that does not change', async () => {
    const limitLook = vi.fn(async () => ({ success: true, data: NONE }))
    await ticks(LIMIT_SCREEN, limitLook, 3)
    expect(limitLook).toHaveBeenCalledTimes(1)
  })

  it('a look that threw is made again on the next tick, with the screen unchanged', async () => {
    const limitLook = vi.fn(async () => ({ success: true, data: NONE }))
    limitLook.mockRejectedValueOnce(new Error('ipc'))
    await ticks(LIMIT_SCREEN, limitLook, 3)
    expect(limitLook.mock.calls.length).toBe(2)
  })

  it('a look main answered with a failure is made again too, until it is answered', async () => {
    const limitLook = vi.fn(async () => ({ success: true, data: NONE }))
    limitLook.mockResolvedValueOnce({ success: false, error: 'busy' } as never)
    limitLook.mockResolvedValueOnce({ success: false, error: 'busy' } as never)
    await ticks(LIMIT_SCREEN, limitLook, 4)
    expect(limitLook.mock.calls.length).toBe(3)
  })

  it('puts a banner up for a one-account agent that ran out, and takes it down when the agent is at work again', async () => {
    const STOP = { ...NONE, status: { status: 'blocked', summary: 'usage limit reached (resets 3pm (America/New_York))' }, words: "You've hit your session limit · resets 3pm (America/New_York)" }
    const WORK = { ...NONE, status: { status: 'working', summary: 'Working...' } }
    const api = bridge(LIMIT_SCREEN)
    const limitLook = vi.fn(async () => ({ success: true, data: STOP }))
    accountsBridge(limitLook)
    render(<App />)
    await settle()
    act(() => { useTerminalStore.setState({ terminals: [TERM], accountsView: view(1) } as never) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(useTerminalStore.getState().limitBanners.map((b) => [b.kind, b.ctx.terminals])).toEqual([['single', ['t1']]])
    // The agent goes on: the screen moves, and the look says it is at work. The stop ends, and the banner with it.
    api.readTerminalBuffer.mockImplementation(async () => ({ success: true, data: { output: 'the agent is working' } }))
    limitLook.mockImplementation(async () => ({ success: true, data: WORK }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(useTerminalStore.getState().limitBanners).toEqual([])
  })
})
