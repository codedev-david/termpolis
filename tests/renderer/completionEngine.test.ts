import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the termpolis API
const mockApi = {
  completionPathCommands: vi.fn().mockResolvedValue({ success: true, data: ['git', 'grep', 'go', 'docker', 'node'] }),
  completionPathEntries: vi.fn().mockResolvedValue({ success: true, data: [{ name: 'src', isDir: true }, { name: 'README.md', isDir: false }] }),
  searchHistory: vi.fn().mockResolvedValue({ success: true, data: [
    { terminalId: '1', terminalName: 'T1', command: 'git status', timestamp: 1 },
    { terminalId: '1', terminalName: 'T1', command: 'git push', timestamp: 2 },
  ]}),
}

vi.stubGlobal('window', { termpolis: mockApi })

const { getCompletions } = await import('../../src/renderer/src/completions/completionEngine')

describe('completionEngine', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns command suggestions for partial command input', async () => {
    const results = await getCompletions('gi')
    expect(results.some(r => r.text === 'git')).toBe(true)
  })

  it('returns at most 8 results', async () => {
    mockApi.completionPathCommands.mockResolvedValue({
      success: true, data: Array.from({ length: 20 }, (_, i) => `cmd${i}`)
    })
    const results = await getCompletions('cmd')
    expect(results.length).toBeLessThanOrEqual(8)
  })

  it('deduplicates results from multiple sources', async () => {
    const results = await getCompletions('git')
    const gitResults = results.filter(r => r.text === 'git')
    expect(gitResults.length).toBeLessThanOrEqual(1)
  })

  it('returns empty for empty input', async () => {
    const results = await getCompletions('')
    expect(results).toEqual([])
  })
})
