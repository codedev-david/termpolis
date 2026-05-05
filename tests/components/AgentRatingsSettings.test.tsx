import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const setAgentRatingOverrides = vi.fn()

let mockOverrides: Record<string, Record<string, number>> = {}

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        agentRatingOverrides: mockOverrides,
        setAgentRatingOverrides,
      }
      return selector ? selector(state) : state
    },
    { getState: vi.fn(), setState: vi.fn() },
  ),
}))

import { AgentRatingsSettings } from '../../src/renderer/src/components/SettingsPane/AgentRatingsSettings'

beforeEach(() => {
  vi.clearAllMocks()
  mockOverrides = {}
})

describe('AgentRatingsSettings', () => {
  it('renders heading and description', () => {
    render(<AgentRatingsSettings />)
    expect(screen.getByText('Agent Capability Ratings')).toBeInTheDocument()
    expect(screen.getByText(/These ratings guide the AI conductor/)).toBeInTheDocument()
  })

  it('renders all default agents', () => {
    render(<AgentRatingsSettings />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Qwen Code')).toBeInTheDocument()
  })

  it('shows token cost labels', () => {
    render(<AgentRatingsSettings />)
    expect(screen.getAllByText(/cost/).length).toBeGreaterThanOrEqual(3)
  })

  it('shows MCP badge for agents that have MCP', () => {
    render(<AgentRatingsSettings />)
    const mcpBadges = screen.getAllByText('MCP')
    expect(mcpBadges.length).toBe(4)
  })

  it('does NOT show Reset All when no overrides', () => {
    render(<AgentRatingsSettings />)
    expect(screen.queryByText('Reset All')).not.toBeInTheDocument()
  })

  it('shows Reset All when overrides exist', () => {
    mockOverrides = { claude: { refactoring: 3 } }
    render(<AgentRatingsSettings />)
    expect(screen.getByText('Reset All')).toBeInTheDocument()
  })

  it('clicking Reset All shows confirmation', () => {
    mockOverrides = { claude: { refactoring: 3 } }
    render(<AgentRatingsSettings />)
    fireEvent.click(screen.getByText('Reset All'))
    expect(screen.getByText(/Reset all to defaults\?/)).toBeInTheDocument()
    expect(screen.getByText('Reset')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('confirming reset clears overrides', () => {
    mockOverrides = { claude: { refactoring: 3 } }
    render(<AgentRatingsSettings />)
    fireEvent.click(screen.getByText('Reset All'))
    fireEvent.click(screen.getByText('Reset'))
    expect(setAgentRatingOverrides).toHaveBeenCalledWith({})
  })

  it('canceling reset dismisses confirmation', () => {
    mockOverrides = { claude: { refactoring: 3 } }
    render(<AgentRatingsSettings />)
    fireEvent.click(screen.getByText('Reset All'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText(/Reset all to defaults\?/)).not.toBeInTheDocument()
    expect(setAgentRatingOverrides).not.toHaveBeenCalled()
  })

  it('clicking a rating button sets override', () => {
    render(<AgentRatingsSettings />)
    // Find the first "2" button for refactoring (default is 5, so 2 != default)
    const allButtons = screen.getAllByRole('button')
    // Find a button with text "2" — pick one
    const ratingBtn = allButtons.find(b => b.textContent === '2')
    if (ratingBtn) {
      fireEvent.click(ratingBtn)
      expect(setAgentRatingOverrides).toHaveBeenCalled()
    }
  })

  it('clicking default value removes the override', () => {
    // Claude's default refactoring is 5 — set custom to 3, then click 5 → removes override
    mockOverrides = { claude: { refactoring: 3 } }
    render(<AgentRatingsSettings />)
    const allButtons = screen.getAllByRole('button')
    const rating5Buttons = allButtons.filter(b => b.textContent === '5')
    // Click the first one (claude's first category = refactoring)
    if (rating5Buttons.length > 0) {
      fireEvent.click(rating5Buttons[0])
      expect(setAgentRatingOverrides).toHaveBeenCalled()
      // The passed overrides should no longer have claude.refactoring
      const arg = setAgentRatingOverrides.mock.calls[0][0]
      expect(arg.claude?.refactoring).toBeUndefined()
    }
  })

  it('clamps value to 1-5 range via button clicks', () => {
    render(<AgentRatingsSettings />)
    // Buttons only offer 1..5, so clicking any of them is already in range.
    // This test verifies the UI doesn't generate out-of-range buttons.
    const allButtons = screen.getAllByRole('button')
    const ratingBtnTexts = allButtons
      .map(b => b.textContent?.trim())
      .filter((t): t is string => !!t && /^\d$/.test(t))
    for (const t of ratingBtnTexts) {
      expect(Number(t)).toBeGreaterThanOrEqual(1)
      expect(Number(t)).toBeLessThanOrEqual(5)
    }
  })

  it('clicking reset icon per-category restores default', () => {
    mockOverrides = { claude: { refactoring: 3 } }
    const { container } = render(<AgentRatingsSettings />)
    // Find the per-row reset icon (has title "Reset to default")
    const resetBtn = container.querySelector('button[title="Reset to default"]')
    expect(resetBtn).toBeTruthy()
    fireEvent.click(resetBtn!)
    expect(setAgentRatingOverrides).toHaveBeenCalled()
  })

  it('shows Customized styling for overridden categories', () => {
    mockOverrides = { claude: { refactoring: 3 } }
    const { container } = render(<AgentRatingsSettings />)
    // Customized category label should have the cyan text class
    const customizedLabel = container.querySelector('.text-\\[\\#22D3EE\\]')
    expect(customizedLabel).toBeTruthy()
  })
})
