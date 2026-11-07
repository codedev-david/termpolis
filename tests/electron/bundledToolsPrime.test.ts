// 1.54.5 (HP2-01, HP2-02): the jq/yq/nano probe that decides whether a terminal's PATH gets Termpolis's bundled
// tools. Counters, not timings:
//  - primeBundledToolsCheck is single-flight: the start-up prime and every terminal created during a session
//    restore (or a swarm opening N terminals) share ONE set of three probes on the proc host, not 3 x N.
//  - a PREPARED spawn (every app path: a click, create_terminal, a workflow command or agent step, run_and_wait)
//    never runs the probe with execSync on the main thread. If the prime has not answered yet, it takes the
//    bundled tools (the answer that can only add tools, never take one away) and leaves the prime to finish.
//  - control: a caller that did not prepare (a test, a spawner given no prepare()) still gets the sync probe.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

const h = vi.hoisted(() => {
  const ptyProc = { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pid: 4242 }
  return {
    ptyProc,
    spawn: vi.fn((..._a: unknown[]) => ptyProc),
    execSync: vi.fn((_c: string, _o?: unknown) => Buffer.from('')),
    offThread: vi.fn(),
  }
})

vi.mock('node-pty', () => ({ spawn: h.spawn, default: { spawn: h.spawn } }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/termpolis-test-userdata' } }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: h.execSync, default: { ...actual, execSync: h.execSync } }
})
vi.mock('../../src/main/procClient', () => ({ execShellCaptureOffThread: h.offThread, execCaptureOffThread: vi.fn() }))
vi.mock('../../src/main/shellAlone', () => ({ shellAlone: vi.fn(async () => true), readConsoleProcessList: vi.fn(async () => null) }))

type TM = typeof import('../../src/main/terminalManager')
async function fresh(): Promise<TM> { vi.resetModules(); return import('../../src/main/terminalManager') }

const prep = { cwd: process.cwd(), integrationScript: null } as never
// The bundled tools go FIRST on PATH (this test may itself run inside a Termpolis terminal, whose PATH carries them later on).
const TOOLS_DIR = join(__dirname, '../../resources', 'tools', process.platform)
const pathOf = (): string => {
  const env = (h.spawn.mock.calls.at(-1)![2] as { env: Record<string, string> }).env
  return env.PATH ?? env.Path ?? ''
}

/** The probe answers a little later, as a real process on the proc host does. */
function probesAnswer(found: boolean): Array<() => void> {
  const pending: Array<() => void> = []
  h.offThread.mockImplementation(() => new Promise((resolve) => {
    pending.push(() => resolve(found ? { stdout: '/usr/bin/x', stderr: '' } : { stdout: '', stderr: '', error: new Error('not found') }))
  }))
  return pending
}

beforeEach(() => {
  vi.clearAllMocks()
  h.spawn.mockImplementation(() => h.ptyProc)
  h.execSync.mockImplementation(() => Buffer.from(''))
})

describe('primeBundledToolsCheck is single-flight', () => {
  it('six concurrent primes (start-up + five restored terminals) launch the three probes once', async () => {
    const tm = await fresh()
    const pending = probesAnswer(true)
    const all = Promise.all(Array.from({ length: 6 }, () => tm.primeBundledToolsCheck()))
    await Promise.resolve()
    expect(h.offThread).toHaveBeenCalledTimes(3)
    pending.forEach((answer) => answer())
    expect(await all).toEqual([false, false, false, false, false, false])
    expect(h.offThread).toHaveBeenCalledTimes(3)
    expect(tm.bundledToolsCounters()).toMatchObject({ primes: 1 })
    // answered: later callers read the cache and launch nothing
    expect(await tm.primeBundledToolsCheck()).toBe(false)
    expect(h.offThread).toHaveBeenCalledTimes(3)
  })

  it('every caller gets the same answer when a tool is missing', async () => {
    const tm = await fresh()
    h.offThread.mockImplementation(async (cmd: string) => (cmd.endsWith('yq') ? { stdout: '', stderr: '', error: new Error('x') } : { stdout: 'x', stderr: '' }))
    expect(await Promise.all([tm.primeBundledToolsCheck(), tm.primeBundledToolsCheck()])).toEqual([true, true])
    expect(h.offThread).toHaveBeenCalledTimes(3)
  })

  it('a prime that failed outright counts the tools as missing and is not retried', async () => {
    const tm = await fresh()
    h.offThread.mockRejectedValue(new Error('no host'))
    expect(await tm.primeBundledToolsCheck()).toBe(true)
    expect(await tm.primeBundledToolsCheck()).toBe(true)
    expect(h.offThread).toHaveBeenCalledTimes(3)
  })
})

