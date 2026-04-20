import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData', getVersion: () => '1.0.0' } }))

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

  it('parses and returns session when file exists with matching version', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', defaultShell: 'zsh', terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }] }
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

  it('skips terminal restore when app version changed', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '0.9.0', defaultShell: 'zsh', terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.defaultShell).toBe('zsh')
    expect(result.terminals).toHaveLength(0)
  })

  it('returns default session when file is corrupt JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not-json' as any)
    const result = loadSession()
    expect(result).toMatchObject(defaultSession)
  })

  it('migrates legacy grid viewMode to split', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', viewMode: 'grid' }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.viewMode).toBe('split')
  })

  it('clears workspace terminals when version changes', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = {
      ...defaultSession,
      appVersion: '0.5.0',
      terminals: [{ id: 't', name: 'T', color: '#fff', shellType: 'bash', cwd: '/' }],
      workspaces: [{ id: 'w', name: 'W', terminals: [{ id: 't2', name: 'T2', color: '#fff', shellType: 'bash', cwd: '/' }] }],
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = loadSession()
    expect(result.terminals).toHaveLength(0)
    expect(result.workspaces[0].terminals).toHaveLength(0)
    logSpy.mockRestore()
  })
})

describe('saveSession', () => {
  it('writes session to disk with appVersion', () => {
    saveSession(defaultSession)
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session.json'),
      JSON.stringify({ ...defaultSession, appVersion: '1.0.0' }, null, 2),
      'utf-8'
    )
  })
})
