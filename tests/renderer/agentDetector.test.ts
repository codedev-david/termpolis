import { describe, it, expect } from 'vitest'
import { detectAgent } from '../../src/renderer/src/lib/agentDetector'

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
})
