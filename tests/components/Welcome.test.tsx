import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { Welcome } from '../../src/renderer/src/components/Welcome/Welcome'

beforeAll(() => {
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({ success: true, data: { claude: true, codex: false, gemini: true, 'aider-qwen': false } }),
  }
})

describe('Welcome', () => {
  it('renders welcome heading', () => {
    render(<Welcome onNewTerminal={vi.fn()} onLaunchAgent={vi.fn()} onStartSwarm={vi.fn()} />)
    expect(screen.getByText('Welcome to Termpolis')).toBeInTheDocument()
  })

  it('shows New Terminal, Launch AI Agent, and Start Swarm action cards', () => {
    render(<Welcome onNewTerminal={vi.fn()} onLaunchAgent={vi.fn()} onStartSwarm={vi.fn()} />)
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    expect(screen.getByText('Launch AI Agent')).toBeInTheDocument()
    expect(screen.getByText('Start Swarm')).toBeInTheDocument()
  })

  it('calls onNewTerminal when clicking the new terminal card', () => {
    const onNewTerminal = vi.fn()
    render(<Welcome onNewTerminal={onNewTerminal} onLaunchAgent={vi.fn()} onStartSwarm={vi.fn()} />)
    fireEvent.click(screen.getByText('New Terminal'))
    expect(onNewTerminal).toHaveBeenCalled()
  })

  it('calls onStartSwarm when clicking the swarm card', () => {
    const onStartSwarm = vi.fn()
    render(<Welcome onNewTerminal={vi.fn()} onLaunchAgent={vi.fn()} onStartSwarm={onStartSwarm} />)
    fireEvent.click(screen.getByText('Start Swarm'))
    expect(onStartSwarm).toHaveBeenCalled()
  })
})
