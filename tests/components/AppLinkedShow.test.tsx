import React from 'react'
import { render, act, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A Linked machines job notification, clicked: main brings the window forward and sends
// `linked:show`, and App opens Settings on the Linked machines tab, where that job is listed and
// can be stopped. Settings itself is a stand-in that keeps its tab the way the real pane does
// (settingsNav's useSettingsTab, unmocked): which tab it shows is what is under test.

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/monaco-bootstrap', () => ({}))
vi.mock('../../src/renderer/src/components/SettingsPane/SettingsPane', async () => {
  const React = await import('react')
  const { useSettingsTab } = await import('../../src/renderer/src/lib/settingsNav')
  return {
    SettingsPane: () => React.createElement('div', { 'data-testid': 'settings-shown' }, useSettingsTab()[0]),
  }
})
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
import { consumePendingSettingsTab } from '../../src/renderer/src/lib/settingsNav'

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
  consumePendingSettingsTab()
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

/** Which tab the Settings stand-in shows, or null while Settings is closed. */
const shownTab = (): string | null => screen.queryByTestId('settings-shown')?.textContent ?? null

describe('App: a Linked machines job notification, clicked', () => {
  /** App rendered with a Linked machines preload; the notification's click, as main sends it. */
  async function withNotification() {
    let show: (() => void) | null = null
    const off = vi.fn()
    win.linked = { onShow: vi.fn((cb: () => void) => { show = cb; return off }) }
    const view = render(<App />)
    await settle()
    expect(show).not.toBeNull()
    return { ...view, off, click: async () => { act(() => show!()); await settle() } }
  }

  it('opens Settings on the Linked machines tab, and lets go of the event when it unmounts', async () => {
    const { click, unmount, off } = await withNotification()
    expect(useTerminalStore.getState().showSettings).toBe(false)
    await click()
    expect(useTerminalStore.getState().showSettings).toBe(true)
    expect(shownTab()).toBe('linked')
    unmount()
    expect(off).toHaveBeenCalled()
  })

  it('switches Settings already open on another tab, and a later plain open still starts on General', async () => {
    const { click } = await withNotification()
    act(() => useTerminalStore.getState().setShowSettings(true))
    await settle()
    expect(shownTab()).toBe('general')
    await click()
    expect(shownTab()).toBe('linked')
    // Closed, then opened the plain way: the click's request was spent where it landed.
    act(() => useTerminalStore.getState().setShowSettings(false))
    await settle()
    expect(shownTab()).toBeNull()
    act(() => useTerminalStore.getState().setShowSettings(true))
    await settle()
    expect(shownTab()).toBe('general')
  })

  it('runs as before with a preload that has no Linked machines', async () => {
    const { unmount } = render(<App />)
    await settle()
    expect(shownTab()).toBeNull()
    expect(consumePendingSettingsTab()).toBeNull()
    expect(() => unmount()).not.toThrow()
  })
})

// The session is saved a second after the last change (a debounce). That timer used to outlive App: an
// unmounted App left it pending, and a second later it called saveSession on a window whose bridge was
// already gone. In a full test run that surfaced as an "unhandled error" that made the whole run exit 1
// although every test had passed, depending on how long the worker lingered.
describe('App: the debounced session save', () => {
  afterEach(() => { vi.useRealTimers() })

  it('does not fire after App is gone', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<App />)
    // Let the session load and the first change schedule its save.
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const saveSession = (win.termpolis as { saveSession: ReturnType<typeof vi.fn> }).saveSession
    unmount()
    delete win.termpolis // the window the save would have written to
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('still saves a second after a change while App is mounted', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<App />)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const saveSession = (win.termpolis as { saveSession: ReturnType<typeof vi.fn> }).saveSession
    saveSession.mockClear()
    act(() => { useTerminalStore.setState({ viewMode: 'tab' }); useTerminalStore.setState({ allowAppMouseControl: true }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(saveSession).not.toHaveBeenCalled() // debounced: not before the second is up
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(saveSession).toHaveBeenCalledTimes(1) // once, however many changes there were
    unmount()
  })
})
