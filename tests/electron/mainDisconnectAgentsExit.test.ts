// @vitest-environment jsdom
//
// `Termpolis.exe --disconnect-agents` the way the Windows uninstaller really runs it
// (build/installer.nsh, customUnInit).
//
// tests/electron/mainAgentIntegrationIpc.test.ts pins the block's contract under the node
// environment, with an app.exit spy that RETURNS, so the rest of index.ts boots behind it. This
// file pins what that harness cannot show:
//
//   1. The block works wherever index.ts is loaded, including jsdom, which is ON PURPOSE the
//      environment above (and, since Vitest 4 ignores `environmentMatchGlobs`, the one every file
//      in tests/electron without a pragma gets anyway). Under jsdom `os` is Vite's
//      browser-external shim, and a builtin's names are bound WHERE ITS IMPORT IS WRITTEN. While
//      index.ts imported `os` below the block, `homedir()` hit the temporal dead zone ("Cannot
//      access 'homedir' before initialization"), the block's catch logged it, and the "uninstall"
//      exited 0 without disconnecting anything. A bundle hoists every import, so the shipped app
//      was not affected, but this file fails again the day the import moves back down.
//   2. What the real app.exit() does before `ready`: it ends the process on the spot and never
//      returns. The mock below throws instead, which stops index.ts at the same statement, so
//      "nothing after the block ran" becomes observable: no telemetry, no Sentry, no GPU switches,
//      no single-instance lock, no IPC handlers, no whenReady boot, no window, no child process.
//      A control launch without the flag shows those same witnesses DO fire, so the checks can fail.
//
// One test runs the REAL disconnect. Its configs live in the scratch home tests/setup.ts points
// TERMPOLIS_TEST_AGENT_HOME at, and HOME / USERPROFILE are redirected there for the test as well,
// so even a resolver that ignored the override could not reach a real ~/.claude.json.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach, type MockInstance } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

const H = vi.hoisted(() => {
  /** Thrown by the mocked app.exit: the real one never returns. */
  class AppExited extends Error {
    constructor(readonly code: unknown) { super(`app.exit(${String(code)})`) }
  }
  /** Ends the control launch right after the witnesses it needs. */
  class StopHere extends Error {}
  return {
    AppExited,
    StopHere,
    userData: '',
    appExit: vi.fn((code?: number): never => { throw new AppExited(code) }),
    // Witnesses for everything below the block. None of them may fire during an uninstall.
    initTelemetry: vi.fn(),
    initMainSentry: vi.fn(),
    gpuPolicy: vi.fn(),
    appendSwitch: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => new Promise<void>(() => {})),
    appOn: vi.fn(),
    ipcHandle: vi.fn(),
    ipcOn: vi.fn(),
    BrowserWindow: vi.fn(),
    utilityFork: vi.fn(),
    crashReporterStart: vi.fn(),
    // The manager: the real functions unless a test queues something else.
    resolvePaths: vi.fn(),
    disconnect: vi.fn(),
    real: {} as { resolve?: (...a: any[]) => any; disconnect?: (...a: any[]) => any; gpuPolicy?: (...a: any[]) => any },
  }
})

vi.mock('electron', () => {
  const app = {
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    getName: vi.fn(() => 'termpolis'),
    getPath: vi.fn((_name: string) => H.userData),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    exit: H.appExit,
    quit: vi.fn(),
    on: H.appOn,
    once: vi.fn(),
    whenReady: H.whenReady,
    isReady: vi.fn(() => false),
    requestSingleInstanceLock: H.requestSingleInstanceLock,
    commandLine: { appendSwitch: H.appendSwitch, hasSwitch: vi.fn(() => false) },
    disableHardwareAcceleration: H.disableHardwareAcceleration,
  }
  const electron = {
    app,
    BrowserWindow: Object.assign(H.BrowserWindow, { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) }),
    ipcMain: { handle: H.ipcHandle, on: H.ipcOn, removeHandler: vi.fn() },
    utilityProcess: { fork: H.utilityFork },
    crashReporter: { start: H.crashReporterStart },
    clipboard: {},
    dialog: {},
    globalShortcut: {},
    Menu: {},
    nativeImage: {},
    safeStorage: {},
    shell: {},
    powerMonitor: { on: vi.fn() },
    screen: {},
    session: {},
  }
  return { ...electron, default: electron }
})

vi.mock('../../src/main/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/telemetry')>()),
  initTelemetry: H.initTelemetry,
}))

vi.mock('../../src/main/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/sentry')>()),
  initMainSentry: H.initMainSentry,
}))

vi.mock('../../src/main/gpuPolicy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/gpuPolicy')>()
  H.real.gpuPolicy = real.gpuPolicy
  return { ...real, gpuPolicy: H.gpuPolicy }
})

