import { describe, it, expect } from 'vitest'
import { parseConversation } from '../../src/renderer/src/lib/conversationParser'

describe('conversationParser', () => {
  describe('parseConversation', () => {
    it('parses user turn from > prompt', () => {
      const turns = parseConversation('> hello world', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].role).toBe('user')
      expect(turns[0].content).toBe('hello world')
    })

    it('parses user turn from $ prompt', () => {
      const turns = parseConversation('$ npm install', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].role).toBe('user')
      expect(turns[0].content).toBe('npm install')
    })

    it('parses user turn from Human: prefix', () => {
      const turns = parseConversation('Human: explain this code', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].role).toBe('user')
      expect(turns[0].content).toBe('explain this code')
    })

    it('parses multi-line assistant response', () => {
      const output = [
        '> tell me about testing',
        'Assistant: Testing is important.',
        'It helps catch bugs early.',
        'You should write tests.',
      ].join('\n')
      const turns = parseConversation(output, 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(2)
      expect(turns[0].role).toBe('user')
      expect(turns[1].role).toBe('assistant')
      expect(turns[1].content).toContain('Testing is important.')
      expect(turns[1].content).toContain('It helps catch bugs early.')
    })

    it('returns correct turn structure with all required fields', () => {
      const turns = parseConversation('> hello', 't1', 'My Terminal', 'claude')
      expect(turns).toHaveLength(1)
      const turn = turns[0]
      expect(turn).toHaveProperty('role')
      expect(turn).toHaveProperty('content')
      expect(turn).toHaveProperty('timestamp')
      expect(turn).toHaveProperty('terminalId', 't1')
      expect(turn).toHaveProperty('terminalName', 'My Terminal')
      expect(turn).toHaveProperty('agentName', 'claude')
    })

    it('returns empty array for output with no prompts', () => {
      const turns = parseConversation('just some plain text output\nmore output', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(0)
    })

    it('strips ANSI escape sequences before parsing', () => {
      const ansiOutput = '\x1b[32m> \x1b[0mhello world'
      const turns = parseConversation(ansiOutput, 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].content).toBe('hello world')
    })

    it('attaches the provided agent name to all turns', () => {
      const output = '> question\nAssistant: answer'
      const turns = parseConversation(output, 't1', 'Term 1', 'gemini')
      expect(turns.every(t => t.agentName === 'gemini')).toBe(true)
    })
  })
})
