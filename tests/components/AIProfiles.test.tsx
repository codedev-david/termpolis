import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing component
vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: (ms: number) => 0,
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/user'),
}))

vi.mock('../../src/renderer/src/lib/terminalDefaults', () => ({
  TERMINAL_DEFAULTS: { fontSize: 14, theme: 'dark', fontFamily: 'monospace' },
}))

vi.mock('../../src/renderer/src/components/InstallHint/InstallHint', () => ({
  InstallHint: ({ agentId, agentName, onClose }: any) => (
    <div data-testid="install-hint">
      <span data-testid="install-hint-agent">{agentName}</span>
      <span data-testid="install-hint-id">{agentId}</span>
      <button onClick={onClose}>Close Hint</button>
    </div>
  ),
}))

const mockAddTerminal = vi.fn()
const mockSetLaunchingAgent = vi.fn()
const mockAddAIProfile = vi.fn()
const mockRemoveAIProfile = vi.fn()
let mockAiProfiles: any[] = []

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        aiProfiles: mockAiProfiles,
        addAIProfile: mockAddAIProfile,
        removeAIProfile: mockRemoveAIProfile,
        addTerminal: mockAddTerminal,
        setLaunchingAgent: mockSetLaunchingAgent,
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        aiProfiles: mockAiProfiles,
        addAIProfile: mockAddAIProfile,
        removeAIProfile: mockRemoveAIProfile,
        addTerminal: mockAddTerminal,
        setLaunchingAgent: mockSetLaunchingAgent,
      })),
      setState: vi.fn(),
    },
  ),
}))

let mockInstalledAgents: Record<string, boolean> = {}

beforeEach(() => {
  vi.clearAllMocks()
  mockAiProfiles = []
  mockInstalledAgents = { claude: true, codex: true, gemini: false, 'qwen-code': false }
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockImplementation(() =>
      Promise.resolve({ success: true, data: mockInstalledAgents })
    ),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
  }
})

import { AIProfiles } from '../../src/renderer/src/components/Sidebar/AIProfiles'

const defaultShells = [
  { type: 'bash' as const, label: 'Bash', executable: '/bin/bash' },
  { type: 'gitbash' as const, label: 'Git Bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe' },
]

