import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock TabPopover since it uses createPortal
vi.mock('../../../src/renderer/src/components/TabPopover/TabPopover', () => ({
  TabPopover: (props: any) => (
    <div data-testid="tab-popover">
      <button onClick={() => props.onSave({ name: 'Renamed' })} data-testid="popover-save">
        Save
      </button>
      <button onClick={props.onClose} data-testid="popover-close">
        Close
      </button>
    </div>
  ),
}))

import { TerminalTab } from '../../../src/renderer/src/components/Sidebar/TerminalTab'

const baseTerminal = {
  id: 't1',
  name: 'My Terminal',
  color: '#22D3EE',
  shellType: 'bash' as const,
  cwd: '/home/user',
  fontSize: 14,
  theme: 'dark',
  fontFamily: 'monospace',
}

describe('TerminalTab', () => {
  const onClick = vi.fn()
  const onClose = vi.fn()
  const onUpdate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the terminal name', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    expect(screen.getByText('My Terminal')).toBeInTheDocument()
  })

  it('renders the shortcut number for index < 9', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={2} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    expect(screen.getByTitle('Alt+3')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('does not render shortcut number for index >= 9', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={9} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    expect(screen.queryByTitle('Alt+10')).not.toBeInTheDocument()
  })

  it('renders the shell icon for bash', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    expect(screen.getByText('$')).toBeInTheDocument()
  })

  it('renders PS icon for powershell', () => {
    const psTerminal = { ...baseTerminal, shellType: 'powershell' as const }
    render(
      <TerminalTab terminal={psTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    expect(screen.getByText('PS')).toBeInTheDocument()
  })

  it('renders fallback $ icon for unknown shell', () => {
    const unknownTerminal = { ...baseTerminal, shellType: 'fish' as any }
    render(
      <TerminalTab terminal={unknownTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    // Two $ signs: one from shortcut index and one from shell icon fallback
    const dollars = screen.getAllByText('$')
    expect(dollars.length).toBeGreaterThanOrEqual(1)
  })

  it('applies the terminal color as left border', () => {
    const { container } = render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    const row = container.firstChild as HTMLElement
    expect(row.style.borderLeft).toContain('solid')
  })

  it('applies active background when isActive is true', () => {
    const { container } = render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={true} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    const row = container.firstChild as HTMLElement
    expect(row.className).toContain('bg-[#37373d]')
  })

  it('does not apply active background when isActive is false', () => {
    const { container } = render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    const row = container.firstChild as HTMLElement
    expect(row.className).not.toContain('bg-[#37373d]')
  })

  it('calls onClick when the row is clicked', () => {
    const { container } = render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    fireEvent.click(container.firstChild as HTMLElement)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    const closeBtn = screen.getByLabelText('Close My Terminal')
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
    // Should not propagate to onClick
    expect(onClick).not.toHaveBeenCalled()
  })

  it('opens popover when edit button is clicked', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    const editBtn = screen.getByLabelText('Edit terminal')
    fireEvent.click(editBtn)
    expect(screen.getByTestId('tab-popover')).toBeInTheDocument()
  })

  it('opens popover on context menu (right-click)', () => {
    const { container } = render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    fireEvent.contextMenu(container.firstChild as HTMLElement)
    expect(screen.getByTestId('tab-popover')).toBeInTheDocument()
  })

  it('calls onUpdate and closes popover when save is clicked', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    // Open popover
    fireEvent.click(screen.getByLabelText('Edit terminal'))
    // Click save in popover
    fireEvent.click(screen.getByTestId('popover-save'))
    expect(onUpdate).toHaveBeenCalledWith({ name: 'Renamed' })
    // Popover should be closed
    expect(screen.queryByTestId('tab-popover')).not.toBeInTheDocument()
  })

  it('closes popover when close is clicked in popover', () => {
    render(
      <TerminalTab terminal={baseTerminal} index={0} isActive={false} onClick={onClick} onClose={onClose} onUpdate={onUpdate} />
    )
    fireEvent.click(screen.getByLabelText('Edit terminal'))
    expect(screen.getByTestId('tab-popover')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('popover-close'))
    expect(screen.queryByTestId('tab-popover')).not.toBeInTheDocument()
  })
})
