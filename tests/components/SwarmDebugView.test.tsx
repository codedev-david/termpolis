import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// GitHub #36: "The Debug button that should show conductor output does not open anything".
// It unhid the conductor's terminal behind the dashboard, a modal over everything, and split view
// draws only the pane tree, which unhiding never touched. Debug now shows the conductor's output
// inside the dashboard. This runs it against the REAL terminal store in both layouts: the output
// shows either way, and no terminal, pane or focus changes for it.

vi.mock('../../src/renderer/src/lib/conductorManager', () => ({
  stopConductor: vi.fn(),
  getConductorState: vi.fn(),
  watchConductorTrace: vi.fn(),
}))
vi.mock('../../src/renderer/src/lib/swarmBridgeManager', () => ({ stopAllBridges: vi.fn() }))
vi.mock('../../src/renderer/src/components/SwarmDashboard/StartSwarmModal', () => ({ StartSwarmModal: () => null }))
vi.mock('../../src/renderer/src/components/SwarmReview/SwarmReviewPanel', () => ({ SwarmReviewPanel: () => null }))

import { SwarmDashboard } from '../../src/renderer/src/components/SwarmDashboard/SwarmDashboard'
import { getConductorState, watchConductorTrace } from '../../src/renderer/src/lib/conductorManager'
import { useTerminalStore, buildPaneTree } from '../../src/renderer/src/store/terminalStore'
import type { TerminalSession } from '../../src/renderer/src/types'

const terminal = (id: string, extra: Partial<TerminalSession> = {}): TerminalSession => ({
  id, name: id, color: '#fff', shellType: 'powershell', cwd: '/proj', fontSize: 14, theme: 'dark', fontFamily: 'monospace', ...extra,
})
const CONDUCTOR_OUTPUT = "PS C:\\proj> & $p -ExecutionPolicy Bypass -File 'C:\\Users\\me\\.termpolis-conductor-run.ps1'\r\n" +
  "\x1b[31merror: unknown option '-NoProfile'\x1b[0m\r\n[termpolis-conductor-exited] 1\r\nPS C:\\proj> "

beforeEach(() => {
  ;(window as any).termpolis = {
    readTerminalBuffer: vi.fn(async (id: string) =>
      id === 'cond-1' ? { success: true, data: { output: CONDUCTOR_OUTPUT } } : { success: true, data: { output: 'not the conductor' } }),
    killTerminal: vi.fn(),
    pickDirectory: vi.fn(),
  }
  ;(window as any).swarmAPI = {
    getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clear: vi.fn(),
    updateTask: vi.fn(),
  }
})

// While the swarm runs, and after the conductor exited (the swarm is over, its terminal remains).
const MOMENTS = [
  { swarmActive: true, status: 'running', error: null },
  { swarmActive: false, status: 'error', error: 'Conductor exited (code 1)' },
] as const

describe.each(['tabs', 'split'] as const)('Debug in %s view', (viewMode) => {
  it.each(MOMENTS)("shows the conductor's output in the dashboard and leaves every terminal where it was (conductor $status)", async ({ swarmActive, status, error }) => {
    vi.mocked(getConductorState).mockReturnValue({ terminalId: 'cond-1', status, error, cwd: '/proj', preSwarmSha: null })
    useTerminalStore.setState({
      terminals: [
        terminal('mine-1'),
        terminal('mine-2'),
        terminal('cond-1', { name: 'Swarm Conductor', agentCommand: 'claude', hidden: true, isConductor: true, isSwarm: true }),
      ],
      viewMode,
      paneTree: viewMode === 'split' ? buildPaneTree(['mine-1', 'mine-2']) : null,
      activeTerminalId: 'mine-2',
      swarmActive,
    })
    const before = useTerminalStore.getState()
    const onClose = vi.fn()
    render(<SwarmDashboard onClose={onClose} />)

    fireEvent.click(screen.getByText('Debug'))

    const text = await screen.findByTestId('conductor-output-text')
    expect(text.textContent).toContain("error: unknown option '-NoProfile'\n[termpolis-conductor-exited] 1")
    expect(window.termpolis.readTerminalBuffer).toHaveBeenCalledWith('cond-1')
    expect(window.termpolis.readTerminalBuffer).not.toHaveBeenCalledWith('mine-1')
    // Nothing in the store was written: the same objects, so the conductor is still hidden, the
    // user's terminals and their panes are as they were, and focus did not move.
    const after = useTerminalStore.getState()
    expect(after.terminals).toBe(before.terminals)
    expect(after.paneTree).toBe(before.paneTree)
    expect(after.activeTerminalId).toBe('mine-2')
    expect(after.viewMode).toBe(viewMode)
    expect(after.terminals.find((t) => t.id === 'cond-1')?.hidden).toBe(true)
    // And the dashboard stays open: the output is in it, not behind it.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Swarm Dashboard')).toBeInTheDocument()
  })
})

// Trace shows the conductor's transcript. Up to 1.53 a pane followed it once Debug unhid the
// conductor's terminal; Debug now shows no pane, so the dashboard asks for the transcript itself
// while Trace or Debug is open, and only then.
describe("following the conductor's transcript for Trace", () => {
  function renderWithConductor() {
    vi.mocked(getConductorState).mockReturnValue({ terminalId: 'cond-1', status: 'running', error: null, cwd: '/proj', preSwarmSha: null })
    useTerminalStore.setState({
      terminals: [terminal('cond-1', { name: 'Swarm Conductor', agentCommand: 'claude', hidden: true, isConductor: true, isSwarm: true })],
      viewMode: 'tabs',
      paneTree: null,
      activeTerminalId: null,
      swarmActive: true,
    })
    render(<SwarmDashboard onClose={vi.fn()} />)
  }

  it.each(['Trace', 'Debug'])('asks for it when %s is opened, and not before', async (tab) => {
    vi.mocked(watchConductorTrace).mockClear()
    renderWithConductor()
    await screen.findByText('Debug')
    expect(watchConductorTrace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(tab))
    expect(watchConductorTrace).toHaveBeenCalled()
  })
})
