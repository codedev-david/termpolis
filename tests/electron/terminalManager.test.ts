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
        cwd: '/tmp',
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
    Object.defineProperty(process, 'platform', { value: 'win32' })

    spawnTerminal('t12', 'cmd.exe', 'C:\\Users', vi.fn())
    expect(getTerminalCwd('t12')).toBeNull()

    Object.defineProperty(process, 'platform', { value: originalPlatform })
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
})
