import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const mockSetDefaultShell = vi.fn()
const mockSetAutocompleteEnabled = vi.fn()
const mockSetAllowAppMouseControl = vi.fn()
const mockSetKeybinding = vi.fn()
const mockResetKeybindings = vi.fn()
const mockAddCustomKeybinding = vi.fn()
const mockUpdateCustomKeybinding = vi.fn()
const mockRemoveCustomKeybinding = vi.fn()
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
  ;(window as any).updater = {
    getStatus: vi.fn().mockResolvedValue({ status: 'idle' }),
    check: vi.fn().mockResolvedValue({ success: true }),
    quitAndInstall: vi.fn().mockResolvedValue({ success: true }),
    onState: vi.fn(() => () => {}),
  }
  ;(window as any).aiSecurity = {
    getStatus: vi.fn().mockResolvedValue({ success: true, data: { settings: { redactionEnabled: false, auditEnabled: false }, facts: [], auditPath: '/tmp/audit.jsonl' } }),
    setRedaction: vi.fn().mockResolvedValue({ success: true, data: { redactionEnabled: true, auditEnabled: false } }),
    setAudit: vi.fn().mockResolvedValue({ success: true, data: { redactionEnabled: false, auditEnabled: true } }),
    scan: vi.fn().mockResolvedValue({ success: true, data: { hitCount: 0, hits: [], redacted: '' } }),
    recentAudit: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clearAudit: vi.fn().mockResolvedValue({ success: true }),
    append: vi.fn().mockResolvedValue({ success: true }),
  }
})

