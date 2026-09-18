import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mocks first — these have to be hoisted before importing the module under
// test, otherwise the real fs/child_process modules get bound at import time
// and the platform branches we want to exercise stay invisible. vi.hoisted
// lets us declare the mock fns alongside the factory call without tripping
// the hoist-order ReferenceError.
const { mockExecSync, mockReaddirSync, mockHomedir, mockExecShellOffThread } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockHomedir: vi.fn(() => '/home/test'),
  mockExecShellOffThread: vi.fn(),
}))

vi.mock('child_process', () => ({
  default: { execSync: mockExecSync },
  execSync: mockExecSync,
}))
vi.mock('fs', () => ({
  readdirSync: mockReaddirSync,
  default: { readdirSync: mockReaddirSync },
}))
vi.mock('os', () => ({
  homedir: mockHomedir,
  default: { homedir: mockHomedir },
}))
vi.mock('../../src/main/procClient', () => ({
  execShellOffThread: mockExecShellOffThread,
}))

import {
  getInteractiveShellPath,
  getAgentExtraPaths,
  getExtendedPath,
  getExtendedPathAsync,
  primeInteractiveShellPath,
  __resetShellPathCacheForTests,
} from '../../src/main/agentPaths'

// Save & restore process.platform and the env vars we mutate so this file
// can run interleaved with other suites without leaking state.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalEnv = { ...process.env }

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetShellPathCacheForTests()
  // Wipe env vars we touch — different tests want different combinations.
  delete process.env.SHELL
  delete process.env.NVM_DIR
  delete process.env.FNM_DIR
  process.env.PATH = '/orig/bin'
  mockHomedir.mockReturnValue('/home/test')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  // Restore the env wholesale so we don't leak NVM_DIR/FNM_DIR fixtures.
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, originalEnv)
})

