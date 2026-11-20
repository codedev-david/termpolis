import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// App-level wiring of Lumopolis: the palette action show_world, Ctrl+Shift+R, and the
// termpolis:openWorld window event (the Sidebar globe) open the overlay; its onClose closes it.
// The pane gets the active terminal's cwd as its root; the ask box gets the root the pane resolved
// (the git root), never the cwd, so a terminal in a subfolder asks about the world on screen.

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

const askLink = vi.hoisted(() => ({ onEscape: () => undefined, setBusy: () => undefined }))
const launched = vi.hoisted(() => ({ fn: null as any }))
vi.mock('../../../src/renderer/src/lib/aiProfiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/src/lib/aiProfiles')>()
  launched.fn = vi.fn(async () => undefined)
  return { ...real, launchAgentProfile: launched.fn }
})
type BuildItProp = { agents: { id: string; name: string }[]; defaultAgent?: string; launch: (res: unknown, agentId: string) => void }
const BUILT = { root: '/build/pets', key: 'design:d1', title: 'Pets', prompt: 'Build the app.' }
vi.mock('../../../src/renderer/src/components/World', () => ({
  // The real pane resolves `root` to its git root; this stand-in says the cwd's root is /repos/app.
  WorldView: ({ root, width, onClose, askSlot, buildIt }: { root: string; width?: number; onClose: () => void; askSlot?: (...a: unknown[]) => React.ReactNode; buildIt?: BuildItProp }) => (
    <div role="region" aria-label="Lumopolis" data-testid="world-view" style={{ width }} data-root={root} data-agents={buildIt?.agents.map((a) => a.id).join(',')} data-default={buildIt?.defaultAgent}>
      <button onClick={onClose}>Close Lumopolis</button>
      <button onClick={() => buildIt?.launch(BUILT, 'claude')}>Build with claude</button>
      <button onClick={() => buildIt?.launch(BUILT, 'nobody')}>Build with nobody</button>
      {askSlot?.(null, null, root ? '/repos/app' : null, askLink)}
    </div>
  ),
}))
vi.mock('../../../src/renderer/src/components/World/WorldAsk', () => ({
  WorldAsk: ({ root, link }: { root: string; link?: unknown }) => (
    <div data-testid="world-ask-stub" data-root={root} data-linked={String(link === askLink)} />
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
const world = () => screen.queryByRole('region', { name: 'Lumopolis' })

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
  it('opening Lumopolis keeps the terminal area rendered beside the pane, with a divider between them', async () => {
    render(<App />)
    await settle()
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    const pane = await screen.findByTestId('world-view')
    expect(pane.parentElement).toBe(screen.getByRole('main').parentElement)
    expect(screen.getByRole('main')).toBeVisible()
    expect(screen.getByRole('main').nextElementSibling).toBe(screen.getByRole('separator'))
    expect(screen.getByRole('separator').nextElementSibling).toBe(pane)
  })

  it("a lumopolis notice shows in the app, and its Open opens the pane on that folder", async () => {
    render(<App />)
    await settle()
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:lumopolisNotice', { detail: { message: 'Another terminal asked to map app in Lumopolis.', folder: 'C:/repo/app' } })) })
    expect(screen.getByTestId('lumopolis-notice')).toHaveTextContent('Another terminal asked to map app in Lumopolis.')
    fireEvent.click(screen.getByTestId('lumopolis-notice-open'))
    expect(await screen.findByTestId('world-view')).toBeTruthy()
    expect(screen.queryByTestId('lumopolis-notice')).toBeNull()
  })

  it('the divider resizes the pane, and the width is remembered', async () => {
    localStorage.setItem('termpolis.world.paneWidth', '400')
    // jsdom has no layout: say the terminals' column is 1200 px wide.
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    render(<App />)
    await settle()
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    const pane = await screen.findByTestId('world-view')
    expect(pane).toHaveStyle({ width: '400px' })
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    expect(pane).toHaveStyle({ width: '424px' })
    expect(localStorage.getItem('termpolis.world.paneWidth')).toBe('424')
    client.mockRestore()
  })

  it('palette action show_world opens the overlay, and its close button closes it', async () => {
    render(<App />)
    await settle()
    expect(world()).toBeNull()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Palette: Open Lumopolis' }))
    expect(await screen.findByRole('region', { name: 'Lumopolis' })).toHaveAttribute('data-root', '')
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
    expect(await screen.findByRole('region', { name: 'Lumopolis' })).toBeInTheDocument()
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
    expect(await screen.findByRole('region', { name: 'Lumopolis' })).toHaveAttribute('data-root', '/repos/app')
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    expect(world()).toBeInTheDocument()
    view.unmount()
    // The listener is removed with the app: a late event finds nothing to open.
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    expect(world()).toBeNull()
    act(() => { useTerminalStore.setState({ terminals: [], activeTerminalId: null }) })
  })

  it('the ask box asks about the resolved project root, not the terminal subfolder', async () => {
    act(() => {
      useTerminalStore.setState({
        terminals: [{ id: 't-sub', name: 'repo', shell: 'bash', cwd: '/repos/app/src/main', hidden: true } as any],
        activeTerminalId: 't-sub',
      })
    })
    render(<App />)
    await settle()
    act(() => { window.dispatchEvent(new CustomEvent('termpolis:openWorld')) })
    expect(await screen.findByRole('region', { name: 'Lumopolis' })).toHaveAttribute('data-root', '/repos/app/src/main')
    const ask = screen.getByTestId('world-ask-stub')
    expect(ask).toHaveAttribute('data-root', '/repos/app')
    expect(ask).toHaveAttribute('data-linked', 'true')
    act(() => { useTerminalStore.setState({ terminals: [], activeTerminalId: null }) })
  })

  it('no resolved root yet: the ask box gets an empty root', async () => {
    render(<App />)
    await settle()
    fireEvent.keyDown(window, { key: 'R', ctrlKey: true, shiftKey: true })
    await screen.findByRole('region', { name: 'Lumopolis' })
    expect(screen.getByTestId('world-ask-stub')).toHaveAttribute('data-root', '')
  })

  it('Build it offers the Claude Code profiles and launches the chosen one in the linked folder with the build prompt', async () => {
    render(<App />)
    await settle()
    fireEvent.keyDown(window, { key: 'R', ctrlKey: true, shiftKey: true })
    const pane = await screen.findByRole('region', { name: 'Lumopolis' })
    expect(pane.getAttribute('data-agents')?.split(',')).toContain('claude')
    expect(pane.getAttribute('data-agents')).not.toContain('codex')
    expect(pane).toHaveAttribute('data-default', 'claude')
    fireEvent.click(screen.getByRole('button', { name: 'Build with nobody' }))
    expect(launched.fn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Build with claude' }))
    expect(launched.fn).toHaveBeenCalledTimes(1)
    const [profile, deps] = launched.fn.mock.calls[0]
    expect(profile).toMatchObject({ id: 'claude', command: 'claude' })
    expect(deps).toMatchObject({ cwd: '/build/pets', prompt: 'Build the app.' })
    expect(typeof deps.addTerminal).toBe('function')
    expect(typeof deps.setLaunchingAgent).toBe('function')
  })

  it('Build it preselects the Claude Code profile the active terminal runs', async () => {
    render(<App />)
    await settle()
    act(() => {
      useTerminalStore.setState({
        aiProfiles: [{ id: 'opus-claude', name: 'Claude (Opus)', icon: '', command: 'claude --model opus', shell: 'bash', color: '#000' }],
        terminals: [{ id: 't-agent', name: 'agent', shell: 'bash', cwd: '/repos/app', hidden: true, agentCommand: 'claude --model opus' } as any],
        activeTerminalId: 't-agent',
      })
    })
    fireEvent.keyDown(window, { key: 'R', ctrlKey: true, shiftKey: true })
    const pane = await screen.findByRole('region', { name: 'Lumopolis' })
    expect(pane.getAttribute('data-agents')?.split(',')).toEqual(['claude', 'opus-claude'])
    expect(pane).toHaveAttribute('data-default', 'opus-claude')
    act(() => { useTerminalStore.setState({ aiProfiles: [], terminals: [], activeTerminalId: null }) })
  })
})
