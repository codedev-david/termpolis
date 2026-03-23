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
  })
})
