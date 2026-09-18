import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

/**
 * Branch backfill for src/main/terminalManager.ts.
 *
 * The main suite (terminalManager.test.ts) covers the happy Windows path. The
 * paths below are the ones a Windows-only coverage gate structurally cannot
 * reach: the POSIX `which` probe, the packaged-app resources dir, a node-pty
 * binding that throws something that is not an Error, and the cwd probe for a
 * pid that no longer exists.
 *
 * Two pieces of module state force a fresh import per scenario:
 *   - `bundledToolsNeeded` is memoised on first spawn, so the tool probe can
 *     only be observed once per module instance;
 *   - the `processes` map leaks terminal ids between tests.
 * `freshManager()` handles both.
 */

const h = vi.hoisted(() => {
  const ptyProc = {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 4242,
  }
  return {
    ptyProc,
    spawn: vi.fn(
      (_file: string, _args: string[], _opts: { cwd?: string; env?: Record<string, string> }) =>
        ptyProc,
    ),
    execSync: vi.fn((_cmd: string, _opts?: unknown) => Buffer.from('')),
    exec: vi.fn(),
    execFile: vi.fn(),
    existsSync: vi.fn((_p: string) => true),
    homedir: vi.fn(() => '/home/testuser'),
    // Mutable so a test can flip the app into "packaged" mode; terminalManager
    // reads `app.isPackaged` at spawn time, not at import time.
    app: { isPackaged: false },
  }
})

// Every factory here is SYNCHRONOUS on purpose. terminalManager memoises its
// tool probe at module scope, so the scenarios below need `vi.resetModules()` —
// and an `async (importOriginal) => …` factory is not resolved yet when the very
// next import runs, so the module under test silently binds the REAL fs /
// child_process (see the same trap documented in shellDetector.test.ts).
// Sync factories are re-applied immediately, which makes the reset deterministic.
// terminalManager only touches these four builtin exports.
vi.mock('node-pty', () => ({ spawn: h.spawn }))
vi.mock('electron', () => ({ app: h.app }))
vi.mock('fs', () => ({ existsSync: h.existsSync, default: { existsSync: h.existsSync } }))
vi.mock('os', () => ({ homedir: h.homedir, default: { homedir: h.homedir } }))
// `execFile` is mocked for procHost's argv runner, which terminalManager now reaches through
// procClient. Nothing here uses the argv form, but leaving it off the factory would make any
// accidental use throw "No execFile export is defined" instead of failing on an assertion.
vi.mock('child_process', () => ({
  execSync: h.execSync,
  exec: h.exec,
  execFile: h.execFile,
  default: { execSync: h.execSync, exec: h.exec, execFile: h.execFile },
}))

type TerminalManager = typeof import('../../src/main/terminalManager')
type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void

/** Re-import terminalManager with its memoised tool check and process map wiped. */
async function freshManager(): Promise<TerminalManager> {
  vi.resetModules()
  return import('../../src/main/terminalManager')
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
}

const TOUCHED_ENV = ['PATH', 'OLLAMA_API_BASE', 'TERMPOLIS_TEST_SHIM_DIR'] as const

