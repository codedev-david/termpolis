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

    it('parses user turn from a ❯ starship/fish prompt', () => {
      const turns = parseConversation('❯ deploy staging', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].role).toBe('user')
      expect(turns[0].content).toBe('deploy staging')
    })

    it('strips an OSC title sequence before parsing', () => {
      // \x1b]0;title\x07 is what a shell emits to set the window title; it must
      // not stop the `> ` prompt on the same chunk from being recognised.
      const turns = parseConversation('\x1b]0;~/repo\x07> run the tests', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].content).toBe('run the tests')
    })

    // ---- box-drawing markers contribute a role but no text ----

    it('treats a Claude Code ╭─ border as a user marker and keeps the border out of the content', () => {
      const output = ['╭──────────────────────────────╮', 'what does this function do?'].join('\n')
      const turns = parseConversation(output, 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].role).toBe('user')
      expect(turns[0].content).toBe('what does this function do?')
      expect(turns[0].content).not.toContain('╭')
    })

    it('treats a ╰─ border as an assistant marker and keeps the border out of the content', () => {
      const output = [
        'Assistant: here is the answer',
        '╰──────────────────────────────╯',
        'trailing note',
      ].join('\n')
      const turns = parseConversation(output, 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(2)
      expect(turns[0].role).toBe('assistant')
      expect(turns[0].content).toBe('here is the answer')
      expect(turns[1].role).toBe('assistant')
      expect(turns[1].content).toBe('trailing note')
      expect(turns.some(t => t.content.includes('╰'))).toBe(false)
    })

    // ---- empty turns are dropped, not emitted as blanks ----

    it('drops a prompt whose only continuation lines are whitespace', () => {
      const output = ['> ', '   ', '\t', '> real question'].join('\n')
      const turns = parseConversation(output, 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].content).toBe('real question')
    })

    it('drops bare prompts that have no content at all', () => {
      const turns = parseConversation('> \n> \n> actual', 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].content).toBe('actual')
    })

    it('ignores output that precedes the first prompt', () => {
      // Nothing has a role yet, so the banner lines are discarded entirely.
      const output = ['Welcome to the shell', 'Loading profile...', '> first command'].join('\n')
      const turns = parseConversation(output, 't1', 'Term 1', 'claude')
      expect(turns).toHaveLength(1)
      expect(turns[0].content).toBe('first command')
      expect(turns[0].content).not.toContain('Welcome')
    })
  })
})
