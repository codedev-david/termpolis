import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  ;(window as any).termpolis = {
    detectAgents: vi.fn().mockResolvedValue({ success: true, data: { claude: true, codex: true, gemini: true, 'aider-qwen': true } }),
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [{ type: 'bash', label: 'Bash' }] }),
    getOllamaPath: vi.fn().mockResolvedValue({ success: true, data: null }),
    createTerminal: vi.fn().mockResolvedValue({ success: true }),
    writeToTerminal: vi.fn(),
    killTerminal: vi.fn().mockResolvedValue({ success: true }),
  }
  ;(window as any).swarmAPI = {
    getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    createTask: vi.fn().mockResolvedValue({ success: true }),
    clear: vi.fn().mockResolvedValue({ success: true }),
  }
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: any) => {
      const state = {
        terminals: [],
        addTerminal: vi.fn(),
        setPaneTree: vi.fn(),
        setSwarmActive: vi.fn(),
        setSwarmAgents: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: vi.fn(() => ({
        terminals: [],
        viewMode: 'tabs',
      })),
      setState: vi.fn(),
    },
  ),
  buildPaneTree: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/swarmBridgeManager', () => ({
  startBridgeForAgent: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/homedir', () => ({
  getHomedir: vi.fn().mockResolvedValue('/home/test'),
}))

vi.mock('../../src/renderer/src/lib/testAgents', () => ({
  resolveAgentCommand: vi.fn((cmd: string) => cmd),
  testDelay: vi.fn((ms: number) => 0),
}))

import { StartSwarmModal } from '../../src/renderer/src/components/SwarmDashboard/StartSwarmModal'

describe('StartSwarmModal', () => {
  it('renders agent selection grid with 4 agents', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    // Wait for agent detection to finish
    await screen.findByText('Claude Code')
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument()
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    expect(screen.getByText('Aider + Qwen3')).toBeInTheDocument()
  })

  it('shows 4 agent options', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await screen.findByText('Claude Code')
    // Each agent shows its command
    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(screen.getByText('codex')).toBeInTheDocument()
    expect(screen.getByText('gemini')).toBeInTheDocument()
    expect(screen.getByText('aider --model ollama/qwen3-coder --no-show-model-warnings')).toBeInTheDocument()
  })

  it('has Next button disabled initially (need 2+ agents)', async () => {
    render(<StartSwarmModal onClose={vi.fn()} onLaunched={vi.fn()} />)
    await screen.findByText('Claude Code')
    const nextButton = screen.getByText('Next')
    expect(nextButton).toBeDisabled()
  })
})
