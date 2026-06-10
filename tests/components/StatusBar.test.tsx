import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StatusBar } from '../../src/renderer/src/components/StatusBar/StatusBar'

let mockSwarmActive = false
let mockSwarmAgents: any[] = []
let mockActiveTerminalId: string | null = null

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector: any) => {
    const state = {
      swarmActive: mockSwarmActive,
      swarmAgents: mockSwarmAgents,
      activeTerminalId: mockActiveTerminalId,
    }
    return selector(state)
  },
}))

beforeEach(() => {
  mockSwarmActive = false
  mockSwarmAgents = []
  mockActiveTerminalId = null
  ;(window as any).agentActivity = undefined
  ;(window as any).open = vi.fn()
  ;(window as any).termpolis = {
    getAppVersion: vi.fn().mockResolvedValue({ success: true, data: { version: '9.9.9' } }),
  }
})

describe('StatusBar', () => {
  it('renders copyright text with current year', () => {
    render(<StatusBar />)
    const year = new Date().getFullYear().toString()
    expect(screen.getByText(new RegExp(`${year} Termpolis`))).toBeInTheDocument()
  })

  it('renders Apache 2.0 License mention', () => {
    render(<StatusBar />)
    expect(screen.getByText(/Apache 2\.0 License/)).toBeInTheDocument()
  })

  it('renders MCP server status indicator', () => {
    render(<StatusBar />)
    expect(screen.getByText('MCP: localhost:9315')).toBeInTheDocument()
  })

  it('shows no context-pressure indicator when no terminal is active', () => {
    render(<StatusBar />)
    expect(screen.queryByTestId('context-pressure-indicator')).not.toBeInTheDocument()
  })

  it('shows a live context-pressure indicator for the active agent terminal', async () => {
    mockActiveTerminalId = 't1'
    ;(window as any).agentActivity = {
      query: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            kind: 'token_update', terminalId: 't1', agentType: 'claude', taskId: 's1', ts: 1,
            payload: { inputTokens: 130000, outputTokens: 0 }, // 130k / 200k = 65% → warn
          },
        ],
      }),
      onEvent: vi.fn(() => () => {}),
    }
    render(<StatusBar />)
    const el = await screen.findByTestId('context-pressure-indicator')
    expect(el).toHaveAttribute('data-level', 'warn')
    expect(el).toHaveTextContent('ctx 65%')
  })

  it('renders MCP status with title tooltip', () => {
    render(<StatusBar />)
    const mcpEl = screen.getByText('MCP: localhost:9315').closest('span')
    expect(mcpEl).toHaveAttribute('title', 'MCP server for AI agent integration')
  })

  it('renders Sponsor link', () => {
    render(<StatusBar />)
    expect(screen.getByText('Sponsor')).toBeInTheDocument()
  })

  it('opens sponsor URL in new window on click', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Sponsor'))
    expect((window as any).open).toHaveBeenCalledWith(
      'https://github.com/sponsors/codedev-david',
      '_blank'
    )
  })

  it('renders Help / Support button', () => {
    render(<StatusBar />)
    expect(screen.getByText('Help / Support')).toBeInTheDocument()
  })

  // -- Swarm indicator --

  it('does not show swarm indicator when swarm is inactive', () => {
    render(<StatusBar />)
    expect(screen.queryByText('Swarm Active')).not.toBeInTheDocument()
  })

  it('shows clickable swarm indicator when swarm is active', () => {
    mockSwarmActive = true
    render(<StatusBar />)
    const button = screen.getByText('Swarm Active').closest('button')
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute('title', 'Open Swarm Dashboard')
  })

  it('calls onSwarmClick when swarm indicator is clicked', () => {
    mockSwarmActive = true
    const onSwarmClick = vi.fn()
    render(<StatusBar onSwarmClick={onSwarmClick} />)
    fireEvent.click(screen.getByText('Swarm Active'))
    expect(onSwarmClick).toHaveBeenCalledTimes(1)
  })

  it('shows running/total agent count when swarm agents exist', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'working' },
      { terminalId: 't2', agentName: 'Codex', role: 'Tests', status: 'working' },
    ]
    render(<StatusBar />)
    expect(screen.getByText('(2/2)')).toBeInTheDocument()
  })

  it('shows partial running count correctly', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'working' },
      { terminalId: 't2', agentName: 'Codex', role: 'Tests', status: 'done' },
      { terminalId: 't3', agentName: 'Gemini', role: 'Docs', status: 'working' },
    ]
    render(<StatusBar />)
    expect(screen.getByText('(2/3)')).toBeInTheDocument()
  })

  it('shows error count when swarm agents have errors', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'working' },
      { terminalId: 't2', agentName: 'Codex', role: 'Tests', status: 'errored' },
    ]
    render(<StatusBar />)
    expect(screen.getByText('1 err')).toBeInTheDocument()
  })

  it('shows multiple error count', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'errored' },
      { terminalId: 't2', agentName: 'Codex', role: 'Tests', status: 'errored' },
    ]
    render(<StatusBar />)
    expect(screen.getByText('2 err')).toBeInTheDocument()
  })

  it('does not show error count when there are no errors', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'working' },
    ]
    render(<StatusBar />)
    expect(screen.queryByText(/err/)).not.toBeInTheDocument()
  })

  it('does not show agent count when no swarm agents', () => {
    mockSwarmActive = true
    mockSwarmAgents = []
    render(<StatusBar />)
    expect(screen.queryByText(/\(\d+\/\d+\)/)).not.toBeInTheDocument()
  })

  // -- Help dialog --

  it('opens help dialog when Help / Support is clicked', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Quick Start Guide')).toBeInTheDocument()
  })

  it('closes help dialog when close button in header is clicked', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Quick Start Guide')).toBeInTheDocument()
    // Click the x button in the modal header
    const closeBtn = screen.getByText('\u00D7')
    fireEvent.click(closeBtn)
    expect(screen.queryByText('Quick Start Guide')).not.toBeInTheDocument()
  })

  it('closes help dialog when footer Close button is clicked', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Quick Start Guide')).toBeInTheDocument()
    // The footer Close button is the one with bg-[#0078d4] class
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeBtn)
    expect(screen.queryByText('Quick Start Guide')).not.toBeInTheDocument()
  })

  it('help dialog shows key sections', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Sidebar Icon Bar')).toBeInTheDocument()
    expect(screen.getByText('Command Palette')).toBeInTheDocument()
    expect(screen.getByText('Prompt Templates')).toBeInTheDocument()
    expect(screen.getByText('Session Recording')).toBeInTheDocument()
    expect(screen.getByText('Output Pinning')).toBeInTheDocument()
  })

  it('help dialog shows GitHub link', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('GitHub')).toBeInTheDocument()
  })

  it('help dialog shows Sponsor this project link', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Sponsor this project')).toBeInTheDocument()
  })

  it('help dialog shows multi-agent swarm section', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText(/Multi-Agent Swarm/)).toBeInTheDocument()
  })

  it('help dialog shows all keyboard shortcuts section', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('All Keyboard Shortcuts')).toBeInTheDocument()
  })

  // -- Help dialog link clicks --

  it('help dialog GitHub link opens in new window', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    const githubLink = screen.getByText('GitHub')
    fireEvent.click(githubLink)
    expect((window as any).open).toHaveBeenCalledWith(
      'https://github.com/codedev-david/termpolis',
      '_blank'
    )
  })

  it('help dialog Sponsor link opens in new window', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    const sponsorLink = screen.getByText('Sponsor this project')
    fireEvent.click(sponsorLink)
    expect((window as any).open).toHaveBeenCalledWith(
      'https://github.com/sponsors/codedev-david',
      '_blank'
    )
  })

  it('help dialog shows context handoff section', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Agent Context Handoff')).toBeInTheDocument()
  })

  it('help dialog shows workspaces section', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Workspaces')).toBeInTheDocument()
  })

  it('help dialog shows accessibility section', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Accessibility')).toBeInTheDocument()
  })

  // -- Show tour again --

  it('help dialog shows a Show-tour-again link', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByTestId('help-show-tour')).toBeInTheDocument()
  })

  it('Show-tour-again link clears the seen flag', () => {
    localStorage.setItem('termpolis.onboarding.seen.v1', '1')
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    fireEvent.click(screen.getByTestId('help-show-tour'))
    expect(localStorage.getItem('termpolis.onboarding.seen.v1')).toBeNull()
  })

  it('Show-tour-again link closes the help modal', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Quick Start Guide')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('help-show-tour'))
    expect(screen.queryByText('Quick Start Guide')).not.toBeInTheDocument()
  })

  it('Show-tour-again link dispatches termpolis:reopenOnboarding', () => {
    const listener = vi.fn()
    window.addEventListener('termpolis:reopenOnboarding', listener)
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    fireEvent.click(screen.getByTestId('help-show-tour'))
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('termpolis:reopenOnboarding', listener)
  })

  it('MCP section reflects the real 17-tool count', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText(/17 tools/)).toBeInTheDocument()
  })

  // -- Observability + security sections --

  it('help dialog documents Past AI Sessions', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Past AI Sessions')).toBeInTheDocument()
  })

  it('help dialog documents the Live AI Observability panels', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('Live AI Observability')).toBeInTheDocument()
    expect(screen.getAllByText(/Activity Feed/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Redundancy/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Efficiency/).length).toBeGreaterThan(0)
  })

  it('help dialog documents the AI Security Center', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText('AI Security Center')).toBeInTheDocument()
    expect(screen.getByText(/Secret scanner/)).toBeInTheDocument()
    expect(screen.getByText(/Sensitive-file watcher/)).toBeInTheDocument()
    expect(screen.getByText(/Per-agent egress audit/)).toBeInTheDocument()
    expect(screen.getByText(/Strict Mode/)).toBeInTheDocument()
  })

  it('keyboard-shortcuts section lists the four observability shortcuts', () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    expect(screen.getByText(/Activity feed/)).toBeInTheDocument()
    expect(screen.getByText(/Context pins/)).toBeInTheDocument()
  })

  // -- Version display (auto-update verification) --

  it('renders installed app version in the footer next to the Apache license', async () => {
    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByTestId('footer-app-version')).toHaveTextContent('v9.9.9')
    })
  })

  it('renders installed app version in the help dialog header', async () => {
    render(<StatusBar />)
    fireEvent.click(screen.getByText('Help / Support'))
    await waitFor(() => {
      expect(screen.getByTestId('help-app-version')).toHaveTextContent('v9.9.9')
    })
  })

  it('hides version when getAppVersion is unavailable', () => {
    ;(window as any).termpolis = {}
    render(<StatusBar />)
    expect(screen.queryByTestId('footer-app-version')).not.toBeInTheDocument()
  })
})
