import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// Module-scope state
let mockTerminals: any[] = []
let mockViewMode = 'tabs'
let mockUserWorkflows: any[] = []
const mockRemoveTerminal = vi.fn()
const mockAddTerminal = vi.fn()
const mockSetPaneTree = vi.fn()
const mockSetActiveTerminal = vi.fn()
const mockToggleViewMode = vi.fn()
const mockAddUserWorkflow = vi.fn()
const mockUpdateUserWorkflow = vi.fn()
const mockRemoveUserWorkflow = vi.fn()

beforeAll(() => {
  ;(window as any).termpolis = {
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
  }
})

beforeEach(() => {
  mockTerminals = []
  mockViewMode = 'tabs'
  mockUserWorkflows = []
  mockRemoveTerminal.mockClear()
  mockAddTerminal.mockClear()
  mockSetPaneTree.mockClear()
  mockSetActiveTerminal.mockClear()
  mockToggleViewMode.mockClear()
  mockAddUserWorkflow.mockClear()
  mockUpdateUserWorkflow.mockClear()
  mockRemoveUserWorkflow.mockClear()
  vi.mocked((window as any).termpolis.killTerminal).mockClear()
  vi.mocked((window as any).termpolis.createTerminal).mockClear()
  vi.mocked((window as any).termpolis.writeToTerminal).mockClear()
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: mockTerminals,
        viewMode: mockViewMode,
        userWorkflows: mockUserWorkflows,
        removeTerminal: mockRemoveTerminal,
        addTerminal: mockAddTerminal,
        setPaneTree: mockSetPaneTree,
        setActiveTerminal: mockSetActiveTerminal,
        toggleViewMode: mockToggleViewMode,
        addUserWorkflow: mockAddUserWorkflow,
        updateUserWorkflow: mockUpdateUserWorkflow,
        removeUserWorkflow: mockRemoveUserWorkflow,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({ viewMode: mockViewMode })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/test'),
}))

import { WorkflowTemplates } from '../../src/renderer/src/components/WorkflowTemplates/WorkflowTemplates'

describe('WorkflowTemplates — list view', () => {
  it('renders workflow template list with heading', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
  })

  it('shows all built-in template names and descriptions', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Claude Code + Shell')).toBeInTheDocument()
    expect(screen.getByText('Claude Code on the left, shell on the right')).toBeInTheDocument()
    expect(screen.getByText('Full Stack Dev')).toBeInTheDocument()
    expect(screen.getByText('AI agent + frontend + backend + tests')).toBeInTheDocument()
    expect(screen.getByText('Code Review')).toBeInTheDocument()
    expect(screen.getByText('AI reviewer + git log + diff viewer')).toBeInTheDocument()
  })

  it('renders a Launch button for each built-in workflow', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    const launchButtons = screen.getAllByText('Launch')
    expect(launchButtons).toHaveLength(3)
  })

  it('shows terminal tags for each workflow', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('AI Agent')).toBeInTheDocument()
    expect(screen.getByText('Frontend')).toBeInTheDocument()
    expect(screen.getByText('Backend')).toBeInTheDocument()
    expect(screen.getByText('Tests')).toBeInTheDocument()
    expect(screen.getByText('AI Review')).toBeInTheDocument()
    expect(screen.getByText('Git')).toBeInTheDocument()
  })

  it('shows footer hint about closing terminals', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText(/Launching a workflow will close all current terminals/)).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close workflows'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop overlay is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<WorkflowTemplates onClose={onClose} />)
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)
    fireEvent.click(screen.getByText('Workflow Templates'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders a New Workflow button in the list', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('New Workflow')).toBeInTheDocument()
  })

  it('shows Custom badge for user-created workflows', () => {
    mockUserWorkflows = [{
      id: 'user-1', name: 'My Custom', description: 'mine',
      icon: 'fa-solid fa-bolt', layout: 'vertical',
      terminals: [{ name: 'Term', command: '', shell: 'bash', color: '#D97706' }],
      isCustom: true,
    }]
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('My Custom')).toBeInTheDocument()
    expect(screen.getByText('Custom')).toBeInTheDocument()
  })

  it('shows "No description" when user workflow description is empty', () => {
    mockUserWorkflows = [{
      id: 'user-1', name: 'Blank Desc', description: '',
      icon: 'fa-solid fa-bolt', layout: 'vertical',
      terminals: [{ name: 'T', command: '', shell: 'bash', color: '#D97706' }],
      isCustom: true,
    }]
    render(<WorkflowTemplates onClose={vi.fn()} />)
    expect(screen.getByText('No description')).toBeInTheDocument()
  })
})

