import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// Module-scope variables for dynamic mock state
let mockActiveTerminalId: string | null = 'test-terminal-1'
let mockPromptTemplates: any[] = []
const mockAddPromptTemplate = vi.fn()
const mockRemovePromptTemplate = vi.fn()
const mockWriteToTerminal = vi.fn()

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: mockWriteToTerminal,
  }
})

beforeEach(() => {
  mockActiveTerminalId = 'test-terminal-1'
  mockPromptTemplates = []
  mockAddPromptTemplate.mockClear()
  mockRemovePromptTemplate.mockClear()
  mockWriteToTerminal.mockClear()
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        activeTerminalId: mockActiveTerminalId,
        promptTemplates: mockPromptTemplates,
        addPromptTemplate: mockAddPromptTemplate,
        removePromptTemplate: mockRemovePromptTemplate,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        activeTerminalId: mockActiveTerminalId,
        promptTemplates: mockPromptTemplates,
      })),
      setState: vi.fn(),
    },
  ),
}))

import { PromptTemplates } from '../../src/renderer/src/components/PromptTemplates/PromptTemplates'

describe('PromptTemplates', () => {
  it('renders overlay with Prompt Templates heading', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Prompt Templates')).toBeInTheDocument()
  })

  it('shows all default templates', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Fix Tests')).toBeInTheDocument()
    expect(screen.getByText('Code Review')).toBeInTheDocument()
    expect(screen.getByText('Explain Code')).toBeInTheDocument()
    expect(screen.getByText('Refactor')).toBeInTheDocument()
    expect(screen.getByText('Write Tests')).toBeInTheDocument()
    expect(screen.getByText('Add Docs')).toBeInTheDocument()
  })

  it('shows template descriptions/text', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Fix the failing tests and explain what was wrong')).toBeInTheDocument()
    expect(screen.getByText('Review this code for bugs, security issues, and improvements')).toBeInTheDocument()
    expect(screen.getByText('Explain what this code does step by step')).toBeInTheDocument()
  })

  it('shows footer with keyboard shortcut hint', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    expect(screen.getByText(/Click a template to insert into the active terminal/)).toBeInTheDocument()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(<PromptTemplates onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<PromptTemplates onClose={onClose} />)
    // Find the close (x) button in the header
    const buttons = screen.getAllByRole('button')
    // The last button in the header row is the close button (after Add button)
    const closeButton = buttons.find(
      b => b.querySelector('.fa-xmark') && !b.closest('[class*="absolute"]')
    )
    expect(closeButton).toBeTruthy()
    fireEvent.click(closeButton!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop overlay is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<PromptTemplates onClose={onClose} />)
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn()
    render(<PromptTemplates onClose={onClose} />)
    fireEvent.click(screen.getByText('Prompt Templates'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('inserts template text into active terminal on click', () => {
    const onClose = vi.fn()
    render(<PromptTemplates onClose={onClose} />)
    fireEvent.click(screen.getByText('Fix Tests'))
    expect(mockWriteToTerminal).toHaveBeenCalledWith(
      'test-terminal-1',
      'Fix the failing tests and explain what was wrong'
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('shows alert when inserting with no active terminal', () => {
    mockActiveTerminalId = null
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const onClose = vi.fn()
    render(<PromptTemplates onClose={onClose} />)
    fireEvent.click(screen.getByText('Fix Tests'))
    expect(alertSpy).toHaveBeenCalledWith('No active terminal. Open a terminal first.')
    expect(mockWriteToTerminal).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('shows Add button and toggles add form', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    const addButton = screen.getByText('Add')
    expect(addButton).toBeInTheDocument()

    // Click Add to show the form
    fireEvent.click(addButton)
    expect(screen.getByPlaceholderText('Template name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Prompt text...')).toBeInTheDocument()
  })

  it('creates a new custom template via the add form', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Add'))

    const nameInput = screen.getByPlaceholderText('Template name')
    const textInput = screen.getByPlaceholderText('Prompt text...')

    fireEvent.change(nameInput, { target: { value: 'My Custom Prompt' } })
    fireEvent.change(textInput, { target: { value: 'Do something custom' } })

    const saveButton = screen.getByText('Save')
    fireEvent.click(saveButton)

    expect(mockAddPromptTemplate).toHaveBeenCalledTimes(1)
    const savedTemplate = mockAddPromptTemplate.mock.calls[0][0]
    expect(savedTemplate.name).toBe('My Custom Prompt')
    expect(savedTemplate.text).toBe('Do something custom')
    expect(savedTemplate.isCustom).toBe(true)
    expect(savedTemplate.icon).toBe('fa-solid fa-message')
    expect(savedTemplate.id).toBeDefined()
  })

  it('does not save template with empty name or text', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Add'))

    // Try to save with empty fields
    const saveButton = screen.getByText('Save')
    fireEvent.click(saveButton)
    expect(mockAddPromptTemplate).not.toHaveBeenCalled()

    // Fill only name
    const nameInput = screen.getByPlaceholderText('Template name')
    fireEvent.change(nameInput, { target: { value: 'Name Only' } })
    fireEvent.click(saveButton)
    expect(mockAddPromptTemplate).not.toHaveBeenCalled()
  })

  it('cancels add form without saving', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Add'))

    expect(screen.getByPlaceholderText('Template name')).toBeInTheDocument()

    const cancelButton = screen.getByText('Cancel')
    fireEvent.click(cancelButton)

    // Form should be hidden
    expect(screen.queryByPlaceholderText('Template name')).not.toBeInTheDocument()
    expect(mockAddPromptTemplate).not.toHaveBeenCalled()
  })

  it('shows delete button on custom templates and removes on click', () => {
    mockPromptTemplates = [
      { id: 'custom-1', name: 'My Custom', text: 'Custom text here', icon: 'fa-solid fa-message', isCustom: true },
    ]
    render(<PromptTemplates onClose={vi.fn()} />)

    // Custom template should be visible
    expect(screen.getByText('My Custom')).toBeInTheDocument()

    // Find the remove button (has title="Remove template")
    const removeButton = screen.getByTitle('Remove template')
    expect(removeButton).toBeInTheDocument()

    // Click remove - stopPropagation should prevent insert
    fireEvent.click(removeButton)
    expect(mockRemovePromptTemplate).toHaveBeenCalledWith('custom-1')
    // Should NOT have triggered insert
    expect(mockWriteToTerminal).not.toHaveBeenCalled()
  })

  it('does not show delete button on default templates', () => {
    mockPromptTemplates = []
    render(<PromptTemplates onClose={vi.fn()} />)
    // No remove buttons should exist for default templates
    expect(screen.queryByTitle('Remove template')).not.toBeInTheDocument()
  })

  it('shows both default and custom templates together', () => {
    mockPromptTemplates = [
      { id: 'custom-1', name: 'My Custom Prompt', text: 'Custom prompt text', icon: 'fa-solid fa-message', isCustom: true },
    ]
    render(<PromptTemplates onClose={vi.fn()} />)

    // Default templates
    expect(screen.getByText('Fix Tests')).toBeInTheDocument()
    expect(screen.getByText('Refactor')).toBeInTheDocument()

    // Custom template
    expect(screen.getByText('My Custom Prompt')).toBeInTheDocument()
  })

  it('submits add form via Enter key (form submit)', () => {
    render(<PromptTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Add'))

    const nameInput = screen.getByPlaceholderText('Template name')
    const textInput = screen.getByPlaceholderText('Prompt text...')

    fireEvent.change(nameInput, { target: { value: 'Enter Template' } })
    fireEvent.change(textInput, { target: { value: 'Submitted via enter' } })

    // Submit the form
    fireEvent.submit(nameInput.closest('form')!)

    expect(mockAddPromptTemplate).toHaveBeenCalledTimes(1)
    expect(mockAddPromptTemplate.mock.calls[0][0].name).toBe('Enter Template')
  })
})