describe('AIProfiles', () => {
  describe('rendering', () => {
    it('renders all four default AI agent profiles', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
      expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
      expect(screen.getByText('Qwen Code')).toBeInTheDocument()
    })

    it('renders custom profiles alongside defaults', async () => {
      mockAiProfiles = [
        { id: 'custom1', name: 'My Custom Agent', icon: 'fa-solid fa-star', command: 'my-agent', shell: 'bash', color: '#FF0000' },
      ]
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      expect(screen.getByText('My Custom Agent')).toBeInTheDocument()
    })

    it('shows AI Agents section header', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('AI Agents')).toBeInTheDocument()
    })

    it('shows + button to add custom profile', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByTitle('Add custom AI profile')).toBeInTheDocument()
    })
  })

  describe('installed/not-installed indicators', () => {
    it('shows green check icon for installed agents after detection', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        const checks = document.querySelectorAll('.fa-circle-check')
        expect(checks.length).toBe(2) // claude and codex
      })
    })

    it('shows red X icon for not-installed agents after detection', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        const xMarks = document.querySelectorAll('.fa-circle-xmark')
        expect(xMarks.length).toBe(2) // gemini, qwen-code
      })
    })

    it('shows all green checks when all agents installed', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true, 'qwen-code': true }
      ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
        success: true,
        data: mockInstalledAgents,
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        const checks = document.querySelectorAll('.fa-circle-check')
        expect(checks.length).toBe(4)
      })
      expect(document.querySelectorAll('.fa-circle-xmark').length).toBe(0)
    })

    it('does not show indicators while still detecting', async () => {
      // detectAgents never resolves during initial render check
      ;(window as any).termpolis.detectAgents = vi.fn().mockReturnValue(new Promise(() => {}))
      render(<AIProfiles availableShells={defaultShells} />)
      // No indicators shown while detecting
      expect(document.querySelectorAll('.fa-circle-check').length).toBe(0)
      expect(document.querySelectorAll('.fa-circle-xmark').length).toBe(0)
    })
  })

  describe('install hint interactions', () => {
    it('opens install hint when not-installed red X icon is clicked', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
      })
      const xButton = document.querySelector('.fa-circle-xmark')!.closest('button')!
      fireEvent.click(xButton)
      expect(screen.getByTestId('install-hint')).toBeInTheDocument()
    })

    it('opens install hint when clicking an uninstalled agent name', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Gemini CLI'))
      expect(screen.getByTestId('install-hint')).toBeInTheDocument()
      expect(screen.getByTestId('install-hint-agent')).toHaveTextContent('Gemini CLI')
    })

    it('closes install hint when close button is clicked', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Gemini CLI'))
      expect(screen.getByTestId('install-hint')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Close Hint'))
      expect(screen.queryByTestId('install-hint')).not.toBeInTheDocument()
    })
  })

  describe('launching agents', () => {
    it('clicking an installed agent calls pickDirectory and createTerminal', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
      })
      await waitFor(() => {
        expect((window as any).termpolis.createTerminal).toHaveBeenCalled()
      })
      expect(mockSetLaunchingAgent).toHaveBeenCalledWith('Claude Code')
      expect(mockAddTerminal).toHaveBeenCalled()
    })

    it('does not launch if pickDirectory is cancelled', async () => {
      ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: true, data: null })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
      })
      expect((window as any).termpolis.createTerminal).not.toHaveBeenCalled()
      expect(mockAddTerminal).not.toHaveBeenCalled()
    })

    it('does not launch if pickDirectory fails', async () => {
      ;(window as any).termpolis.pickDirectory = vi.fn().mockResolvedValue({ success: false })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect((window as any).termpolis.pickDirectory).toHaveBeenCalled()
      })
      expect((window as any).termpolis.createTerminal).not.toHaveBeenCalled()
    })

    it('shows alert when createTerminal fails', async () => {
      ;(window as any).termpolis.createTerminal = vi.fn().mockResolvedValue({ success: false, error: 'spawn failed' })
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('Failed to open terminal: spawn failed')
      })
      expect(mockSetLaunchingAgent).toHaveBeenCalledWith(null)
      alertSpy.mockRestore()
    })

    it('calls addTerminal with agentCommand on successful launch', async () => {
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      })
      fireEvent.click(screen.getByText('Claude Code'))
      await waitFor(() => {
        expect(mockAddTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Claude Code',
            agentCommand: 'claude',
          }),
        )
      })
    })
  })

  describe('collapse/expand', () => {
    it('collapses agent list when header is clicked', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      fireEvent.click(screen.getByText('AI Agents'))
      expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
    })

    it('re-expands agent list when header is clicked again', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByText('AI Agents'))
      expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('AI Agents'))
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
    })
  })

  describe('add custom profile modal', () => {
    it('opens add profile modal when + button is clicked', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      expect(screen.getByText('Add AI Profile')).toBeInTheDocument()
    })

    it('closes add profile modal on cancel', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      expect(screen.getByText('Add AI Profile')).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByText('Add AI Profile')).not.toBeInTheDocument()
    })

    it('adds custom profile via the modal form', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'My Agent' } })
      fireEvent.change(screen.getByPlaceholderText(/command/i), { target: { value: 'my-agent --flag' } })
      fireEvent.click(screen.getByText('Add'))
      expect(mockAddAIProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Agent',
          command: 'my-agent --flag',
          shell: 'bash',
        }),
      )
    })

    it('does not submit empty name/command', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Add custom AI profile'))
      // Submit without filling in
      fireEvent.click(screen.getByText('Add'))
      expect(mockAddAIProfile).not.toHaveBeenCalled()
    })
  })

  describe('additional branch coverage', () => {
    it('handles detectAgents rejection gracefully', async () => {
      ;(window as any).termpolis.detectAgents = vi.fn().mockRejectedValue(new Error('boom'))
      render(<AIProfiles availableShells={defaultShells} />)
      // Should still render without crashing
      await waitFor(() => {
        expect(screen.getByText('Claude Code')).toBeInTheDocument()
      })
    })

    it('auto-trusts codex by sending "1\\r" after launch (codex branch)', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true, 'qwen-code': true }
      ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
        success: true, data: mockInstalledAgents,
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBe(4)
      }, { timeout: 3000 })
      fireEvent.click(screen.getByText('OpenAI Codex'))
      await waitFor(() => {
        expect((window as any).termpolis.createTerminal).toHaveBeenCalled()
      })
      await waitFor(() => {
        const calls = (window as any).termpolis.writeToTerminal.mock.calls
        const hasCodexTrust = calls.some((c: any[]) => c[1] === '1\r')
        expect(hasCodexTrust).toBe(true)
      }, { timeout: 3000 })
    }, 10000)
  })

  describe('remove custom profile', () => {
    it('shows remove button on custom profiles', () => {
      mockAiProfiles = [
        { id: 'custom1', name: 'My Custom', icon: 'fa-solid fa-star', command: 'custom', shell: 'bash', color: '#FF0000' },
      ]
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByTitle('Remove profile')).toBeInTheDocument()
    })

    it('calls removeAIProfile when remove button is clicked', () => {
      mockAiProfiles = [
        { id: 'custom1', name: 'My Custom', icon: 'fa-solid fa-star', command: 'custom', shell: 'bash', color: '#FF0000' },
      ]
      render(<AIProfiles availableShells={defaultShells} />)
      fireEvent.click(screen.getByTitle('Remove profile'))
      expect(mockRemoveAIProfile).toHaveBeenCalledWith('custom1')
    })

    it('does not show remove button on default profiles', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.queryByTitle('Remove profile')).not.toBeInTheDocument()
    })
  })
})