vi.mock('../../src/main/agentIntegrationManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/agentIntegrationManager')>()
  H.real.resolve = real.resolveAgentIntegrationPaths
  H.real.disconnect = real.disconnectAgentIntegration
  return { ...real, resolveAgentIntegrationPaths: H.resolvePaths, disconnectAgentIntegration: H.disconnect }
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let logSpy: MockInstance<typeof console.log>
let errorSpy: MockInstance<typeof console.error>

/** A FRESH index.ts, launched the way the uninstaller launches it. Returns what stopped it. The
 *  flag comes off argv again whatever happens, so nothing imported later can see it. */
async function launch(withFlag: boolean): Promise<unknown> {
  if (withFlag) process.argv.push('--disconnect-agents')
  try {
    vi.resetModules()
    await import('../../src/main/index')
    return undefined
  } catch (e) {
    return e
  } finally {
    const at = process.argv.lastIndexOf('--disconnect-agents')
    if (at !== -1) process.argv.splice(at, 1)
  }
}

/** The uninstaller's console: one `<agent>: <action> <what> (<file>)` row per change. */
function rows(): string[] {
  return logSpy.mock.calls.map((c) => c.join(' ')).filter((l) => /^(claude|codex|gemini): /.test(l))
}

const witnesses = (): Record<string, { mock: { calls: unknown[][] } }> => ({
  initTelemetry: H.initTelemetry,
  initMainSentry: H.initMainSentry,
  gpuPolicy: H.gpuPolicy,
  'app.commandLine.appendSwitch': H.appendSwitch,
  'app.disableHardwareAcceleration': H.disableHardwareAcceleration,
  'app.requestSingleInstanceLock': H.requestSingleInstanceLock,
  'app.whenReady': H.whenReady,
  'app.on': H.appOn,
  'ipcMain.handle': H.ipcHandle,
  'ipcMain.on': H.ipcOn,
  'new BrowserWindow': H.BrowserWindow,
  'utilityProcess.fork': H.utilityFork,
  'crashReporter.start': H.crashReporterStart,
})

const SCRATCH_PATHS = {
  home: '/scratch/home',
  userData: '/scratch/ud',
  claudeDir: '/scratch/home/.claude',
  claudeJson: '/scratch/home/.claude.json',
  codexHome: '/scratch/home/.codex',
  geminiDir: '/scratch/home/.gemini',
}

beforeAll(() => {
  H.userData = mkdtempSync(join(tmpdir(), 'tp-disconnect-exit-'))
})

