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
  mockInstalledAgents = { claude: true, codex: true, gemini: false, 'aider-qwen': false }
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockImplementation(() =>
      Promise.resolve({ success: true, data: mockInstalledAgents })
    ),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    getOllamaPath: vi.fn().mockResolvedValue({ success: true, data: null }),
  }
  // Mock fetch for Ollama API check (default: not reachable)
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('not reachable')) as any
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
      expect(screen.getByText('Aider + Qwen3')).toBeInTheDocument()
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

    it('shows FREE badge on Aider + Qwen3', () => {
      render(<AIProfiles availableShells={defaultShells} />)
      expect(screen.getByText('FREE')).toBeInTheDocument()
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
        expect(xMarks.length).toBe(2) // gemini and aider-qwen
      })
    })

    it('shows all green checks when all agents installed', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true, 'aider-qwen': true }
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

  describe('Ollama path detection for Aider', () => {
    it('fetches Ollama path when launching Aider + Qwen3', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true, 'aider-qwen': true }
      ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
        success: true,
        data: mockInstalledAgents,
      })
      // Mock Ollama as reachable so aider-qwen doesn't show ollama hint
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve({ ok: true })) as any
      ;(window as any).termpolis.getOllamaPath = vi.fn().mockResolvedValue({
        success: true,
        data: '/usr/local/bin',
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBe(4)
      }, { timeout: 3000 })
      fireEvent.click(screen.getByText('Aider + Qwen3'))
      await waitFor(() => {
        expect((window as any).termpolis.getOllamaPath).toHaveBeenCalled()
      }, { timeout: 3000 })
      await waitFor(() => {
        expect((window as any).termpolis.createTerminal).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          '/test/project',
          ['/usr/local/bin'],
        )
      }, { timeout: 3000 })
    }, 10000)

    it('does not pass extraPaths when getOllamaPath returns default', async () => {
      mockInstalledAgents = { claude: true, codex: true, gemini: true, 'aider-qwen': true }
      ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
        success: true,
        data: mockInstalledAgents,
      })
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve({ ok: true })) as any
      ;(window as any).termpolis.getOllamaPath = vi.fn().mockResolvedValue({
        success: true,
        data: 'ollama', // default — means it's on PATH already
      })
      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBe(4)
      }, { timeout: 3000 })
      fireEvent.click(screen.getByText('Aider + Qwen3'))
      await waitFor(() => {
        expect((window as any).termpolis.createTerminal).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          '/test/project',
          undefined,
        )
      }, { timeout: 3000 })
    }, 10000)

    it('shows Ollama hint when Ollama is not installed and Aider is clicked', async () => {
      // aider-qwen is installed but Ollama is not reachable
      mockInstalledAgents = { claude: true, codex: true, gemini: false, 'aider-qwen': true }
      ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
        success: true,
        data: mockInstalledAgents,
      })
      // Ollama not reachable — fetch rejects immediately
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.reject(new Error('not reachable'))) as any

      render(<AIProfiles availableShells={defaultShells} />)
      await waitFor(() => {
        expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
      }, { timeout: 3000 })
      fireEvent.click(screen.getByText('Aider + Qwen3'))
      await waitFor(() => {
        expect(screen.getByText('Free AI Coding with Qwen3-Coder')).toBeInTheDocument()
      }, { timeout: 3000 })
    }, 10000)
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
