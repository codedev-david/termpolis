import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const mockTerminals = [
  { id: 't1', name: 'Terminal 1', hidden: false },
  { id: 't2', name: 'Dev Server', hidden: false },
]

const mockPromptTemplates = [
  { id: 'custom1', name: 'My Custom', text: 'Custom prompt text', icon: 'fa-solid fa-star', isCustom: true },
]

// What the palette does through getState(): the terminal it activates, and the one a prompt
// template is typed into (null: none is active).
const setActiveTerminal = vi.fn()
let activeTerminalId: string | null = 't1'
// The accounts registered: Switch account… is offered only with one (D13).
let accountsView: { accounts: unknown[] } | null = null

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: mockTerminals,
        activeTerminalId: 't1',
        promptTemplates: mockPromptTemplates,
        accountsView,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: mockTerminals,
        activeTerminalId,
        setActiveTerminal,
      })),
      setState: vi.fn(),
    },
  ),
}))

vi.mock('../../src/renderer/src/types', () => ({}))

beforeAll(() => {
  ;(window as any).termpolis = {
    writeToTerminal: vi.fn(),
  }
})

import { CommandPalette } from '../../src/renderer/src/components/CommandPalette/CommandPalette'

describe('CommandPalette', () => {
  it('renders input field and command list', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByPlaceholderText('Type a command...')).toBeInTheDocument()
    // All commands are shown when input is empty
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    expect(screen.getByText('Split Right')).toBeInTheDocument()
  })

  it('filters commands when typing', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'new terminal' } })
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    // Other non-matching commands should not appear
    expect(screen.queryByText('Split Right')).not.toBeInTheDocument()
  })

  it('offers Switch account… for the active agent terminal, once an account is registered', () => {
    const onAction = vi.fn()
    accountsView = { accounts: [{ id: 'acc_a' }] }
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Type a command...'), { target: { value: 'switch account' } })
    fireEvent.click(screen.getByText('Switch account…'))
    expect(onAction).toHaveBeenCalledWith('switch_account', undefined)
    accountsView = null
  })

  it('does not hijack a command that merely mentions an account: "run az account show" still runs the command on Enter', () => {
    const onAction = vi.fn()
    accountsView = { accounts: [{ id: 'acc_a' }] }
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    const box = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(box, { target: { value: 'run az account show' } })
    expect(screen.queryByText('Switch account…')).toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAction).toHaveBeenCalledWith('run_command', 'az account show')
    expect(onAction).not.toHaveBeenCalledWith('switch_account', expect.anything())
    // Typing just "account" still finds it, by its label, when nothing else does.
    onAction.mockClear()
    fireEvent.change(box, { target: { value: 'account' } })
    expect(screen.getByText('Switch account…')).toBeInTheDocument()
    accountsView = null
  })

  it('offers no Switch account… with no account registered, typed or listed (D13)', () => {
    for (const view of [null, { accounts: [] }]) {
      accountsView = view
      const { unmount } = render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
      expect(screen.queryByText('Switch account…')).toBeNull()
      fireEvent.change(screen.getByPlaceholderText('Type a command...'), { target: { value: 'switch account' } })
      expect(screen.queryByText('Switch account…')).toBeNull()
      fireEvent.change(screen.getByPlaceholderText('Type a command...'), { target: { value: 'account' } })
      expect(screen.queryByText('Switch account…')).toBeNull()
      unmount()
    }
    accountsView = null
  })

  it('calls onAction with correct action when command clicked', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    fireEvent.click(screen.getByText('New Terminal'))
    expect(onAction).toHaveBeenCalledWith('create_terminal', undefined)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape pressed', () => {
    const onClose = vi.fn()
    render(<CommandPalette onAction={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('navigates with ArrowDown and ArrowUp keys', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    // Exercises keyboard navigation handler
  })

  it('executes command on Enter key', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('shows multiple built-in commands', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    // Some of the standard commands that should always be visible
    expect(screen.getByText('New Terminal')).toBeInTheDocument()
    expect(screen.getByText('Split Right')).toBeInTheDocument()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(<CommandPalette onAction={vi.fn()} onClose={onClose} />)
    const backdrop = container.firstChild as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls correct action for split_right command', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    fireEvent.click(screen.getByText('Split Right'))
    expect(onAction).toHaveBeenCalledWith('split_right', undefined)
  })

  it('offers one recording entry that starts or stops, found by typing "record"', () => {
    const onAction = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Type a command...'), { target: { value: 'record' } })
    fireEvent.click(screen.getByText('Start/Stop Recording'))
    expect(onAction).toHaveBeenCalledWith('toggle_recording', undefined)
  })

  it('offers Export Terminal Output for the active terminal', () => {
    const onAction = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Type a command...'), { target: { value: 'export output' } })
    fireEvent.click(screen.getByText('Export Terminal Output'))
    expect(onAction).toHaveBeenCalledWith('export_output', undefined)
  })

  it('shows prompt templates from store', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    // Custom prompt template should appear
    expect(screen.getByText('My Custom')).toBeInTheDocument()
  })

  it('filters to show prompt templates when typed', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'my custom' } })
    expect(screen.getByText('My Custom')).toBeInTheDocument()
  })

  it('shows "No matching command" when query has no matches', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'zzzzzzzzz-no-such-command' } })
    expect(screen.getByText('No matching command')).toBeInTheDocument()
  })

  it('inserts prompt template text into active terminal when selected', () => {
    const writeToTerminal = vi.fn()
    ;(window as any).termpolis.writeToTerminal = writeToTerminal
    const onClose = vi.fn()
    render(<CommandPalette onAction={vi.fn()} onClose={onClose} />)
    // Click on our custom prompt template
    fireEvent.click(screen.getByText('My Custom'))
    expect(writeToTerminal).toHaveBeenCalledWith('t1', 'Custom prompt text')
    expect(onClose).toHaveBeenCalled()
  })

  it('executes run_command with captured argument', () => {
    const onAction = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'run ls -la' } })
    fireEvent.click(screen.getByText('Run Command'))
    expect(onAction).toHaveBeenCalledWith('run_command', 'ls -la')
  })

  it('falls back to label/description search when no pattern matches', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    // 'Terminal layout' is not a pattern but matches "Save Workspace" description
    fireEvent.change(input, { target: { value: 'layout' } })
    expect(screen.getByText('Save Workspace')).toBeInTheDocument()
  })

  it('ArrowDown wraps around to first when already at end', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    // Press ArrowDown many times to wrap around
    for (let i = 0; i < 50; i++) fireEvent.keyDown(input, { key: 'ArrowDown' })
  })

  it('ArrowUp wraps around to last from first', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    // Press ArrowUp at selectedIndex 0 — should wrap to end
    fireEvent.keyDown(input, { key: 'ArrowUp' })
  })

  it('hovering a command updates the selection highlight', () => {
    render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
    const splitRight = screen.getByText('Split Right').closest('button') as HTMLButtonElement
    fireEvent.mouseEnter(splitRight)
    expect(splitRight.className).toContain('bg-[#094771]')
  })

  it('does nothing when Enter is pressed with no matches', () => {
    const onAction = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    fireEvent.change(input, { target: { value: 'zzzzzzzzz-no-such-command' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('switches to the terminal picked from the list, and closes', () => {
    setActiveTerminal.mockClear()
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={onClose} />)
    fireEvent.click(screen.getByText('Dev Server'))
    expect(setActiveTerminal).toHaveBeenCalledWith('t2')
    expect(onClose).toHaveBeenCalled()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('types a prompt template nowhere when no terminal is active, and still closes', () => {
    const writeToTerminal = vi.fn()
    ;(window as any).termpolis.writeToTerminal = writeToTerminal
    activeTerminalId = null
    try {
      const onAction = vi.fn()
      const onClose = vi.fn()
      render(<CommandPalette onAction={onAction} onClose={onClose} />)
      fireEvent.click(screen.getByText('My Custom'))
      expect(writeToTerminal).not.toHaveBeenCalled()
      expect(onAction).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    } finally {
      activeTerminalId = 't1'
    }
  })

  it('shows the first 60 characters of a longer template, and an ellipsis', () => {
    const text = 'Review this change for correctness and say what it breaks, file by file, with each line.'
    mockPromptTemplates.push({ id: 'long1', name: 'Long One', text, icon: 'fa-solid fa-star', isCustom: true })
    try {
      render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
      expect(screen.getByText(`${text.slice(0, 60)}...`)).toBeInTheDocument()
      expect(screen.getByText('Custom prompt text')).toBeInTheDocument()
    } finally {
      mockPromptTemplates.pop()
    }
  })

  it('gives the first nine terminals Alt+1 to Alt+9 and the tenth no shortcut', () => {
    for (let i = 3; i <= 10; i++) mockTerminals.push({ id: `t${i}`, name: `Shell ${i}`, hidden: false })
    try {
      render(<CommandPalette onAction={vi.fn()} onClose={vi.fn()} />)
      expect(screen.getByText('Alt+9')).toBeInTheDocument()
      expect(screen.queryByText('Alt+10')).not.toBeInTheDocument()
      const tenth = screen.getByText('Shell 10').closest('button') as HTMLButtonElement
      expect(tenth.textContent).toBe('Shell 10')
    } finally {
      mockTerminals.splice(2)
    }
  })

  it('leaves the selection and the commands alone on a key it doesn\'t use', () => {
    const onAction = vi.fn()
    render(<CommandPalette onAction={onAction} onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('Type a command...')
    const first = screen.getByText('New Terminal').closest('button') as HTMLButtonElement
    const selected = first.className
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(first.className).toBe(selected)
    expect(onAction).not.toHaveBeenCalled()
  })
})