afterAll(() => {
  rmSync(H.userData, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  // mockReset also drops a once-queue a failed test left behind, so it cannot answer the next test.
  H.resolvePaths.mockReset().mockImplementation((...a: any[]) => H.real.resolve!(...a))
  H.disconnect.mockReset().mockImplementation((...a: any[]) => H.real.disconnect!(...a))
  H.gpuPolicy.mockReset().mockImplementation((...a: any[]) => H.real.gpuPolicy!(...a))
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
})

// ===========================================================================
describe('--disconnect-agents, the way the uninstaller runs it', () => {
  it('resolves the paths from the real home folder, disconnects, prints one row per change and exits 0', async () => {
    H.resolvePaths.mockReturnValueOnce(SCRATCH_PATHS)
    H.disconnect.mockReturnValueOnce([
      { agent: 'claude', file: '/scratch/home/.claude.json', action: 'remove', what: 'MCP server' },
      { agent: 'codex', file: '/scratch/home/.codex/config.toml', action: 'skipped', what: 'MCP server', error: 'EBUSY: resource busy or locked' },
    ])

    const stopped = await launch(true)

    expect(stopped).toBeInstanceOf(H.AppExited)
    expect((stopped as InstanceType<typeof H.AppExited>).code).toBe(0)
    // Under jsdom this is where "Cannot access 'homedir' before initialization" used to land:
    // caught, logged, exit 0, and nothing disconnected.
    expect(errorSpy).not.toHaveBeenCalledWith('Could not disconnect agents:', expect.anything())
    expect(H.resolvePaths).toHaveBeenCalledTimes(1)
    expect(H.resolvePaths).toHaveBeenCalledWith(homedir(), H.userData, process.env)
    expect(H.disconnect).toHaveBeenCalledTimes(1)
    expect(H.disconnect).toHaveBeenCalledWith(SCRATCH_PATHS)
    expect(rows()).toEqual([
      'claude: remove MCP server (/scratch/home/.claude.json)',
      'codex: skipped MCP server (/scratch/home/.codex/config.toml) - EBUSY: resource busy or locked',
    ])
    expect(H.appExit).toHaveBeenCalledTimes(1)
    expect(H.appExit).toHaveBeenCalledWith(0)
    expect(H.disconnect.mock.invocationCallOrder[0]).toBeLessThan(H.appExit.mock.invocationCallOrder[0])
  })

  it('runs nothing after the block: no telemetry, Sentry, GPU switch, lock, IPC, boot, window or child process', async () => {
    H.resolvePaths.mockReturnValueOnce(SCRATCH_PATHS)
    H.disconnect.mockReturnValueOnce([])

    expect(await launch(true)).toBeInstanceOf(H.AppExited)

    expect(H.disconnect).toHaveBeenCalledTimes(1)
    for (const [name, spy] of Object.entries(witnesses())) {
      expect(spy.mock.calls, `${name} ran during --disconnect-agents`).toEqual([])
    }
  })

  it('control: without the flag the same launch never disconnects or exits, and runs on into those witnesses', async () => {
    // Stop the control at the GPU policy, the third statement after the block, so it proves the
    // witnesses are wired without booting the rest of the app in a test.
    H.gpuPolicy.mockImplementationOnce(() => { throw new H.StopHere() })

    expect(await launch(false)).toBeInstanceOf(H.StopHere)

    expect(H.disconnect).not.toHaveBeenCalled()
    expect(H.appExit).not.toHaveBeenCalled()
    expect(H.initTelemetry).toHaveBeenCalledTimes(1)
    expect(H.initTelemetry).toHaveBeenCalledWith(H.userData, '0.0.0-test')
    expect(H.initMainSentry).toHaveBeenCalledTimes(1)
    expect(H.gpuPolicy).toHaveBeenCalledTimes(1)
  })

  it('still exits 0 when the disconnect throws, after saying why', async () => {
    H.resolvePaths.mockReturnValueOnce(SCRATCH_PATHS)
    H.disconnect.mockImplementationOnce(() => { throw new Error('~/.claude.json is locked by another process') })

    const stopped = await launch(true)

    expect((stopped as InstanceType<typeof H.AppExited>).code).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith('Could not disconnect agents:', '~/.claude.json is locked by another process')
    expect(H.appExit).toHaveBeenCalledTimes(1)
    expect(H.initTelemetry).not.toHaveBeenCalled()
  })

  it('still exits 0 when the disconnect hands back something that is not a list', async () => {
    // Whatever the manager returns, an uninstall is never blocked by the report of it.
    H.resolvePaths.mockReturnValueOnce(SCRATCH_PATHS)
    H.disconnect.mockReturnValueOnce(undefined)

    const stopped = await launch(true)

    expect((stopped as InstanceType<typeof H.AppExited>).code).toBe(0)
    expect(H.disconnect).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith('Could not disconnect agents:', expect.stringMatching(/iterable/))
    expect(H.appExit).toHaveBeenCalledTimes(1)
    expect(H.appExit).toHaveBeenCalledWith(0)
  })

  it('really takes Termpolis out of the agent configs of a scratch home, and leaves the user\'s own entries', async () => {
    const home = process.env.TERMPOLIS_TEST_AGENT_HOME
    // tests/setup.ts made this folder. Refuse to go on if it is missing or is the real home.
    expect(home).toBeTruthy()
    expect(resolve(home!)).not.toBe(resolve(homedir()))
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
    }
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.CODEX_HOME
    try {
      const adapter = 'C:/Program Files/Termpolis/resources/mcp-adapter/stdio-adapter.cjs'
      const mine = { command: 'npx', args: ['-y', 'my-own-mcp-server'] }
      const claudeJson = join(home!, '.claude.json')
      const geminiSettings = join(home!, '.gemini', 'settings.json')
      mkdirSync(join(home!, '.claude'), { recursive: true })
      mkdirSync(join(home!, '.gemini'), { recursive: true })
      writeFileSync(claudeJson, JSON.stringify({ mcpServers: { termpolis: { type: 'stdio', command: 'node', args: [adapter] }, mine } }, null, 2))
      writeFileSync(geminiSettings, JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [adapter] }, mine } }, null, 2))

      const stopped = await launch(true)

      expect((stopped as InstanceType<typeof H.AppExited>).code).toBe(0)
      expect(errorSpy).not.toHaveBeenCalledWith('Could not disconnect agents:', expect.anything())
      expect(H.disconnect.mock.calls[0][0]).toMatchObject({ home, claudeJson, geminiDir: join(home!, '.gemini') })
      expect(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers).toEqual({ mine })
      expect(JSON.parse(readFileSync(geminiSettings, 'utf8')).mcpServers).toEqual({ mine })
      const printed = rows()
      expect(printed.some((l) => l.startsWith('claude: remove ') && l.includes(claudeJson))).toBe(true)
      expect(printed.some((l) => l.startsWith('gemini: remove ') && l.includes(geminiSettings))).toBe(true)
      expect(H.appExit).toHaveBeenCalledTimes(1)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
