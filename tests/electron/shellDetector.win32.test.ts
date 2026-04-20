import { describe, it, expect, vi } from 'vitest'

// Hoisted top-level mocks — see shellDetector.darwin.test.ts for why this
// lives in its own file instead of a dynamic-mock block.
vi.mock('os', () => ({
  homedir: () => 'C:\\Users\\u',
  platform: () => 'win32',
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const existsSync = (p: unknown) =>
    p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' ||
    p === 'C:\\Windows\\System32\\cmd.exe'
  return {
    ...actual,
    default: { ...actual, existsSync },
    existsSync,
  }
})

import { detectAvailableShells } from '../../src/main/shellDetector'

describe('detectAvailableShells — win32 platform branch', () => {
  it('selects win32 candidates list', async () => {
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'powershell')).toBe(true)
    expect(shells.some(s => s.type === 'cmd')).toBe(true)
  })
})
