import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
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
})
