import { describe, it, expect } from 'vitest'
import { parsePromptFromOutput } from '../../src/renderer/src/lib/promptParser'

describe('promptParser', () => {
  describe('parsePromptFromOutput', () => {
    it('parses Git Bash prompt with cwd and branch', () => {
      const output = 'user@host MINGW64 ~/repos/project (main)\n$'
      const result = parsePromptFromOutput(output, 'gitbash')
      expect(result.cwd).toBe('~/repos/project')
      expect(result.gitBranch).toBe('main')
    })

    it('parses PowerShell prompt with Windows path', () => {
      const output = 'PS C:\\Users\\name\\repos\\project>'
      const result = parsePromptFromOutput(output, 'powershell')
      expect(result.cwd).toBe('C:\\Users\\name\\repos\\project')
    })

    it('returns null branch when no branch info present in Git Bash', () => {
      const output = 'user@host MINGW64 ~/repos/project\n$'
      const result = parsePromptFromOutput(output, 'gitbash')
      expect(result.cwd).toBe('~/repos/project')
      expect(result.gitBranch).toBeNull()
    })

    it('parses Windows-style paths in PowerShell', () => {
      const output = 'PS D:\\Development\\my-app>'
      const result = parsePromptFromOutput(output, 'powershell')
      expect(result.cwd).toBe('D:\\Development\\my-app')
    })

    it('parses Unix-style paths from generic prompts', () => {
      const output = '/home/user/project $'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('/home/user/project')
    })

    it('returns null cwd and branch for unrecognized output', () => {
      const output = 'Hello world\nJust some text'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBeNull()
      expect(result.gitBranch).toBeNull()
    })

    // -----------------------------------------------------------------
    // CD command tracking
    // The parser scans bottom-up. It first finds a "cd X" command,
    // stores lastCdTarget, then continues up to find a prompt with a path.
    // The prompt and the cd must be on SEPARATE lines.
    // -----------------------------------------------------------------
    it('resolves relative cd target from a known path', () => {
      // Line 1: prompt with path, Line 2: cd command
      const output = '~/project $\n$ cd src\n'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('~/project/src')
    })

    it('resolves absolute cd target', () => {
      const output = '~/old $\n$ cd /home/user/new\n'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('/home/user/new')
    })

    it('resolves cd to home-relative path (~)', () => {
      const output = '/tmp $\n$ cd ~/projects\n'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('~/projects')
    })

    it('resolves cd to nested relative path', () => {
      const output = '~/repos $\n$ cd my-app/src\n'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('~/repos/my-app/src')
    })

    it('resolves cd with Windows drive letter target in bash', () => {
      // The cd regex recognizes Windows absolute paths (letter colon)
      const output = '/old/path $\n$ cd C:\\Projects\\app\n'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('C:\\Projects\\app')
    })

    // -----------------------------------------------------------------
    // Branch detection in various formats
    // -----------------------------------------------------------------
    it('detects branch from parens at end of prompt line', () => {
      const output = 'user:~/project (feature/branch) $'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.gitBranch).toBe('feature/branch')
    })

    it('handles multi-line output and finds most recent prompt', () => {
      const output = [
        'user@host MINGW64 ~/old-project (old-branch)',
        '$ git status',
        'On branch old-branch',
        'nothing to commit, working tree clean',
        'user@host MINGW64 ~/new-project (new-branch)',
        '$',
      ].join('\n')
      const result = parsePromptFromOutput(output, 'gitbash')
      expect(result.cwd).toBe('~/new-project')
      expect(result.gitBranch).toBe('new-branch')
    })

    // -----------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------
    it('handles empty output', () => {
      const result = parsePromptFromOutput('', 'bash')
      expect(result.cwd).toBeNull()
      expect(result.gitBranch).toBeNull()
    })

    it('handles very long output (takes last ~2000 chars)', () => {
      const filler = 'x'.repeat(5000)
      const output = filler + '\n/home/user/final $'
      const result = parsePromptFromOutput(output, 'bash')
      expect(result.cwd).toBe('/home/user/final')
    })

    it('does not scan more than 20 lines back', () => {
      // Put a valid prompt 25 lines from the bottom, preceded by 25 blank/filler lines
      const lines = ['/home/user/deep $']
      for (let i = 0; i < 25; i++) lines.push('some output line')
      const result = parsePromptFromOutput(lines.join('\n'), 'bash')
      // Should NOT find the prompt because it's > 20 lines back
      expect(result.cwd).toBeNull()
    })

    it('parses Git Bash prompt with spaces in path', () => {
      const output = 'user@host MINGW64 ~/My Documents/project (main)\n$'
      const result = parsePromptFromOutput(output, 'gitbash')
      expect(result.cwd).toBe('~/My Documents/project')
      expect(result.gitBranch).toBe('main')
    })

    // -----------------------------------------------------------------
    // Agent-TUI noise rejection — AI agents print path/branch-shaped text
    // (spinner hints, quoted prompts in code samples, injected context)
    // that must never be mistaken for the live shell prompt.
    // -----------------------------------------------------------------
    it('does not treat TUI hint text in parens as a git branch', () => {
      const result = parsePromptFromOutput('✻ Thinking… (esc to interrupt)', 'bash')
      expect(result.gitBranch).toBeNull()
    })

    it('rejects paren text with spaces; accepts ref-like branch names', () => {
      expect(parsePromptFromOutput('~/repos/app (my feature) $', 'bash').gitBranch).toBeNull()
      expect(parsePromptFromOutput('~/repos/app (feature/x-1.2) $', 'bash').gitBranch).toBe('feature/x-1.2')
    })

    it('rejects keyboard-hint parens like (ctrl+c to quit)', () => {
      expect(parsePromptFromOutput('Press (ctrl+c to quit)', 'bash').gitBranch).toBeNull()
    })

    it('requires a PowerShell prompt to start the line (ignores prompts quoted mid-text)', () => {
      expect(parsePromptFromOutput('Try this: PS C:\\other> npm i', 'powershell').cwd).toBeNull()
      expect(parsePromptFromOutput('PS C:\\repos\\app>', 'powershell').cwd).toBe('C:\\repos\\app')
    })
  })
})
