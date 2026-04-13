import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InstallHint } from '../../src/renderer/src/components/InstallHint/InstallHint'

beforeEach(() => {
  window.open = vi.fn()
})

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

  it('calls onClose when close (x) button is clicked', () => {
    const onClose = vi.fn()
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={onClose} />)
    // The x button is the one with &times; content
    const closeButtons = screen.getAllByRole('button')
    const xButton = closeButtons.find(btn => btn.textContent === '\u00d7')
    expect(xButton).toBeDefined()
    fireEvent.click(xButton!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop (overlay) is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<InstallHint agentId="claude" agentName="Claude Code" onClose={onClose} />)
    // Click on the fixed overlay backdrop
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when dialog content is clicked', () => {
    const onClose = vi.fn()
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={onClose} />)
    // Click on the dialog card itself (stopPropagation should prevent onClose)
    const dialog = screen.getByText('Install Claude Code').closest('.bg-\\[\\#252526\\]') as HTMLElement
    fireEvent.click(dialog)
    // onClose should NOT be called from the card click
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows codex install instructions', () => {
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={vi.fn()} />)
    expect(screen.getByText('npm install -g @openai/codex')).toBeInTheDocument()
    expect(screen.getByText(/codex --version/)).toBeInTheDocument()
  })

  it('shows gemini install instructions', () => {
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    expect(screen.getByText('npm install -g @google/gemini-cli')).toBeInTheDocument()
    expect(screen.getByText(/gemini --version/)).toBeInTheDocument()
  })

  it('shows aider-qwen install instructions with aider and ollama steps', () => {
    render(<InstallHint agentId="aider-qwen" agentName="Aider + Qwen" onClose={vi.fn()} />)
    expect(screen.getAllByText(/Aider/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/Ollama/).length).toBeGreaterThanOrEqual(1)
  })

  it('shows default instructions for unknown agent', () => {
    render(<InstallHint agentId="unknown-agent" agentName="Unknown" onClose={vi.fn()} />)
    expect(screen.getByText('Install Unknown')).toBeInTheDocument()
    expect(screen.getByText('Check the documentation for install instructions.')).toBeInTheDocument()
  })

  it('shows "not installed" notice text', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText(/not installed on your system/)).toBeInTheDocument()
  })

  it('shows restart notice', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText(/restart Termpolis/)).toBeInTheDocument()
  })

  it('renders Documentation link', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText('Documentation')).toBeInTheDocument()
  })

  it('opens documentation URL in new window when link is clicked', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Documentation'))
    expect(window.open).toHaveBeenCalledWith('https://docs.anthropic.com/en/docs/claude-code', '_blank')
  })

  it('opens correct URL for codex documentation', () => {
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Documentation'))
    expect(window.open).toHaveBeenCalledWith('https://github.com/openai/codex', '_blank')
  })
})
