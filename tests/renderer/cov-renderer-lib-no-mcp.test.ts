// Covers the FALSE arm of conductorPrompt's `a.hasMcp ? 'Has MCP' : 'No MCP
// (use swarm bridge)'` roster line.
//
// Every agent in the shipped capability matrix has hasMcp: true, and
// getEffectiveCapabilities() only merges STRENGTH overrides — there is no option
// on buildConductorPrompt that can flip hasMcp. So the capability module is
// mocked with a roster that contains one bridged (no-MCP) agent and one native
// one, which pins both arms of the line side by side.
//
// vi.mock is hoisted and file-scoped: keeping it here means conductorPrompt.test.ts
// continues to exercise the real DEFAULT_AGENT_CAPABILITIES roster.
import { describe, it, expect, vi } from 'vitest'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'

vi.mock('../../src/renderer/src/lib/agentCapabilities', () => ({
  CATEGORY_LABELS: {
    refactoring: 'Refactoring',
    testing: 'Testing',
    devops: 'DevOps',
  },
  getEffectiveCapabilities: () => [
    {
      agentId: 'bridged',
      agentName: 'Bridged Agent',
      strengths: { refactoring: 5, testing: 2, devops: 4 },
      tokenCost: 'high',
      hasMcp: false,
    },
    {
      agentId: 'native',
      agentName: 'Native Agent',
      strengths: { refactoring: 4, testing: 1, devops: 2 },
      tokenCost: 'low',
      hasMcp: true,
    },
  ],
}))

const build = (installedAgents: Record<string, boolean> = {}): string =>
  buildConductorPrompt({
    taskDescription: 'do the thing',
    installedAgents,
    projectCwd: '/x',
    shellType: 'bash',
  })

const roster = (prompt: string): string =>
  prompt.split('INSTALLED AGENTS:\n')[1].split('\n\nYOUR MCP TOOLS:')[0]

describe('buildConductorPrompt — agent without MCP', () => {
  it('tells the conductor to reach a non-MCP agent through the swarm bridge', () => {
    expect(roster(build())).toContain(
      '- Bridged Agent (bridged): Strengths: Refactoring (5/5), DevOps (4/5). High cost. No MCP (use swarm bridge).',
    )
  })

  it('still reports an MCP-capable agent as "Has MCP"', () => {
    expect(roster(build())).toContain(
      '- Native Agent (native): Strengths: Refactoring (4/5). Low cost. Has MCP.',
    )
  })

  it('lists both arms in the same roster, one line each', () => {
    const lines = roster(build()).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.filter(l => l.includes('No MCP (use swarm bridge)'))).toHaveLength(1)
    expect(lines.filter(l => l.endsWith('Has MCP.'))).toHaveLength(1)
  })

  it('omits strengths scored below 4 from the roster line', () => {
    const section = roster(build())
    expect(section).not.toContain('Testing')
    expect(section).not.toContain('(2/5)')
    expect(section).not.toContain('(1/5)')
  })

  it('still honours installedAgents === false against the mocked roster', () => {
    const section = roster(build({ bridged: false }))
    expect(section).not.toContain('Bridged Agent')
    expect(section).toContain('Native Agent')
  })
})
