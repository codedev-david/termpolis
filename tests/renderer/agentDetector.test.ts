import { describe, it, expect } from 'vitest'
import { detectAgent, agentFromCommand } from '../../src/renderer/src/lib/agentDetector'

describe('agentDetector', () => {
  describe('detectAgent', () => {
    it('detects Claude from output containing "claude"', () => {
      const result = detectAgent('Starting claude code session...')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Claude Code')
    })

    it('detects Claude from output containing "anthropic"', () => {
      const result = detectAgent('Powered by Anthropic API')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Claude Code')
    })

    it('detects Codex from output containing "codex"', () => {
      const result = detectAgent('Running codex analysis...')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Codex')
    })

    it('detects Codex from output containing "openai"', () => {
      const result = detectAgent('OpenAI API response received')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Codex')
    })

    it('detects Gemini from output containing "gemini"', () => {
      const result = detectAgent('gemini model loaded')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Gemini CLI')
    })

    it('detects Qwen Code from output containing "qwen"', () => {
      const result = detectAgent('qwen v0.35.0')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Qwen Code')
    })

    it('returns null for regular terminal output', () => {
      expect(detectAgent('npm install completed successfully')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(detectAgent('')).toBeNull()
    })

    it('returns correct icon and color fields', () => {
      const result = detectAgent('claude session')
      expect(result).toEqual({
        name: 'Claude Code',
        icon: 'fa-solid fa-robot',
        color: '#D97706',
      })
    })

    it('is case insensitive and first match wins', () => {
      // "CLAUDE" should match Claude Code first, even if other patterns could match later
      const result = detectAgent('CLAUDE and QWEN running')
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Claude Code')
    })
  })

  describe('agentFromCommand (launched-agent identity, not output scraping)', () => {
    it('maps the claude launch command to Claude Code', () => {
      expect(agentFromCommand('claude')!.name).toBe('Claude Code')
    })
    it('maps claude with flags/resume (startsWith) to Claude Code', () => {
      expect(agentFromCommand('claude --resume abc --append-system-prompt-file "x"')!.name).toBe('Claude Code')
    })
    it('maps codex to OpenAI Codex with its color', () => {
      const a = agentFromCommand('codex')!
      expect(a.name).toBe('OpenAI Codex')
      expect(a.color).toBe('#10B981')
    })
    it('maps gemini to Gemini CLI', () => {
      expect(agentFromCommand('gemini')!.name).toBe('Gemini CLI')
    })
    it('maps qwen to Qwen Code', () => {
      expect(agentFromCommand('qwen')!.name).toBe('Qwen Code')
    })
    it('is case-insensitive and tolerates leading whitespace', () => {
      expect(agentFromCommand('  CLAUDE ')!.name).toBe('Claude Code')
    })
    it('returns null for a non-agent command, empty, null, or undefined', () => {
      expect(agentFromCommand('npm run dev')).toBeNull()
      expect(agentFromCommand('')).toBeNull()
      expect(agentFromCommand(null)).toBeNull()
      expect(agentFromCommand(undefined)).toBeNull()
    })
    it('returns a fresh object each call (safe to mutate)', () => {
      expect(agentFromCommand('claude')).not.toBe(agentFromCommand('claude'))
      expect(agentFromCommand('claude')).toEqual(agentFromCommand('claude'))
    })
  })
})
