import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/contextCapture', () => ({
  formatHandoffPrompt: vi.fn(() => 'Handoff prompt text here'),
}))

import { AgentHandoffModal } from '../../src/renderer/src/components/AgentHandoff/AgentHandoffModal'
import type { HandoffContext } from '../../src/renderer/src/lib/contextCapture'

const mockContext: HandoffContext = {
  task: 'Fix authentication module',
  recentCommands: ['git status', 'npm test'],
  recentOutput: 'FAIL: auth.test.ts',
  gitDiff: 'diff --git a/auth.ts',
  gitBranch: 'feature/auth-fix',
  cwd: '/home/user/project',
  filesModified: ['auth.ts', 'auth.test.ts'],
  previousAgent: 'Claude Code',
  timestamp: '2026-03-23T12:00:00Z',
}

describe('AgentHandoffModal', () => {
  it('renders modal with agent selection buttons (excluding previous agent)', () => {
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('Switch AI Agent')).toBeInTheDocument()
    // Available agents should not include Claude Code (the previous agent)
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.getByText('Aider')).toBeInTheDocument()
  })

  it('shows handoff context info and editable prompt', () => {
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('Claude Code ran out of context')).toBeInTheDocument()
    expect(screen.getByText('Handoff prompt (editable):')).toBeInTheDocument()
    // The Switch Agent button should be present
    expect(screen.getByText('Switch Agent')).toBeInTheDocument()
  })

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('selects an agent when clicked and enables Switch Agent button', () => {
    const onConfirm = vi.fn()
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )
    // Click on Codex agent
    fireEvent.click(screen.getByText('Codex'))
    // Now Switch Agent should be clickable
    fireEvent.click(screen.getByText('Switch Agent'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('shows the editable prompt textarea with handoff content', () => {
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // The textarea should contain the formatted handoff prompt
    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeInTheDocument()
    expect((textarea as HTMLTextAreaElement).value).toContain('Handoff prompt text here')
  })

  it('allows editing the prompt text', () => {
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Custom handoff prompt' } })
    expect((textarea as HTMLTextAreaElement).value).toBe('Custom handoff prompt')
  })

  it('shows previous agent name in context message', () => {
    render(
      <AgentHandoffModal
        context={mockContext}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/Claude Code/)).toBeInTheDocument()
  })
})
