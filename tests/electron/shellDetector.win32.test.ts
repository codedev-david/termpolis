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
    p === 'C:\\Windows\\System32\\cmd.exe' ||
    p === 'C:\\Program Files\\Git\\bin\\bash.exe'
  return {
    ...actual,
    default: { ...actual, existsSync },
    existsSync,
  }
})

import { detectAvailableShells, detectAvailableShellsSync, resolveShellExecutable } from '../../src/main/shellDetector'

describe('detectAvailableShells — win32 platform branch', () => {
  it('selects win32 candidates list', async () => {
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'powershell')).toBe(true)
    expect(shells.some(s => s.type === 'cmd')).toBe(true)
  })

  it('detects Git Bash as the gitbash type', () => {
    expect(detectAvailableShellsSync().some(s => s.type === 'gitbash')).toBe(true)
  })
})

// This is the regression guard for the workflow Command-step spawn bug:
// node-pty on Windows threw `Failed to spawn "bash": File not found` because
// the workflow adapter handed it the bare logical type 'bash'. On Windows a
// step's 'bash' must resolve to the real Git Bash executable.
describe('resolveShellExecutable — win32 platform branch', () => {
  it("resolves a step's logical 'bash' to the real Git Bash exe (never the bare string)", () => {
    expect(resolveShellExecutable('bash')).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it("resolves 'powershell' to the detected pwsh executable", () => {
    expect(resolveShellExecutable('powershell')).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })
})
