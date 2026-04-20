import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'fs'

vi.mock('fs')
vi.mock('os', () => ({ homedir: () => '/home/user', platform: () => 'linux' }))

const { detectAvailableShells, getDefaultShell } = await import('../../src/main/shellDetector')

describe('detectAvailableShells', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns bash when /bin/bash exists on linux', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'bash')).toBe(true)
  })

  it('excludes zsh when not present', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'zsh')).toBe(false)
  })

  it('always returns an array', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const shells = await detectAvailableShells()
    expect(Array.isArray(shells)).toBe(true)
  })

  it('finds multiple linux shells when both exist', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) =>
      p === '/bin/bash' || p === '/usr/bin/zsh',
    )
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'bash')).toBe(true)
    expect(shells.some(s => s.type === 'zsh')).toBe(true)
  })
})

describe('getDefaultShell', () => {
  it('returns bash on linux when available', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    const shells = await detectAvailableShells()
    const def = getDefaultShell(shells, 'linux')
    expect(def?.type).toBe('bash')
  })

  it('returns preferred zsh on darwin when available', () => {
    const shells = [
      { type: 'zsh' as const, label: 'Zsh', executable: '/bin/zsh' },
      { type: 'bash' as const, label: 'Bash', executable: '/bin/bash' },
    ]
    const def = getDefaultShell(shells, 'darwin')
    expect(def?.type).toBe('zsh')
  })

  it('returns preferred powershell on win32 when available', () => {
    const shells = [
      { type: 'cmd' as const, label: 'CMD', executable: 'cmd.exe' },
      { type: 'powershell' as const, label: 'PS', executable: 'pwsh.exe' },
    ]
    const def = getDefaultShell(shells, 'win32')
    expect(def?.type).toBe('powershell')
  })

  it('falls back to first shell when preferred not available', () => {
    const shells = [{ type: 'powershell' as const, label: 'PS', executable: '/p' }]
    const def = getDefaultShell(shells, 'linux')
    expect(def?.type).toBe('powershell')
  })

  it('falls back to bash lookup for unknown OS', () => {
    const shells = [
      { type: 'bash' as const, label: 'Bash', executable: '/bash' },
      { type: 'powershell' as const, label: 'PS', executable: '/p' },
    ]
    const def = getDefaultShell(shells, 'unknown-os')
    expect(def?.type).toBe('bash')
  })

  it('returns undefined when shells empty', () => {
    expect(getDefaultShell([], 'linux')).toBeUndefined()
  })
})

// Darwin and win32 platform branches are covered in sibling files
// (shellDetector.darwin.test.ts, shellDetector.win32.test.ts) where the
// `os` + `fs` mocks can be hoisted at top level. Mixing them here via
// `vi.resetModules()` + dynamic `vi.doMock` was flaky across CI runners
// — the rebuilt module registry lost the fs mock on one platform or
// another depending on timing, and the pattern oscillated between
// green on Windows, green on macOS, and green on Ubuntu without ever
// being green on all three at once.