describe('terminalManager — defensive and non-Windows branches', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let resourcesPathDescriptor: PropertyDescriptor | undefined
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    savedEnv = Object.fromEntries(TOUCHED_ENV.map((k) => [k, process.env[k]]))

    vi.clearAllMocks()
    // Re-arm implementations explicitly: clearAllMocks only wipes call history,
    // and several tests below install throwing implementations.
    h.spawn.mockImplementation(() => h.ptyProc)
    h.existsSync.mockImplementation(() => true)
    h.homedir.mockImplementation(() => '/home/testuser')
    h.execSync.mockImplementation(() => Buffer.from(''))
    // procClient with no utilityProcess forked runs the probe in-process through procHost,
    // which calls `exec`. Left unarmed it returns undefined and the callback never fires, so
    // an awaited probe would hang rather than fail.
    h.exec.mockImplementation((_cmd: string, _opts: unknown, cb: ExecCallback) => cb(null, '', ''))
    h.app.isPackaged = false

    // The e2e shim dir would prepend an extra PATH entry and make the exact
    // PATH assertions below depend on the developer's environment.
    delete process.env.TERMPOLIS_TEST_SHIM_DIR
    delete process.env.OLLAMA_API_BASE
  })

  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
    for (const k of TOUCHED_ENV) {
      const v = savedEnv[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.restoreAllMocks()
  })

  // ---- checkBundledToolsNeeded: the POSIX probe + the "nothing to bundle" path ----

  it('probes with `which` on non-Windows and leaves PATH untouched when jq/yq/nano all resolve', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin:/bin'
    // execSync *returning* is how check() reports "tool is installed". All three
    // must resolve, otherwise the `||` chain short-circuits and we never see the
    // later probes — nor the no-bundled-tools PATH shape.
    h.execSync.mockImplementation(() => Buffer.from('/usr/bin/jq\n'))

    const tm = await freshManager()
    tm.spawnTerminal('probe-posix', '/bin/bash', '/tmp', vi.fn())

    expect(h.execSync.mock.calls.map((c) => c[0])).toEqual(['which jq', 'which yq', 'which nano'])

    const env = h.spawn.mock.calls[0][2].env
    expect(env?.PATH).toBe('/usr/bin:/bin')
  })

  it('resolves the bundled tools dir under process.resourcesPath once the app is packaged', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    h.app.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', {
      value: '/opt/Termpolis/resources',
      configurable: true,
    })
    // jq missing => `!check('jq')` is already true, so the `||` chain stops there
    // and only one probe is ever run.
    h.execSync.mockImplementation(() => {
      throw new Error('command not found')
    })

    const tm = await freshManager()
    tm.spawnTerminal('packaged', '/bin/bash', '/tmp', vi.fn())

    expect(h.execSync.mock.calls.map((c) => c[0])).toEqual(['which jq'])

    const env = h.spawn.mock.calls[0][2].env
    // Unpackaged builds read from <repo>/resources; packaged ones must read from
    // the asar-adjacent resources dir, or every spawn ships a broken tools path.
    expect(env?.PATH).toBe(`${join('/opt/Termpolis/resources', 'tools', 'linux')}:/usr/bin`)
  })

  // ---- env assembly ----

  it('honours a user-configured OLLAMA_API_BASE and only falls back to localhost when unset', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    process.env.OLLAMA_API_BASE = 'http://ollama.lan:11434'

    const tm = await freshManager()
    tm.spawnTerminal('ollama-set', '/bin/bash', '/tmp', vi.fn())
    expect(h.spawn.mock.calls[0][2].env?.OLLAMA_API_BASE).toBe('http://ollama.lan:11434')

    // Same module instance, second terminal: dropping the var must restore the
    // built-in default rather than leaving the key empty.
    delete process.env.OLLAMA_API_BASE
    tm.spawnTerminal('ollama-unset', '/bin/bash', '/tmp', vi.fn())
    expect(h.spawn.mock.calls[1][2].env?.OLLAMA_API_BASE).toBe('http://localhost:11434')
  })

  // ---- spawn failure: node-pty's native binding does not always throw an Error ----

  it('reports a bare string thrown by the node-pty binding instead of an empty message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // ConPTY failures surface from the native layer as a plain string, which has
    // no `.message` — the `|| String(e)` fallback is what keeps the surfaced
    // error readable instead of "Failed to open terminal: undefined".
    h.spawn.mockImplementation(() => {
      throw 'conpty: cannot create process'
    })

    const tm = await freshManager()
    expect(() => tm.spawnTerminal('spawn-str', 'C:\\bad.exe', 'C:\\', vi.fn())).toThrow(
      'Failed to open terminal: conpty: cannot create process',
    )
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('conpty: cannot create process'))
    // A failed spawn must not leave a half-registered terminal behind.
    expect(tm.getTerminalPid('spawn-str')).toBeNull()
  })

  it('still throws a well-formed error when node-pty throws a null-ish value', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // `e?.message` exists precisely so a `throw undefined` cannot turn a failed
    // spawn into a TypeError inside the catch block.
    h.spawn.mockImplementation(() => {
      throw undefined
    })

    const tm = await freshManager()
    expect(() => tm.spawnTerminal('spawn-nullish', '/bin/bash', '/tmp', vi.fn())).toThrow(
      'Failed to open terminal: undefined',
    )
  })

  // ---- getTerminalCwd ----

  it('returns null for a terminal that is not registered, without shelling out', async () => {
    setPlatform('linux')
    const tm = await freshManager()
    h.execSync.mockClear()

    // The status bar polls terminal:status every 5s per terminal; a poll that
    // races a close must short-circuit on the missing pid rather than run lsof.
    expect(tm.getTerminalCwd('never-spawned')).toBeNull()
    expect(h.execSync).not.toHaveBeenCalled()
  })

  it('trims the probe output for the pty pid, and treats a blank probe as no cwd', async () => {
    setPlatform('linux')
    const tm = await freshManager()
    tm.spawnTerminal('cwd-probe', '/bin/bash', '/tmp', vi.fn())

    h.execSync.mockClear()
    h.execSync.mockImplementation(() => Buffer.from('/home/testuser/repos/termpolis\n'))
    expect(tm.getTerminalCwd('cwd-probe')).toBe('/home/testuser/repos/termpolis')

    const probe = h.execSync.mock.calls[0][0]
    expect(probe).toContain(`/proc/${h.ptyProc.pid}/cwd`)
    expect(probe).toContain(`lsof -p ${h.ptyProc.pid}`)

    // lsof exits 0 with no output for a pid it cannot inspect. That must read as
    // "unknown" (null, so the caller keeps the configured cwd), never as ''.
    h.execSync.mockImplementation(() => Buffer.from('   \n'))
    expect(tm.getTerminalCwd('cwd-probe')).toBeNull()
  })

  // ---- primeBundledToolsCheck: the same answer as the sync check, off the main thread ----

  it('fills the cache at startup so the first spawn never probes on the main thread', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin:/bin'
    const tm = await freshManager()

    await expect(tm.primeBundledToolsCheck()).resolves.toBe(false)
    // All three are asked, and all three go through `exec` (the proc host), not `execSync`.
    expect(h.exec.mock.calls.map((c) => c[0])).toEqual(['which jq', 'which yq', 'which nano'])
    expect(h.execSync).not.toHaveBeenCalled()

    // This is the whole point: spawnTerminal used to run those probes itself, on the thread that
    // pumps every PTY, while the user waited for the terminal to appear.
    tm.spawnTerminal('primed', '/bin/bash', '/tmp', vi.fn())
    expect(h.execSync).not.toHaveBeenCalled()
    expect(h.spawn.mock.calls[0][2].env?.PATH).toBe('/usr/bin:/bin')
  })

  it('probes all three in parallel rather than short-circuiting on the first miss', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    // jq missing. The sync version stops there because `||` short-circuits; off the main thread the
    // other two cost nothing in wall-clock, and asking them keeps the probe one shape.
    h.exec.mockImplementation((cmd: string, _opts: unknown, cb: ExecCallback) => {
      if (cmd === 'which jq') cb(new Error('Command failed'), '', 'not found')
      else cb(null, '/usr/bin/x\n', '')
    })

    const tm = await freshManager()
    await expect(tm.primeBundledToolsCheck()).resolves.toBe(true)
    expect(h.exec.mock.calls.map((c) => c[0])).toEqual(['which jq', 'which yq', 'which nano'])
  })

  it('asks Windows the Windows question', async () => {
    setPlatform('win32')
    process.env.PATH = 'C:\\Windows'
    const tm = await freshManager()
    await tm.primeBundledToolsCheck()
    expect(h.exec.mock.calls.map((c) => c[0])).toEqual(['where jq', 'where yq', 'where nano'])
  })

  it('answers from the cache on a second call without probing again', async () => {
    setPlatform('linux')
    const tm = await freshManager()
    await tm.primeBundledToolsCheck()
    h.exec.mockClear()
    await expect(tm.primeBundledToolsCheck()).resolves.toBe(false)
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('reads a probe that cannot run at all as "missing", exactly as the sync version does', async () => {
    setPlatform('linux')
    // No proc host AND no in-process fallback: the spawn itself throws. Treating that as "tool is
    // present" would drop the bundled tools off PATH for the whole session.
    h.exec.mockImplementation(() => {
      throw new Error('spawn ENOMEM')
    })
    const tm = await freshManager()
    await expect(tm.primeBundledToolsCheck()).resolves.toBe(true)
  })

  it('leaves the sync check authoritative when nothing primed it', async () => {
    setPlatform('linux')
    h.execSync.mockImplementation(() => Buffer.from('/usr/bin/jq\n'))
    const tm = await freshManager()
    tm.spawnTerminal('unprimed', '/bin/bash', '/tmp', vi.fn())
    expect(h.execSync.mock.calls.map((c) => c[0])).toEqual(['which jq', 'which yq', 'which nano'])
    // And the primed reader then agrees with it instead of re-probing.
    h.exec.mockClear()
    await expect(tm.primeBundledToolsCheck()).resolves.toBe(false)
    expect(h.exec).not.toHaveBeenCalled()
  })
})
