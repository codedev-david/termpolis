import React from 'react'
import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// App-level wiring of terminals created over MCP: a paired phone's terminal is the user's own
// (in the sidebar and in the saved session the phone's list is read from), while an agent's is
// a hidden swarm worker. Before this, the phone's terminal was a hidden swarm worker too, so it
// showed on neither the desktop nor the phone once the user left it.

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
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

import App from '../../src/renderer/src/App'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

type Created = { id: string; name: string; shell: string; cwd: string; remote?: boolean; agentCommand?: string }

let emitCreated: ((data: Created) => void) | null = null

/** Every bridge call App makes: a harmless answer for each, the session load and save named. */
function bridge() {
  const api: Record<string, any> = {
    loadSession: vi.fn(async () => ({ success: true, data: { terminals: [], workspaces: [] } })),
    saveSession: vi.fn(),
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
  ;(window as any).mcpEvents = {
    onTerminalCreated: vi.fn((cb: (data: Created) => void) => { emitCreated = cb; return () => { emitCreated = null } }),
    onTerminalClosed: vi.fn(() => () => {}),
  }
  return api
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })

/** Past the one-second debounce on the session save. */
const afterSave = () => act(async () => { await new Promise(r => setTimeout(r, 1100)) })

const terminal = (id: string) => useTerminalStore.getState().terminals.find(t => t.id === id)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('termpolis.onboarding.seen.v1', '1')
  emitCreated = null
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null })
})

afterEach(() => {
  delete (window as any).termpolis
  delete (window as any).mcpEvents
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null })
  localStorage.clear()
})

describe('App: terminals created over MCP', () => {
  it('shows a terminal a phone started, saves it, and records the agent it launched', async () => {
    const api = bridge()
    render(<App />)
    await settle()
    expect(emitCreated).not.toBeNull()

    act(() => emitCreated!({
      id: 'p1', name: 'Claude · repo', shell: 'powershell', cwd: '/repo', remote: true, agentCommand: 'claude',
    }))

    const t = terminal('p1')
    expect(t).toMatchObject({ name: 'Claude · repo', cwd: '/repo', agentCommand: 'claude' })
    expect(t?.hidden).toBeFalsy()
    expect(t?.isSwarm).toBeFalsy()
    expect(useTerminalStore.getState().activeTerminalId).toBe('p1')
    // Not a swarm worker: the swarm dashboard and its status loop leave it alone.
    expect(useTerminalStore.getState().swarmAgents).toEqual([])

    // The phone's list is read from the saved session, so the terminal has to reach it.
    await afterSave()
    const saved = api.saveSession.mock.calls.at(-1)?.[0]
    expect(saved?.terminals.map((x: { id: string }) => x.id)).toEqual(['p1'])
  })

  it('adds a phone’s terminal with no agent as a plain terminal', async () => {
    bridge()
    render(<App />)
    await settle()

    act(() => emitCreated!({ id: 'p2', name: 'shell', shell: 'bash', cwd: '/repo', remote: true }))

    const t = terminal('p2')
    expect(t?.hidden).toBeFalsy()
    expect(t?.agentCommand).toBeUndefined()
  })

  it('still hides an agent’s terminal as a swarm worker, and keeps it out of the session', async () => {
    const api = bridge()
    render(<App />)
    await settle()

    api.saveSession.mockClear()
    act(() => emitCreated!({ id: 'w1', name: 'Claude (Build UI)', shell: 'bash', cwd: '/repo' }))

    expect(terminal('w1')).toMatchObject({ isSwarm: true, hidden: true })
    expect(useTerminalStore.getState().swarmAgents.map(a => a.terminalId)).toEqual(['w1'])

    // Adding it changed the terminal list, so a save ran after it, and left it out.
    await afterSave()
    expect(api.saveSession).toHaveBeenCalled()
    expect(api.saveSession.mock.calls.at(-1)?.[0].terminals).toEqual([])
  })
})