describe('WorkflowTemplates — launch flow', () => {
  it('launches workflow: kills existing terminals and creates new ones', async () => {
    mockTerminals = [
      { id: 'existing-1', name: 'Old Terminal' },
      { id: 'existing-2', name: 'Old Terminal 2' },
    ]
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    fireEvent.click(screen.getAllByText('Launch')[0])

    await waitFor(() => {
      expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('existing-1')
      expect((window as any).termpolis.killTerminal).toHaveBeenCalledWith('existing-2')
      expect(mockRemoveTerminal).toHaveBeenCalledWith('existing-1')
      expect(mockRemoveTerminal).toHaveBeenCalledWith('existing-2')
    })

    await waitFor(() => {
      expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(2)
      expect(mockAddTerminal).toHaveBeenCalledTimes(2)
    })

    await waitFor(() => {
      expect(mockSetPaneTree).toHaveBeenCalledTimes(1)
      expect(mockSetActiveTerminal).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(mockToggleViewMode).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('does not toggle view mode if already in split mode', async () => {
    mockViewMode = 'split'
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    fireEvent.click(screen.getAllByText('Launch')[0])

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockToggleViewMode).not.toHaveBeenCalled()
  })

  it('launches Full Stack Dev workflow with 4 terminals', async () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    fireEvent.click(screen.getAllByText('Launch')[1])

    await waitFor(() => {
      expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(4)
      expect(mockAddTerminal).toHaveBeenCalledTimes(4)
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('skips addTerminal when createTerminal reports failure', async () => {
    vi.mocked((window as any).termpolis.createTerminal).mockResolvedValueOnce({ success: false })
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    fireEvent.click(screen.getAllByText('Launch')[0])

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // First terminal failed, so only 1 of 2 should be added
    expect(mockAddTerminal).toHaveBeenCalledTimes(1)
  })

  it('sends startup commands after 500ms for templates with commands', async () => {
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    fireEvent.click(screen.getAllByText('Launch')[0])

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    await waitFor(() => {
      expect((window as any).termpolis.writeToTerminal).toHaveBeenCalled()
    }, { timeout: 2000 })
  })

  it('launches a user-created workflow via stored list', async () => {
    mockUserWorkflows = [{
      id: 'user-run',
      name: 'My Workflow',
      description: 'Runs my thing',
      icon: 'fa-solid fa-bolt',
      layout: 'vertical',
      terminals: [{ name: 'T1', command: 'echo hi', shell: 'bash', color: '#D97706' }],
      isCustom: true,
    }]
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    const launches = screen.getAllByText('Launch')
    // Built-ins (3) + the 1 custom = 4 Launch buttons
    expect(launches).toHaveLength(4)
    fireEvent.click(launches[3])

    await waitFor(() => {
      expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(1)
      expect(mockAddTerminal).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('WorkflowTemplates — create / edit / delete', () => {
  it('opens the editor when New Workflow is clicked', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    expect(screen.getByText('New Workflow')).toBeInTheDocument() // header title
    expect(screen.getByPlaceholderText('My Workflow')).toBeInTheDocument()
    expect(screen.getByText('Create workflow')).toBeInTheDocument()
  })

  it('cannot save an empty workflow — Create button disabled', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    const createBtn = screen.getByText('Create workflow') as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)
  })

  it('creates a workflow with default single terminal', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))

    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'MyFlow' } })
    fireEvent.change(screen.getByPlaceholderText('What this workflow sets up'), { target: { value: 'Does stuff' } })

    const createBtn = screen.getByText('Create workflow') as HTMLButtonElement
    expect(createBtn.disabled).toBe(false)
    fireEvent.click(createBtn)

    expect(mockAddUserWorkflow).toHaveBeenCalledTimes(1)
    const saved = mockAddUserWorkflow.mock.calls[0][0]
    expect(saved.name).toBe('MyFlow')
    expect(saved.description).toBe('Does stuff')
    expect(saved.isCustom).toBe(true)
    expect(saved.terminals).toHaveLength(1)
    expect(saved.id).toMatch(/^user-/)
  })

  it('can add and remove terminals in editor', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))

    fireEvent.click(screen.getByText('+ Add terminal'))
    fireEvent.click(screen.getByText('+ Add terminal'))
    expect(screen.getByText(/Terminals \(3\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remove terminal 3'))
    expect(screen.getByText(/Terminals \(2\)/)).toBeInTheDocument()
  })

  it('remove-terminal button is disabled when only one terminal remains', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    const removeBtn = screen.getByLabelText('Remove terminal 1') as HTMLButtonElement
    expect(removeBtn.disabled).toBe(true)
  })

  it('caps terminal additions at 8', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))

    const addBtn = screen.getByText('+ Add terminal') as HTMLButtonElement
    for (let i = 0; i < 7; i++) fireEvent.click(addBtn)
    expect(screen.getByText(/Terminals \(8\)/)).toBeInTheDocument()
    expect(addBtn.disabled).toBe(true)
  })

  it('cancel button returns to list without saving', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'Abandoned' } })
    fireEvent.click(screen.getByText('Cancel'))

    expect(mockAddUserWorkflow).not.toHaveBeenCalled()
    expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
  })

  it('back arrow returns to list without saving', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.click(screen.getByLabelText('Back to workflow list'))

    expect(mockAddUserWorkflow).not.toHaveBeenCalled()
    expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
  })

  it('duplicates a built-in workflow into the editor', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    // Duplicate buttons are rendered on built-ins only
    const duplicates = screen.getAllByText(/Duplicate/)
    expect(duplicates.length).toBe(3)
    fireEvent.click(duplicates[0])

    const nameInput = screen.getByPlaceholderText('My Workflow') as HTMLInputElement
    expect(nameInput.value).toBe('Claude Code + Shell (copy)')
  })

  it('edits a user workflow and calls updateUserWorkflow', () => {
    mockUserWorkflows = [{
      id: 'user-edit-1',
      name: 'EditMe',
      description: 'desc',
      icon: 'fa-solid fa-bolt',
      layout: 'vertical',
      terminals: [{ name: 'T', command: '', shell: 'bash', color: '#D97706' }],
      isCustom: true,
    }]
    render(<WorkflowTemplates onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Edit EditMe'))
    const nameInput = screen.getByPlaceholderText('My Workflow') as HTMLInputElement
    expect(nameInput.value).toBe('EditMe')

    fireEvent.change(nameInput, { target: { value: 'EditedName' } })
    fireEvent.click(screen.getByText('Save changes'))

    expect(mockUpdateUserWorkflow).toHaveBeenCalledWith('user-edit-1', expect.objectContaining({
      name: 'EditedName',
      id: 'user-edit-1',
    }))
  })

  it('deletes a user workflow via the trash button', () => {
    mockUserWorkflows = [{
      id: 'user-del-1',
      name: 'DeleteMe',
      description: '',
      icon: 'fa-solid fa-bolt',
      layout: 'vertical',
      terminals: [{ name: 'T', command: '', shell: 'bash', color: '#D97706' }],
      isCustom: true,
    }]
    render(<WorkflowTemplates onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Delete DeleteMe'))
    expect(mockRemoveUserWorkflow).toHaveBeenCalledWith('user-del-1')
  })

  it('changes layout and terminal color in editor then saves', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))

    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'Q' } })

    // Layout dropdown
    const selects = screen.getAllByRole('combobox')
    // selects[1] = Layout select (first is icon)
    fireEvent.change(selects[1], { target: { value: 'quad' } })

    // Click a non-default color swatch on terminal 1
    fireEvent.click(screen.getByLabelText('Color #22D3EE'))

    fireEvent.click(screen.getByText('Create workflow'))

    const saved = mockAddUserWorkflow.mock.calls[0][0]
    expect(saved.layout).toBe('quad')
    expect(saved.terminals[0].color).toBe('#22D3EE')
  })

  it('trims whitespace in name on save', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: '   Trim Me   ' } })
    fireEvent.click(screen.getByText('Create workflow'))
    expect(mockAddUserWorkflow.mock.calls[0][0].name).toBe('Trim Me')
  })

  it('disables Create button when a terminal name is blank', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'ValidName' } })

    // Clear terminal name (first text input after the workflow-level ones is terminal name)
    // workflow inputs: name, description. Then per-terminal: name + command (command is 2nd terminal-level text input)
    // Simplest way: find by placeholder
    const termNames = screen.getAllByPlaceholderText('Terminal name')
    fireEvent.change(termNames[0], { target: { value: '' } })

    const createBtn = screen.getByText('Create workflow') as HTMLButtonElement
    expect(createBtn.disabled).toBe(true)
  })

  it('edits terminal command field', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'CmdTest' } })

    const cmdInputs = screen.getAllByPlaceholderText(/Startup command/)
    fireEvent.change(cmdInputs[0], { target: { value: 'npm run dev' } })

    fireEvent.click(screen.getByText('Create workflow'))
    expect(mockAddUserWorkflow.mock.calls[0][0].terminals[0].command).toBe('npm run dev')
  })

  it('changes terminal shell select', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'ShellTest' } })

    const selects = screen.getAllByRole('combobox')
    // selects: [0]=icon, [1]=layout, [2..]=per-terminal shell selects
    fireEvent.change(selects[2], { target: { value: 'powershell' } })

    fireEvent.click(screen.getByText('Create workflow'))
    expect(mockAddUserWorkflow.mock.calls[0][0].terminals[0].shell).toBe('powershell')
  })

  it('changes icon select', () => {
    render(<WorkflowTemplates onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'IconTest' } })

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'fa-solid fa-rocket' } })

    fireEvent.click(screen.getByText('Create workflow'))
    expect(mockAddUserWorkflow.mock.calls[0][0].icon).toBe('fa-solid fa-rocket')
  })

  it('cancels out of edit mode without saving changes', () => {
    mockUserWorkflows = [{
      id: 'user-edit-cancel',
      name: 'KeepMe',
      description: 'unchanged',
      icon: 'fa-solid fa-bolt',
      layout: 'vertical',
      terminals: [{ name: 'T', command: '', shell: 'bash', color: '#D97706' }],
      isCustom: true,
    }]
    render(<WorkflowTemplates onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Edit KeepMe'))
    fireEvent.change(screen.getByPlaceholderText('My Workflow'), { target: { value: 'ThrownAway' } })
    fireEvent.click(screen.getByText('Cancel'))

    expect(mockUpdateUserWorkflow).not.toHaveBeenCalled()
    expect(screen.getByText('Workflow Templates')).toBeInTheDocument()
  })

  it('launches a quad-layout workflow with 3 terminals via fallback split', async () => {
    mockUserWorkflows = [{
      id: 'user-quad-3',
      name: 'Triple Quad',
      description: 'quad with 3',
      icon: 'fa-solid fa-bolt',
      layout: 'quad',
      terminals: [
        { name: 'A', command: '', shell: 'bash', color: '#D97706' },
        { name: 'B', command: '', shell: 'bash', color: '#22D3EE' },
        { name: 'C', command: '', shell: 'bash', color: '#A5D6A7' },
      ],
      isCustom: true,
    }]
    const onClose = vi.fn()
    render(<WorkflowTemplates onClose={onClose} />)

    const launches = screen.getAllByText('Launch')
    fireEvent.click(launches[3])

    await waitFor(() => {
      expect((window as any).termpolis.createTerminal).toHaveBeenCalledTimes(3)
      expect(mockAddTerminal).toHaveBeenCalledTimes(3)
    })
    await waitFor(() => expect(mockSetPaneTree).toHaveBeenCalled())
    const tree = mockSetPaneTree.mock.calls[mockSetPaneTree.mock.calls.length - 1][0]
    expect(tree.type).toBe('split')
    expect(tree.direction).toBe('horizontal')
    expect(tree.children).toHaveLength(2)
  })
})
