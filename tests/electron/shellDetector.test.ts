import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'fs'

// existsSync is the fake every case drives; the async probe (detectAvailableShells) asks the thread pool and is
// answered from the same fake.
vi.mock('fs', () => {
  const existsSync = vi.fn()
  const promises = { access: vi.fn(async (p: unknown) => { if (!existsSync(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) }
  return { existsSync, promises, default: { existsSync, promises } }
})
vi.mock('os', () => ({ homedir: () => '/home/user', platform: () => 'linux' }))

const { detectAvailableShells, detectAvailableShellsSync, getDefaultShell, pickShellExecutable, resolveShellExecutable, _resetShellProbeForTests } = await import('../../src/main/shellDetector')

describe('detectAvailableShells', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetShellProbeForTests() })

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

// pickShellExecutable is PURE — it never touches fs/os, so these cases hold
// regardless of the linux mocks above. It maps a workflow step's logical
// shell TYPE (what the Designer stores, e.g. 'bash') to a concrete executable
// node-pty can actually spawn. node-pty on Windows CANNOT resolve a bare
// 'bash' via PATH — it must be handed a real path — which is the whole reason
// this function exists.
describe('pickShellExecutable', () => {
  const win = [
    { type: 'powershell' as const, label: 'PowerShell', executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    { type: 'cmd' as const, label: 'Command Prompt', executable: 'C:\\Windows\\System32\\cmd.exe' },
    { type: 'gitbash' as const, label: 'Git Bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe' },
  ]
  const linux = [
    { type: 'bash' as const, label: 'Bash', executable: '/bin/bash' },
    { type: 'zsh' as const, label: 'Zsh', executable: '/usr/bin/zsh' },
  ]

  it("maps logical 'bash' to the Git Bash executable when no native bash is present (Windows)", () => {
    expect(pickShellExecutable(win, 'bash')).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it("maps logical 'zsh' to Git Bash on Windows (nearest POSIX shell)", () => {
    expect(pickShellExecutable(win, 'zsh')).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('returns the exact executable for an exactly-matching shell type', () => {
    expect(pickShellExecutable(win, 'powershell')).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(pickShellExecutable(win, 'cmd')).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('passes a full path or .exe straight through unchanged', () => {
    expect(pickShellExecutable(win, 'C:\\custom\\fish.exe')).toBe('C:\\custom\\fish.exe')
    expect(pickShellExecutable(linux, '/opt/homebrew/bin/fish')).toBe('/opt/homebrew/bin/fish')
  })

  it("resolves 'bash' to native /bin/bash on a Linux shell list", () => {
    expect(pickShellExecutable(linux, 'bash')).toBe('/bin/bash')
  })

  it('returns the raw type as a last resort when it is unknown and nothing compatible is detected', () => {
    expect(pickShellExecutable(win, 'fish')).toBe('fish')
    expect(pickShellExecutable([], 'bash')).toBe('bash')
  })
})

describe('resolveShellExecutable (linux platform mock)', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetShellProbeForTests() })

  it("resolves 'bash' to the detected /bin/bash", () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    expect(resolveShellExecutable('bash')).toBe('/bin/bash')
  })

  it('detectAvailableShellsSync returns the same result as the async detector', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    expect(detectAvailableShellsSync()).toEqual(await detectAvailableShells())
  })

  it('reads the shells the async probe found from memory, without touching the file system again', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    await detectAvailableShells() // what start-up and every terminal creation do, on the thread pool
    vi.mocked(existsSync).mockClear()
    expect(resolveShellExecutable('bash')).toBe('/bin/bash')
    expect(existsSync).not.toHaveBeenCalled()
  })
})

describe('detectAvailableShells never probes on the main thread', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetShellProbeForTests() })

  it('asks the thread pool and makes no synchronous existence check', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    const fsMod = await import('fs')
    vi.mocked(fsMod.promises.access).mockClear()
    await detectAvailableShells()
    const asked = vi.mocked(fsMod.promises.access).mock.calls.length
    expect(asked).toBeGreaterThan(0)
    // The fake answers each access() from existsSync, so every existsSync call here is one access() made: the
    // detector itself made none of its own.
    expect(existsSync).toHaveBeenCalledTimes(asked)
  })

  it('shares one probe between callers that ask together (a swarm opening twenty terminals)', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    const fsMod = await import('fs')
    vi.mocked(fsMod.promises.access).mockClear()
    const once = await detectAvailableShells()
    const perProbe = vi.mocked(fsMod.promises.access).mock.calls.length
    vi.mocked(fsMod.promises.access).mockClear()
    const twenty = await Promise.all(Array.from({ length: 20 }, () => detectAvailableShells()))
    expect(vi.mocked(fsMod.promises.access).mock.calls.length).toBe(perProbe)
    for (const r of twenty) expect(r).toEqual(once)
  })

  it('hands every caller its own copy (one cannot change what another sees)', async () => {
    vi.mocked(existsSync).mockImplementation((p: any) => p === '/bin/bash')
    const [a, b] = await Promise.all([detectAvailableShells(), detectAvailableShells()])
    a[0].executable = '/tampered'
    expect(b[0].executable).toBe('/bin/bash')
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
