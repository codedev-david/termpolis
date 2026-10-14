import React from 'react'
import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A Linked machines job notification, clicked: main brings the window forward and sends
// `linked:show`, and App opens Settings on the Linked machines tab, where that job is listed and
// can be stopped. Settings itself is a stand-in: which tab it opens on is what is under test.

const nav = vi.hoisted(() => ({ setPendingSettingsTab: vi.fn() }))

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/settingsNav', () => ({
  setPendingSettingsTab: nav.setPendingSettingsTab,
  consumePendingSettingsTab: () => null,
}))
vi.mock('../../src/renderer/src/lib/monaco-bootstrap', () => ({}))
vi.mock('../../src/renderer/src/components/SettingsPane/SettingsPane', () => ({ SettingsPane: () => null }))
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

/** Every bridge call App makes, answered harmlessly. */
function bridge(): void {
  const api: Record<string, unknown> = {
    loadSession: vi.fn(async () => ({ success: true, data: { terminals: [], workspaces: [] } })),
    saveSession: vi.fn(),
  }
  ;(window as unknown as { termpolis: unknown }).termpolis = new Proxy(api, {
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
  ;(window as unknown as { mcpEvents: unknown }).mcpEvents = {
    onTerminalCreated: vi.fn(() => () => {}),
    onTerminalClosed: vi.fn(() => () => {}),
  }
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })

type TestWindow = { termpolis?: unknown; mcpEvents?: unknown; linked?: unknown }
const win = window as unknown as TestWindow

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('termpolis.onboarding.seen.v1', '1')
  nav.setPendingSettingsTab.mockClear()
  useTerminalStore.setState({ terminals: [], swarmAgents: [], activeTerminalId: null, showSettings: false })
  bridge()
})

afterEach(() => {
  delete win.termpolis
  delete win.mcpEvents
  delete win.linked
  useTerminalStore.setState({ showSettings: false })
  localStorage.clear()
})

describe('App: a Linked machines job notification, clicked', () => {
  it('opens Settings on the Linked machines tab, and lets go of the event when it unmounts', async () => {
    let show: (() => void) | null = null
    const off = vi.fn()
    win.linked = { onShow: vi.fn((cb: () => void) => { show = cb; return off }) }
    const { unmount } = render(<App />)
    await settle()
    expect(show).not.toBeNull()
    expect(useTerminalStore.getState().showSettings).toBe(false)
    act(() => show!())
    expect(nav.setPendingSettingsTab).toHaveBeenCalledWith('linked')
    expect(useTerminalStore.getState().showSettings).toBe(true)
    unmount()
    expect(off).toHaveBeenCalled()
  })

  it('runs as before with a preload that has no Linked machines', async () => {
    const { unmount } = render(<App />)
    await settle()
    expect(nav.setPendingSettingsTab).not.toHaveBeenCalled()
    expect(() => unmount()).not.toThrow()
  })
})
