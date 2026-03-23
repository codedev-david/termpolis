import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AgentHandoffBanner } from '../../src/renderer/src/components/AgentHandoff/AgentHandoffBanner'

describe('AgentHandoffBanner', () => {
  it('renders warning banner with agent name showing context limit message', () => {
    render(
      <AgentHandoffBanner
        previousAgent="Claude Code"
        onSwitchTo={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText('Claude Code context limit reached')).toBeInTheDocument()
  })

  it('shows switch agent buttons (excluding the previous agent) and Dismiss button', () => {
    const onSwitchTo = vi.fn()
    render(
      <AgentHandoffBanner
        previousAgent="Claude Code"
        onSwitchTo={onSwitchTo}
        onDismiss={vi.fn()}
      />
    )
    // Claude Code is filtered out; Codex, Gemini, Aider should remain
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.getByText('Aider')).toBeInTheDocument()
    expect(screen.queryByText('Claude Code', { exact: false, selector: 'button' })).not.toBeInTheDocument()
    expect(screen.getByText('Dismiss')).toBeInTheDocument()
  })
})
