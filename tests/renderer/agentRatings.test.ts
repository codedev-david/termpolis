import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_AGENT_CAPABILITIES,
  getEffectiveCapabilities,
  getAgentCapability,
  STRENGTH_CATEGORIES,
  type AgentRatingOverrides,
} from '../../src/renderer/src/lib/agentCapabilities'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'

// ═══════════════════════════════════════════════════════
// getEffectiveCapabilities
// ═══════════════════════════════════════════════════════

describe('getEffectiveCapabilities', () => {
  it('returns defaults when overrides is undefined', () => {
    const result = getEffectiveCapabilities(undefined)
    expect(result).toBe(DEFAULT_AGENT_CAPABILITIES)
  })

  it('returns defaults when overrides is empty', () => {
    const result = getEffectiveCapabilities({})
    // Empty overrides — each agent should match default strengths
    for (const agent of result) {
      const def = DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === agent.agentId)!
      expect(agent.strengths).toEqual(def.strengths)
    }
  })

  it('merges a single category override for one agent', () => {
    const overrides: AgentRatingOverrides = {
      claude: { refactoring: 2 },
    }
    const result = getEffectiveCapabilities(overrides)
    const claude = result.find(a => a.agentId === 'claude')!
    expect(claude.strengths.refactoring).toBe(2)
    // Other categories remain default
    expect(claude.strengths.architecture).toBe(5)
    expect(claude.strengths.testing).toBe(4)
  })

  it('merges multiple category overrides for one agent', () => {
    const overrides: AgentRatingOverrides = {
      codex: { testing: 2, debugging: 1, frontend: 5 },
    }
    const result = getEffectiveCapabilities(overrides)
    const codex = result.find(a => a.agentId === 'codex')!
    expect(codex.strengths.testing).toBe(2)
    expect(codex.strengths.debugging).toBe(1)
    expect(codex.strengths.frontend).toBe(5)
    // Unchanged categories
    expect(codex.strengths.refactoring).toBe(4)
  })

  it('merges overrides for multiple agents simultaneously', () => {
    const overrides: AgentRatingOverrides = {
      claude: { refactoring: 1 },
      gemini: { documentation: 1 },
    }
    const result = getEffectiveCapabilities(overrides)
    expect(result.find(a => a.agentId === 'claude')!.strengths.refactoring).toBe(1)
    expect(result.find(a => a.agentId === 'gemini')!.strengths.documentation).toBe(1)
    // Unmodified agents stay default
    expect(result.find(a => a.agentId === 'codex')!.strengths).toEqual(
      DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === 'codex')!.strengths
    )
  })

  it('does not mutate the original DEFAULT_AGENT_CAPABILITIES', () => {
    const originalClaudeRefactoring = DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === 'claude')!.strengths.refactoring
    getEffectiveCapabilities({ claude: { refactoring: 1 } })
    expect(DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === 'claude')!.strengths.refactoring).toBe(originalClaudeRefactoring)
  })

  it('preserves non-strength fields (tokenCost, hasMcp, agentName)', () => {
    const overrides: AgentRatingOverrides = {
      gemini: { bulkTasks: 1 },
    }
    const result = getEffectiveCapabilities(overrides)
    const gemini = result.find(a => a.agentId === 'gemini')!
    expect(gemini.tokenCost).toBe('low')
    expect(gemini.hasMcp).toBe(true)
    expect(gemini.agentName).toBe('Gemini CLI')
  })

  it('ignores overrides for non-existent agent IDs', () => {
    const overrides: AgentRatingOverrides = {
      'nonexistent-agent': { refactoring: 5 },
    }
    const result = getEffectiveCapabilities(overrides)
    // Should still return 3 agents, unchanged
    expect(result.length).toBe(3)
    for (const agent of result) {
      const def = DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === agent.agentId)!
      expect(agent.strengths).toEqual(def.strengths)
    }
  })
})

// ═══════════════════════════════════════════════════════
// getAgentCapability
// ═══════════════════════════════════════════════════════

describe('getAgentCapability', () => {
  it('returns the agent with overrides applied', () => {
    const result = getAgentCapability('claude', { claude: { testing: 1 } })
    expect(result!.strengths.testing).toBe(1)
    expect(result!.strengths.refactoring).toBe(5) // unchanged
  })

  it('returns undefined for unknown agent ID', () => {
    expect(getAgentCapability('fake-agent')).toBeUndefined()
  })

  it('returns default when no overrides provided', () => {
    const result = getAgentCapability('claude')
    const def = DEFAULT_AGENT_CAPABILITIES.find(a => a.agentId === 'claude')!
    expect(result!.strengths).toEqual(def.strengths)
  })
})

