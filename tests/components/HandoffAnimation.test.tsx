import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { HandoffAnimation } from '../../src/renderer/src/components/HandoffAnimation/HandoffAnimation'

afterEach(() => {
  vi.useRealTimers()
})

describe('HandoffAnimation', () => {
  it('renders with from and to labels', () => {
    render(<HandoffAnimation fromAgent="Claude" toAgent="Codex" />)
    expect(screen.getByTestId('handoff-animation')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('defaults from to Conductor when missing', () => {
    render(<HandoffAnimation toAgent="Gemini" />)
    expect(screen.getByText('Conductor')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
  })

  it('auto-hides after duration and fires onComplete', () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    render(<HandoffAnimation toAgent="Aider" durationMs={500} onComplete={onComplete} />)
    expect(screen.getByTestId('handoff-animation')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByTestId('handoff-animation')).toBeNull()
    expect(onComplete).toHaveBeenCalled()
  })
})
