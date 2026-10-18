import { describe, it, expect } from 'vitest'
import { buildConductorPrompt } from '../../src/renderer/src/lib/conductorPrompt'

const allInstalled = { claude: true, codex: true, gemini: true }
const onlyClaude = { claude: true, codex: false, gemini: false }

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
  })

  it('excludes agents that are not installed (installedAgents[id] === false)', () => {
    const prompt = buildDefault({
      installedAgents: { claude: true, codex: false, gemini: false },
    })
    // Extract just the INSTALLED AGENTS section
    const agentsSection = prompt.split('INSTALLED AGENTS:')[1].split('YOUR MCP TOOLS:')[0]
    expect(agentsSection).toContain('Claude Code')
    expect(agentsSection).not.toContain('OpenAI Codex')
    expect(agentsSection).not.toContain('Gemini CLI')
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
    expect(prompt).toContain("command='agy --dangerously-skip-permissions'") // Gemini launches via the Antigravity CLI
    expect(prompt).toContain('Gemini (Docs)')
  })

  it('lists wrong Gemini examples in the WRONG section', () => {
    const prompt = buildDefault()
    expect(prompt).toContain("gemini -p")
    expect(prompt).toContain("gemini --sandbox -p")
  })

  it('offers Claude model brokering in STEP 4 so the conductor can downshift to save tokens', () => {
    const prompt = buildDefault()
    const step4Idx = prompt.indexOf('STEP 4')
    const step5Idx = prompt.indexOf('STEP 5')
    const step4Block = prompt.slice(step4Idx, step5Idx)
    expect(step4Block).toContain('--model haiku')
    expect(step4Block).toContain('--model sonnet')
    expect(step4Block).toContain('--model opus')
    expect(step4Block).toMatch(/conserve tokens/i)
  })

  // ---- write_to_terminal's submit, and a blocked worker (GitHub #36) ----

  const block = (prompt: string, from: string, to: string) => prompt.slice(prompt.indexOf(from), prompt.indexOf(to))

  it('has a prompt that did not go through sent again as it was: submit types nothing already in the input', () => {
    // Sending it as a new text appended it to the copy still in the input: the agent got it twice.
    const step5 = block(buildDefault(), 'STEP 5', 'STEP 6')
    expect(step5).toContain("text='[task prompt]', submit=true")
    expect(step5).toMatch(/submitted=false[\s\S]*again\s+with the same text/)
    expect(step5).toMatch(/types nothing that is already in the agent's input/)
  })

  it("says what to do when submit refused to send a text behind other text, or into a shell its agent left", () => {
    const step5 = block(buildDefault(), 'STEP 5', 'STEP 6')
    expect(step5).toMatch(/already held other text, nothing was sent: clear the input[\s\S]*then send the text again/)
    // Submit refuses only once the agent is gone: right after a restart it waits for the agent's input.
    expect(step5).toMatch(/at its shell's prompt, the agent is not running: start it again \(STEP 4\),\s+then send the text again\. Right after STEP 4, submit=true waits for the agent to show its input\./)
    expect(step5).not.toMatch(/still starting/)
  })

  it('reads the bus as the conductor, which is where a blocked worker is reported', () => {
    expect(block(buildDefault(), 'STEP 6', 'STEP 7')).toContain("swarm_read_messages(terminalId='conductor')")
  })

  it('says submit reaches only an agent at its prompt, and to answer a question without it', () => {
    const step6 = block(buildDefault(), 'STEP 6', 'STEP 7')
    expect(step6).toMatch(/submit=true only reaches an agent that is at its prompt/)
    expect(step6).toMatch(/answer a question or a choice[\s\S]*without submit/)
  })

  it('closes a worker a usage limit stopped before its task goes to another agent: a limit can lift by itself', () => {
    expect(buildDefault()).toContain('close its terminal with close_terminal, then give its task to another installed agent')
    expect(buildDefault()).toContain('- close_terminal: close a terminal (terminalId)')
  })

  it('answers a menu instead: a key press or two clear it, and the worker keeps what it did', () => {
    const rule = buildDefault().split('\n').find((l) => l.includes('waiting on a menu'))!
    expect(rule).toMatch(/answer the menu as STEP 6 says/)
    expect(rule).toMatch(/another installed agent only if the menu stays/)
    expect(rule).not.toMatch(/close_terminal/)
  })

  // A report can be wrong, and closing or reassigning on one alone ended a healthy worker's task
  // (GitHub #36): the conductor looks at the worker's screen first, for a limit and for a menu.
  it("has the conductor confirm a blocked worker with read_output before it closes, answers or reassigns it", () => {
    const rules = buildDefault().split('\n').filter((l) => l.includes('blocked by a usage limit') || l.includes('waiting on a menu'))
    expect(rules).toHaveLength(2)
    for (const rule of rules) {
      const look = rule.indexOf('read_output')
      expect(look).toBeGreaterThan(0)
      expect(rule.search(/close_terminal|answer the menu/)).toBeGreaterThan(look)
    }
  })

  // Both examples send a task the way STEP 5 says; with "\r" at the end, an example that drifted
  // back to the old raw write would teach the conductor the lost-prompt bug again.
  it('sends the task in both worked examples with submit=true, and never with a CR of its own', () => {
    const prompt = buildDefault()
    expect(prompt).toContain("Task ID: task-abc-123', submit=true)")
    expect(prompt).toContain("Task ID: task-def-456', submit=true)")
    expect(prompt).not.toMatch(/write_to_terminal\([^)]*\\r'\)/)
  })

  it("starts Codex with its update check off: its update offer is a menu at every start", () => {
    expect(block(buildDefault(), 'STEP 4', 'STEP 5')).toContain("Codex       → 'codex -a never -s workspace-write -c check_for_update_on_startup=false'")
  })

  // ---- shellType branch coverage (line 12) ----

  it('honors explicit shellType="powershell"', () => {
    const prompt = buildDefault({ shellType: 'powershell' })
    expect(prompt).toContain("shell='powershell'")
  })

  it('honors explicit shellType="bash"', () => {
    const prompt = buildDefault({ shellType: 'bash' })
    expect(prompt).toContain("shell='bash'")
  })

  it('falls back to navigator.platform (Win → powershell, otherwise → bash)', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform')
    try {
      // Force Win branch
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
      const winPrompt = buildConductorPrompt({
        taskDescription: 't',
        installedAgents: allInstalled,
        projectCwd: '/x',
      })
      expect(winPrompt).toContain("shell='powershell'")

      // Force non-Win branch
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
      const nixPrompt = buildConductorPrompt({
        taskDescription: 't',
        installedAgents: allInstalled,
        projectCwd: '/x',
      })
      expect(nixPrompt).toContain("shell='bash'")
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig)
    }
  })

  // ---- agent description branches (lines 16, 19, 22, 23) ----

  it('respects agentRatingOverrides — bumping a category shows it as a strength', () => {
    const prompt = buildConductorPrompt({
      taskDescription: 't',
      installedAgents: allInstalled,
      projectCwd: '/x',
      agentRatingOverrides: {
        // Force a non-default value to exercise the merge path
        claude: { Refactoring: 4 },
      } as any,
    })
    expect(prompt).toContain('Refactoring')
  })

  it('treats installedAgents[id]===undefined as installed (only ===false hides)', () => {
    // Pass a sparse map — agents not listed should still appear because
    // the filter is `!== false`, not `=== true`.
    const prompt = buildConductorPrompt({
      taskDescription: 't',
      installedAgents: {} as any,
      projectCwd: '/x',
    })
    expect(prompt).toContain('Claude Code')
    expect(prompt).toContain('OpenAI Codex')
    expect(prompt).toContain('Gemini CLI')
  })

  it('labels each agent with its token cost tier', () => {
    // All three ternary arms in one prompt: gemini=low, codex=medium, claude=high.
    const prompt = buildDefault()
    expect(prompt).toMatch(/Claude Code \(claude\):.*High cost\./)
    expect(prompt).toMatch(/OpenAI Codex \(codex\):.*Medium cost\./)
    expect(prompt).toMatch(/Gemini CLI \(gemini\):.*Low cost\./)
  })

  it('renders an empty INSTALLED AGENTS section when every agent is marked uninstalled', () => {
    const prompt = buildDefault({ installedAgents: { claude: false, codex: false, gemini: false } })
    const section = prompt.split('INSTALLED AGENTS:\n')[1].split('\n\nYOUR MCP TOOLS:')[0]
    expect(section).toBe('')
    // The rest of the prompt is unaffected — tools and steps still ship.
    expect(prompt).toContain('swarm_create_task')
    expect(prompt).toContain('Begin now')
  })
})

describe('buildConductorPrompt — model guidance seam', () => {
  // The guidance block is spliced in between STEP 4's command list and the
  // "Then post a status update" line. The FALSE arm of that splice (broker has
  // no Claude tiers) needs the broker mocked and lives in
  // cov-renderer-lib-no-model-tiers.test.ts — vi.mock is file-scoped, so keeping
  // it out of this file is what makes every test here genuinely unmocked.
  it('splices the real broker guidance in at the STEP 4 seam', () => {
    const prompt = buildDefault()
    expect(prompt).toContain("Gemini CLI  → 'agy --dangerously-skip-permissions'\n  MODEL SELECTION")
    expect(prompt).toContain("'--model haiku'")
    expect(prompt).toContain('Then post a status update via swarm_send_message.')
  })

  it('reports every shipped agent as MCP-capable', () => {
    // The "No MCP (use swarm bridge)" arm needs a capability roster that does
    // not exist in the shipped defaults — see cov-renderer-lib-no-mcp.test.ts.
    const prompt = buildDefault()
    expect(prompt).toContain('Has MCP')
    expect(prompt).not.toContain('No MCP (use swarm bridge)')
  })
})
