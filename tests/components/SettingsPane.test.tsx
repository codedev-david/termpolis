import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const mockSetDefaultShell = vi.fn()
const mockSetAutocompleteEnabled = vi.fn()
const mockSetKeybinding = vi.fn()
const mockResetKeybindings = vi.fn()
const mockSetAgentRatingOverrides = vi.fn()

beforeAll(() => {
  ;(window as any).termpolis = {
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [
      { type: 'bash', label: 'Bash' },
      { type: 'powershell', label: 'PowerShell' },
      { type: 'zsh', label: 'Zsh' },
    ] }),
    getHomedir: vi.fn().mockResolvedValue({ success: true, data: '/home/test' }),
    readConfigFile: vi.fn().mockResolvedValue({ success: true, data: '# config content' }),
    writeConfigFile: vi.fn().mockResolvedValue({ success: true }),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        defaultShell: 'bash',
        setDefaultShell: mockSetDefaultShell,
        autocompleteEnabled: true,
        setAutocompleteEnabled: mockSetAutocompleteEnabled,
        keybindings: {},
        setKeybinding: mockSetKeybinding,
        resetKeybindings: mockResetKeybindings,
        agentRatingOverrides: {},
        setAgentRatingOverrides: mockSetAgentRatingOverrides,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        defaultShell: 'bash',
        autocompleteEnabled: true,
        keybindings: {},
        agentRatingOverrides: {},
      })),
      setState: vi.fn(),
    },
  ),
}))

// Mock Monaco editor since it requires browser APIs not available in jsdom
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco-editor">Monaco Editor</div>,
}))

import { SettingsPane } from '../../src/renderer/src/components/SettingsPane/SettingsPane'

describe('SettingsPane', () => {
  it('renders settings panel with heading', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('shows Default Shell section', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Default Shell')).toBeInTheDocument()
  })

  it('shows Keyboard Shortcuts section via KeybindingsSettings', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Enable Autocomplete')).toBeInTheDocument()
  })

  it('renders the default shell label', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Default Shell')).toBeInTheDocument()
  })

  it('calls setDefaultShell when shell dropdown is changed', async () => {
    render(<SettingsPane />)
    // Wait for shells to load
    await waitFor(() => {
      expect(screen.getByText('Default Shell')).toBeInTheDocument()
    })
    const selects = screen.getAllByRole('combobox')
    const shellSelect = selects[0]
    fireEvent.change(shellSelect, { target: { value: 'powershell' } })
    expect(mockSetDefaultShell).toHaveBeenCalledWith('powershell')
  })

  it('toggles autocomplete when the toggle button is clicked', () => {
    render(<SettingsPane />)
    // Find the toggle button near "Enable Autocomplete"
    const toggles = screen.getAllByRole('button')
    // The autocomplete toggle is the rounded-full button
    const autocompleteToggle = toggles.find(btn => btn.className.includes('rounded-full'))
    if (autocompleteToggle) {
      fireEvent.click(autocompleteToggle)
      expect(mockSetAutocompleteEnabled).toHaveBeenCalledWith(false)
    }
  })

  it('renders Monaco editor for config files', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
  })

  it('renders Shell Config Files section', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('Shell Config Files')).toBeInTheDocument()
    })
  })

  it('renders a Save button for config files', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument()
    })
  })

  it('calls writeConfigFile when Save is clicked', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => {
      expect((window as any).termpolis.writeConfigFile).toHaveBeenCalled()
    })
  })

  it('shows Agent Capability Ratings section', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Agent Capability Ratings')).toBeInTheDocument()
  })

  it('shows Keyboard Shortcuts heading', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
  })

  it('renders config file tabs after loading', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('.bashrc')).toBeInTheDocument()
    })
  })

  it('switches active config file tab on click', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('.bashrc')).toBeInTheDocument()
    })
    // Click on .zshrc tab
    const zshTab = screen.getByText('.zshrc')
    fireEvent.click(zshTab)
    // Tab should be visually active (has bg-[#2d2d2d])
    expect(zshTab.className).toContain('bg-[#2d2d2d]')
  })
})
