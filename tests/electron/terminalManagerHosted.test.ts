// terminalManager with the pty host up (perf155 P14): the shell starts in the host, everything else stays in main.
//
// The real ptyHostClient over a fake transport, so what is asserted is the wire: what main asks the host, and what a
// terminal does with the host's replies. Load-bearing:
//   * no pty is spawned in main once the host is ready (the point of the host);
//   * a spawn the host could not make rejects with main's own "Failed to open terminal" and leaves no terminal behind;
//   * a close reads the console's programs through the proc host and hands the list over, never forking for it;
//   * quitting waits for a shell the host is still starting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PtyHostReply, PtyHostRequest } from '../../src/main/ptyHost'

const h = vi.hoisted(() => ({
  spawn: vi.fn(() => { throw new Error('main must not spawn a pty while the host is up') }),
  consoleList: vi.fn(async (_pid: number): Promise<number[] | null> => null),
}))

vi.mock('node-pty', () => ({ spawn: h.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
vi.mock('../../src/main/shellAlone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/shellAlone')>()),
  readConsoleProcessList: h.consoleList,
}))

const tm = await import('../../src/main/terminalManager')
const client = await import('../../src/main/ptyHostClient')

const PREP = { cwd: process.cwd(), integrationScript: null }
const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
}

function hostUp() {
  let onMsg: ((m: PtyHostReply) => void) | null = null
  let onExit: ((c: number) => void) | null = null
  const sent: PtyHostRequest[] = []
  const t = {
    postMessage: vi.fn((m: PtyHostRequest) => { sent.push(m) }),
    onMessage: (cb: (m: PtyHostReply) => void) => { onMsg = cb },
    onExit: (cb: (c: number) => void) => { onExit = cb },
    kill: vi.fn(),
  }
  client.setPtyHostSpawner(() => t)
  client.startPtyHost({})
  onMsg!({ kind: 'ready' })
  return { t, sent, reply: (m: PtyHostReply) => onMsg!(m), die: (c: number) => onExit!(c) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setPlatform('win32')
  client._resetPtyHostClientForTests()
  tm._resetTerminalExitsForTests()
  h.spawn.mockClear()
  h.consoleList.mockReset()
  h.consoleList.mockResolvedValue(null)
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  tm.killAll()
  client._resetPtyHostClientForTests()
  tm._resetTerminalExitsForTests()
  setPlatform(realPlatform)
  errSpy.mockRestore()
})

