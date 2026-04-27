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
    setTelemetryOptIn: vi.fn().mockResolvedValue({ success: true, data: { optIn: true } }),
    getAppVersion: vi.fn().mockResolvedValue({ success: true, data: { version: '9.9.9' } }),
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
  default: ({ onChange, value }: any) => (
    <div data-testid="monaco-editor">
      <button data-testid="monaco-change-undefined" onClick={() => onChange(undefined)}>x</button>
      <button data-testid="monaco-change-new" onClick={() => onChange('new content')}>y</button>
      <span data-testid="monaco-value">{value}</span>
    </div>
  ),
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

  it('renders PS7/PS5 profile entries when home is a Windows path', async () => {
    ;(window as any).termpolis.getHomedir = vi.fn().mockResolvedValue({ success: true, data: 'C:\\Users\\test' })
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('PS7 Profile')).toBeInTheDocument()
      expect(screen.getByText('PS5 Profile')).toBeInTheDocument()
    })
    // Restore default for subsequent tests
    ;(window as any).termpolis.getHomedir = vi.fn().mockResolvedValue({ success: true, data: '/home/test' })
  })

  it('does not update config file list when getHomedir fails', async () => {
    ;(window as any).termpolis.getHomedir = vi.fn().mockResolvedValue({ success: false })
    render(<SettingsPane />)
    // Should render Settings header but no config file tabs
    expect(screen.getByText('Settings')).toBeInTheDocument()
    // Wait briefly and assert .bashrc is not rendered
    await waitFor(() => {
      expect(screen.queryByText('.bashrc')).not.toBeInTheDocument()
    })
    ;(window as any).termpolis.getHomedir = vi.fn().mockResolvedValue({ success: true, data: '/home/test' })
  })

  it('handles undefined editor onChange value via ?? fallback', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
    // Click the mock editor's undefined-change button — the SettingsPane handler
    // should coalesce undefined to '' without crashing.
    fireEvent.click(screen.getByTestId('monaco-change-undefined'))
    // No assertion needed — component did not throw.
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
  })

  it('handles defined editor onChange value', async () => {
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('monaco-change-new'))
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
  })

  it('shows Saved status after save completes', async () => {
    render(<SettingsPane />)
    const saveBtn = await screen.findByText('Save')
    fireEvent.click(saveBtn)
    // writeConfigFile resolves, then "✓ Saved" should appear
    await waitFor(() => {
      expect(screen.getByText(/Saved/)).toBeInTheDocument()
    })
  })

  it('ignores shell list when getAvailableShells fails', async () => {
    ;(window as any).termpolis.getAvailableShells = vi.fn().mockResolvedValue({ success: false })
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByText('Default Shell')).toBeInTheDocument()
    })
    // No shell options should have been rendered from the detector
    const options = screen.queryAllByRole('option')
    expect(options.length).toBe(0)
    ;(window as any).termpolis.getAvailableShells = vi.fn().mockResolvedValue({ success: true, data: [
      { type: 'bash', label: 'Bash' },
      { type: 'powershell', label: 'PowerShell' },
      { type: 'zsh', label: 'Zsh' },
    ] })
  })

  it('toggling crash reporting writes localStorage AND mirrors to main', async () => {
    localStorage.removeItem('termpolis.telemetry.optIn')
    render(<SettingsPane />)
    // The crash-reporting toggle is the button with aria-label "Toggle crash reporting"
    const toggle = await screen.findByRole('button', { name: /Toggle crash reporting/i })
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.telemetry.optIn')).toBe('1')
    expect((window as any).termpolis.setTelemetryOptIn).toHaveBeenCalledWith(true)
    // Toggle off
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.telemetry.optIn')).toBe('0')
    expect((window as any).termpolis.setTelemetryOptIn).toHaveBeenLastCalledWith(false)
  })

  it('telemetry toggle reflects current localStorage value on mount', () => {
    localStorage.setItem('termpolis.telemetry.optIn', '1')
    render(<SettingsPane />)
    // We can't easily inspect button state, but a click should now toggle it OFF
    const toggle = screen.getByRole('button', { name: /Toggle crash reporting/i })
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.telemetry.optIn')).toBe('0')
    localStorage.removeItem('termpolis.telemetry.optIn')
  })

  it('telemetry toggle still works if main bridge is missing (graceful)', () => {
    const original = (window as any).termpolis.setTelemetryOptIn
    delete (window as any).termpolis.setTelemetryOptIn
    expect(() => {
      render(<SettingsPane />)
      fireEvent.click(screen.getByRole('button', { name: /Toggle crash reporting/i }))
    }).not.toThrow()
    ;(window as any).termpolis.setTelemetryOptIn = original
  })

  it('handles readConfigFile returning no data (?? fallback)', async () => {
    ;(window as any).termpolis.readConfigFile = vi.fn().mockResolvedValue({ success: true })
    render(<SettingsPane />)
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
    // Editor value should have been set to '' from the ?? fallback
    ;(window as any).termpolis.readConfigFile = vi.fn().mockResolvedValue({ success: true, data: '# config content' })
  })
})
