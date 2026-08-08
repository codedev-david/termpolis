import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake/userData', getVersion: () => '1.0.0' } }))

const { loadSession, loadRestoreSession, saveSession } = await import('../../src/main/sessionStore')

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

  it('reports the stored terminals faithfully, with defaults applied', () => {
    // loadSession is the RECORD of what the session holds, not a restore plan.
    // MCP list_terminals/swarm_list_agents and the workflow trigger supervisor all
    // read it; blanking terminals here silently broke all three.
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', defaultShell: 'zsh', terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.defaultShell).toBe('zsh')
    expect(result.terminals).toHaveLength(1)
    expect(result.terminals[0]).toMatchObject({ id: '1', cwd: '/home', fontSize: 14, theme: 'dark' })
  })

  it('still reports the stored terminals when the app version changed', () => {
    // A cwd does not stop existing because the app upgraded, and the trigger
    // supervisor arms projects from those cwds on the very first launch after one.
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '0.9.0', defaultShell: 'zsh', terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.defaultShell).toBe('zsh')
    expect(result.terminals).toHaveLength(1)
  })

  it('tolerates a session file whose terminals/workspaces keys are missing', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ appVersion: '1.0.0', defaultShell: 'zsh' }) as any)
    const result = loadSession()
    expect(result.terminals).toEqual([])
    expect(result.workspaces).toEqual([])
  })

  it('KEEPS workspace terminals across a version change, with defaults applied', () => {
    // Regression: this used to blank every workspace's terminal list whenever the
    // app version changed, so an auto-update silently emptied all saved workspaces.
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = {
      ...defaultSession,
      appVersion: '0.9.0',
      workspaces: [{ id: 'w', name: 'W', terminals: [{ id: 't2', name: 'T2', color: '#fff', shellType: 'bash', cwd: '/' }] }],
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.workspaces[0].terminals).toHaveLength(1)
    expect(result.workspaces[0].terminals[0]).toMatchObject({
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

  it('migrates legacy grid viewMode to split', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', viewMode: 'grid' }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.viewMode).toBe('split')
  })

  it('keeps well-formed customKeybindings on load', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', customKeybindings: [
      { id: 'a', label: 'Git', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true },
    ] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.customKeybindings).toEqual([
      { id: 'a', label: 'Git', combo: 'Ctrl+Alt+G', text: 'git status', runOnSend: true },
    ])
  })

  it('drops malformed customKeybindings entries and coerces runOnSend to a strict boolean', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', customKeybindings: [
      { id: 'a', label: 'ok', combo: 'Ctrl+G', text: 'ls', runOnSend: 'yes' }, // non-boolean → false
      { id: 'b', combo: 'Ctrl+H', text: 'x', runOnSend: true },                // no label → dropped
      { label: 'no id', combo: 'Ctrl+J', text: 'y', runOnSend: true },         // no id → dropped
      'garbage',                                                               // not an object → dropped
      { id: 'c', label: 'noText', combo: 'Ctrl+K', runOnSend: true },          // no text → dropped
    ] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.customKeybindings).toEqual([
      { id: 'a', label: 'ok', combo: 'Ctrl+G', text: 'ls', runOnSend: false },
    ])
  })

  it('caps absurdly long customKeybinding text', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', customKeybindings: [
      { id: 'a', label: 'L', combo: 'Ctrl+G', text: 'x'.repeat(20000), runOnSend: true },
    ] }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.customKeybindings![0].text.length).toBeLessThanOrEqual(4096)
  })

  it('drops a customKeybindings value that is not an array', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = { ...defaultSession, appVersion: '1.0.0', customKeybindings: { not: 'an array' } }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.customKeybindings).toEqual([])
  })

  it('preserves workspace terminals across a version change alongside the loose ones', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = {
      ...defaultSession,
      appVersion: '0.5.0',
      terminals: [{ id: 't', name: 'T', color: '#fff', shellType: 'bash', cwd: '/' }],
      workspaces: [{ id: 'w', name: 'W', terminals: [{ id: 't2', name: 'T2', color: '#fff', shellType: 'bash', cwd: '/' }] }],
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadSession()
    expect(result.terminals).toHaveLength(1)
    expect(result.workspaces[0].terminals).toHaveLength(1)
    expect(result.workspaces[0].terminals[0].id).toBe('t2')
  })
})

describe('loadRestoreSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops the loose terminals so every launch starts clean', () => {
    // Restoring open terminals resurrected dead shells and fought workspaces for
    // ownership of "what's open"; saving a group of terminals is a WORKSPACE's job.
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = {
      ...defaultSession,
      appVersion: '1.0.0',
      defaultShell: 'zsh',
      terminals: [{ id: '1', name: 'T1', color: '#fff', shellType: 'zsh', cwd: '/home' }],
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    expect(loadRestoreSession().terminals).toHaveLength(0)
    // ...and it drops them from the RESTORE only — the stored record is untouched.
    expect(loadSession().terminals).toHaveLength(1)
  })

  it('keeps settings and workspace terminals — only the loose list is emptied', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const stored = {
      ...defaultSession,
      appVersion: '0.5.0',
      defaultShell: 'zsh',
      viewMode: 'grid',
      terminals: [{ id: 't', name: 'T', color: '#fff', shellType: 'bash', cwd: '/' }],
      workspaces: [{ id: 'w', name: 'W', terminals: [{ id: 't2', name: 'T2', color: '#fff', shellType: 'bash', cwd: '/' }] }],
    }
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stored) as any)
    const result = loadRestoreSession()
    expect(result.terminals).toHaveLength(0)
    expect(result.defaultShell).toBe('zsh')
    expect(result.viewMode).toBe('split')
    expect(result.workspaces[0].terminals).toHaveLength(1)
    expect(result.workspaces[0].terminals[0].id).toBe('t2')
  })

  it('returns an empty terminal list when there is no session file at all', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(loadRestoreSession()).toMatchObject(defaultSession)
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
