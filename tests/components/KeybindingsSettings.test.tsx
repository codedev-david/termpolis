import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const setKeybinding = vi.fn()
const resetKeybindings = vi.fn()

let mockKeybindings: Record<string, string> = {
  copy: 'Ctrl+Shift+C',
  paste: 'Ctrl+Shift+V',
  historySearch: 'Ctrl+Shift+H',
  newTerminal: 'Ctrl+Shift+T',
  closeTerminal: 'Ctrl+Shift+W',
  nextTerminal: 'Ctrl+Tab',
  prevTerminal: 'Ctrl+Shift+Tab',
  toggleAutocomplete: 'Ctrl+Space',
  toggleSidebar: 'Ctrl+B',
  toggleGrid: 'Ctrl+Shift+G',
}

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    () => ({
      keybindings: mockKeybindings,
      setKeybinding,
      resetKeybindings,
    }),
    { getState: vi.fn(), setState: vi.fn() },
  ),
}))

import { KeybindingsSettings } from '../../src/renderer/src/components/SettingsPane/KeybindingsSettings'

beforeEach(() => {
  vi.clearAllMocks()
  mockKeybindings = {
    copy: 'Ctrl+Shift+C',
    paste: 'Ctrl+Shift+V',
    historySearch: 'Ctrl+Shift+H',
    newTerminal: 'Ctrl+Shift+T',
    closeTerminal: 'Ctrl+Shift+W',
    nextTerminal: 'Ctrl+Tab',
    prevTerminal: 'Ctrl+Shift+Tab',
    toggleAutocomplete: 'Ctrl+Space',
    toggleSidebar: 'Ctrl+B',
    toggleGrid: 'Ctrl+Shift+G',
  }
})

describe('KeybindingsSettings', () => {
  it('renders heading and reset button', () => {
    render(<KeybindingsSettings />)
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Reset All')).toBeInTheDocument()
  })

  it('shows action labels for all keybindings', () => {
    render(<KeybindingsSettings />)
    expect(screen.getByText('Copy')).toBeInTheDocument()
    expect(screen.getByText('Paste')).toBeInTheDocument()
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
  })

  it('shows current shortcut values', () => {
    render(<KeybindingsSettings />)
    expect(screen.getByText('Ctrl+Shift+C')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+V')).toBeInTheDocument()
  })

  it('clicking a shortcut enters recording mode', () => {
    render(<KeybindingsSettings />)
    const copyBtn = screen.getByText('Ctrl+Shift+C')
    fireEvent.click(copyBtn)
    expect(screen.getByText('Press a key combination...')).toBeInTheDocument()
  })

  it('shows help text when recording', () => {
    render(<KeybindingsSettings />)
    fireEvent.click(screen.getByText('Ctrl+Shift+C'))
    expect(screen.getByText(/Click anywhere outside or press Escape to cancel/)).toBeInTheDocument()
  })

  it('pressing Escape while recording cancels', () => {
    render(<KeybindingsSettings />)
    fireEvent.click(screen.getByText('Ctrl+Shift+C'))
    expect(screen.getByText('Press a key combination...')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    // Recording should be cleared — Ctrl+Shift+C text back
    expect(screen.getByText('Ctrl+Shift+C')).toBeInTheDocument()
  })

  it('pressing a key combo while recording invokes setKeybinding', () => {
    render(<KeybindingsSettings />)
    fireEvent.click(screen.getByText('Ctrl+Shift+C'))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'X',
        ctrlKey: true,
        shiftKey: true,
      }))
    })
    expect(setKeybinding).toHaveBeenCalledWith('copy', 'Ctrl+Shift+X')
  })

  it('pressing a modifier-only key does not set keybinding', () => {
    render(<KeybindingsSettings />)
    fireEvent.click(screen.getByText('Ctrl+Shift+C'))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Control',
        ctrlKey: true,
      }))
    })
    expect(setKeybinding).not.toHaveBeenCalled()
  })

  it('clicking recording button again cancels recording', () => {
    render(<KeybindingsSettings />)
    const copyBtn = screen.getByText('Ctrl+Shift+C')
    fireEvent.click(copyBtn)
    // Now click again to cancel
    fireEvent.click(screen.getByText('Press a key combination...'))
    expect(screen.getByText('Ctrl+Shift+C')).toBeInTheDocument()
  })

  it('reset all button calls resetKeybindings', () => {
    render(<KeybindingsSettings />)
    fireEvent.click(screen.getByText('Reset All'))
    expect(resetKeybindings).toHaveBeenCalled()
  })

  it('shows reset-per-row button when non-default binding', () => {
    mockKeybindings = { ...mockKeybindings, copy: 'Alt+C' }
    const { container } = render(<KeybindingsSettings />)
    // Non-default copy value should yield one reset icon
    const icons = container.querySelectorAll('.fa-rotate-left')
    expect(icons.length).toBeGreaterThanOrEqual(1)
  })

  it('clicking per-row reset sets default binding', () => {
    mockKeybindings = { ...mockKeybindings, copy: 'Alt+C' }
    const { container } = render(<KeybindingsSettings />)
    const icon = container.querySelector('.fa-rotate-left')
    expect(icon).toBeTruthy()
    fireEvent.click(icon!.parentElement as HTMLElement)
    expect(setKeybinding).toHaveBeenCalledWith('copy', 'Ctrl+Shift+C')
  })

  it('key event without recording does nothing', () => {
    render(<KeybindingsSettings />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', ctrlKey: true }))
    })
    expect(setKeybinding).not.toHaveBeenCalled()
  })
})