describe('terminalManager: a terminal in the pty host', () => {
  it('starts the shell in the host, not here, and works through it', async () => {
    const host = hostUp()
    const onData = vi.fn()
    const onExit = vi.fn()
    const started = tm.spawnTerminal('h1', 'cmd.exe', 'C:/', onData, undefined, undefined, onExit, PREP)
    expect(h.spawn).not.toHaveBeenCalled()
    const spawn = host.sent[0] as Extract<PtyHostRequest, { kind: 'spawn' }>
    expect(spawn.kind).toBe('spawn')
    expect(spawn.file).toBe('cmd.exe')
    expect(spawn.opts.cwd).toBe(PREP.cwd)
    expect(spawn.opts.env.TERMPOLIS_TERMINAL_ID).toBe('h1')
    // A shell the host is still starting: no pid yet, but quitting waits for it.
    expect(tm.getTerminalPid('h1')).toBeNull()
    expect(tm.runningShellCount()).toBe(1)
    // Typing and a resize before the shell started go out behind the spawn.
    tm.writeToTerminal('h1', 'dir\r')
    tm.resizeTerminal('h1', 120, 40)
    host.reply({ kind: 'spawned', key: spawn.key, pid: 777 })
    await started
    expect(tm.getTerminalPid('h1')).toBe(777)
    expect(tm.isShellInForeground('h1')).toBeNull()
    host.reply({ kind: 'data', key: spawn.key, data: 'C:\\> ' })
    await vi.waitFor(() => expect(onData).toHaveBeenCalledWith('C:\\> '))
    expect(host.sent.slice(1)).toEqual([
      { kind: 'write', key: spawn.key, data: 'dir\r' },
      { kind: 'resize', key: spawn.key, cols: 120, rows: 40 },
    ])
    host.reply({ kind: 'exit', key: spawn.key, code: 0 })
    expect(onExit).toHaveBeenCalledWith(0)
    expect(tm.runningShellCount()).toBe(0)
    expect(tm.getTerminalPid('h1')).toBeNull()
  })

  it('a spawn the host could not make rejects as a spawn here throws, and leaves no terminal', async () => {
    const host = hostUp()
    const onExit = vi.fn()
    const started = tm.spawnTerminal('h2', 'nope.exe', 'C:/', vi.fn(), undefined, undefined, onExit, PREP)
    const key = (host.sent[0] as { key: number }).key
    host.reply({ kind: 'spawn-error', key, message: 'File not found: nope.exe' })
    await expect(started).rejects.toThrow('Failed to open terminal: File not found: nope.exe')
    expect(onExit).not.toHaveBeenCalled()
    expect(tm.runningShellCount()).toBe(0)
    expect(tm.getTerminalSize('h2')).toBeNull()
  })

  it('a failed spawn under an id already reused keeps the new terminal', async () => {
    const host = hostUp()
    const first = tm.spawnTerminal('same', 'a.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    tm.killTerminal('same') // pid unknown yet: the shell alone, at once
    void tm.spawnTerminal('same', 'b.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    host.reply({ kind: 'spawn-error', key: (host.sent[0] as { key: number }).key, message: 'gone' })
    await expect(first).rejects.toThrow('gone')
    expect(tm.getTerminalSize('same')).not.toBeNull()
  })

  it('an exit for a terminal whose id was reused leaves the new one alone', async () => {
    const host = hostUp()
    const onExit = vi.fn()
    void tm.spawnTerminal('re', 'a.exe', 'C:/', vi.fn(), undefined, undefined, onExit, PREP)
    const key1 = (host.sent[0] as { key: number }).key
    host.reply({ kind: 'spawned', key: key1, pid: 10 })
    tm.killTerminal('re')
    await flush()
    void tm.spawnTerminal('re', 'b.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    host.reply({ kind: 'exit', key: key1, code: 1 })
    expect(onExit).toHaveBeenCalledWith(1)
    expect(tm.getTerminalSize('re')).not.toBeNull()
  })

  it('closing reads the console\'s programs through the proc host and hands them to the host', async () => {
    const host = hostUp()
    h.consoleList.mockResolvedValueOnce([10, 11, 12])
    void tm.spawnTerminal('k1', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    const key = (host.sent[0] as { key: number }).key
    host.reply({ kind: 'spawned', key, pid: 10 })
    await flush()
    tm.killTerminal('k1')
    expect(h.consoleList).toHaveBeenCalledWith(10)
    await vi.waitFor(() => expect(host.sent.at(-1)).toEqual({ kind: 'kill', key, consolePids: [10, 11, 12] }))
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('with the tree killer on, the tree goes after the list is read and before the host ends the shell', async () => {
    const tk = await import('../../src/main/terminalTreeKill')
    const host = hostUp()
    h.consoleList.mockResolvedValueOnce([10, 11])
    let release!: (ended: ReadonlySet<number>) => void
    const killer = vi.fn(() => new Promise<ReadonlySet<number>>((r) => { release = r }))
    tk.setTerminalTreeKiller(killer)
    try {
      void tm.spawnTerminal('kt', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
      const key = (host.sent[0] as { key: number }).key
      host.reply({ kind: 'spawned', key, pid: 10 })
      await flush()
      tm.killTerminal('kt')
      await vi.waitFor(() => expect(killer).toHaveBeenCalledWith(10))
      expect(host.sent.some((m) => m.kind === 'kill')).toBe(false) // the shell still leads taskkill to its tree
      // taskkill ended the shell itself; 11 is on the console but not in the tree, so it still goes.
      release(new Set([10]))
      await vi.waitFor(() => expect(host.sent.at(-1)).toEqual({ kind: 'kill', key, consolePids: [11] }))
      // A killer that rejects anyway still lets the shell go.
      killer.mockImplementationOnce(() => Promise.reject(new Error('broken')))
      h.consoleList.mockRejectedValueOnce(new Error('no list'))
      void tm.spawnTerminal('kt2', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
      const key2 = (host.sent.at(-1) as { key: number }).key
      host.reply({ kind: 'spawned', key: key2, pid: 12 })
      await flush()
      tm.killTerminal('kt2')
      await vi.waitFor(() => expect(host.sent.at(-1)).toEqual({ kind: 'kill', key: key2, consolePids: null }))
    } finally {
      tk.setTerminalTreeKiller(null)
    }
  })

  it('closing when the list cannot be read ends the shell alone', async () => {
    const host = hostUp()
    h.consoleList.mockRejectedValueOnce(new Error('proc host down'))
    void tm.spawnTerminal('k2', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    const key = (host.sent[0] as { key: number }).key
    host.reply({ kind: 'spawned', key, pid: 20 })
    await flush()
    tm.killTerminal('k2')
    await vi.waitFor(() => expect(host.sent.at(-1)).toEqual({ kind: 'kill', key, consolePids: null }))
  })

  it('closing before the host said the pid ends the shell alone, without asking for a list', () => {
    const host = hostUp()
    void tm.spawnTerminal('k3', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    tm.killTerminal('k3')
    expect(h.consoleList).not.toHaveBeenCalled()
    expect(host.sent.at(-1)).toEqual({ kind: 'kill', key: (host.sent[0] as { key: number }).key, consolePids: null })
  })

  it('the host dying ends its terminals with a note, and the next terminal opens here', async () => {
    const host = hostUp()
    const onData = vi.fn()
    const onExit = vi.fn()
    void tm.spawnTerminal('d1', 'cmd.exe', 'C:/', onData, undefined, undefined, onExit, PREP)
    host.reply({ kind: 'spawned', key: (host.sent[0] as { key: number }).key, pid: 30 })
    host.die(1)
    expect(onExit).toHaveBeenCalledWith(-1)
    expect(onData.mock.calls.map((c) => c[0]).join('')).toContain('the terminal process stopped')
    expect(client.ptyHostReady()).toBe(false)
    // Back to main: node-pty is asked (and here throws, which spawnTerminal reports as it always has).
    expect(() => tm.spawnTerminal('d2', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)).toThrow('Failed to open terminal')
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('off Windows the host is not used even when ready', () => {
    hostUp()
    setPlatform('linux')
    expect(() => tm.spawnTerminal('l1', '/bin/bash', '/tmp', vi.fn(), undefined, undefined, undefined, PREP)).toThrow('Failed to open terminal')
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('quitting waits for a hosted shell, and a still-starting one is never SIGKILLed by pid 0', async () => {
    const host = hostUp()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      void tm.spawnTerminal('q1', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
      const waited = tm.whenTerminalsExit(40)
      await waited
      expect(kill).not.toHaveBeenCalledWith(0, expect.anything())
      host.reply({ kind: 'spawned', key: (host.sent[0] as { key: number }).key, pid: 55 })
      await flush()
      await tm.whenTerminalsExit(40)
      expect(kill).toHaveBeenCalledWith(55, 'SIGKILL')
    } finally {
      kill.mockRestore()
    }
  })
})

describe('terminalManager: the direct typing line (1.61.0)', () => {
  it('passes the direct spec to the host under the terminal id, and gates the host pty', async () => {
    const host = hostUp()
    void tm.spawnTerminal('d1', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP, { base: 12 })
    const spawn = host.sent[0] as Extract<PtyHostRequest, { kind: 'spawn' }>
    expect(spawn.direct).toEqual({ id: 'd1', base: 12 })
    tm.gateTerminal('d1', 900)
    tm.gateTerminal('missing', 900)
    expect(host.sent.filter((m) => m.kind === 'gate')).toEqual([{ kind: 'gate', key: spawn.key, until: 900 }])
    void tm.spawnTerminal('d2', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP)
    expect((host.sent.at(-1) as Extract<PtyHostRequest, { kind: 'spawn' }>).direct).toBeUndefined()
    void tm.spawnTerminal('d3', 'cmd.exe', 'C:/', vi.fn(), undefined, undefined, undefined, PREP, { base: 0, until: 5000 })
    expect((host.sent.at(-1) as Extract<PtyHostRequest, { kind: 'spawn' }>).direct).toEqual({ id: 'd3', base: 0, until: 5000 })
  })
})
