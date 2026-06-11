import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { KeyComboRecorder } from '../../src/renderer/src/components/SettingsPane/KeyComboRecorder'

const noop = () => {}

describe('KeyComboRecorder', () => {
  it('shows the current value when not recording', () => {
    render(<KeyComboRecorder value="Ctrl+Shift+C" recording={false} onToggle={noop} onCapture={noop} onCancel={noop} />)
    expect(screen.getByText('Ctrl+Shift+C')).toBeInTheDocument()
  })

  it('shows the placeholder when value is empty and not recording', () => {
    render(<KeyComboRecorder value="" placeholder="Set shortcut" recording={false} onToggle={noop} onCapture={noop} onCancel={noop} />)
    expect(screen.getByText('Set shortcut')).toBeInTheDocument()
  })

  it('shows the recording prompt while recording', () => {
    render(<KeyComboRecorder value="Ctrl+Shift+C" recording={true} onToggle={noop} onCapture={noop} onCancel={noop} />)
    expect(screen.getByText('Press a key combination...')).toBeInTheDocument()
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<KeyComboRecorder value="X" recording={false} onToggle={onToggle} onCapture={noop} onCancel={noop} />)
    fireEvent.click(screen.getByText('X'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('captures a full combo while recording', () => {
    const onCapture = vi.fn()
    render(<KeyComboRecorder value="X" recording={true} onToggle={noop} onCapture={onCapture} onCancel={noop} />)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, shiftKey: true })) })
    expect(onCapture).toHaveBeenCalledWith('Ctrl+Shift+G')
  })

  it('Escape cancels while recording (no capture)', () => {
    const onCancel = vi.fn(); const onCapture = vi.fn()
    render(<KeyComboRecorder value="X" recording={true} onToggle={noop} onCapture={onCapture} onCancel={onCancel} />)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onCancel).toHaveBeenCalled()
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('ignores modifier-only keypresses while recording', () => {
    const onCapture = vi.fn()
    render(<KeyComboRecorder value="X" recording={true} onToggle={noop} onCapture={onCapture} onCancel={noop} />)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true })) })
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('does not listen for keys when not recording', () => {
    const onCapture = vi.fn()
    render(<KeyComboRecorder value="X" recording={false} onToggle={noop} onCapture={onCapture} onCancel={noop} />)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, shiftKey: true })) })
    expect(onCapture).not.toHaveBeenCalled()
  })
})
