// The Welcome screen's agent buttons and the command palette's "Launch Claude/Codex/Gemini" create the
// terminal for the account the agent will launch on (launchAgents resolves the same one a moment later),
// so the compression proxy's step-aside and the folder trust are that account's profile's: not the
// default profile's. An agent with no accounts is launched as before.
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
      <button data-testid="palette-codex" onClick={() => p.onAction('launch_codex')}>codex</button>
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
vi.mock('../../src/renderer/src/lib/agentLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/lib/agentLaunch')>()),
  launchAgents: vi.fn(),
}))

import App from '../../src/renderer/src/App'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

let api: Record<string, any>
let created: unknown[][]

function bridge() {
  created = []
  api = {
    loadSession: vi.fn(async () => ({ success: true, data: { terminals: [], workspaces: [] } })),
    saveSession: vi.fn(),
    readTerminalBuffer: vi.fn(async () => ({ success: true, data: { output: '' } })),
    pickDirectory: vi.fn(async () => ({ success: true, data: '/work/repo' })),
    createTerminal: vi.fn(async (...args: unknown[]) => { created.push(args); return { success: true } }),
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

function accountsBridge(answer: (agent: string) => string | null) {
  const accounts: Record<string, any> = {
    launchLine: vi.fn(),
    launchAccount: vi.fn(async (agent: string) => ({ success: true, data: { accountId: answer(agent) } })),
  }
  ;(window as any).accounts = new Proxy(accounts, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      if (!(prop in target)) target[prop] = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(async () => ({ success: false, error: 'not part of this test' }))
      return target[prop]
    },
  })
}

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) })

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

describe('the account an agent launched from the Welcome screen or the palette is created for', () => {
  it('is the one the agent will launch on, from the Welcome screen', async () => {
    accountsBridge((agent) => (agent === 'claude' ? 'acc_pref' : null))
    render(<App />)
    await settle()
    fireEvent.click(await screen.findByTestId('welcome-claude'))
    await settle()
    expect(created).toHaveLength(1)
    expect(created[0].slice(5)).toEqual(['acc_pref', 'claude'])
  })

  it('is the one the agent will launch on, from the palette', async () => {
    accountsBridge((agent) => (agent === 'claude' ? 'acc_pref' : null))
    render(<App />)
    await settle()
    await act(async () => { (window as any).__openCommandPalette(true) })
    fireEvent.click(await screen.findByTestId('palette-claude'))
    await settle()
    expect(created[0].slice(5)).toEqual(['acc_pref', 'claude'])
  })

  it('is none for an agent with no account, as before accounts', async () => {
    accountsBridge(() => null)
    render(<App />)
    await settle()
    await act(async () => { (window as any).__openCommandPalette(true) })
    fireEvent.click(await screen.findByTestId('palette-codex'))
    await settle()
    expect(created[0].slice(5)).toEqual([undefined, 'codex'])
  })

  it('is none when the build has no accounts bridge at all', async () => {
    render(<App />)
    await settle()
    fireEvent.click(await screen.findByTestId('welcome-claude'))
    await settle()
    expect(created[0].slice(5)).toEqual([undefined, 'claude'])
  })
})
