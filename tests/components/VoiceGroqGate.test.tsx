import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { VoiceGroqGate } from '../../src/renderer/src/components/TerminalPane/VoiceGroqGate'

describe('VoiceGroqGate', () => {
  it('explains that voice needs Groq and points the user to Settings', () => {
    render(<VoiceGroqGate onOpenSettings={vi.fn()} onClose={vi.fn()} />)
    const gate = screen.getByTestId('voice-groq-gate')
    expect(gate).toBeInTheDocument()
    expect(gate).toHaveTextContent(/groq/i)
    expect(gate).toHaveTextContent(/settings/i)
  })

  it('"Open Voice Settings" invokes onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    render(<VoiceGroqGate onOpenSettings={onOpenSettings} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('voice-groq-gate-open-settings'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('dismiss invokes onClose without opening Settings', () => {
    const onClose = vi.fn()
    const onOpenSettings = vi.fn()
    render(<VoiceGroqGate onOpenSettings={onOpenSettings} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('voice-groq-gate-dismiss'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).not.toHaveBeenCalled()
  })
})
