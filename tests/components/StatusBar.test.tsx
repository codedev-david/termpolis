import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StatusBar } from '../../src/renderer/src/components/StatusBar/StatusBar'

let mockSwarmActive = false
let mockSwarmAgents: any[] = []

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector: any) => {
    const state = {
      swarmActive: mockSwarmActive,
      swarmAgents: mockSwarmAgents,
    }
    return selector(state)
  },
}))

beforeEach(() => {
  mockSwarmActive = false
  mockSwarmAgents = []
})

describe('StatusBar', () => {
  it('renders copyright text', () => {
    render(<StatusBar />)
    const year = new Date().getFullYear().toString()
    expect(screen.getByText(new RegExp(`${year} Termpolis`))).toBeInTheDocument()
  })

  it('shows MCP server status', () => {
    render(<StatusBar />)
    expect(screen.getByText('MCP: localhost:9315')).toBeInTheDocument()
  })

  it('shows Sponsor link', () => {
    render(<StatusBar />)
    expect(screen.getByText('Sponsor')).toBeInTheDocument()
  })

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

  it('shows agent count when swarm agents exist', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'running' },
      { terminalId: 't2', agentName: 'Codex', role: 'Tests', status: 'running' },
    ]
    render(<StatusBar />)
    expect(screen.getByText('(2/2)')).toBeInTheDocument()
  })

  it('shows error count when swarm agents have errors', () => {
    mockSwarmActive = true
    mockSwarmAgents = [
      { terminalId: 't1', agentName: 'Claude', role: 'Build', status: 'running' },
      { terminalId: 't2', agentName: 'Codex', role: 'Tests', status: 'error' },
    ]
    render(<StatusBar />)
    expect(screen.getByText('1 err')).toBeInTheDocument()
  })
})
