import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing component
vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: (cmd: string) => cmd,
  testDelay: (ms: number) => ms,
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
      <button onClick={onClose}>Close Hint</button>
    </div>
  ),
}))

let mockInstalledAgents: Record<string, boolean> = {}
let mockDetectingAgents = false

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        aiProfiles: [],
        addAIProfile: vi.fn(),
        removeAIProfile: vi.fn(),
        addTerminal: vi.fn(),
        setLaunchingAgent: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        aiProfiles: [],
        addAIProfile: vi.fn(),
        removeAIProfile: vi.fn(),
        addTerminal: vi.fn(),
        setLaunchingAgent: vi.fn(),
      })),
      setState: vi.fn(),
    },
  ),
}))

beforeEach(() => {
  mockInstalledAgents = { claude: true, codex: true, gemini: false, 'aider-qwen': false }
  mockDetectingAgents = false
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockImplementation(() =>
      Promise.resolve({ success: true, data: mockInstalledAgents })
    ),
    pickDirectory: vi.fn().mockResolvedValue({ success: true, data: '/test/project' }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    getOllamaPath: vi.fn().mockResolvedValue({ success: true, data: null }),
  }
})

import { AIProfiles } from '../../src/renderer/src/components/Sidebar/AIProfiles'

const defaultShells = [
  { type: 'bash' as const, label: 'Bash', executable: '/bin/bash' },
]

describe('AIProfiles', () => {
  it('renders all default AI agent profiles', async () => {
    render(<AIProfiles availableShells={defaultShells} />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Aider + Qwen3')).toBeInTheDocument()
  })

  it('shows green check icon for installed agents', async () => {
    render(<AIProfiles availableShells={defaultShells} />)
    await waitFor(() => {
      const checks = document.querySelectorAll('.fa-circle-check')
      // Claude and Codex are installed
      expect(checks.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('shows red X icon for not-installed agents', async () => {
    render(<AIProfiles availableShells={defaultShells} />)
    await waitFor(() => {
      const xMarks = document.querySelectorAll('.fa-circle-xmark')
      // Gemini and Aider are not installed
      expect(xMarks.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('opens install hint when not-installed icon is clicked', async () => {
    render(<AIProfiles availableShells={defaultShells} />)
    await waitFor(() => {
      expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
    })
    // Click the first not-installed icon
    const xButton = document.querySelector('.fa-circle-xmark')!.closest('button')!
    fireEvent.click(xButton)
    expect(screen.getByTestId('install-hint')).toBeInTheDocument()
  })

  it('opens install hint when clicking an uninstalled agent name', async () => {
    render(<AIProfiles availableShells={defaultShells} />)
    await waitFor(() => {
      expect(document.querySelectorAll('.fa-circle-xmark').length).toBeGreaterThan(0)
    })
    // Click "Gemini CLI" — it's not installed so should show hint
    fireEvent.click(screen.getByText('Gemini CLI'))
    expect(screen.getByTestId('install-hint')).toBeInTheDocument()
    expect(screen.getByTestId('install-hint-agent')).toHaveTextContent('Gemini CLI')
  })

  it('does not show green Ollama dot next to Aider', async () => {
    // Even when Ollama responds as installed, no green dot should appear
    ;(window as any).termpolis.detectAgents = vi.fn().mockResolvedValue({
      success: true,
      data: { claude: true, codex: true, gemini: true, 'aider-qwen': true },
    })
    // Mock Ollama API as reachable
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as any
    render(<AIProfiles availableShells={defaultShells} />)
    await waitFor(() => {
      expect(document.querySelectorAll('.fa-circle-check').length).toBeGreaterThan(0)
    })
    // The old green dot had class "bg-green-400" with "rounded-full" and was 1.5x1.5
    const greenDots = document.querySelectorAll('.bg-green-400.rounded-full')
    expect(greenDots.length).toBe(0)
    globalThis.fetch = origFetch
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
