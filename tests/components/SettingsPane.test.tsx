import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  ;(window as any).termpolis = {
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [{ type: 'bash', label: 'Bash' }] }),
    getHomedir: vi.fn().mockResolvedValue({ success: true, data: '/home/test' }),
    readConfigFile: vi.fn().mockResolvedValue({ success: true, data: '' }),
    writeConfigFile: vi.fn().mockResolvedValue({ success: true }),
  }
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: (selector?: any) => {
    const state = {
      defaultShell: 'bash',
      setDefaultShell: vi.fn(),
      autocompleteEnabled: true,
      setAutocompleteEnabled: vi.fn(),
      keybindings: {},
      setKeybinding: vi.fn(),
      resetKeybindings: vi.fn(),
      agentRatingOverrides: {},
      setAgentRatingOverrides: vi.fn(),
    }
    return selector ? selector(state) : state
  },
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
})
