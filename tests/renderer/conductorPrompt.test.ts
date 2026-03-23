import { describe, it, expect } from 'vitest'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'

const allInstalled = { claude: true, codex: true, gemini: true, aider: false, 'aider-qwen': true }
const onlyClaude = { claude: true, codex: false, gemini: false, aider: false, 'aider-qwen': false }

function buildDefault(overrides: Partial<Parameters<typeof buildConductorPrompt>[0]> = {}) {
  return buildConductorPrompt({
    taskDescription: 'Refactor the auth module',
    installedAgents: allInstalled,
    projectCwd: '/home/user/myproject',
    ...overrides,
  })
}

describe('buildConductorPrompt', () => {
  it('returns a string containing the task description', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('Refactor the auth module')
  })

  it('returns a string containing the project cwd', () => {
    const prompt = buildDefault({ projectCwd: '/tmp/workspace' })
    expect(prompt).toContain('/tmp/workspace')
  })

  it('includes installed agent names', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('Claude Code')
    expect(prompt).toContain('OpenAI Codex')
    expect(prompt).toContain('Gemini CLI')
    expect(prompt).toContain('Aider + Qwen3')
  })

  it('excludes agents that are not installed (installedAgents[id] === false)', () => {
    const prompt = buildDefault({
      installedAgents: { claude: true, codex: false, gemini: false, aider: false, 'aider-qwen': false },
    })
    // Extract just the INSTALLED AGENTS section
    const agentsSection = prompt.split('INSTALLED AGENTS:')[1].split('YOUR MCP TOOLS:')[0]
    expect(agentsSection).toContain('Claude Code')
    expect(agentsSection).not.toContain('OpenAI Codex')
    expect(agentsSection).not.toContain('Gemini CLI')
    // aider-qwen is special — only included when explicitly true
    expect(agentsSection).not.toContain('Aider + Qwen3')
  })

  it('includes MCP tool names', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('swarm_send_message')
    expect(prompt).toContain('swarm_create_task')
    expect(prompt).toContain('swarm_list_agents')
    expect(prompt).toContain('swarm_list_tasks')
    expect(prompt).toContain('swarm_update_task')
    expect(prompt).toContain('swarm_read_messages')
  })

  it('includes agent capability scores for installed agents', () => {
    const prompt = buildDefault()
    // Claude Code has Refactoring 5/5, Architecture 5/5
    expect(prompt).toContain('Refactoring (5/5)')
    expect(prompt).toContain('Architecture (5/5)')
    // Gemini CLI has DevOps 5/5, Data Analysis 5/5
    expect(prompt).toContain('DevOps (5/5)')
    expect(prompt).toContain('Data Analysis (5/5)')
  })

  it('includes "Begin now" instruction', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('Begin now')
  })

  it('includes conductor role description', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('Swarm Conductor')
    expect(prompt).toContain('orchestrate')
  })

  it('handles case where only Claude is installed', () => {
    const prompt = buildDefault({ installedAgents: onlyClaude })
    // Extract just the INSTALLED AGENTS section
    const agentsSection = prompt.split('INSTALLED AGENTS:')[1].split('YOUR MCP TOOLS:')[0]
    expect(agentsSection).toContain('Claude Code')
    expect(agentsSection).not.toContain('OpenAI Codex')
    expect(agentsSection).not.toContain('Gemini CLI')
    expect(agentsSection).not.toContain('Aider + Qwen3')
    // Should still be a valid prompt with tools section
    expect(prompt).toContain('swarm_create_task')
  })

  it('handles empty task description gracefully', () => {
    const prompt = buildDefault({ taskDescription: '' })
    // Should still produce a valid string (no crash)
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('TASK FROM USER:')
    expect(prompt).toContain('PROJECT DIRECTORY:')
  })
})
