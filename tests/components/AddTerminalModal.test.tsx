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
})
