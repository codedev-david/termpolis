import { describe, it, expect } from 'vitest'
import { isClaudeCommand } from '../../src/renderer/src/lib/testAgents'
import { isClaudeAgentName } from '../../src/main/agentCommandSanitizer'

describe('Claude launch gating (always-on proxy coverage)', () => {
  it('isClaudeCommand detects Claude launch commands', () => {
    expect(isClaudeCommand('claude')).toBe(true)
    expect(isClaudeCommand('claude --resume abc123')).toBe(true)
    expect(isClaudeCommand('  CLAUDE  ')).toBe(true)
    expect(isClaudeCommand('codex')).toBe(false)
    expect(isClaudeCommand('gemini')).toBe(false)
    expect(isClaudeCommand('')).toBe(false)
    expect(isClaudeCommand(undefined)).toBe(false)
    expect(isClaudeCommand(null)).toBe(false)
  })

  it('isClaudeAgentName detects Claude swarm names without false positives', () => {
    expect(isClaudeAgentName('Claude (Build UI)')).toBe(true)
    expect(isClaudeAgentName('claude')).toBe(true)
    expect(isClaudeAgentName('my-claude worker')).toBe(true)
    expect(isClaudeAgentName('Gemini (Docs)')).toBe(false)
    expect(isClaudeAgentName('declauded')).toBe(false) // 'claude' preceded by a letter → not a Claude launch
    expect(isClaudeAgentName('')).toBe(false)
  })
})
