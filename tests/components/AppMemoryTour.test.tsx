import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// App-level wiring of the first-run memory tour and Memory ▸ This week: the tour opens once after
// the onboarding tour is finished (not skipped), the palette reopens it, and "Open This week" or a
// termpolis:openMemory event with view 'week' opens the Memory panel on that tab.

const SEEN_KEY = 'termpolis.onboarding.seen.v1'
const TOUR_SEEN_KEY = 'termpolis.memoryTour.seen.v1'

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
vi.mock('../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ startRepoResweep: () => () => {} }))
vi.mock('../../src/renderer/src/components/AgentIntegration/AgentReviewModal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/AgentIntegration/AgentReviewModal')>()),
  agentReviewNeeded: vi.fn(async () => false),
}))
vi.mock('../../src/renderer/src/components/ConsentReview/ConsentReviewModal', () => ({
  consentNeedsReview: vi.fn(async () => false),
  ConsentReviewModal: () => null,
}))

// The onboarding tour, with both ways out.
vi.mock('../../src/renderer/src/components/Onboarding/OnboardingModal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/Onboarding/OnboardingModal')>()),
  OnboardingModal: ({ onDone }: { onDone: (r: { completed: boolean }) => void }) => (
    <div data-testid="onboarding">
      <button onClick={() => onDone({ completed: true })}>Get started</button>
      <button onClick={() => onDone({ completed: false })}>Skip onboarding</button>
    </div>
  ),
}))

// The memory tour keeps its real seen flag; the modal is a stand-in with its two exits.
vi.mock('../../src/renderer/src/components/Memory/MemoryTour', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/Memory/MemoryTour')>()),
  MemoryTour: ({ onClose }: { onClose: (o?: { openWeek?: boolean }) => void }) => (
    <div data-testid="memory-tour">
      <button onClick={() => onClose()}>Finish tour</button>
      <button onClick={() => onClose({ openWeek: true })}>Open This week</button>
    </div>
  ),
}))

vi.mock('../../src/renderer/src/components/Memory/Memory', () => ({
  Memory: ({ weekRequest, onClose }: { weekRequest?: number; onClose?: () => void }) => (
    <div data-testid="memory-panel" data-week={String(weekRequest ?? 0)}><button onClick={onClose}>Close memory</button></div>
  ),
}))

vi.mock('../../src/renderer/src/components/CommandPalette/CommandPalette', () => ({
  CommandPalette: ({ onAction }: { onAction: (a: string) => void }) => (
    <button onClick={() => onAction('memory_tour')}>Palette: Memory tour</button>
  ),
}))

import App from '../../src/renderer/src/App'

function bridge() {
  ;(window as any).termpolis = new Proxy({} as Record<string, any>, {
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
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })
const memoryTour = () => screen.queryByTestId('memory-tour')
const panel = () => screen.queryByTestId('memory-panel')

beforeEach(() => {
  localStorage.clear()
  bridge()
})

afterEach(() => {
  delete (window as any).termpolis
  localStorage.clear()
})

describe('App memory tour wiring', () => {
  it('opens the memory tour after onboarding is finished, and Open This week opens the week view', async () => {
    render(<App />)
    expect(screen.getByTestId('onboarding')).toBeInTheDocument()
    expect(memoryTour()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    await settle()
    expect(screen.queryByTestId('onboarding')).toBeNull()
    expect(memoryTour()).toBeInTheDocument()
    expect(panel()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open This week' }))
    expect(memoryTour()).toBeNull()
    expect(await screen.findByTestId('memory-panel')).toHaveAttribute('data-week', '1')
  })

  it('does not open the memory tour when onboarding is skipped, or when it was seen before', async () => {
    const first = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip onboarding' }))
    await settle()
    expect(memoryTour()).toBeNull()
    first.unmount()

    localStorage.removeItem(SEEN_KEY)
    localStorage.setItem(TOUR_SEEN_KEY, '1')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    await settle()
    expect(memoryTour()).toBeNull()
  })

  it('the command palette reopens the tour, and Finish closes it without opening Memory', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    localStorage.setItem(TOUR_SEEN_KEY, '1')
    render(<App />)
    await settle()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Palette: Memory tour' }))
    expect(memoryTour()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Finish tour' }))
    await settle()
    expect(memoryTour()).toBeNull()
    expect(panel()).toBeNull()
  })

  it('termpolis:openMemory opens the panel, on This week only when asked', async () => {
    localStorage.setItem(SEEN_KEY, '1')
    render(<App />)
    await settle()
    act(() => { window.dispatchEvent(new Event('termpolis:openMemory')) })
    expect(await screen.findByTestId('memory-panel')).toHaveAttribute('data-week', '0')
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openMemory', { detail: { view: 'week' } })) })
    expect(panel()).toHaveAttribute('data-week', '1')
    // Closed and opened again (Ctrl+Shift+M, the Settings link): back on Overview, not This week.
    fireEvent.click(screen.getByRole('button', { name: 'Close memory' }))
    expect(panel()).toBeNull()
    act(() => { window.dispatchEvent(new Event('termpolis:openMemory')) })
    expect(await screen.findByTestId('memory-panel')).toHaveAttribute('data-week', '0')
  })
})
