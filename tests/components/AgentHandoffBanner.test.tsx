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
    // Claude Code is filtered out; Codex, Gemini, Qwen Code should remain
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.getByText('Qwen Code')).toBeInTheDocument()
    expect(screen.queryByText('Claude Code', { exact: false, selector: 'button' })).not.toBeInTheDocument()
    expect(screen.getByText('Dismiss')).toBeInTheDocument()
  })

  it('clicking a switch button invokes onSwitchTo with the lowercase command name', () => {
    const onSwitchTo = vi.fn()
    render(
      <AgentHandoffBanner
        previousAgent="Claude Code"
        onSwitchTo={onSwitchTo}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('Codex'))
    expect(onSwitchTo).toHaveBeenCalledWith('codex')
    fireEvent.click(screen.getByText('Gemini'))
    expect(onSwitchTo).toHaveBeenCalledWith('gemini')
    fireEvent.click(screen.getByText('Qwen Code'))
    expect(onSwitchTo).toHaveBeenCalledWith('qwen')
  })

  it('clicking Dismiss invokes onDismiss', () => {
    const onDismiss = vi.fn()
    render(
      <AgentHandoffBanner
        previousAgent="Claude Code"
        onSwitchTo={vi.fn()}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('mouseEnter/mouseLeave on a switch button toggles its background color', () => {
    render(
      <AgentHandoffBanner
        previousAgent="Claude Code"
        onSwitchTo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const btn = screen.getByText('Codex') as HTMLButtonElement
    fireEvent.mouseEnter(btn)
    expect(btn.style.backgroundColor).toBe('rgb(180, 83, 9)') // #b45309
    fireEvent.mouseLeave(btn)
    expect(btn.style.backgroundColor).toBe('rgb(146, 64, 14)') // #92400e
  })

  it('mouseEnter/mouseLeave on Dismiss toggles its color', () => {
    render(
      <AgentHandoffBanner
        previousAgent="Claude Code"
        onSwitchTo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const btn = screen.getByText('Dismiss') as HTMLButtonElement
    fireEvent.mouseEnter(btn)
    expect(btn.style.color).toBe('rgb(251, 191, 36)') // #fbbf24
    fireEvent.mouseLeave(btn)
    expect(btn.style.color).toBe('rgb(217, 119, 6)') // #d97706
  })

  it('case-insensitive previousAgent filtering — "claude code" still hides Claude Code button', () => {
    render(
      <AgentHandoffBanner
        previousAgent="claude code"
        onSwitchTo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    // Claude Code button should still be filtered (case-insensitive match)
    const buttons = screen.queryAllByRole('button')
    const labels = buttons.map(b => b.textContent || '')
    expect(labels.find(l => l.includes('Claude Code'))).toBeUndefined()
    expect(labels.find(l => l.includes('Codex'))).toBeDefined()
  })

  it('renders all 4 switch targets when previousAgent does not match any name', () => {
    render(
      <AgentHandoffBanner
        previousAgent="Some Unknown Agent"
        onSwitchTo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Qwen Code')).toBeInTheDocument()
  })
})
