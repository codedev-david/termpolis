import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Welcome } from '../../src/renderer/src/components/Welcome/Welcome'

let mockDetectAgentsResult: any = {
  success: true,
  data: { claude: true, codex: false, gemini: true, 'qwen-code': false, 'aider-qwen': false },
}

beforeEach(() => {
  mockDetectAgentsResult = {
    success: true,
    data: { claude: true, codex: false, gemini: true, 'qwen-code': false, 'aider-qwen': false },
  }
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockImplementation(() => Promise.resolve(mockDetectAgentsResult)),
  }
})

describe('Welcome', () => {
  const defaultProps = () => ({
    onNewTerminal: vi.fn(),
    onLaunchAgent: vi.fn(),
    onStartSwarm: vi.fn(),
  })

  // -- Rendering --

  it('renders welcome heading', () => {
    render(<Welcome {...defaultProps()} />)
    expect(screen.getByText('Welcome to Termpolis')).toBeInTheDocument()
  })

  it('renders subtitle', () => {
    render(<Welcome {...defaultProps()} />)
    expect(screen.getByText('The AI-native terminal for developers')).toBeInTheDocument()
  })

  it('shows all three action cards', () => {
    render(<Welcome {...defaultProps()} />)
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    expect(screen.getByText('Launch AI Agent')).toBeInTheDocument()
    expect(screen.getByText('Start Swarm')).toBeInTheDocument()
  })

  it('shows feature highlights', () => {
    render(<Welcome {...defaultProps()} />)
    expect(screen.getByText('Ctrl+K Command Palette')).toBeInTheDocument()
    expect(screen.getByText('Split Panes')).toBeInTheDocument()
    expect(screen.getByText('Smart Routing')).toBeInTheDocument()
    expect(screen.getByText('MCP Server')).toBeInTheDocument()
    expect(screen.getByText('Session Recording')).toBeInTheDocument()
  })

  it('shows keyboard hint at the bottom', () => {
    render(<Welcome {...defaultProps()} />)
    // The hint paragraph contains mixed text and <kbd>/<strong> elements
    const hintParagraph = screen.getByText(/to open the command palette/i)
    expect(hintParagraph).toBeInTheDocument()
  })

  // -- New Terminal button --

  it('calls onNewTerminal when clicking the new terminal card', () => {
    const props = defaultProps()
    render(<Welcome {...props} />)
    fireEvent.click(screen.getByText('New Terminal'))
    expect(props.onNewTerminal).toHaveBeenCalledTimes(1)
  })

  // -- Start Swarm button --

  it('calls onStartSwarm when clicking the swarm card', () => {
    const props = defaultProps()
    render(<Welcome {...props} />)
    fireEvent.click(screen.getByText('Start Swarm'))
    expect(props.onStartSwarm).toHaveBeenCalledTimes(1)
  })

  // -- Agent picker --

  it('opens agent picker when clicking Launch AI Agent', () => {
    render(<Welcome {...defaultProps()} />)
    fireEvent.click(screen.getByText('Launch AI Agent'))
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Qwen Code')).toBeInTheDocument()
    expect(screen.getByText('Qwen AI')).toBeInTheDocument()
  })

  it('toggles agent picker open and closed', () => {
    render(<Welcome {...defaultProps()} />)
    const btn = screen.getByText('Launch AI Agent')
    fireEvent.click(btn)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    fireEvent.click(btn)
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
  })

  it('calls onLaunchAgent with correct agent id when clicking installed agent', async () => {
    const props = defaultProps()
    render(<Welcome {...props} />)

    // Wait for agent detection to finish
    await waitFor(() => {
      expect((window as any).termpolis.detectAgents).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByText('Launch AI Agent'))
    fireEvent.click(screen.getByText('Claude Code'))
    expect(props.onLaunchAgent).toHaveBeenCalledWith('claude')
  })

  it('closes agent picker after selecting an agent', async () => {
    const props = defaultProps()
    render(<Welcome {...props} />)

    await waitFor(() => {
      expect((window as any).termpolis.detectAgents).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByText('Launch AI Agent'))
    fireEvent.click(screen.getByText('Claude Code'))
    // Picker should close
    expect(screen.queryByText('OpenAI Codex')).not.toBeInTheDocument()
  })

  it('shows install hint when clicking uninstalled agent', async () => {
    const props = defaultProps()
    render(<Welcome {...props} />)

    await waitFor(() => {
      expect((window as any).termpolis.detectAgents).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByText('Launch AI Agent'))
    fireEvent.click(screen.getByText('OpenAI Codex'))
    // Should NOT call onLaunchAgent for uninstalled agent
    expect(props.onLaunchAgent).not.toHaveBeenCalled()
  })

  it('calls detectAgents on mount', () => {
    render(<Welcome {...defaultProps()} />)
    expect((window as any).termpolis.detectAgents).toHaveBeenCalledTimes(1)
  })

  it('handles detectAgents failure gracefully', async () => {
    ;(window as any).termpolis.detectAgents = vi.fn().mockRejectedValue(new Error('fail'))
    render(<Welcome {...defaultProps()} />)
    // Should still render without error
    await waitFor(() => {
      expect(screen.getByText('Welcome to Termpolis')).toBeInTheDocument()
    })
  })

  it('shows FREE badge for aider-qwen when installed', async () => {
    mockDetectAgentsResult = {
      success: true,
      data: { claude: true, codex: true, gemini: true, 'qwen-code': true, 'aider-qwen': true },
    }
    ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue(mockDetectAgentsResult)

    render(<Welcome {...defaultProps()} />)
    await waitFor(() => {
      expect((window as any).termpolis.detectAgents).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText('Launch AI Agent'))
    expect(screen.getByText('FREE')).toBeInTheDocument()
  })

  it('shows Install badge for uninstalled agents', async () => {
    render(<Welcome {...defaultProps()} />)
    await waitFor(() => {
      expect((window as any).termpolis.detectAgents).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText('Launch AI Agent'))
    const installBadges = screen.getAllByText('Install')
    // codex, qwen-code, and aider-qwen are not installed
    expect(installBadges.length).toBe(3)
  })
})
