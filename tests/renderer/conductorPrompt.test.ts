import { describe, it, expect } from 'vitest'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'

const allInstalled = { claude: true, codex: true, gemini: true, 'qwen-code': true, aider: false, 'aider-qwen': true }
const onlyClaude = { claude: true, codex: false, gemini: false, 'qwen-code': false, aider: false, 'aider-qwen': false }

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
    expect(prompt).toContain('Qwen AI')
  })

  it('excludes agents that are not installed (installedAgents[id] === false)', () => {
    const prompt = buildDefault({
      installedAgents: { claude: true, codex: false, gemini: false, 'qwen-code': false, aider: false, 'aider-qwen': false },
    })
    // Extract just the INSTALLED AGENTS section
    const agentsSection = prompt.split('INSTALLED AGENTS:')[1].split('YOUR MCP TOOLS:')[0]
    expect(agentsSection).toContain('Claude Code')
    expect(agentsSection).not.toContain('OpenAI Codex')
    expect(agentsSection).not.toContain('Gemini CLI')
    // aider-qwen is special — only included when explicitly true
    expect(agentsSection).not.toContain('Qwen AI')
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
    expect(agentsSection).not.toContain('Qwen AI')
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

  // ---- Task creation enforcement ----

  it('places swarm_create_task in STEP 2 before creating terminals', () => {
    const prompt = buildDefault()
    const step2Idx = prompt.indexOf('STEP 2')
    const step3Idx = prompt.indexOf('STEP 3')
    const createTaskIdx = prompt.indexOf('swarm_create_task', step2Idx)
    // swarm_create_task must appear in the STEP 2 block
    expect(step2Idx).toBeGreaterThan(-1)
    expect(createTaskIdx).toBeGreaterThan(step2Idx)
    expect(createTaskIdx).toBeLessThan(step3Idx)
  })

  it('marks task creation as mandatory in the instructions', () => {
    const prompt = buildDefault()
    // "Do NOT skip" must appear in the STEP 2 block
    const step2Idx = prompt.indexOf('STEP 2')
    const step3Idx = prompt.indexOf('STEP 3')
    const step2Block = prompt.slice(step2Idx, step3Idx)
    expect(step2Block).toMatch(/do not skip|never skip/i)
  })

  it('instructs conductor never to skip task creation', () => {
    const prompt = buildDefault()
    expect(prompt).toMatch(/never skip|do not skip/i)
  })

  it('includes swarm_update_task for marking tasks complete', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('swarm_update_task')
  })

  it('requires a SWARM COMPLETE result message as the final step', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('SWARM COMPLETE')
    // Should be part of a swarm_send_message call with type result
    expect(prompt).toContain("type='result'")
  })

  // ---- Anti-piping / stdin safety ----

  it('warns against piping and headless mode for all agents', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('piping breaks stdin')
    expect(prompt).toContain('echo "prompt" | claude')
    expect(prompt).toContain('gemini -p "prompt"')
    expect(prompt).toContain('gemini --sandbox')
  })

  it('specifies write_to_terminal as the ONLY way to send prompts', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('write_to_terminal')
    expect(prompt).toMatch(/ONLY.*way to send prompts/i)
  })

  it('includes --dangerously-skip-permissions in Claude agent command', () => {
    const prompt = buildDefault()
    expect(prompt).toContain("claude --dangerously-skip-permissions")
  })

  it('includes worked examples for both Claude and Gemini agents', () => {
    const prompt = buildDefault()
    expect(prompt).toContain("command='claude --dangerously-skip-permissions'")
    expect(prompt).toContain("command='gemini'")
    expect(prompt).toContain('Gemini (Docs)')
  })

  it('lists wrong Gemini examples in the WRONG section', () => {
    const prompt = buildDefault()
    expect(prompt).toContain("gemini -p")
    expect(prompt).toContain("gemini --sandbox -p")
  })

  it('includes Qwen Code launch command in STEP 4', () => {
    const prompt = buildDefault()
    const step4Idx = prompt.indexOf('STEP 4')
    const step5Idx = prompt.indexOf('STEP 5')
    const step4Block = prompt.slice(step4Idx, step5Idx)
    expect(step4Block).toContain("Qwen Code")
    expect(step4Block).toContain("'qwen'")
  })

  it('warns against headless flags for Qwen Code (Gemini-fork)', () => {
    const prompt = buildDefault()
    expect(prompt).toContain('qwen -p "prompt"')
    expect(prompt).toContain('qwen --sandbox')
  })
})