// Helper: click a settings tab so its content renders.
function openTab(tabId: 'general' | 'security' | 'keybindings' | 'agents' | 'shell') {
  fireEvent.click(screen.getByTestId(`settings-tab-${tabId}`))
}

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
        allowAppMouseControl: false,
        setAllowAppMouseControl: mockSetAllowAppMouseControl,
        keybindings: {},
        customKeybindings: [],
        setKeybinding: mockSetKeybinding,
        resetKeybindings: mockResetKeybindings,
        addCustomKeybinding: mockAddCustomKeybinding,
        updateCustomKeybinding: mockUpdateCustomKeybinding,
        removeCustomKeybinding: mockRemoveCustomKeybinding,
        agentRatingOverrides: {},
        setAgentRatingOverrides: mockSetAgentRatingOverrides,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        defaultShell: 'bash',
        autocompleteEnabled: true,
        allowAppMouseControl: false,
        keybindings: {},
        customKeybindings: [],
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

  it('renders the Terminal Defaults section with theme, size, font, and folder-name controls', () => {
    render(<SettingsPane />)
    expect(screen.getByTestId('settings-terminal-defaults')).toBeInTheDocument()
    expect(screen.getByText('Terminal Defaults')).toBeInTheDocument()
    expect(screen.getByTestId('settings-default-font-size')).toBeInTheDocument()
    expect(screen.getByTestId('settings-default-font-family')).toBeInTheDocument()
    expect(screen.getByTestId('settings-agent-name-from-folder')).toBeInTheDocument()
  })

  it('persists default theme, font size, and font family changes', () => {
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-default-theme-light'))
    fireEvent.change(screen.getByTestId('settings-default-font-size'), { target: { value: '18' } })
    fireEvent.change(screen.getByTestId('settings-default-font-family'), {
      target: { value: 'JetBrains Mono, monospace' },
    })
    const saved = JSON.parse(localStorage.getItem('termpolis.terminal.defaults')!)
    expect(saved.theme).toBe('light')
    expect(saved.fontSize).toBe(18)
    expect(saved.fontFamily).toBe('JetBrains Mono, monospace')
    localStorage.removeItem('termpolis.terminal.defaults')
  })

  it('agent-name-from-folder checkbox is off by default and persists when toggled', () => {
    localStorage.removeItem('termpolis.terminal.agentNameFromFolder')
    render(<SettingsPane />)
    const box = screen.getByTestId('settings-agent-name-from-folder') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(localStorage.getItem('termpolis.terminal.agentNameFromFolder')).toBe('1')
    fireEvent.click(box)
    expect(localStorage.getItem('termpolis.terminal.agentNameFromFolder')).toBe('0')
    localStorage.removeItem('termpolis.terminal.agentNameFromFolder')
  })

  it('renders the Check for updates button', () => {
    render(<SettingsPane />)
    expect(screen.getByTestId('settings-check-updates')).toBeInTheDocument()
  })

  it('invokes updater.check when the button is clicked', async () => {
    const checkMock = (window as any).updater.check as ReturnType<typeof vi.fn>
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    await waitFor(() => expect(checkMock).toHaveBeenCalled())
  })

  it('reports "latest version" message when updater pushes not-available state', async () => {
    let cb: (s: any) => void = () => {}
    ;(window as any).updater.onState = vi.fn((fn: any) => { cb = fn; return () => {} })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    cb({ status: 'not-available' })
    await waitFor(() => {
      expect(screen.getByTestId('settings-update-status')).toHaveTextContent(/latest version/i)
    })
  })

  it('shows "ready — restart" message when an update is downloaded', async () => {
    let cb: (s: any) => void = () => {}
    ;(window as any).updater.onState = vi.fn((fn: any) => { cb = fn; return () => {} })
    render(<SettingsPane />)
    cb({ status: 'downloaded', version: '9.9.9' })
    await waitFor(() => {
      expect(screen.getByTestId('settings-update-status')).toHaveTextContent(/v9\.9\.9 ready/i)
    })
  })

  it('surfaces an error when the IPC check call fails', async () => {
    ;(window as any).updater.check = vi.fn().mockResolvedValue({ success: false, error: 'no internet' })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    await waitFor(() => {
      expect(screen.getByTestId('settings-update-status')).toHaveTextContent(/no internet/i)
    })
  })

  it('shows Default Shell section', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Default Shell')).toBeInTheDocument()
  })

  it('shows the terminal-behavior settings (app mouse control toggle)', () => {
    render(<SettingsPane />)
    expect(screen.getByText('Let terminal apps control the mouse')).toBeInTheDocument()
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

  it('toggles app mouse control on when its switch is clicked', () => {
    render(<SettingsPane />)
    const toggle = screen.getByLabelText('Toggle whether terminal apps may capture the mouse')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(mockSetAllowAppMouseControl).toHaveBeenCalledWith(true)
  })

  it('renders Monaco editor for config files', async () => {
    render(<SettingsPane />)
    openTab('shell')
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
  })

  it('renders Shell Config Files section', async () => {
    render(<SettingsPane />)
    openTab('shell')
    await waitFor(() => {
      expect(screen.getByText('Shell Config Files')).toBeInTheDocument()
    })
  })

  it('renders a Save button for config files', async () => {
    render(<SettingsPane />)
    openTab('shell')
    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument()
    })
  })

  it('calls writeConfigFile when Save is clicked', async () => {
    render(<SettingsPane />)
    openTab('shell')
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
    openTab('agents')
    expect(screen.getByText('Agent Capability Ratings')).toBeInTheDocument()
  })

  it('shows Keyboard Shortcuts heading', () => {
    render(<SettingsPane />)
    openTab('keybindings')
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
  })

  it('renders config file tabs after loading', async () => {
    render(<SettingsPane />)
    openTab('shell')
    await waitFor(() => {
      expect(screen.getByText('.bashrc')).toBeInTheDocument()
    })
  })

  it('switches active config file tab on click', async () => {
    render(<SettingsPane />)
    openTab('shell')
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
    openTab('shell')
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
    openTab('shell')
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
    openTab('shell')
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('monaco-change-new'))
    expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
  })

  it('shows Saved status after save completes', async () => {
    render(<SettingsPane />)
    openTab('shell')
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
    // No shell options should have been rendered from the detector. (Scope to the
    // shell dropdown — the Terminal Defaults font-family select has its own options.)
    const shellSelect = screen.getByText('Default Shell').parentElement!.querySelector('select')!
    expect(shellSelect.querySelectorAll('option').length).toBe(0)
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
    openTab('shell')
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor')).toBeInTheDocument()
    })
    // Editor value should have been set to '' from the ?? fallback
    ;(window as any).termpolis.readConfigFile = vi.fn().mockResolvedValue({ success: true, data: '# config content' })
  })

  it('renders all 5 settings tabs by default', () => {
    render(<SettingsPane />)
    expect(screen.getByTestId('settings-tab-general')).toBeInTheDocument()
    expect(screen.getByTestId('settings-tab-security')).toBeInTheDocument()
    expect(screen.getByTestId('settings-tab-keybindings')).toBeInTheDocument()
    expect(screen.getByTestId('settings-tab-agents')).toBeInTheDocument()
    expect(screen.getByTestId('settings-tab-shell')).toBeInTheDocument()
  })

  it('AI Security tab renders the security panel', async () => {
    render(<SettingsPane />)
    openTab('security')
    await waitFor(() => {
      expect(screen.getByTestId('security-settings')).toBeInTheDocument()
    })
  })

  it('switches to keybindings tab when termpolis:openShortcuts event fires (Ctrl+/ hotkey)', async () => {
    render(<SettingsPane />)
    // Default tab is 'general' — keybindings panel should not yet be the active one.
    expect(screen.getByTestId('settings-tab-general').className).toMatch(/border-\[#0078d4\]/)
    window.dispatchEvent(new CustomEvent('termpolis:openShortcuts'))
    await waitFor(() => {
      expect(screen.getByTestId('settings-tab-keybindings').className).toMatch(/border-\[#0078d4\]/)
    })
  })

  it('auto-primer toggle defaults ON and persists "0" when switched off', () => {
    localStorage.removeItem('termpolis.memory.autoPrimerOnLaunch')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-auto-primer-toggle')
    // default ON → first click turns it OFF
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.memory.autoPrimerOnLaunch')).toBe('0')
    // click again → back ON
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.memory.autoPrimerOnLaunch')).toBe('1')
    localStorage.removeItem('termpolis.memory.autoPrimerOnLaunch')
  })

  it('auto-primer toggle reflects a stored opt-out on mount', () => {
    localStorage.setItem('termpolis.memory.autoPrimerOnLaunch', '0')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-auto-primer-toggle')
    // stored OFF → first click turns it ON
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.memory.autoPrimerOnLaunch')).toBe('1')
    localStorage.removeItem('termpolis.memory.autoPrimerOnLaunch')
  })

  it('solo-learning toggle defaults ON and persists "0" when switched off', () => {
    localStorage.removeItem('termpolis.memory.learnFromSessions')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-solo-learning-toggle')
    // default ON → first click turns it OFF
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.memory.learnFromSessions')).toBe('0')
    // click again → back ON
    fireEvent.click(toggle)
    expect(localStorage.getItem('termpolis.memory.learnFromSessions')).toBe('1')
    localStorage.removeItem('termpolis.memory.learnFromSessions')
  })

  it('auto-reprime-on-compaction toggle defaults ON and persists "0" when switched off', () => {
    localStorage.removeItem('termpolis.memory.autoReprimeOnCompaction')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-auto-reprime-toggle')
    fireEvent.click(toggle) // default ON → OFF
    expect(localStorage.getItem('termpolis.memory.autoReprimeOnCompaction')).toBe('0')
    fireEvent.click(toggle) // back ON
    expect(localStorage.getItem('termpolis.memory.autoReprimeOnCompaction')).toBe('1')
    localStorage.removeItem('termpolis.memory.autoReprimeOnCompaction')
  })

  it('auto-reprime toggle reflects a stored opt-out on mount', () => {
    localStorage.setItem('termpolis.memory.autoReprimeOnCompaction', '0')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-auto-reprime-toggle')
    fireEvent.click(toggle) // stored OFF → ON
    expect(localStorage.getItem('termpolis.memory.autoReprimeOnCompaction')).toBe('1')
    localStorage.removeItem('termpolis.memory.autoReprimeOnCompaction')
  })

  it('auto-index toggle defaults ON and persists "0" when switched off', () => {
    localStorage.removeItem('termpolis.memory.autoIndexEverything')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-auto-index-toggle')
    fireEvent.click(toggle) // default ON → OFF
    expect(localStorage.getItem('termpolis.memory.autoIndexEverything')).toBe('0')
    fireEvent.click(toggle) // back ON
    expect(localStorage.getItem('termpolis.memory.autoIndexEverything')).toBe('1')
    localStorage.removeItem('termpolis.memory.autoIndexEverything')
  })

  it('auto-index toggle reflects a stored opt-out on mount', () => {
    localStorage.setItem('termpolis.memory.autoIndexEverything', '0')
    render(<SettingsPane />)
    const toggle = screen.getByTestId('settings-auto-index-toggle')
    fireEvent.click(toggle) // stored OFF → ON
    expect(localStorage.getItem('termpolis.memory.autoIndexEverything')).toBe('1')
    localStorage.removeItem('termpolis.memory.autoIndexEverything')
  })

  it('shows an "Open the Memory panel" link with the Ctrl+Shift+M hint', () => {
    render(<SettingsPane />)
    const link = screen.getByTestId('settings-open-memory-panel')
    expect(link).toBeInTheDocument()
    expect(link.parentElement?.textContent).toMatch(/Ctrl\+Shift\+M/)
  })

  it('dispatches termpolis:openMemory when the Memory panel link is clicked', () => {
    const onOpen = vi.fn()
    window.addEventListener('termpolis:openMemory', onOpen)
    try {
      render(<SettingsPane />)
      fireEvent.click(screen.getByTestId('settings-open-memory-panel'))
      expect(onOpen).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('termpolis:openMemory', onOpen)
    }
  })
})
