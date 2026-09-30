import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentIntegrationStatus } from '../../src/shared/agentIntegration'

// App-level wiring of the launch reviews: which of the tour, the agent review and the telemetry
// review shows, in what order, and that the tour showing at launch rules both reviews out even
// when the seen flag is written after the first render (e2e does exactly that).

const SEEN_KEY = 'termpolis.onboarding.seen.v1'

const hooks = vi.hoisted(() => ({
  // Runs while App's children render, after App's own first-render reads and before its effects.
  duringChildRender: null as null | (() => void),
  consentNeedsReview: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

// The chrome around the reviews has nothing to do with them.
vi.mock('../../src/renderer/src/components/TitleBar/TitleBar', () => ({
  TitleBar: () => { hooks.duringChildRender?.(); return null },
}))
vi.mock('../../src/renderer/src/components/Sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('../../src/renderer/src/components/TabView/TabView', () => ({ TabView: () => null }))
vi.mock('../../src/renderer/src/components/SplitView/SplitView', () => ({ SplitView: () => null }))
vi.mock('../../src/renderer/src/components/StatusBar/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../../src/renderer/src/components/UpdateBanner/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../../src/renderer/src/components/SecretSentBanner/SecretSentBanner', () => ({ SecretSentBanner: () => null }))
vi.mock('../../src/renderer/src/components/ShieldScanFailedBanner/ShieldScanFailedBanner', () => ({ ShieldScanFailedBanner: () => null }))
vi.mock('../../src/renderer/src/components/Welcome/Welcome', () => ({ Welcome: () => null }))
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ startRepoResweep: () => () => {} }))

// The real seen-flag read; the tour itself is a stand-in with a way out.
vi.mock('../../src/renderer/src/components/Onboarding/OnboardingModal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/Onboarding/OnboardingModal')>()),
  OnboardingModal: ({ onDone }: { onDone: () => void }) => (
    <div data-testid="tour"><button onClick={onDone}>Close tour</button></div>
  ),
}))

// The real agent review, with its check watched.
vi.mock('../../src/renderer/src/components/AgentIntegration/AgentReviewModal', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/renderer/src/components/AgentIntegration/AgentReviewModal')>()
  return { ...real, agentReviewNeeded: vi.fn(real.agentReviewNeeded) }
})

vi.mock('../../src/renderer/src/components/ConsentReview/ConsentReviewModal', () => {
  hooks.consentNeedsReview = vi.fn(async () => false)
  return {
    consentNeedsReview: hooks.consentNeedsReview,
    ConsentReviewModal: ({ onDone }: { onDone: () => void }) => (
      <div data-testid="telemetry-review"><button onClick={onDone}>Not now</button></div>
    ),
  }
})

import App from '../../src/renderer/src/App'
import { agentReviewNeeded } from '../../src/renderer/src/components/AgentIntegration/AgentReviewModal'

function status(over: Partial<AgentIntegrationStatus> = {}): AgentIntegrationStatus {
  return {
    consent: null,
    legacyDetected: false,
    connected: false,
    primerHook: true,
    agents: {
      claude: { installed: true, configPath: '/home/me/.claude/settings.json', registered: false },
      codex: { installed: false, configPath: '/home/me/.codex/config.toml', registered: false },
      gemini: { installed: false, configPath: '/home/me/.gemini/settings.json', registered: false },
    },
    autoAllowedTools: [],
    trustedFolders: [],
    codexHomeTrusted: false,
    ...over,
  }
}

/** Every bridge call App's startup makes: the ones named here, and a harmless answer for the rest. */
function bridge(over: Record<string, unknown> = {}) {
  const api: Record<string, any> = {
    agentIntegrationStatus: vi.fn(async () => ({ success: true, data: status() })),
    agentIntegrationSet: vi.fn(async () => ({ success: true, data: { status: status({ consent: 'granted' }), changes: [] } })),
    ...over,
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
  return api
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })

const agentReview = () => screen.queryByTestId('agent-review-modal')
const telemetryReview = () => screen.queryByTestId('telemetry-review')
const tour = () => screen.queryByTestId('tour')

