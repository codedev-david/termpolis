import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TabPopover } from '../../src/renderer/src/components/TabPopover/TabPopover'

describe('TabPopover', () => {
  const props = {
    name: 'My Terminal',
    color: '#4FC3F7',
    fontSize: 14,
    theme: 'dark',
    fontFamily: 'Consolas, "Courier New", monospace',
    onSave: vi.fn(),
    onClose: vi.fn(),
  }

  it('shows current name in input', () => {
    render(<TabPopover {...props} />)
    expect(screen.getByDisplayValue('My Terminal')).toBeInTheDocument()
  })

  it('calls onSave with updated name and color', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Name' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Name', color: '#4FC3F7' }))
  })

  it('calls onClose when Cancel clicked', () => {
    const onClose = vi.fn()
    render(<TabPopover {...props} onClose={onClose} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders font size stepper with current value', () => {
    render(<TabPopover {...props} />)
    const fontSizeInput = screen.getByRole('spinbutton', { name: /font size/i })
    expect(fontSizeInput).toBeInTheDocument()
    expect((fontSizeInput as HTMLInputElement).value).toBe('14')
  })

  it('increments font size when + is clicked', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    fireEvent.click(screen.getByText('+'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 15 }))
  })

  it('decrements font size when − is clicked', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    fireEvent.click(screen.getByText('−'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 13 }))
  })

  it('clamps font size to minimum 8', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} fontSize={8} onSave={onSave} />)
    fireEvent.click(screen.getByText('−'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 8 }))
  })

  it('clamps font size to maximum 32', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} fontSize={32} onSave={onSave} />)
    fireEvent.click(screen.getByText('+'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 32 }))
  })

  it('renders theme pills for all themes', () => {
    render(<TabPopover {...props} />)
    expect(screen.getByText('Dark')).toBeInTheDocument()
    expect(screen.getByText('Light')).toBeInTheDocument()
    expect(screen.getByText('Monokai')).toBeInTheDocument()
    expect(screen.getByText('Dracula')).toBeInTheDocument()
    expect(screen.getByText('Nord')).toBeInTheDocument()
  })

  it('saves updated theme when a theme pill is clicked', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    fireEvent.click(screen.getByText('Monokai'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: 'monokai' }))
  })

  it('renders font family dropdown', () => {
    render(<TabPopover {...props} />)
    const select = screen.getByRole('combobox', { name: /font family/i })
    expect(select).toBeInTheDocument()
  })

  it('saves updated font family when changed', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    const select = screen.getByRole('combobox', { name: /font family/i })
    fireEvent.change(select, { target: { value: 'JetBrains Mono, monospace' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fontFamily: 'JetBrains Mono, monospace' }))
  })

  it('saves all fields together on Save', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('Dracula'))
    fireEvent.click(screen.getByText('+'))
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith({
      name: 'Renamed',
      color: '#4FC3F7',
      fontSize: 15,
      theme: 'dracula',
      fontFamily: 'Consolas, "Courier New", monospace',
    })
  })
})
