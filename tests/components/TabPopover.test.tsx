import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TabPopover } from '../../src/renderer/src/components/TabPopover/TabPopover'

describe('TabPopover', () => {
  const props = { name: 'My Terminal', color: '#4FC3F7', onSave: vi.fn(), onClose: vi.fn() }

  it('shows current name in input', () => {
    render(<TabPopover {...props} />)
    expect(screen.getByDisplayValue('My Terminal')).toBeInTheDocument()
  })

  it('calls onSave with updated name and color', () => {
    const onSave = vi.fn()
    render(<TabPopover {...props} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Name' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith({ name: 'New Name', color: '#4FC3F7' })
  })

  it('calls onClose when Cancel clicked', () => {
    const onClose = vi.fn()
    render(<TabPopover {...props} onClose={onClose} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })
})
