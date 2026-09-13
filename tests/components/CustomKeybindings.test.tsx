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

  // ---------------------------------------------------------------------------
  // Recorder lifecycle on EXISTING rows: capture / Escape-cancel / toggle-off.
  // Each arm detaches the global keydown listener; the follow-up dispatch in
  // these tests is what proves it actually went away.
  // ---------------------------------------------------------------------------
  const row = (over: any = {}) => ({
    id: 'c1', label: 'Git Status', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true, ...over,
  })

  it('rebinds an existing shortcut to a non-reserved combo and disarms the recorder', () => {
    mockCustom = [row()]
    render(<Harness />)
    fireEvent.click(screen.getByText('Ctrl+Alt+G'))
    expect(screen.getByText('Press a key combination...')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, altKey: true })) })
    expect(updateCustomKeybinding).toHaveBeenCalledWith('c1', { combo: 'Ctrl+Alt+H' })
    expect(screen.queryByText('Press a key combination...')).not.toBeInTheDocument()
  })

  it('cancels an existing-row recording on Escape, leaving the combo untouched', () => {
    mockCustom = [row()]
    render(<Harness />)
    fireEvent.click(screen.getByText('Ctrl+Alt+G'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(updateCustomKeybinding).not.toHaveBeenCalled()
    expect(screen.getByText('Ctrl+Alt+G')).toBeInTheDocument()
    // The listener must be detached — a later combo cannot sneak in.
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, altKey: true })) })
    expect(updateCustomKeybinding).not.toHaveBeenCalled()
  })

  it('disarms an existing-row recorder when its button is clicked a second time', () => {
    mockCustom = [row()]
    render(<Harness />)
    fireEvent.click(screen.getByText('Ctrl+Alt+G'))
    fireEvent.click(screen.getByText('Press a key combination...'))
    expect(screen.getByText('Ctrl+Alt+G')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, altKey: true })) })
    expect(updateCustomKeybinding).not.toHaveBeenCalled()
  })

  it('arms only the clicked row when several shortcuts exist', () => {
    mockCustom = [
      { id: 'c1', label: 'One', combo: 'Ctrl+Alt+1', text: 'one', runOnSend: true },
      { id: 'c2', label: 'Two', combo: 'Ctrl+Alt+2', text: 'two', runOnSend: false },
    ]
    render(<Harness />)
    fireEvent.click(screen.getByText('Ctrl+Alt+2'))
    expect(screen.getByText('Ctrl+Alt+1')).toBeInTheDocument()
    expect(screen.getAllByText('Press a key combination...')).toHaveLength(1)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, altKey: true })) })
    expect(updateCustomKeybinding).toHaveBeenCalledTimes(1)
    expect(updateCustomKeybinding).toHaveBeenCalledWith('c2', { combo: 'Ctrl+Alt+X' })
  })

  // ---- Existing-row field edits & accessible names ---------------------------

  it('edits the snippet text of an existing shortcut', () => {
    mockCustom = [row()]
    render(<Harness />)
    fireEvent.change(screen.getByDisplayValue('git status'), { target: { value: 'git status -sb' } })
    expect(updateCustomKeybinding).toHaveBeenCalledWith('c1', { text: 'git status -sb' })
  })

  it('names each row input after that row label', () => {
    mockCustom = [row()]
    render(<Harness />)
    expect(screen.getByLabelText('Label for Git Status')).toHaveValue('Git Status')
    expect(screen.getByLabelText('Text sent by Git Status')).toHaveValue('git status')
  })

  it('falls back to "shortcut" in the aria labels while a row is still unnamed', () => {
    mockCustom = [row({ label: '', runOnSend: false })]
    render(<Harness />)
    expect(screen.getByLabelText('Label for shortcut')).toHaveValue('')
    expect(screen.getByLabelText('Text sent by shortcut')).toHaveValue('git status')
    // runOnSend:false renders an unchecked box, and toggling it turns Run back on.
    expect(screen.getByLabelText('Run on send')).not.toBeChecked()
    fireEvent.click(screen.getByLabelText('Run on send'))
    expect(updateCustomKeybinding).toHaveBeenCalledWith('c1', { runOnSend: true })
  })

  it('hides the empty-state once a shortcut exists', () => {
    mockCustom = [row()]
    render(<Harness />)
    expect(screen.queryByText(/No custom shortcuts yet/i)).not.toBeInTheDocument()
  })

  // ---- The add form: recorder cancel/toggle, Run checkbox, draft reset -------

  it('cancels a new-shortcut recording on Escape without drafting a combo', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(screen.getByText('Set combo')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, altKey: true })) })
    expect(screen.queryByText('Ctrl+Alt+G')).not.toBeInTheDocument()
  })

  it('disarms the new-shortcut recorder when its button is clicked a second time', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Set combo'))
    expect(screen.getByText('Press a key combination...')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Press a key combination...'))
    expect(screen.getByText('Set combo')).toBeInTheDocument()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, altKey: true })) })
    expect(screen.queryByText('Ctrl+Alt+G')).not.toBeInTheDocument()
  })

  it('adds with Run disabled when the new-shortcut checkbox is cleared', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Git status)'), { target: { value: 'Echo' } })
    fireEvent.change(screen.getByPlaceholderText('Text to send (e.g. git status)'), { target: { value: 'echo hi' } })
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, altKey: true })) })
    const run = screen.getByLabelText('Run new shortcut on send')
    expect(run).toBeChecked()
    fireEvent.click(run)
    expect(run).not.toBeChecked()
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).toHaveBeenCalledWith(
      expect.objectContaining({ combo: 'Ctrl+Alt+E', runOnSend: false }),
    )
  })

  it('clears the draft form and re-checks Run after a successful add', () => {
    render(<Harness />)
    const label = screen.getByPlaceholderText('Label (e.g. Git status)')
    const text = screen.getByPlaceholderText('Text to send (e.g. git status)')
    fireEvent.change(label, { target: { value: 'Echo' } })
    fireEvent.change(text, { target: { value: 'echo hi' } })
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, altKey: true })) })
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).toHaveBeenCalledTimes(1)
    expect(label).toHaveValue('')
    expect(text).toHaveValue('')
    expect(screen.getByText('Set combo')).toBeInTheDocument()
    expect(screen.getByLabelText('Run new shortcut on send')).toBeChecked()
    expect(screen.getByText('Add Shortcut')).toBeDisabled()
  })

  it('trims the label but sends the snippet text verbatim', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Git status)'), { target: { value: '  Git Status  ' } })
    fireEvent.change(screen.getByPlaceholderText('Text to send (e.g. git status)'), { target: { value: ' git status ' } })
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, altKey: true })) })
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).toHaveBeenCalledWith({
      id: 'new-id', label: 'Git Status', combo: 'Ctrl+Alt+G', text: ' git status ', runOnSend: true,
    })
  })

  it('keeps Add disabled until label, combo and text are all present', () => {
    render(<Harness />)
    const add = screen.getByText('Add Shortcut')
    expect(add).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Git status)'), { target: { value: 'Echo' } })
    expect(add).toBeDisabled() // label alone — no combo, no text
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, altKey: true })) })
    expect(add).toBeDisabled() // label + combo, still no text
    fireEvent.click(add)
    expect(addCustomKeybinding).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('Text to send (e.g. git status)'), { target: { value: 'echo hi' } })
    expect(add).toBeEnabled()
  })

  it('treats a whitespace-only label as empty', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Git status)'), { target: { value: '   ' } })
    fireEvent.change(screen.getByPlaceholderText('Text to send (e.g. git status)'), { target: { value: 'echo hi' } })
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, altKey: true })) })
    expect(screen.getByText('Add Shortcut')).toBeDisabled()
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).not.toHaveBeenCalled()
  })

  // ---- Warning banners appear and clear with the drafted combo ---------------

  it('shows neither warning before a combo has been recorded', () => {
    render(<Harness />)
    expect(screen.queryByText(/must include Ctrl or Alt/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/reserved for copy/i)).not.toBeInTheDocument()
  })

  it('drops the modifier warning once a valid combo replaces a bare key', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' })) })
    expect(screen.getByText(/must include Ctrl or Alt/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('G'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true })) })
    expect(screen.getByText('Ctrl+G')).toBeInTheDocument()
    expect(screen.queryByText(/must include Ctrl or Alt/i)).not.toBeInTheDocument()
  })

  it('drops the reserved warning and re-enables Add once a free combo is picked', () => {
    render(<Harness />)
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. Git status)'), { target: { value: 'Steal Copy' } })
    fireEvent.change(screen.getByPlaceholderText('Text to send (e.g. git status)'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByText('Set combo'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true })) })
    expect(screen.getByText(/reserved for copy/i)).toBeInTheDocument()
    expect(screen.getByText('Add Shortcut')).toBeDisabled()
    fireEvent.click(screen.getByText('Ctrl+Shift+C'))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, altKey: true })) })
    expect(screen.queryByText(/reserved for copy/i)).not.toBeInTheDocument()
    expect(screen.getByText('Add Shortcut')).toBeEnabled()
    fireEvent.click(screen.getByText('Add Shortcut'))
    expect(addCustomKeybinding).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Steal Copy', combo: 'Ctrl+Alt+C' }),
    )
  })
})
