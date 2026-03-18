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
})

describe('getDefaultShell', () => {
  it('returns bash on linux when available', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    const shells = await detectAvailableShells()
    const def = getDefaultShell(shells, 'linux')
    expect(def?.type).toBe('bash')
  })
})
