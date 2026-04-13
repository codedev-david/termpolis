import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData', getVersion: () => '1.0.0' } }))

const { loadSession } = await import('../../src/main/sessionStore')

describe('session migration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('applies default fontSize, theme, fontFamily to old sessions missing those fields', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const oldSession = {
      terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/home' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
      appVersion: '1.0.0',
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(oldSession) as any)
    const result = loadSession()
    expect(result.terminals[0]).toMatchObject({
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'Consolas, "Courier New", monospace',
    })
  })

  it('preserves existing fontSize, theme, fontFamily when present', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const session = {
      terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'bash', cwd: '/home', fontSize: 18, theme: 'nord', fontFamily: 'JetBrains Mono' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
      appVersion: '1.0.0',
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(session) as any)
    const result = loadSession()
    expect(result.terminals[0].fontSize).toBe(18)
    expect(result.terminals[0].theme).toBe('nord')
    expect(result.terminals[0].fontFamily).toBe('JetBrains Mono')
  })

  it('applies defaults to workspace terminal templates missing new fields', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const oldSession = {
      terminals: [],
      workspaces: [{ id: 'w1', name: 'Dev', terminals: [{ name: 'T1', color: '#fff', shellType: 'bash' }] }],
      defaultShell: 'bash',
      viewMode: 'tabs',
      appVersion: '1.0.0',
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(oldSession) as any)
    const result = loadSession()
    expect(result.workspaces[0].terminals[0]).toMatchObject({
      fontSize: 14,
      theme: 'dark',
      fontFamily: 'Consolas, "Courier New", monospace',
    })
  })
})