beforeEach(() => {
  localStorage.clear()
  hooks.duringChildRender = null
  hooks.consentNeedsReview.mockReset()
  hooks.consentNeedsReview.mockResolvedValue(true)
  vi.mocked(agentReviewNeeded).mockClear()
})

afterEach(() => {
  delete (window as any).termpolis
  localStorage.clear()
})

describe('App launch reviews', () => {
  it('asks neither review when the tour shows at launch, even once the seen flag is written after the first render', async () => {
    bridge()
    hooks.duringChildRender = () => { localStorage.setItem(SEEN_KEY, '1') }
    render(<App />)
    expect(localStorage.getItem(SEEN_KEY)).toBe('1')
    expect(tour()).toBeInTheDocument()
    await settle()
    expect(agentReviewNeeded).not.toHaveBeenCalled()
    expect(hooks.consentNeedsReview).not.toHaveBeenCalled()
    expect(agentReview()).toBeNull()
    expect(telemetryReview()).toBeNull()

    // Closing the tour does not bring either up later in the session.
    fireEvent.click(screen.getByRole('button', { name: 'Close tour' }))
    await settle()
    expect(tour()).toBeNull()
    expect(agentReview()).toBeNull()
    expect(telemetryReview()).toBeNull()
    expect(agentReviewNeeded).not.toHaveBeenCalled()
    expect(hooks.consentNeedsReview).not.toHaveBeenCalled()
  })

  it('after an earlier tour, asks about the agents first and telemetry second', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    const api = bridge()
    render(<App />)
    expect(tour()).toBeNull()
    expect(await screen.findByTestId('agent-review-modal')).toBeInTheDocument()
    expect(agentReviewNeeded).toHaveBeenCalledWith(true)
    expect(hooks.consentNeedsReview).toHaveBeenCalledTimes(1)
    expect(telemetryReview()).toBeNull()

    fireEvent.click(screen.getByTestId('agent-review-connect'))
    expect(await screen.findByTestId('telemetry-review')).toBeInTheDocument()
    expect(api.agentIntegrationSet).toHaveBeenCalledWith({ connect: true, primerHook: true })
    expect(agentReview()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(telemetryReview()).toBeNull()
    expect(agentReview()).toBeNull()
  })

  it('asks only about telemetry when the agents already have an answer', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    bridge({ agentIntegrationStatus: vi.fn(async () => ({ success: true, data: status({ consent: 'granted', connected: true }) })) })
    render(<App />)
    expect(await screen.findByTestId('telemetry-review')).toBeInTheDocument()
    expect(agentReview()).toBeNull()
  })

  it('shows nothing when there is nothing to ask', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    hooks.consentNeedsReview.mockResolvedValue(false)
    bridge({ agentIntegrationStatus: vi.fn(async () => ({ success: true, data: status({ consent: 'declined' }) })) })
    render(<App />)
    await settle()
    expect(agentReviewNeeded).toHaveBeenCalledTimes(1)
    expect(agentReview()).toBeNull()
    expect(telemetryReview()).toBeNull()
  })

  it('ignores checks still in flight when the tour is reopened and closed meanwhile', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    const agent = deferred<unknown>()
    const telemetry = deferred<boolean>()
    hooks.consentNeedsReview.mockImplementation(() => telemetry.promise)
    bridge({ agentIntegrationStatus: vi.fn(() => agent.promise) })
    render(<App />)
    act(() => { window.dispatchEvent(new Event('termpolis:reopenOnboarding')) })
    expect(tour()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close tour' }))
    agent.resolve({ success: true, data: status() })
    telemetry.resolve(true)
    await settle()
    expect(tour()).toBeNull()
    expect(agentReview()).toBeNull()
    expect(telemetryReview()).toBeNull()
  })

  it('never shows a review over the tour, and the tour answers it', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    bridge()
    render(<App />)
    expect(await screen.findByTestId('agent-review-modal')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new Event('termpolis:reopenOnboarding')) })
    expect(tour()).toBeInTheDocument()
    expect(agentReview()).toBeNull()
    expect(telemetryReview()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close tour' }))
    await settle()
    expect(agentReview()).toBeNull()
    expect(telemetryReview()).toBeNull()
  })
})