// ═══════════════════════════════════════════════════════
// buildConductorPrompt with overrides
// ═══════════════════════════════════════════════════════

describe('buildConductorPrompt with agentRatingOverrides', () => {
  const allInstalled = { claude: true, codex: true, gemini: true }

  it('reflects overridden ratings in the conductor prompt', () => {
    const overrides: AgentRatingOverrides = {
      claude: { refactoring: 1 },
    }
    const prompt = buildConductorPrompt({
      taskDescription: 'Refactor the auth module',
      installedAgents: allInstalled,
      projectCwd: '/home/user/project',
      agentRatingOverrides: overrides,
    })
    // Prompt only shows strengths >= 4, so refactoring at 1 should be excluded
    // Extract Claude's line from the prompt
    const claudeLine = prompt.split('\n').find(l => l.includes('Claude Code'))!
    expect(claudeLine).not.toContain('Refactoring')
    // Other Claude ratings should remain default
    expect(prompt).toContain('Architecture (5/5)')
  })

  it('shows boosted ratings in the conductor prompt', () => {
    const overrides: AgentRatingOverrides = {
      codex: { architecture: 5 },
    }
    const prompt = buildConductorPrompt({
      taskDescription: 'Refactor the auth module',
      installedAgents: allInstalled,
      projectCwd: '/home/user/project',
      agentRatingOverrides: overrides,
    })
    // OpenAI Codex normally has architecture 3 (below threshold), but boosted to 5 it should appear
    const codexLine = prompt.split('\n').find(l => l.includes('OpenAI Codex'))!
    expect(codexLine).toContain('Architecture (5/5)')
  })

  it('without overrides, shows default ratings', () => {
    const prompt = buildConductorPrompt({
      taskDescription: 'Refactor the auth module',
      installedAgents: allInstalled,
      projectCwd: '/home/user/project',
    })
    expect(prompt).toContain('Refactoring (5/5)')
  })

  it('overrides for uninstalled agents do not appear in prompt', () => {
    const overrides: AgentRatingOverrides = {
      gemini: { devops: 1 },
    }
    const prompt = buildConductorPrompt({
      taskDescription: 'Set up CI/CD',
      installedAgents: { claude: true, codex: false, gemini: false },
      projectCwd: '/home/user/project',
      agentRatingOverrides: overrides,
    })
    const agentsSection = prompt.split('INSTALLED AGENTS:')[1].split('YOUR MCP TOOLS:')[0]
    expect(agentsSection).not.toContain('Gemini CLI')
    expect(agentsSection).not.toContain('DevOps (1/5)')
  })
})

// ═══════════════════════════════════════════════════════
// Store — agentRatingOverrides
// ═══════════════════════════════════════════════════════

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid-ratings') }))

import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'

describe('terminalStore agentRatingOverrides', () => {
  const initialState = useTerminalStore.getState()

  beforeEach(() => {
    useTerminalStore.setState({ ...initialState }, true)
  })

  it('starts with empty overrides', () => {
    const overrides = useTerminalStore.getState().agentRatingOverrides
    expect(overrides).toEqual({})
  })

  it('setAgentRatingOverrides updates the store', () => {
    const newOverrides: AgentRatingOverrides = { claude: { refactoring: 2 } }
    useTerminalStore.getState().setAgentRatingOverrides(newOverrides)
    expect(useTerminalStore.getState().agentRatingOverrides).toEqual(newOverrides)
  })

  it('setAgentRatingOverrides replaces all overrides (not merge)', () => {
    useTerminalStore.getState().setAgentRatingOverrides({ claude: { refactoring: 2 } })
    useTerminalStore.getState().setAgentRatingOverrides({ codex: { testing: 1 } })
    const overrides = useTerminalStore.getState().agentRatingOverrides
    // Should only have codex, not claude
    expect(overrides).toEqual({ codex: { testing: 1 } })
  })

  it('reset to empty object clears all overrides', () => {
    useTerminalStore.getState().setAgentRatingOverrides({ claude: { refactoring: 2 } })
    useTerminalStore.getState().setAgentRatingOverrides({})
    expect(useTerminalStore.getState().agentRatingOverrides).toEqual({})
  })
})
