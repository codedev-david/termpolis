import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// App-level wiring of Lumopolis: the palette action show_world, Ctrl+Shift+R, and the
// termpolis:openWorld window event (the Sidebar globe) open the overlay; its onClose closes it.
// The pane gets the active terminal's cwd as its root.

const SEEN_KEY = 'termpolis.onboarding.seen.v1'

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  getClient: vi.fn(() => undefined),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('../../../src/renderer/src/components/TitleBar/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('../../../src/renderer/src/components/Sidebar/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('../../../src/renderer/src/components/TabView/TabView', () => ({ TabView: () => null }))
vi.mock('../../../src/renderer/src/components/SplitView/SplitView', () => ({ SplitView: () => null }))
vi.mock('../../../src/renderer/src/components/StatusBar/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../../../src/renderer/src/components/UpdateBanner/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../../../src/renderer/src/components/SecretSentBanner/SecretSentBanner', () => ({ SecretSentBanner: () => null }))
vi.mock('../../../src/renderer/src/components/ShieldScanFailedBanner/ShieldScanFailedBanner', () => ({ ShieldScanFailedBanner: () => null }))
vi.mock('../../../src/renderer/src/components/Welcome/Welcome', () => ({ Welcome: () => null }))
vi.mock('../../../src/renderer/src/hooks/useAutoCodeIndex', () => ({ startRepoResweep: () => () => {} }))
vi.mock('../../../src/renderer/src/components/AgentIntegration/AgentReviewModal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/renderer/src/components/AgentIntegration/AgentReviewModal')>()),
  agentReviewNeeded: vi.fn(async () => false),
}))
vi.mock('../../../src/renderer/src/components/ConsentReview/ConsentReviewModal', () => ({
  consentNeedsReview: vi.fn(async () => false),
  ConsentReviewModal: () => null,
}))

vi.mock('../../../src/renderer/src/components/World', () => ({
  WorldView: ({ root, onClose }: { root: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Lumopolis" data-root={root}><button onClick={onClose}>Close Lumopolis</button></div>
  ),
}))

vi.mock('../../../src/renderer/src/components/CommandPalette/CommandPalette', () => ({
  CommandPalette: ({ onAction }: { onAction: (a: string) => void }) => (
    <button onClick={() => onAction('show_world')}>Palette: Open Lumopolis</button>
  ),
}))

import App from '../../../src/renderer/src/App'
import { useTerminalStore } from '../../../src/renderer/src/store/terminalStore'

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
const world = () => screen.queryByRole('dialog', { name: 'Lumopolis' })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(SEEN_KEY, '1')
  bridge()
})

afterEach(() => {
  delete (window as any).termpolis
  localStorage.clear()
})

describe('App Lumopolis wiring', () => {
  it('palette action show_world opens the overlay, and its close button closes it', async () => {
    render(<App />)
    await settle()
    expect(world()).toBeNull()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Palette: Open Lumopolis' }))
    expect(await screen.findByRole('dialog', { name: 'Lumopolis' })).toHaveAttribute('data-root', '')
    fireEvent.click(screen.getByRole('button', { name: 'Close Lumopolis' }))
    expect(world()).toBeNull()
  })

  it('Ctrl+Shift+R toggles the overlay; Ctrl+Shift+W does not open it', async () => {
    render(<App />)
    await settle()
    fireEvent.keyDown(window, { key: 'W', ctrlKey: true, shiftKey: true })
    await settle()
    expect(world()).toBeNull()
    fireEvent.keyDown(window, { key: 'R', ctrlKey: true, shiftKey: true })
    expect(await screen.findByRole('dialog', { name: 'Lumopolis' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'R', ctrlKey: true, shiftKey: true })
    expect(world()).toBeNull()
  })

  it('termpolis:openWorld opens the overlay on the active terminal folder, and stays open when sent again', async () => {
    act(() => {
      useTerminalStore.setState({
        terminals: [{ id: 't-world', name: 'repo', shell: 'bash', cwd: '/repos/app', hidden: true } as any],
        activeTerminalId: 't-world',
      })
    })
    const view = render(<App />)
    await settle()
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    expect(await screen.findByRole('dialog', { name: 'Lumopolis' })).toHaveAttribute('data-root', '/repos/app')
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    expect(world()).toBeInTheDocument()
    view.unmount()
    // The listener is removed with the app: a late event finds nothing to open.
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    expect(world()).toBeNull()
    act(() => { useTerminalStore.setState({ terminals: [], activeTerminalId: null }) })
  })
})
