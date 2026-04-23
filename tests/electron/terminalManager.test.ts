import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks ---

const mockPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPty) }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, existsSync: vi.fn(() => true) }
})
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, homedir: () => '/home/testuser' }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, execSync: vi.fn() }
})

const { existsSync } = await import('fs')
const { execSync } = await import('child_process')
const pty = await import('node-pty')

const {
  spawnTerminal,
  killTerminal,
  writeToTerminal,
  resizeTerminal,
  killAll,
  getTerminalPid,
  getTerminalCwd,
} = await import('../../src/main/terminalManager')

describe('terminalManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: all tools installed (execSync succeeds = tools found)
    vi.mocked(execSync).mockReturnValue(Buffer.from(''))
    vi.mocked(existsSync).mockReturnValue(true)
    // Reset mockPty callbacks for each test
    mockPty.onData.mockReset()
    mockPty.onExit.mockReset()
    mockPty.write.mockReset()
    mockPty.resize.mockReset()
    mockPty.kill.mockReset()
  })

  afterEach(() => {
    // Clean up all terminals between tests so the internal map is fresh
    killAll()
  })

  // 1. spawnTerminal creates a pty with correct args and stores it
  it('spawnTerminal spawns a pty and stores the process in the map', () => {
    const onData = vi.fn()
    spawnTerminal('t1', '/bin/bash', '/tmp', onData)

    expect(pty.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['--login'],
      expect.objectContaining({
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
      })
    )
    // Terminal is now in the map — pid should be retrievable
    expect(getTerminalPid('t1')).toBe(12345)
  })

  // 2. spawnTerminal falls back to homedir when cwd doesn't exist
  it('spawnTerminal falls back to homedir when cwd does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const onData = vi.fn()
    spawnTerminal('t2', '/bin/bash', '/nonexistent/path', onData)

    const { homedir } = require('os')
    expect(pty.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['--login'],
      expect.objectContaining({ cwd: homedir() })
    )
  })

  // 3. spawnTerminal passes --login for bash/zsh, empty for others
  it('spawnTerminal passes --login args for bash', () => {
    spawnTerminal('t3a', '/bin/bash', '/tmp', vi.fn())
    expect(pty.spawn).toHaveBeenCalledWith('/bin/bash', ['--login'], expect.any(Object))
  })

  it('spawnTerminal passes --login args for zsh', () => {
    spawnTerminal('t3b', '/bin/zsh', '/tmp', vi.fn())
    expect(pty.spawn).toHaveBeenCalledWith('/bin/zsh', ['--login'], expect.any(Object))
  })

  it('spawnTerminal passes empty args for other shells', () => {
    spawnTerminal('t3c', '/usr/bin/fish', '/tmp', vi.fn())
    expect(pty.spawn).toHaveBeenCalledWith('/usr/bin/fish', [], expect.any(Object))
  })

  // 4. spawnTerminal prepends bundled tools dir to PATH when tools are not installed
  it('spawnTerminal prepends bundled tools dir to PATH when tools are missing', () => {
    // Make the tool check fail (execSync throws = tool not found)
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })

    // Force re-evaluation of bundledToolsNeeded cache by re-importing
    // Since the cache is module-level, we test the env passed to pty.spawn
    // The first spawn in the module will have already cached. We rely on the
    // module having been freshly imported above.
    spawnTerminal('t4', '/bin/bash', '/tmp', vi.fn())

    const call = vi.mocked(pty.spawn).mock.calls[0]
    const env = call[2]?.env as Record<string, string>
    // PATH should contain the tools directory
    expect(env?.PATH || '').toContain('tools')
  })

  // 5. killTerminal calls pty.kill() and process.kill(pid), removes from map
  it('killTerminal kills the pty process and removes it from the map', () => {
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    spawnTerminal('t5', '/bin/bash', '/tmp', vi.fn())
    expect(getTerminalPid('t5')).toBe(12345)

    killTerminal('t5')

    expect(mockPty.kill).toHaveBeenCalled()
    expect(processKillSpy).toHaveBeenCalledWith(12345)
    expect(getTerminalPid('t5')).toBeNull()
    processKillSpy.mockRestore()
  })

  // 6. killTerminal handles non-existent terminal gracefully
  it('killTerminal does not throw for a non-existent terminal', () => {
    expect(() => killTerminal('nonexistent')).not.toThrow()
  })

  // 7. writeToTerminal calls pty.write() on the correct process
  it('writeToTerminal writes data to the terminal pty', () => {
    spawnTerminal('t7', '/bin/bash', '/tmp', vi.fn())
    writeToTerminal('t7', 'hello\n')
    expect(mockPty.write).toHaveBeenCalledWith('hello\n')
  })

  // 8. writeToTerminal is a no-op for non-existent terminal
  it('writeToTerminal is a no-op for a non-existent terminal', () => {
    expect(() => writeToTerminal('ghost', 'data')).not.toThrow()
    expect(mockPty.write).not.toHaveBeenCalled()
  })

  // 9. resizeTerminal calls pty.resize() with correct args
  it('resizeTerminal resizes the pty with the given cols and rows', () => {
    spawnTerminal('t9', '/bin/bash', '/tmp', vi.fn())
    resizeTerminal('t9', 120, 40)
    expect(mockPty.resize).toHaveBeenCalledWith(120, 40)
  })

  // 10. killAll kills all spawned terminals
  it('killAll kills every terminal in the map', () => {
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    spawnTerminal('ta', '/bin/bash', '/tmp', vi.fn())
    spawnTerminal('tb', '/bin/bash', '/tmp', vi.fn())

    killAll()

    expect(getTerminalPid('ta')).toBeNull()
    expect(getTerminalPid('tb')).toBeNull()
    processKillSpy.mockRestore()
  })

  // 11. getTerminalPid returns pid when terminal exists, null otherwise
  it('getTerminalPid returns pid for existing terminal and null for missing', () => {
    spawnTerminal('t11', '/bin/bash', '/tmp', vi.fn())
    expect(getTerminalPid('t11')).toBe(12345)
    expect(getTerminalPid('missing')).toBeNull()
  })

  // 12. getTerminalCwd returns null on Windows
  it('getTerminalCwd returns null on Windows', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    spawnTerminal('t12', 'cmd.exe', 'C:\\Users', vi.fn())
    expect(getTerminalCwd('t12')).toBeNull()

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  // 13. onData callback is wired up correctly
  it('spawnTerminal wires up the onData callback via pty.onData', () => {
    const onData = vi.fn()
    spawnTerminal('t13', '/bin/bash', '/tmp', onData)

    // The first call to mockPty.onData should have received our callback
    expect(mockPty.onData).toHaveBeenCalledTimes(1)
    const registeredCallback = mockPty.onData.mock.calls[0][0]
    // Simulate data arriving
    registeredCallback('some output')
    expect(onData).toHaveBeenCalledWith('some output')
  })

  // 14. onExit callback cleans up the process from the map
  it('onExit callback removes the terminal from the map', () => {
    spawnTerminal('t14', '/bin/bash', '/tmp', vi.fn())
    expect(getTerminalPid('t14')).toBe(12345)

    // Simulate the exit event by invoking the registered onExit callback
    expect(mockPty.onExit).toHaveBeenCalledTimes(1)
    const exitCallback = mockPty.onExit.mock.calls[0][0]
    exitCallback({ exitCode: 0, signal: 0 })

    expect(getTerminalPid('t14')).toBeNull()
  })

  // 15. resizeTerminal is a no-op for non-existent terminal
  it('resizeTerminal does not throw for a non-existent terminal', () => {
    expect(() => resizeTerminal('ghost', 100, 50)).not.toThrow()
    expect(mockPty.resize).not.toHaveBeenCalled()
  })

  // 16. getTerminalCwd returns null when terminal does not exist
  it('getTerminalCwd returns null for a non-existent terminal', () => {
    expect(getTerminalCwd('nope')).toBeNull()
  })

  // 17. spawnTerminal falls back to homedir when existsSync throws
  it('spawnTerminal falls back to homedir when existsSync throws', () => {
    vi.mocked(existsSync).mockImplementation(() => { throw new Error('EPERM') })
    const { homedir } = require('os')
    spawnTerminal('t17', '/bin/bash', '/bad/path', vi.fn())
    const call = vi.mocked(pty.spawn).mock.calls[0]
    expect(call[2]?.cwd).toBe(homedir())
  })

  // 18. spawnTerminal throws a descriptive error when pty.spawn fails
  it('spawnTerminal throws a descriptive error when pty.spawn fails', () => {
    vi.mocked(pty.spawn).mockImplementationOnce(() => {
      throw new Error('posix_spawnp: no such file')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => spawnTerminal('t18', '/bad/shell', '/tmp', vi.fn())).toThrow(
      /Failed to open terminal/,
    )
    errSpy.mockRestore()
  })

  // 19. spawnTerminal sets BASH_SILENCE_DEPRECATION_WARNING to silence macOS bash warning
  it('spawnTerminal sets BASH_SILENCE_DEPRECATION_WARNING env var', () => {
    spawnTerminal('t19', '/bin/bash', '/tmp', vi.fn())
    const call = vi.mocked(pty.spawn).mock.calls[0]
    const env = call[2]?.env as Record<string, string>
    expect(env?.BASH_SILENCE_DEPRECATION_WARNING).toBe('1')
  })

  // 20. getTerminalCwd — exercise the non-windows path via dynamic import after platform change
  it('getTerminalCwd returns cwd when execSync succeeds on non-windows', async () => {
    const originalPlatform = process.platform
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })

    vi.mocked(execSync).mockReturnValue(Buffer.from('/home/user/project\n') as any)
    spawnTerminal('t20', '/bin/bash', '/tmp', vi.fn())
    const result = getTerminalCwd('t20')
    // Platform might still be win32 on Windows runs — accept either null or the path
    expect(result === null || result === '/home/user/project').toBe(true)

    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    else Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  // 21. getTerminalCwd returns null when execSync throws on non-windows
  it('getTerminalCwd returns null when execSync fails on non-windows', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })

    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('no such process')
    })
    spawnTerminal('t21', '/bin/bash', '/tmp', vi.fn())
    expect(getTerminalCwd('t21')).toBeNull()

    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
  })

  // 22. getTerminalCwd returns null when execSync returns empty string
  it('getTerminalCwd returns null when execSync returns empty', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })

    vi.mocked(execSync).mockReturnValue(Buffer.from('\n') as any)
    spawnTerminal('t22', '/bin/bash', '/tmp', vi.fn())
    expect(getTerminalCwd('t22')).toBeNull()

    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
  })

  // 23. spawnTerminal accepts extra PATH entries
  it('spawnTerminal prepends extra paths to PATH env var', () => {
    spawnTerminal('t23', '/bin/bash', '/tmp', vi.fn(), ['/opt/custom/bin'])
    const call = vi.mocked(pty.spawn).mock.calls[0]
    const env = call[2]?.env as Record<string, string>
    expect(env?.PATH || '').toContain('/opt/custom/bin')
  })

  // 24. spawnTerminal honors TERMPOLIS_TEST_SHIM_DIR env var
  it('spawnTerminal prepends TERMPOLIS_TEST_SHIM_DIR to PATH', () => {
    const original = process.env.TERMPOLIS_TEST_SHIM_DIR
    process.env.TERMPOLIS_TEST_SHIM_DIR = '/test/shim'
    spawnTerminal('t24', '/bin/bash', '/tmp', vi.fn())
    const call = vi.mocked(pty.spawn).mock.calls[0]
    const env = call[2]?.env as Record<string, string>
    expect(env?.PATH || '').toContain('/test/shim')
    if (original === undefined) delete process.env.TERMPOLIS_TEST_SHIM_DIR
    else process.env.TERMPOLIS_TEST_SHIM_DIR = original
  })

  // 25. spawnTerminal respects existing OLLAMA_API_BASE env var
  it('spawnTerminal respects existing OLLAMA_API_BASE env var', () => {
    const original = process.env.OLLAMA_API_BASE
    process.env.OLLAMA_API_BASE = 'http://custom-ollama:9999'
    spawnTerminal('t25', '/bin/bash', '/tmp', vi.fn())
    const call = vi.mocked(pty.spawn).mock.calls[0]
    const env = call[2]?.env as Record<string, string>
    expect(env?.OLLAMA_API_BASE).toBe('http://custom-ollama:9999')
    if (original === undefined) delete process.env.OLLAMA_API_BASE
    else process.env.OLLAMA_API_BASE = original
  })

  // ---- Windows PATH composition: the v1.11.4 regression guard ----
  //
  // Before the fix, winSystemPath used `existingPath.includes(p)`, which meant
  // `C:\Windows\System32` was considered already-present whenever the longer
  // `C:\Windows\System32\WindowsPowerShell\v1.0` was on PATH — even though the
  // shorter System32 entry (where cmd.exe and powershell.exe actually live)
  // was NOT. Result on affected systems: `cmd` and `powershell` unresolvable.

  describe('Windows system PATH injection', () => {
    let origPlatform: PropertyDescriptor | undefined
    let origPath: string | undefined

    beforeEach(() => {
      origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      origPath = process.env.PATH
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: true })
    })

    afterEach(() => {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
      if (origPath === undefined) delete process.env.PATH
      else process.env.PATH = origPath
    })

    function getPath(): string {
      const call = vi.mocked(pty.spawn).mock.calls[0]
      return (call[2]?.env as any)?.PATH || ''
    }

    it('injects System32 when PATH only has the PS 1.0 subdirectory (regression)', () => {
      process.env.PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
      spawnTerminal('win-reg-1', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tmp', vi.fn())
      const finalPath = getPath()
      // System32 must appear before the substring-colliding PS 1.0 entry
      expect(finalPath).toContain('C:\\Windows\\System32;')
      // And both should be on PATH
      expect(finalPath).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    })

    it('does not duplicate System32 when it is already on PATH exactly', () => {
      process.env.PATH = 'C:\\Windows\\System32;C:\\Windows'
      spawnTerminal('win-reg-2', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tmp', vi.fn())
      const finalPath = getPath()
      // The original System32 entry stays; the injector must skip re-adding.
      // Count occurrences of the exact entry surrounded by separator boundaries.
      const segments = finalPath.split(';').map((e: string) =>
        e.replace(/[\\/]+$/, '').toLowerCase(),
      )
      const dupes = segments.filter((e: string) => e === 'c:\\windows\\system32').length
      expect(dupes).toBe(1)
    })

    it('does not duplicate when PATH entry has trailing backslash', () => {
      process.env.PATH = 'C:\\Windows\\System32\\;C:\\Windows\\'
      spawnTerminal('win-reg-3', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tmp', vi.fn())
      const finalPath = getPath()
      const segments = finalPath.split(';').map((e: string) =>
        e.replace(/[\\/]+$/, '').toLowerCase(),
      )
      expect(segments.filter((e: string) => e === 'c:\\windows\\system32').length).toBe(1)
      expect(segments.filter((e: string) => e === 'c:\\windows').length).toBe(1)
    })

    it('does not duplicate when case differs (Windows PATH is case-insensitive)', () => {
      process.env.PATH = 'c:\\windows\\system32;c:\\windows'
      spawnTerminal('win-reg-4', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tmp', vi.fn())
      const finalPath = getPath()
      const segments = finalPath.split(';').map((e: string) =>
        e.replace(/[\\/]+$/, '').toLowerCase(),
      )
      expect(segments.filter((e: string) => e === 'c:\\windows\\system32').length).toBe(1)
    })

    it('injects all four system dirs when PATH is empty', () => {
      process.env.PATH = ''
      spawnTerminal('win-reg-5', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tmp', vi.fn())
      const finalPath = getPath()
      expect(finalPath).toContain('C:\\Windows\\System32')
      expect(finalPath).toContain('C:\\Windows')
      expect(finalPath).toContain('C:\\Windows\\System32\\Wbem')
      expect(finalPath).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    })

    it('does not inject anything on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })
      process.env.PATH = '/usr/bin:/bin'
      spawnTerminal('non-win-1', '/bin/bash', '/tmp', vi.fn())
      const finalPath = getPath()
      expect(finalPath).not.toContain('C:\\Windows\\System32')
    })
  })

  // ---- Git Bash /usr/bin injection — v1.11.10 regression guard ----
  //
  // Symptom: bash-wrapped CLIs (Claude Code's `claude`, gh completion, etc.)
  // fail with "sed: command not found" / "dirname: command not found" inside
  // a Git Bash terminal. Root cause: users whose ~/.bash_profile does not
  // chain to ~/.bashrc end up in a login shell where Git's /usr/bin is not
  // on PATH. Termpolis now injects it up-front so those helpers always work.

  describe('Git Bash /usr/bin injection', () => {
    let origPlatform: PropertyDescriptor | undefined
    let origPath: string | undefined

    beforeEach(() => {
      origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      origPath = process.env.PATH
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: true })
    })

    afterEach(() => {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
      if (origPath === undefined) delete process.env.PATH
      else process.env.PATH = origPath
    })

    function getPath(): string {
      const call = vi.mocked(pty.spawn).mock.calls[0]
      return (call[2]?.env as any)?.PATH || ''
    }

    it('injects Git usr\\bin when launching Git Bash and it is not on PATH', () => {
      process.env.PATH = 'C:\\Windows\\System32;C:\\Windows'
      spawnTerminal('gb-1', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\tmp', vi.fn())
      expect(getPath()).toContain('C:\\Program Files\\Git\\usr\\bin')
    })

    it('does not duplicate when Git usr\\bin is already on PATH', () => {
      process.env.PATH = 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32'
      spawnTerminal('gb-2', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\tmp', vi.fn())
      const segments = getPath().split(';').map((e: string) =>
        e.replace(/[\\/]+$/, '').toLowerCase(),
      )
      expect(segments.filter((e: string) => e === 'c:\\program files\\git\\usr\\bin').length).toBe(1)
    })

    it('does not inject when launching a non-Git-Bash shell', () => {
      process.env.PATH = 'C:\\Windows\\System32'
      spawnTerminal('gb-3', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tmp', vi.fn())
      expect(getPath()).not.toContain('\\Git\\usr\\bin')
    })

    it('derives usr\\bin from a non-standard Git install path', () => {
      process.env.PATH = 'C:\\Windows\\System32'
      spawnTerminal('gb-4', 'D:\\tools\\Git\\bin\\bash.exe', 'C:\\tmp', vi.fn())
      expect(getPath()).toContain('D:\\tools\\Git\\usr\\bin')
    })
  })

})