// =========================================================================
// getInteractiveShellPath
// =========================================================================
describe('getInteractiveShellPath', () => {
  it('on Windows short-circuits to empty string without invoking a shell', () => {
    setPlatform('win32')
    expect(getInteractiveShellPath()).toBe('')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('returns the cached value on subsequent calls (no second exec)', () => {
    setPlatform('win32')
    getInteractiveShellPath()
    getInteractiveShellPath()
    getInteractiveShellPath()
    // Windows path never calls execSync — the assertion that matters here
    // is that the cache short-circuit fires (no platform check on the 2nd+ call).
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('on macOS forks $SHELL with -ilc and extracts PATH from the sentinel', () => {
    setPlatform('darwin')
    process.env.SHELL = '/bin/zsh'
    mockExecSync.mockReturnValue('TERMPOLIS_PATH_BEGIN:/usr/local/bin:/opt/homebrew/bin\n')
    const got = getInteractiveShellPath()
    expect(got).toBe('/usr/local/bin:/opt/homebrew/bin')
    const [cmd, opts] = mockExecSync.mock.calls[0]
    expect(cmd).toContain('/bin/zsh -ilc')
    expect(cmd).toContain('TERMPOLIS_PATH_BEGIN')
    expect(opts).toMatchObject({ encoding: 'utf8', timeout: 5000, windowsHide: true })
  })

  it('on linux falls back to /bin/zsh when SHELL is unset', () => {
    setPlatform('linux')
    // SHELL deliberately unset in beforeEach
    mockExecSync.mockReturnValue('TERMPOLIS_PATH_BEGIN:/usr/bin\n')
    getInteractiveShellPath()
    expect(mockExecSync.mock.calls[0][0]).toContain('/bin/zsh -ilc')
  })

  it('returns "" when the sentinel marker is missing from output', () => {
    setPlatform('darwin')
    process.env.SHELL = '/bin/bash'
    mockExecSync.mockReturnValue('login banner with no marker line\n')
    expect(getInteractiveShellPath()).toBe('')
  })

  it('returns "" when execSync throws (shell missing / timed out)', () => {
    setPlatform('darwin')
    process.env.SHELL = '/bin/zsh'
    mockExecSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(getInteractiveShellPath()).toBe('')
  })

  it('caches across platforms — second call does not re-invoke execSync', () => {
    setPlatform('linux')
    process.env.SHELL = '/bin/bash'
    mockExecSync.mockReturnValue('TERMPOLIS_PATH_BEGIN:/cached/path\n')
    expect(getInteractiveShellPath()).toBe('/cached/path')
    expect(getInteractiveShellPath()).toBe('/cached/path')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })
})

// =========================================================================
// getAgentExtraPaths
// =========================================================================
describe('getAgentExtraPaths', () => {
  it('on Windows returns the Windows install dirs (incl. the Antigravity CLI) and nothing else', () => {
    setPlatform('win32')
    const paths = getAgentExtraPaths()
    expect(paths).toHaveLength(4)
    expect(paths[0]).toMatch(/AppData[\\/]Roaming[\\/]npm$/)
    expect(paths[1]).toMatch(/AppData[\\/]Local[\\/]pnpm$/)
    expect(paths[2]).toMatch(/Google[\\/]Cloud SDK[\\/]bin$/)
    expect(paths[3]).toMatch(/AppData[\\/]Local[\\/]agy[\\/]bin$/) // agy (Antigravity CLI) — Gemini's headless access
    // No fs scan should run on Windows.
    expect(mockReaddirSync).not.toHaveBeenCalled()
  })

  it('on macOS includes Homebrew + every version-manager dir', () => {
    setPlatform('darwin')
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    const paths = getAgentExtraPaths()
    expect(paths).toContain('/opt/homebrew/bin')
    expect(paths).toContain('/usr/local/bin')
    // path.join uses backslashes on Windows even when we ask for posix-y
    // paths, so match with a separator-tolerant regex.
    const has = (re: RegExp) => paths.some((p) => re.test(p))
    expect(has(/\.local[\\/]bin$/)).toBe(true)
    expect(has(/\.volta[\\/]bin$/)).toBe(true)
    expect(has(/\.asdf[\\/]shims$/)).toBe(true)
    expect(has(/[\\/]n[\\/]bin$/)).toBe(true)
    expect(has(/\.yarn[\\/]bin$/)).toBe(true)
    expect(has(/\.npm-global[\\/]bin$/)).toBe(true)
    expect(has(/\.bun[\\/]bin$/)).toBe(true)
  })

  it('on linux enumerates NVM versions when readdirSync returns them', () => {
    setPlatform('linux')
    process.env.NVM_DIR = '/opt/nvm'
    mockReaddirSync.mockImplementation((dir: any) => {
      // path.join uses backslashes on Windows runners, so normalize first.
      const norm = String(dir).replace(/\\/g, '/')
      if (norm.endsWith('versions/node')) return ['v18.0.0', 'v20.11.0', 'v22.3.0']
      throw new Error('unexpected dir: ' + dir)
    })
    const paths = getAgentExtraPaths().map((p) => p.replace(/\\/g, '/'))
    expect(paths).toContain('/opt/nvm/versions/node/v18.0.0/bin')
    expect(paths).toContain('/opt/nvm/versions/node/v20.11.0/bin')
    expect(paths).toContain('/opt/nvm/versions/node/v22.3.0/bin')
  })

  it('on linux defaults NVM_DIR to ~/.nvm when env var is unset', () => {
    setPlatform('linux')
    // NVM_DIR deliberately unset in beforeEach
    mockReaddirSync.mockReturnValue(['v20.0.0'])
    const paths = getAgentExtraPaths().map((p) => p.replace(/\\/g, '/'))
    expect(paths).toContain('/home/test/.nvm/versions/node/v20.0.0/bin')
  })

  it('swallows NVM enumeration errors without aborting the rest', () => {
    setPlatform('darwin')
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    const paths = getAgentExtraPaths()
    // Static unix list still present, just no NVM additions.
    expect(paths).toContain('/opt/homebrew/bin')
    expect(paths.every((p) => !p.includes('/.nvm/'))).toBe(true)
  })

  it('skips the fnm block entirely when FNM_DIR is unset', () => {
    setPlatform('linux')
    mockReaddirSync.mockReturnValue([])
    getAgentExtraPaths()
    // Only one readdirSync call (for NVM); FNM block should not run.
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)
  })

  it('enumerates fnm versions when FNM_DIR is set', () => {
    setPlatform('darwin')
    process.env.FNM_DIR = '/opt/fnm'
    mockReaddirSync.mockImplementation((dir: any) => {
      const norm = String(dir).replace(/\\/g, '/')
      if (norm.endsWith('versions/node')) throw new Error('no nvm')
      if (norm.endsWith('node-versions')) return ['v18.0.0', 'v20.0.0']
      return []
    })
    const paths = getAgentExtraPaths().map((p) => p.replace(/\\/g, '/'))
    expect(paths).toContain('/opt/fnm/node-versions/v18.0.0/installation/bin')
    expect(paths).toContain('/opt/fnm/node-versions/v20.0.0/installation/bin')
  })

  it('swallows fnm enumeration errors when layout is unexpected', () => {
    setPlatform('linux')
    process.env.FNM_DIR = '/opt/fnm'
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    const paths = getAgentExtraPaths()
    // No fnm dirs in the result, but the static list still made it through.
    expect(paths).toContain('/opt/homebrew/bin')
    expect(paths.every((p) => !p.includes('node-versions'))).toBe(true)
  })
})

// =========================================================================
// getExtendedPath
// =========================================================================
describe('getExtendedPath', () => {
  it('on Windows joins with ";" and includes process.env.PATH last', () => {
    setPlatform('win32')
    process.env.PATH = 'C:\\Windows;C:\\Tools'
    const out = getExtendedPath()
    expect(out).toContain(';')
    expect(out.endsWith('C:\\Windows;C:\\Tools')).toBe(true)
  })

  it('on linux joins with ":" and prepends the agent paths', () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    mockExecSync.mockImplementation(() => { throw new Error('no shell') })
    const out = getExtendedPath()
    expect(out.split(':')[0]).toBe('/opt/homebrew/bin')
    expect(out.endsWith(':/usr/bin')).toBe(true)
  })

  it('filters out the empty interactive-shell PATH when discovery fails', () => {
    setPlatform('darwin')
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    mockExecSync.mockImplementation(() => { throw new Error('no shell') })
    const out = getExtendedPath()
    // Two consecutive ":" would mean an empty segment slipped through.
    expect(out).not.toMatch(/::+/)
  })

  it('handles process.env.PATH being undefined', () => {
    setPlatform('linux')
    delete process.env.PATH
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    mockExecSync.mockImplementation(() => { throw new Error('no shell') })
    const out = getExtendedPath()
    // Should still contain the static unix dirs even with no PATH.
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).not.toMatch(/::+/)
    expect(out.endsWith(':')).toBe(false)
  })

  it('appends the interactive-shell PATH when discovery succeeds', () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    process.env.SHELL = '/bin/zsh'
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    mockExecSync.mockReturnValue('TERMPOLIS_PATH_BEGIN:/from/shell/bin\n')
    const out = getExtendedPath()
    expect(out).toContain('/from/shell/bin')
    expect(out.indexOf('/from/shell/bin')).toBeLessThan(out.indexOf('/usr/bin'))
  })
})

