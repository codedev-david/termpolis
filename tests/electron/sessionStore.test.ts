import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData' } }))

const { loadSession, saveSession } = await import('../../src/main/sessionStore')

const defaultSession = {
  terminals: [],
  workspaces: [],
  defaultShell: 'bash' as const,
  viewMode: 'tabs' as const,
}

describe('loadSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns default session when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = loadSession()
    expect(result).toMatchObject(defaultSession)
  })

  it('parses and returns session when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, defaultShell: 'zsh', terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.defaultShell).toBe('zsh')
    expect(result.terminals).toHaveLength(1)
    // Migration should apply defaults to old terminals missing new fields
    expect(result.terminals[0]).toMatchObject({
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'Consolas, "Courier New", monospace',
    })
  })

  it('returns default session when file is corrupt JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not-json' as any)
    const result = loadSession()
    expect(result).toMatchObject(defaultSession)
  })
})

describe('saveSession', () => {
  it('writes session to disk as JSON', () => {
    saveSession(defaultSession)
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session.json'),
      JSON.stringify(defaultSession, null, 2),
      'utf-8'
    )
  })
})
