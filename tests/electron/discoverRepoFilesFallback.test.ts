import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

// Simulate a packaged app whose PATH has no git: the async execFile('git') ENOENTs, and the
// synchronous safeGit fallback (execFileSync) resolves it. discoverRepoFiles must use the fallback
// instead of returning [] (which would let the code graph wipe itself).
vi.mock('child_process', () => {
  const execFile = (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
    cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '')
  const execFileSync = (): Buffer => Buffer.from('src/a.ts\nsrc/b.ts\n')
  const execSync = (): Buffer => Buffer.from('')
  return { execFile, execFileSync, execSync, default: { execFile, execFileSync, execSync } }
})

import { discoverRepoFiles } from '../../src/main/codeIngest'
import { _resetGitBinForTests } from '../../src/main/gitCommand'

describe('discoverRepoFiles — safeGit fallback (git off PATH)', () => {
  beforeEach(() => _resetGitBinForTests())

  it('falls back to safeGit when the async git call fails, mapping to absolute paths', async () => {
    const files = await discoverRepoFiles('/repo')
    expect(files).toEqual([join('/repo', 'src/a.ts'), join('/repo', 'src/b.ts')])
  })
})