// =========================================================================
// primeInteractiveShellPath / getExtendedPathAsync
// =========================================================================
//
// Same answer as the sync pair, with the shell fork moved off the main thread. That fork is
// `zsh -ilc`, which sources the user's entire dotfile chain — nvm, asdf, rbenv, whatever else has
// accumulated — and routinely takes a few hundred milliseconds. On main, every one of those
// milliseconds is a frozen terminal, because main is the thread pumping every PTY.
//
// The reason priming works at all is that it fills the SAME cache the sync functions read. Nothing
// downstream had to become async; the sync callers simply stop finding the cache empty.
describe('primeInteractiveShellPath', () => {
  it('forks the shell through the proc host, never on the main thread', async () => {
    setPlatform('darwin')
    process.env.SHELL = '/bin/zsh'
    mockExecShellOffThread.mockResolvedValue('TERMPOLIS_PATH_BEGIN:/opt/homebrew/bin:/usr/bin\n')

    await expect(primeInteractiveShellPath()).resolves.toBe('/opt/homebrew/bin:/usr/bin')
    const [cmd, opts] = mockExecShellOffThread.mock.calls[0]
    expect(cmd).toContain('/bin/zsh -ilc')
    expect(cmd).toContain('TERMPOLIS_PATH_BEGIN')
    expect(opts).toEqual({ timeout: 5000 })
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('fills the cache the SYNC function reads, so no sync caller ever spawns', async () => {
    // The entire point of priming. If this ever stopped holding, the spawn would quietly come back
    // to the main thread through whichever sync caller asked first.
    setPlatform('linux')
    process.env.SHELL = '/bin/bash'
    mockExecShellOffThread.mockResolvedValue('TERMPOLIS_PATH_BEGIN:/primed/bin\n')
    await primeInteractiveShellPath()

    expect(getInteractiveShellPath()).toBe('/primed/bin')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('short-circuits on Windows exactly as the sync version does', async () => {
    setPlatform('win32')
    await expect(primeInteractiveShellPath()).resolves.toBe('')
    expect(mockExecShellOffThread).not.toHaveBeenCalled()
  })

  it('returns the cache without a second fork', async () => {
    setPlatform('darwin')
    mockExecShellOffThread.mockResolvedValue('TERMPOLIS_PATH_BEGIN:/once/bin\n')
    await primeInteractiveShellPath()
    await expect(primeInteractiveShellPath()).resolves.toBe('/once/bin')
    expect(mockExecShellOffThread).toHaveBeenCalledTimes(1)
  })

  it('falls back to /bin/zsh when SHELL is unset', async () => {
    setPlatform('darwin')
    mockExecShellOffThread.mockResolvedValue('TERMPOLIS_PATH_BEGIN:/usr/bin\n')
    await primeInteractiveShellPath()
    expect(mockExecShellOffThread.mock.calls[0][0]).toContain('/bin/zsh -ilc')
  })

  it('yields "" — and caches it — when the shell prints no sentinel', async () => {
    setPlatform('darwin')
    mockExecShellOffThread.mockResolvedValue('a login banner and nothing else\n')
    await expect(primeInteractiveShellPath()).resolves.toBe('')
    expect(getInteractiveShellPath()).toBe('')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('yields "" when the fork fails, rather than rejecting into app startup', async () => {
    // This runs unawaited at startup. A rejection here would be an unhandled promise rejection in
    // the main process, and on a box with a broken $SHELL that is every single launch.
    setPlatform('darwin')
    mockExecShellOffThread.mockRejectedValue(new Error('ENOENT'))
    await expect(primeInteractiveShellPath()).resolves.toBe('')
  })
})

describe('getExtendedPathAsync', () => {
  it('produces the same PATH as the sync version, with the fork done off-thread', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    mockExecShellOffThread.mockResolvedValue('TERMPOLIS_PATH_BEGIN:/from/shell/bin\n')

    const asyncPath = await getExtendedPathAsync()
    const syncPath = getExtendedPath()
    expect(asyncPath).toBe(syncPath)
    expect(asyncPath).toContain('/from/shell/bin')
    expect(asyncPath).toContain('/usr/bin')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('joins with the platform separator and drops the empty shell path on Windows', async () => {
    setPlatform('win32')
    process.env.PATH = 'C:\Windows'
    const out = await getExtendedPathAsync()
    expect(out.split(';')).toContain('C:\Windows')
    expect(out).not.toContain(';;')
  })

  it('survives PATH being undefined', async () => {
    setPlatform('linux')
    delete process.env.PATH
    mockReaddirSync.mockImplementation(() => { throw new Error('no nvm') })
    mockExecShellOffThread.mockResolvedValue('TERMPOLIS_PATH_BEGIN:/shell/bin\n')
    const out = await getExtendedPathAsync()
    expect(out).toContain('/shell/bin')
    expect(out.endsWith(':')).toBe(false)
  })
})
