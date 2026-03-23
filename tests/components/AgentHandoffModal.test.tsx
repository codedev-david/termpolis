import React from 'react'
import { render, screen } from '@testing-library/react'
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
})
