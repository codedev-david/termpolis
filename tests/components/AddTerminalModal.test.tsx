import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AddTerminalModal } from '../../src/renderer/src/components/Sidebar/AddTerminalModal'

const shells = [
  { type: 'bash' as const, label: 'Bash', executable: '/bin/bash' },
  { type: 'zsh' as const, label: 'Zsh', executable: '/bin/zsh' },
]

describe('AddTerminalModal', () => {
  it('renders name input pre-filled with Terminal 1', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByDisplayValue('Terminal 1')).toBeInTheDocument()
  })

  it('calls onCancel when Cancel clicked', () => {
    const onCancel = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls onCreate with name, shellType, color when Create clicked', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Terminal 1',
      shellType: 'bash',
      color: expect.any(String),
    }))
  })

  it('renders font size stepper defaulting to 14', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByDisplayValue('14')).toBeInTheDocument()
  })

  it('renders theme pills', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Dark')).toBeInTheDocument()
    expect(screen.getByText('Light')).toBeInTheDocument()
    expect(screen.getByText('Nord')).toBeInTheDocument()
  })

  it('renders font family selector', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByDisplayValue('Consolas')).toBeInTheDocument()
  })

  it('seeds appearance fields from the saved Terminal Defaults (overridable in-modal)', () => {
    localStorage.setItem(
      'termpolis.terminal.defaults',
      JSON.stringify({ fontSize: 18, theme: 'nord', fontFamily: 'JetBrains Mono, monospace' }),
    )
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    expect(screen.getByDisplayValue('18')).toBeInTheDocument()
    expect(screen.getByDisplayValue('JetBrains Mono')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      fontSize: 18,
      theme: 'nord',
      fontFamily: 'JetBrains Mono, monospace',
    }))
    localStorage.removeItem('termpolis.terminal.defaults')
  })

  it('calls onCreate with all fields including fontSize, theme, fontFamily', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Terminal 1',
      shellType: 'bash',
      color: expect.any(String),
      fontSize: 14,
      theme: 'dark',
      fontFamily: expect.any(String),
    }))
  })

  it('updates name via input', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Terminal 1'), { target: { value: 'Custom Name' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Custom Name' }))
  })

  it('changes shellType via select', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    const select = screen.getByDisplayValue('Bash') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'zsh' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ shellType: 'zsh' }))
  })

  it('steps font size up and down with bounds', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    const plus = screen.getByText('+')
    const minus = screen.getByText('−')
    fireEvent.click(plus)
    expect(screen.getByDisplayValue('15')).toBeInTheDocument()
    fireEvent.click(minus)
    fireEvent.click(minus)
    expect(screen.getByDisplayValue('13')).toBeInTheDocument()
  })

  it('clamps font size to valid range on direct input', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    const input = screen.getByDisplayValue('14') as HTMLInputElement
    fireEvent.change(input, { target: { value: '100' } })
    expect(screen.getByDisplayValue('32')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '1' } })
    expect(screen.getByDisplayValue('8')).toBeInTheDocument()
  })

  it('picks a theme pill', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Nord'))
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ theme: 'nord' }))
  })

  it('picks a color swatch', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    const swatches = screen.getAllByLabelText(/^#/)
    fireEvent.click(swatches[1])
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalled()
  })

  it('changes font family via select', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    const fontSelect = screen.getByDisplayValue('Consolas') as HTMLSelectElement
    fireEvent.change(fontSelect, { target: { value: 'JetBrains Mono, monospace' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fontFamily: 'JetBrains Mono, monospace' }),
    )
  })

  it('falls back to the indexed default name when the name is blanked out', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={7} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    const nameInput = screen.getByDisplayValue('Terminal 7')

    // Whitespace only: trim() leaves an empty string, so the || fallback must
    // re-supply the indexed name rather than creating a nameless terminal.
    fireEvent.change(nameInput, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Create'))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Terminal 7' }))
  })
})

// The folder is the only field that decides whether the new terminal's git dot can ever
// appear: the dot and the Changes rail read the LAUNCH directory, and on Windows nothing
// can follow a `cd`. Before this existed the modal had no cwd field at all, so every
// terminal it made was pinned to the home directory and showed no dot, ever.
describe('AddTerminalModal — folder', () => {
  afterEach(() => {
    delete (window as any).termpolis
  })

  const folderInput = () => screen.getByPlaceholderText('Home directory') as HTMLInputElement

  it('defaults to the directory it was handed (the active terminal’s)', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" defaultCwd="/repo" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(folderInput().value).toBe('/repo')
  })

  it('shows the home-directory placeholder when it is handed nothing', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(folderInput().value).toBe('')
  })

  it('passes a typed folder to onCreate', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.change(folderInput(), { target: { value: '/repo/sub' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/sub' }))
  })

  it('trims the folder, so stray spaces cannot spawn a terminal in nowhere', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.change(folderInput(), { target: { value: '  /repo  ' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo' }))
  })

  it('reports an empty folder so the caller can fall back to the home directory', () => {
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '' }))
  })

  it('fills the folder from the directory picker', async () => {
    const pickDirectory = vi.fn().mockResolvedValue({ success: true, data: '/picked/repo' })
    ;(window as any).termpolis = { pickDirectory }
    const onCreate = vi.fn()
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" defaultCwd="/repo" onCreate={onCreate} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Browse…'))
    await waitFor(() => expect(folderInput().value).toBe('/picked/repo'))
    // Seeded with the current folder so the dialog opens where the user already is.
    expect(pickDirectory).toHaveBeenCalledWith('/repo')
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/picked/repo' }))
  })

  it('opens the picker with no seed when no folder is set yet', async () => {
    const pickDirectory = vi.fn().mockResolvedValue({ success: true, data: null })
    ;(window as any).termpolis = { pickDirectory }
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" onCreate={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Browse…'))
    await waitFor(() => expect(pickDirectory).toHaveBeenCalledWith(undefined))
  })

  it('keeps the current folder when the picker is dismissed', async () => {
    const pickDirectory = vi.fn().mockResolvedValue({ success: true, data: null })
    ;(window as any).termpolis = { pickDirectory }
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" defaultCwd="/repo" onCreate={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Browse…'))
    await waitFor(() => expect(pickDirectory).toHaveBeenCalled())
    expect(folderInput().value).toBe('/repo')
  })

  it('keeps the current folder when the picker fails outright', async () => {
    const pickDirectory = vi.fn().mockRejectedValue(new Error('no dialog'))
    ;(window as any).termpolis = { pickDirectory }
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" defaultCwd="/repo" onCreate={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByText('Browse…'))
    await waitFor(() => expect(pickDirectory).toHaveBeenCalled())
    expect(folderInput().value).toBe('/repo')
  })

  it('does not throw when there is no preload bridge', () => {
    render(<AddTerminalModal shells={shells} nextIndex={1} defaultShell="bash" defaultCwd="/repo" onCreate={vi.fn()} onCancel={vi.fn()} />)
    expect(() => fireEvent.click(screen.getByText('Browse…'))).not.toThrow()
    expect(folderInput().value).toBe('/repo')
  })
})