describe('a prepared spawn never runs the probe on the main thread', () => {
  it('while the start-up prime is still in flight: no execSync, the bundled tools are on PATH, the prime is shared', async () => {
    const tm = await fresh()
    const pending = probesAnswer(true)
    const startup = tm.primeBundledToolsCheck() // index.ts start-up: `void primeBundledToolsCheck()`
    tm.spawnTerminal('wf-step', process.execPath, process.cwd(), vi.fn(), undefined, undefined, undefined, prep)
    expect(h.execSync).not.toHaveBeenCalled()
    expect(pathOf().startsWith(TOOLS_DIR)).toBe(true)
    expect(tm.bundledToolsCounters()).toMatchObject({ unprimedPreparedSpawns: 1, primes: 1 })
    expect(h.offThread).toHaveBeenCalledTimes(3) // the spawn joined the start-up prime, it did not start another
    pending.forEach((answer) => answer())
    expect(await startup).toBe(false)
    // primed now: the next prepared spawn reads the answer (tools installed, so no bundled dir)
    tm.spawnTerminal('wf-step-2', process.execPath, process.cwd(), vi.fn(), undefined, undefined, undefined, prep)
    expect(pathOf().startsWith(TOOLS_DIR)).toBe(false)
    expect(tm.bundledToolsCounters()).toMatchObject({ unprimedPreparedSpawns: 1 })
    expect(h.execSync).not.toHaveBeenCalled()
  })

  it('with no prime at all, the spawn starts one on the proc host instead of probing on main', async () => {
    const tm = await fresh()
    const pending = probesAnswer(false)
    tm.spawnTerminal('run-and-wait', process.execPath, process.cwd(), vi.fn(), undefined, undefined, undefined, prep)
    expect(h.execSync).not.toHaveBeenCalled()
    expect(h.offThread).toHaveBeenCalledTimes(3)
    pending.forEach((answer) => answer())
    expect(await tm.primeBundledToolsCheck()).toBe(true)
  })

  it('TERMPOLIS_BUNDLED_TOOLS_SYNC_PROBE=1 puts back the sync probe for a prepared spawn (the 1.54.4 behaviour)', async () => {
    const tm = await fresh()
    process.env.TERMPOLIS_BUNDLED_TOOLS_SYNC_PROBE = '1'
    try {
      tm.spawnTerminal('wf-step', process.execPath, process.cwd(), vi.fn(), undefined, undefined, undefined, prep)
    } finally { delete process.env.TERMPOLIS_BUNDLED_TOOLS_SYNC_PROBE }
    expect(h.execSync).toHaveBeenCalledTimes(3)
    expect(h.offThread).not.toHaveBeenCalled()
    expect(tm.bundledToolsCounters()).toMatchObject({ unprimedPreparedSpawns: 0 })
  })

  it('control: a caller that did not prepare still gets the synchronous probe (the 1.54.4 path)', async () => {
    const tm = await fresh()
    tm.spawnTerminal('test', process.execPath, process.cwd(), vi.fn())
    expect(h.execSync).toHaveBeenCalledTimes(3)
    expect(tm.bundledToolsCounters()).toMatchObject({ unprimedPreparedSpawns: 0, primes: 0 })
  })
})
