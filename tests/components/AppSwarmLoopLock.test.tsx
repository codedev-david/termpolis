// App.tsx's swarm loop skips a worker while a relaunch holds it (`if (store.relaunching[agent.terminalId])
// continue`): the poller then presses nothing into the shell line a switch is typing (R7) and reads no
// stop from a screen the switch is redrawing. AppAccountSwitch.test.tsx pins it for a plain terminal;
// this pins it for a swarm worker (a mutant that removed the guard survived every other test).
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
import { _resetStopReportsForTest, carryWorkerStop } from '../../src/renderer/src/lib/swarmStopReports'

const PICKER = 'Select login method:\r\n❯ 1. Claude account with subscription\r\n  2. Anthropic Console account\r\n'
const LIMIT_ROWS = ['❯ Build the login page.', "  ⎿  You've hit your session limit · resets 3pm (America/New_York)", '', '─'.repeat(80), '❯ ', '─'.repeat(80)]
const LIMIT_SCREEN = `\x1b[H\x1b[2J${LIMIT_ROWS.map((r, i) => `\x1b[${i + 1};1H${r}`).join('')}`

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
const view = (n: number) => ({ accounts: Array.from({ length: n }, (_, i) => ({ id: `acc_${i}`, agent: 'claude', label: `a${i}` })) as never, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [], advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h' })
const WORKER = { id: 'w1', name: 'Claude (Build UI)', color: '', shellType: 'gitbash' as const, cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', isSwarm: true, hidden: true, swarmAgent: 'claude' as const }
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
  delete (window as any).termpolis; delete (window as any).mcpEvents; delete (window as any).swarmAPI; delete (window as any).accounts
  useTerminalStore.setState(RESET as never)
})

async function runWorkerLoop(output: string, relaunching: Record<string, 'account' | 'model' | 'sign-in'>, worker: typeof WORKER & { agentAccountId?: string } = WORKER, status: 'working' | 'idle' = 'working') {
  const api = bridge(output)
  const sendMessage = vi.fn(async () => ({ success: true }))
  ;(window as any).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: [] })), sendMessage }
  render(<App />)
  await settle()
  act(() => {
    useTerminalStore.setState({
      terminals: [worker], accountsView: view(1) as never, relaunching,
      swarmAgents: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', status }],
    } as never)
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
  await settle()
  return { api, sendMessage }
}

describe('App: the swarm loop leaves a worker a relaunch holds alone (R7)', () => {
  it('control: with no relaunch the poller answers the login picker (one account), as before', async () => {
    const { api } = await runWorkerLoop(PICKER, {})
    expect(api.writeToTerminal.mock.calls.filter((c: unknown[]) => c[0] === 'w1').map((c: unknown[]) => c[1])).toEqual(['\r'])
  })
  it('presses nothing into a worker a relaunch types into', async () => {
    const { api } = await runWorkerLoop(PICKER, { w1: 'account' })
    expect(api.writeToTerminal.mock.calls.filter((c: unknown[]) => c[0] === 'w1')).toEqual([])
  })
  it('control: with no relaunch the worker\'s limit is reported to the conductor', async () => {
    const { sendMessage } = await runWorkerLoop(LIMIT_SCREEN, {})
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
  it('reads no stop from a worker a relaunch holds (the screen is the switch\'s)', async () => {
    const { sendMessage } = await runWorkerLoop(LIMIT_SCREEN, { w1: 'account' })
    expect(sendMessage).not.toHaveBeenCalled()
  })
  it('gives the restart offer the words of a stop on a worker with an account, and reports it all the same when no other account is a way out', async () => {
    const api: Record<string, any> = { switchAccount: vi.fn(), noteLimit: vi.fn(async () => ({ success: true })) }
    ;(window as any).accounts = new Proxy(api, {
      get(target, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined
        if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
        return target[prop]
      },
    })
    const { sendMessage } = await runWorkerLoop(LIMIT_SCREEN, {}, { ...WORKER, agentAccountId: 'acc_0' })
    // The offer read the words off the screen to record the limit, found no way out, and left the report to the conductor.
    expect(api.noteLimit).toHaveBeenCalledWith('acc_0', expect.objectContaining({ text: expect.stringContaining('hit your') }))
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})

// SWARM-R1 N5: a worker Termpolis restarted on another account draws the limit it stopped at again above its empty
// box. The dashboard shows it waiting, not blocked, and the conductor hears nothing of a stop that is not the new
// run's, until the worker has taken a turn; a limit shown after that is a new stop and is reported as one.
describe('App: the swarm loop and a stop carried across a worker\'s restart (N5)', () => {
  const statusOfWorker = (): string | undefined => useTerminalStore.getState().swarmAgents.find((a) => a.terminalId === 'w1')?.status

  it('shows the carried limit as waiting and tells the conductor nothing', async () => {
    carryWorkerStop('w1', "You've hit your session limit", async () => false)
    const { sendMessage } = await runWorkerLoop(LIMIT_SCREEN, {})
    expect(statusOfWorker()).toBe('idle')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('shows a limit as blocked again, and reports it, once the worker took a turn since', async () => {
    carryWorkerStop('w1', "You've hit your session limit", async () => true)
    const { sendMessage } = await runWorkerLoop(LIMIT_SCREEN, {})
    expect(statusOfWorker()).toBe('blocked')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  const at = (rows: string[]): string => `\x1b[H\x1b[2J${rows.map((r, i) => `\x1b[${i + 1};1H${r}`).join('')}`
  const RULE = '─'.repeat(80)

  it('shows a worker that is at work as at work, whatever was carried for it', async () => {
    carryWorkerStop('w1', "You've hit your session limit", async () => false)
    await runWorkerLoop(at(['❯ continue', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE]), {}, WORKER, 'idle')
    expect(statusOfWorker()).toBe('working')
  })

  it('shows a worker that asks something as asking, whatever was carried for it', async () => {
    carryWorkerStop('w1', "You've hit your session limit", async () => false)
    await runWorkerLoop(at(['● I will edit the file.', '', RULE, ' Edit file', ' app.ts', ' Do you want to make this edit to app.ts?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session (shift+tab)', '   3. No', '', ' Esc to cancel']), {}, WORKER, 'working')
    expect(statusOfWorker()).toBe('waiting_for_input')
  })

  it('control: a worker nothing was carried for shows its limit as blocked', async () => {
    const { sendMessage } = await runWorkerLoop(LIMIT_SCREEN, {})
    expect(statusOfWorker()).toBe('blocked')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})

// SWARM-R1 N7: a worker closed while it was on a restart offer. The conductor was told to wait for Termpolis's next
// word, so when the user closes the pane it is told the worker is gone; one it closed itself, nothing.
describe('App: a worker closed while it is on a restart offer (N7)', () => {
  const GROUP = {
    id: 'g1', agent: 'claude', accountId: 'acc_0', words: "You've hit your session limit", resetsAt: null,
    workers: [{ terminalId: 'w1', agentName: 'Claude', role: 'Build UI', summary: 'usage limit reached' }], targets: ['acc_1'], phase: { kind: 'offered' },
  }
  const closedMessage = (): string[] => sendMessages().filter((m) => m.includes('was closed before Termpolis could restart it'))
  let sendMessage: ReturnType<typeof vi.fn>
  const sendMessages = (): string[] => sendMessage.mock.calls.map((c: unknown[]) => c[3] as string)

  async function runLoop(emitClosed?: (id: string) => void) {
    bridge('')
    sendMessage = vi.fn(async () => ({ success: true }))
    ;(window as any).swarmAPI = { getTasks: vi.fn(async () => ({ success: true, data: [] })), sendMessage }
    if (emitClosed) (window as any).mcpEvents = { onTerminalCreated: vi.fn(() => () => {}), onTerminalClosed: vi.fn((cb: (id: string) => void) => { closedCb = cb; return () => {} }) }
    render(<App />)
    await settle()
    act(() => {
      useTerminalStore.setState({ terminals: [{ ...WORKER, agentAccountId: 'acc_0' }], accountsView: view(2) as never, swarmRestarts: [GROUP as never] } as never)
    })
  }
  let closedCb: ((id: string) => void) | null = null

  it('is told to the conductor, and the offer goes, when the user closed the worker\'s pane', async () => {
    await runLoop()
    act(() => { useTerminalStore.setState({ terminals: [] } as never) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
    expect(closedMessage()).toHaveLength(1)
  })

  it('is told nothing when the conductor closed the worker itself (close_terminal)', async () => {
    await runLoop(() => undefined)
    act(() => { closedCb!('w1') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(useTerminalStore.getState().swarmRestarts).toEqual([])
    expect(closedMessage()).toEqual([])
  })

  it('leaves an offer whose worker is still there alone', async () => {
    await runLoop()
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await settle()
    expect(useTerminalStore.getState().swarmRestarts).toHaveLength(1)
    expect(closedMessage()).toEqual([])
  })
})
