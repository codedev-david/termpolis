import { describe, it, expect } from 'vitest'
import { formatHandoffPrompt } from '../../src/renderer/src/lib/contextCapture'
import type { HandoffContext } from '../../src/renderer/src/lib/contextCapture'

function makeContext(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    task: 'Implement user authentication',
    recentCommands: ['npm test', 'git status'],
    recentOutput: 'All tests passed',
    gitDiff: 'diff --git a/src/auth.ts',
    gitBranch: 'feature/auth',
    cwd: '/home/user/project',
    filesModified: ['src/auth.ts', 'src/login.ts'],
    previousAgent: 'Claude Code',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('contextCapture', () => {
  describe('formatHandoffPrompt', () => {
    it('includes the task description', () => {
      const prompt = formatHandoffPrompt(makeContext())
      expect(prompt).toContain('Implement user authentication')
    })

    it('includes the working directory', () => {
      const prompt = formatHandoffPrompt(makeContext())
      expect(prompt).toContain('/home/user/project')
    })

    it('includes the git branch', () => {
      const prompt = formatHandoffPrompt(makeContext())
      expect(prompt).toContain('feature/auth')
    })

    it('includes recent commands', () => {
      const prompt = formatHandoffPrompt(makeContext())
      expect(prompt).toContain('$ npm test')
      expect(prompt).toContain('$ git status')
    })

    it('includes modified files', () => {
      const prompt = formatHandoffPrompt(makeContext())
      expect(prompt).toContain('src/auth.ts')
      expect(prompt).toContain('src/login.ts')
    })

    it('includes the previous agent name', () => {
      const prompt = formatHandoffPrompt(makeContext())
      expect(prompt).toContain('Claude Code')
    })

    it('truncates very long prompts', () => {
      const ctx = makeContext({
        recentOutput: 'x'.repeat(5000),
        gitDiff: 'y'.repeat(5000),
      })
      const prompt = formatHandoffPrompt(ctx)
      // The function caps at ~3000 chars
      expect(prompt.length).toBeLessThanOrEqual(3100)
      expect(prompt).toContain('[Context truncated for brevity]')
    })

    it('handles empty optional fields gracefully', () => {
      const ctx = makeContext({
        task: '',
        recentCommands: [],
        recentOutput: '',
        gitDiff: '',
        gitBranch: '',
        filesModified: [],
      })
      const prompt = formatHandoffPrompt(ctx)
      // Should still produce valid output with fallback task text
      expect(prompt).toContain('Continuing previous work session')
      expect(prompt).toContain('Working Directory')
      // Should not contain empty sections for commands/files
      expect(prompt).not.toContain('## Recent Commands')
      expect(prompt).not.toContain('## Files Modified')
    })
  })
})
