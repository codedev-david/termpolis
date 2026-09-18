import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

// Simulate a packaged app whose PATH has no git. codeIngest's own execGit asks for bare `git` and
// gets ENOENT; safeGitAsync retries the same command against the known install locations and finds
// it there. discoverRepoFiles must take that second answer instead of returning [], which would let
// the code graph wipe itself the first time the app launched from a Finder/Explorer shortcut.
//
// Both halves run off the main thread now (v1.47.1) — this used to be "async fails, SYNC fallback
// works", and the fallback's value was never the sync-ness. It was the binary resolution.
const H = vi.hoisted(() => ({ installedGitWorks: true }))

vi.mock('child_process', () => {
  type Cb = (e: Error | null, out: string, err: string) => void
  const enoent = (): Error => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
  const execFile = (bin: string, _args: string[], _opts: unknown, cb: Cb): void => {
    if (bin === 'git' || !H.installedGitWorks) return cb(enoent(), '', '')
    cb(null, 'src/a.ts\nsrc/b.ts\n', '')
  }
  const exec = (_cmd: string, _opts: unknown, cb: Cb): void => cb(null, '', '')
  const execFileSync = (): Buffer => Buffer.from('')
  const execSync = (): Buffer => Buffer.from('')
  return { execFile, exec, execFileSync, execSync, default: { execFile, exec, execFileSync, execSync } }
})

import { discoverRepoFiles } from '../../src/main/codeIngest'
import { _resetGitBinForTests } from '../../src/main/gitCommand'

describe('discoverRepoFiles — safeGitAsync fallback (git off PATH)', () => {
  beforeEach(() => {
    H.installedGitWorks = true
    _resetGitBinForTests()
  })

  it('falls back to the resolved git binary, mapping to absolute paths', async () => {
    const files = await discoverRepoFiles('/repo')
    expect(files).toEqual([join('/repo', 'src/a.ts'), join('/repo', 'src/b.ts')])
  })

  it('returns [] — not a throw — when git cannot be found anywhere', async () => {
    // The caller re-indexes on the next tick; an exception here would take the whole consolidation
    // pass down with it.
    H.installedGitWorks = false
    await expect(discoverRepoFiles('/repo')).resolves.toEqual([])
  })

  it('short-circuits an empty repo root without asking git at all', async () => {
    await expect(discoverRepoFiles('')).resolves.toEqual([])
  })
})
