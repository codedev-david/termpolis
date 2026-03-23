import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StatusBar } from '../../src/renderer/src/components/StatusBar/StatusBar'

// Mock the terminal store to provide default state
vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector: any) => {
    const state = {
      swarmActive: false,
      swarmAgents: [],
    }
    return selector(state)
  },
}))

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
})
