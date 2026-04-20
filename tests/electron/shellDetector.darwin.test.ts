import { describe, it, expect, vi } from 'vitest'

// Hoisted top-level mocks so `import { existsSync } from 'fs'` inside
// shellDetector resolves to our stub on every platform, without needing
// vi.resetModules() dynamics that behaved inconsistently across runners.
vi.mock('os', () => ({
  homedir: () => '/Users/u',
  platform: () => 'darwin',
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const existsSync = (p: unknown) => p === '/bin/zsh' || p === '/bin/bash'
  return {
    ...actual,
    default: { ...actual, existsSync },
    existsSync,
  }
})

import { detectAvailableShells } from '../../src/main/shellDetector'

describe('detectAvailableShells — darwin platform branch', () => {
  it('selects darwin candidates list', async () => {
    const shells = await detectAvailableShells()
    expect(shells.some(s => s.type === 'zsh')).toBe(true)
    expect(shells.some(s => s.type === 'bash')).toBe(true)
  })
})
