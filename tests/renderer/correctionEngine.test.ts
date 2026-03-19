import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('window', {
  termpolis: {
    completionPathCommands: vi.fn().mockResolvedValue({
      success: true, data: ['git', 'docker', 'node', 'npm', 'apt']
    })
  }
})

const { getSuggestion } = await import('../../src/renderer/src/corrections/correctionEngine')

describe('correctionEngine', () => {
  it('suggests correction for git typo with stderr hint', async () => {
    const result = await getSuggestion(
      'git comit -m "fix"',
      "git: 'comit' is not a git command.\n\nThe most similar command is\n    commit"
    )
    expect(result).toBe('git commit -m "fix"')
  })

  it('suggests sudo for permission denied', async () => {
    const result = await getSuggestion('apt install vim', 'Permission denied')
    expect(result).toBe('sudo apt install vim')
  })

  it('suggests closest command for typo', async () => {
    const result = await getSuggestion('dockr ps', 'bash: dockr: command not found')
    expect(result).toBe('docker ps')
  })

  it('returns null when no fix available', async () => {
    const result = await getSuggestion('somecommand', 'some random error')
    expect(result).toBeNull()
  })
})
