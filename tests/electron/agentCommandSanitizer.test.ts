import { describe, it, expect } from 'vitest'
import { sanitizeAgentCommand, AGENT_COMMAND_ALLOWLIST } from '../../src/main/agentCommandSanitizer'

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

  it('passes through correct aider command', () => {
    expect(sanitizeAgentCommand('aider --model ollama/qwen3-coder --no-show-model-warnings'))
      .toBe('aider --model ollama/qwen3-coder --no-show-model-warnings')
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

  it('has entries for all four agent types', () => {
    expect(Object.keys(AGENT_COMMAND_ALLOWLIST)).toEqual(['claude', 'codex', 'gemini', 'aider'])
  })
})
