import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const { appendCommand, searchHistory } = await import('../../src/main/historyStore')

describe('appendCommand', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appends a command to history', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    appendCommand('t1', 'T1', 'ls -la')
    expect(writeFileSync).toHaveBeenCalled()
    const written = JSON.parse((writeFileSync as any).mock.calls[0][1])
    expect(written.t1[0].command).toBe('ls -la')
  })

  it('prunes entries beyond 1000 per terminal', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const existing = Array.from({ length: 1000 }, (_, i) => ({
      terminalId: 't1', terminalName: 'T1', command: `cmd${i}`, timestamp: i,
    }))
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ t1: existing }) as any)
    appendCommand('t1', 'T1', 'new-cmd')
    const written = JSON.parse((writeFileSync as any).mock.calls[0][1])
    expect(written.t1.length).toBe(1000)
    expect(written.t1[999].command).toBe('new-cmd')
  })
})

describe('searchHistory', () => {
  it('returns entries matching query across all terminals', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      t1: [{ terminalId: 't1', terminalName: 'T1', command: 'git status', timestamp: 1 }],
      t2: [{ terminalId: 't2', terminalName: 'T2', command: 'npm install', timestamp: 2 }],
    }) as any)
    const results = searchHistory('git')
    expect(results).toHaveLength(1)
    expect(results[0].command).toBe('git status')
  })

  it('returns results sorted by recency descending', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      t1: [
        { terminalId: 't1', terminalName: 'T1', command: 'git log', timestamp: 100 },
        { terminalId: 't1', terminalName: 'T1', command: 'git status', timestamp: 200 },
      ],
    }) as any)
    const results = searchHistory('git')
    expect(results[0].timestamp).toBe(200)
  })
})
