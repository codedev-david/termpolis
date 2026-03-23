import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { InstallHint } from '../../src/renderer/src/components/InstallHint/InstallHint'

describe('InstallHint', () => {
  it('renders agent name in title', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText('Install Claude Code')).toBeInTheDocument()
  })

  it('shows install steps for the given agent', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code')).toBeInTheDocument()
    expect(screen.getByText(/claude --version/)).toBeInTheDocument()
  })

  it('calls onClose when "Got it" clicked', () => {
    const onClose = vi.fn()
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={onClose} />)
    fireEvent.click(screen.getByText('Got it'))
    expect(onClose).toHaveBeenCalled()
  })
})
