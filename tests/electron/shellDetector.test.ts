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

// Separate module reload for darwin/win32 platform branches.
// Use explicit `vi.doMock('fs', ...)` instead of relying on the top-level
// `vi.mock('fs')` auto-mock surviving `vi.resetModules()` — that behavior
// is flaky on macOS runners and was letting real fs.existsSync leak
// through, which made the win32 assertion pass on Windows (pwsh.exe
// actually exists) and Ubuntu (nothing at C:\... exists so the filter
// works correctly) but fail on macOS.
describe('detectAvailableShells — darwin/win32 platform coverage', () => {
  it('darwin branch: selects darwin candidates list', async () => {
    vi.resetModules()
    vi.doMock('os', () => ({ homedir: () => '/Users/u', platform: () => 'darwin' }))
    vi.doMock('fs', () => ({
      existsSync: (p: any) => p === '/bin/zsh' || p === '/bin/bash',
    }))
    const mod = await import('../../src/main/shellDetector')
    const shells = await mod.detectAvailableShells()
    expect(shells.some(s => s.type === 'zsh')).toBe(true)
    vi.doUnmock('os')
    vi.doUnmock('fs')
  })

  it('win32 branch: selects win32 candidates list', async () => {
    vi.resetModules()
    vi.doMock('os', () => ({ homedir: () => 'C:\\Users\\u', platform: () => 'win32' }))
    vi.doMock('fs', () => ({
      existsSync: (p: any) =>
        p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' ||
        p === 'C:\\Windows\\System32\\cmd.exe',
    }))
    const mod = await import('../../src/main/shellDetector')
    const shells = await mod.detectAvailableShells()
    expect(shells.some(s => s.type === 'powershell')).toBe(true)
    expect(shells.some(s => s.type === 'cmd')).toBe(true)
    vi.doUnmock('os')
    vi.doUnmock('fs')
  })
})
