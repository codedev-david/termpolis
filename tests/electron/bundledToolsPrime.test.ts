// 1.54.5 (HP2-01, HP2-02): the jq/yq/nano probe that decides whether a terminal's PATH gets Termpolis's bundled
// tools. Counters, not timings:
//  - primeBundledToolsCheck is single-flight: the start-up prime and every terminal created during a session
//    restore (or a swarm opening N terminals) share ONE set of three probes on the proc host, not 3 x N.
//  - a PREPARED spawn (every app path: a click, create_terminal, a workflow command or agent step, run_and_wait)
//    never runs the probe with execSync on the main thread. If the prime has not answered yet, it takes the
//    bundled tools (the answer that can only add tools, never take one away) and leaves the prime to finish.
//  - control: a caller that did not prepare (a test, a spawner given no prepare()) still gets the sync probe.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
