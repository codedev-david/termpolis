import React, { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('uuid', () => ({ v4: () => 'new-id' }))

const addCustomKeybinding = vi.fn()
const updateCustomKeybinding = vi.fn()
const removeCustomKeybinding = vi.fn()
let mockCustom: any[] = []

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    () => ({
      customKeybindings: mockCustom,
      addCustomKeybinding,
      updateCustomKeybinding,
      removeCustomKeybinding,
    }),
    { getState: vi.fn(), setState: vi.fn() },
  ),
}))

import { CustomKeybindings } from '../../src/renderer/src/components/SettingsPane/CustomKeybindings'

function Harness() {
  const [recordingId, setRecordingId] = useState<string | null>(null)
  return <CustomKeybindings recordingId={recordingId} setRecordingId={setRecordingId} />
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCustom = []
})

describe('CustomKeybindings', () => {
  it('renders the section heading', () => {
    render(<Harness />)
    expect(screen.getByText('Custom Shortcuts')).toBeInTheDocument()
  })

  it('renders existing custom shortcuts', () => {
    mockCustom = [{ id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true }]
    render(<Harness />)
    expect(screen.getByDisplayValue('Git Status')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Alt+G')).toBeInTheDocument()
    expect(screen.getByDisplayValue('git status')).toBeInTheDocument()
  })

  it('adds a custom shortcut through the form (records a combo, fills fields)', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'Git Status' } })
    fireEvent.change(screen.getByPlaceholderText(/Text to send/i), { target: { value: 'git status' } })
    // Record a combo for the new shortcut
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, altKey: true })) })
    expect(screen.getByText('Ctrl+Alt+G')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).toHaveBeenCalledWith(expect.objectContaining({
      id: 'new-id', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true,
    }))
  })

  it('does not add when label, combo, or text is missing', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).not.toHaveBeenCalled()
  })

  it('does not add a shortcut whose combo lacks Ctrl or Alt', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'Bad' } })
    fireEvent.change(screen.getByPlaceholderText(/Text to send/i), { target: { value: 'oops' } })
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' })) }) // bare key, no modifier
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).not.toHaveBeenCalled()
  })

  it('shows an empty-state when there are no custom shortcuts', () => {
    render(<Harness />)
    expect(screen.getByText(/No custom shortcuts yet/i)).toBeInTheDocument()
  })

  it('warns that shortcuts are stored unencrypted', () => {
    render(<Harness />)
    expect(screen.getByText(/unencrypted/i)).toBeInTheDocument()
  })

  it('removes a custom shortcut', () => {
    mockCustom = [{ id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true }]
    render(<Harness />)
    fireEvent.click(screen.getByTitle('Remove shortcut'))
    expect(removeCustomKeybinding).toHaveBeenCalledWith('c1')
  })

  it('edits an existing shortcut label', () => {
    mockCustom = [{ id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true }]
    render(<Harness />)
    fireEvent.change(screen.getByDisplayValue('Git Status'), { target: { value: 'Status' } })
    expect(updateCustomKeybinding).toHaveBeenCalledWith('c1', { label: 'Status' })
  })

  it('toggles runOnSend on an existing shortcut', () => {
    mockCustom = [{ id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true }]
    render(<Harness />)
    const checkbox = screen.getByLabelText('Run on send')
    fireEvent.click(checkbox)
    expect(updateCustomKeybinding).toHaveBeenCalledWith('c1', { runOnSend: false })
  })

  // The three reserved copy combos (Ctrl+Shift+C / K / Q) can never be claimed by
  // a custom shortcut — not through the Add form, not by re-recording an existing
  // row. Copy must always win. (v1.30.3)
  it('does not add a custom shortcut bound to a reserved copy combo', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'Steal Copy' } })
    fireEvent.change(screen.getByPlaceholderText(/Text to send/i), { target: { value: 'nope' } })
    fireEvent.click(screen.getByText('Set combo'))
    // Ctrl+Shift+C carries a modifier but is the reserved Copy hotkey — refuse it.
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true })) })
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).not.toHaveBeenCalled()
  })

  it('warns when the drafted combo is a reserved copy hotkey', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true })) })
    expect(screen.getByText(/reserved for copy/i)).toBeInTheDocument()
  })

  it('refuses to overwrite an existing custom shortcut with a reserved combo', () => {
    mockCustom = [{ id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true }]
    render(<Harness />)
    fireEvent.click(screen.getByText('Ctrl+Alt+G'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Q', ctrlKey: true, shiftKey: true })) })
    expect(updateCustomKeybinding).not.toHaveBeenCalled()
  })
})
