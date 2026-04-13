import { describe, it, expect } from 'vitest'
import { detectAgentStatus, type AgentStatus } from '../../src/renderer/src/lib/agentStatusDetector'

describe('detectAgentStatus', () => {
  // Helper to generate filler output
  const filler = (lines: number) => Array(lines).fill('some terminal output line here').join('\n')

  describe('waiting_for_input (highest priority)', () => {
    it('detects trust folder prompts', () => {
      const output = filler(10) + '\nDo you trust the files in this folder?\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
      expect(result.summary).toMatch(/trust/i)
    })

    it('detects authentication prompts', () => {
      const output = filler(10) + '\nPlease sign in to continue\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
    })

    it('detects y/n prompts', () => {
      const output = filler(10) + '\nDo you want to continue? (y/n)\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
    })

    it('detects [Y/n] prompts', () => {
      const output = filler(10) + '\nProceed with installation? [Y/n]\n'
      const result = detectAgentStatus(output, 'Codex')
      expect(result.status).toBe('waiting_for_input')
    })

    it('detects Claude Allow/Deny prompts', () => {
      const output = filler(10) + '\nDo you want to proceed with this action? Allow or Deny\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
    })

    it('detects Codex select option prompts', () => {
      const output = filler(10) + '\nPlease select an option or press Enter to confirm\n'
      const result = detectAgentStatus(output, 'Codex')
      expect(result.status).toBe('waiting_for_input')
    })

    it('detects Aider yes/no prompts', () => {
      const output = filler(10) + '\nApply changes? (y)es (n)o\n'
      const result = detectAgentStatus(output, 'Aider')
      expect(result.status).toBe('waiting_for_input')
    })

    it('detects API key prompts', () => {
      const output = filler(10) + '\nPlease enter your API key to continue\n'
      const result = detectAgentStatus(output, 'Gemini')
      expect(result.status).toBe('waiting_for_input')
    })
  })

  describe('errored', () => {
    it('detects fatal errors', () => {
      const output = filler(10) + '\nfatal error: unhandled exception in main thread\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
      expect(result.summary).toMatch(/fatal/i)
    })

    it('detects token limit exceeded', () => {
      const output = filler(10) + '\nError: token limit exceeded, conversation too long\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
    })

    it('detects rate limit errors', () => {
      const output = filler(10) + '\n429 Too Many Requests - rate limit exceeded\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
    })

    it('detects connection errors', () => {
      const output = filler(10) + '\nError: ECONNREFUSED 127.0.0.1:3000\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
    })

    it('detects process crashes', () => {
      const output = filler(10) + '\nprocess exit with code 1 - killed\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
    })

    it('does not false-positive on normal error messages in code', () => {
      // "error" in a normal code context shouldn't trigger errored status
      const output = filler(10) + '\nfunction handleError(err) { console.log(err) }\n'
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result.status).not.toBe('errored')
    })
  })

  describe('completed', () => {
    it('detects SWARM COMPLETE signal', () => {
      const output = filler(10) + '\nSWARM COMPLETE: All tasks finished successfully\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('completed')
    })

    it('detects TASK COMPLETE signal', () => {
      const output = filler(10) + '\nTASK COMPLETE\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('completed')
    })

    it('detects "finished" at end of output', () => {
      const output = filler(10) + '\nAll work finished.'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('completed')
    })
  })

  describe('working', () => {
    it('detects file creation', () => {
      const output = filler(10) + '\nCreating file src/components/Button.tsx\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
      expect(result.summary).toBeTruthy()
    })

    it('detects file writes', () => {
      const output = filler(10) + '\nWrote src/index.ts\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
    })

    it('detects npm install', () => {
      const output = filler(10) + '\nnpm install express --save\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
    })

    it('detects git commands', () => {
      const output = filler(10) + '\ngit add src/\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
    })

    it('detects running tests', () => {
      const output = filler(10) + '\nrunning test suite...\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
    })

    it('detects tool use patterns from Claude', () => {
      const output = filler(10) + '\nEdit(src/main.ts)\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
    })

    it('detects building', () => {
      const output = filler(10) + '\nbuilding project...\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('working')
    })
  })

  describe('thinking', () => {
    it('detects thinking indicators', () => {
      const output = filler(10) + '\nthinking about how to approach this...\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('thinking')
    })

    it('detects active output without prompt (mid-generation)', () => {
      const output = filler(10) + '\nLet me analyze the codebase structure and determine the best approach for implementing this feature across multiple files'
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('thinking')
    })
  })

  describe('idle', () => {
    it('detects shell prompt ($)', () => {
      const output = filler(10) + '\nuser@host:~/project$ '
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result.status).toBe('idle')
    })

    it('detects shell prompt (>)', () => {
      const output = filler(10) + '\nPS C:\\Users\\dev> '
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result.status).toBe('idle')
    })

    it('detects Claude Code prompt', () => {
      const output = filler(10) + '\n> '
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result.status).toBe('idle')
    })
  })

  describe('starting', () => {
    it('stays starting with very little output', () => {
      const output = 'Loading...'
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('starting')
    })

    it('stays starting with version output', () => {
      const output = 'claude version 1.2.3\nInitializing...'
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('starting')
    })

    it('does not revert to starting from another status', () => {
      const output = 'Loading...'
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result.status).not.toBe('starting')
    })
  })

  describe('priority ordering', () => {
    it('waiting_for_input beats working', () => {
      // Output has both working indicators and a trust prompt
      const output = filler(5) + '\nCreating file src/test.ts\nDo you trust the files in this folder?'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
    })

    it('errored beats working', () => {
      const output = filler(5) + '\nrunning tests...\nfatal error: unhandled exception\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
    })

    it('waiting_for_input beats errored', () => {
      // Edge case: error followed by a prompt
      const output = filler(5) + '\nError connecting\nPlease sign in to continue'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
    })
  })

  describe('summary extraction', () => {
    it('extracts input prompt text', () => {
      const output = filler(10) + '\nDo you want to proceed with this change? (y/n)'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.summary).toMatch(/proceed/)
    })

    it('extracts error details', () => {
      const output = filler(10) + '\nfatal error: cannot connect to database\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.summary).toMatch(/cannot connect/i)
    })

    it('extracts work summary', () => {
      const output = filler(10) + '\nCreating file src/components/Header.tsx\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.summary).toMatch(/Header/)
    })
  })

  describe('ANSI escape handling', () => {
    it('strips ANSI codes before detection', () => {
      const output = filler(10) + '\n\x1b[31mfatal error: \x1b[0munhandled exception in main\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('errored')
    })

    it('strips cursor movement codes', () => {
      const output = filler(10) + '\n\x1b[2KDo you trust the files? (y/n)\x1b[0m\n'
      const result = detectAgentStatus(output, 'Claude')
      expect(result.status).toBe('waiting_for_input')
    })
  })

  describe('agent-specific behavior', () => {
    it('handles Gemini trailing question marks', () => {
      const output = filler(10) + '\n'.padEnd(200, 'x') + '\nWhich approach should I use?'
      const result = detectAgentStatus(output, 'Gemini')
      expect(result.status).toBe('waiting_for_input')
    })
  })

  describe('edge cases', () => {
    it('handles empty output', () => {
      const result = detectAgentStatus('', 'Claude', 'starting')
      expect(result.status).toBe('starting')
    })

    it('handles output with only whitespace', () => {
      const result = detectAgentStatus('   \n\n  ', 'Claude', 'starting')
      expect(result.status).toBe('starting')
    })

    it('returns previous status when nothing matches', () => {
      const output = filler(5)
      const result = detectAgentStatus(output, 'Claude', 'working')
      // Should stay working or detect something — not revert to starting
      expect(result.status).not.toBe('starting')
    })
  })
})
