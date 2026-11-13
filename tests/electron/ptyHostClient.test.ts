// ptyHostClient — main's side of the terminal process host (src/main/ptyHostClient.ts), with an injected transport.
//
// Load-bearing, and invisible in the happy path:
//   * the ready gate: until the host says ready, ptyHostReady() is false and terminals open in main.
//   * fail open, once: a host that dies or never gets ready ends its terminals (with a note) and every later
//     terminal opens in main. It is never restarted.
//   * replies are routed by key, and replies from a transport that is no longer current are dropped.
//   * a spawn that fails rejects `spawned`; sign-in's exitOnSpawnError also turns it into data plus exit(-1).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PtyHostReply, PtyHostRequest } from '../../src/main/ptyHost'
import {
  HOST_LOST_NOTE,
  READY_TIMEOUT_MS,
  _resetPtyHostClientForTests,
  connectRendererPort,
  gateHostPty,
  onPtyHostDown,
  onPtyHostInput,
  onPtyHostReady,
  ptyHostRouted,
  ptyHostSync,
  isHostPty,
  ptyHostDisabledByEnv,
  ptyHostReady,
  ptyHostTerminalCount,
  setPtyHostSpawner,
  shutdownPtyHost,
  spawnInPtyHost,
  startPtyHost,
  type PtyHostInput,
  type PtyHostTransport,
} from '../../src/main/ptyHostClient'

const OPTS = { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'C:/', env: {} }

function fakeTransport() {
  let onMsg: ((m: PtyHostReply) => void) | null = null
  let onExit: ((c: number) => void) | null = null
  const sent: PtyHostRequest[] = []
  const t: PtyHostTransport & { sent: PtyHostRequest[]; reply(m: PtyHostReply): void; die(code: number): void } = {
    sent,
    postMessage: vi.fn((m: PtyHostRequest) => { sent.push(m) }),
    onMessage: (cb) => { onMsg = cb },
    onExit: (cb) => { onExit = cb },
    kill: vi.fn(),
    reply: (m) => onMsg?.(m),
    die: (c) => onExit?.(c),
  }
  return t
}

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  _resetPtyHostClientForTests()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  _resetPtyHostClientForTests()
  vi.useRealTimers()
  errSpy.mockRestore()
})

function readyHost() {
  const t = fakeTransport()
  setPtyHostSpawner(() => t)
  startPtyHost({})
  t.reply({ kind: 'ready' })
  return t
}

describe('ptyHostClient: starting', () => {
  it('reads the kill switch', () => {
    expect(ptyHostDisabledByEnv({ TERMPOLIS_NO_PTY_HOST: '1' })).toBe(true)
    expect(ptyHostDisabledByEnv({ TERMPOLIS_NO_PTY_HOST: ' 1 ' })).toBe(true)
    expect(ptyHostDisabledByEnv({ TERMPOLIS_NO_PTY_HOST: '0' })).toBe(false)
    expect(ptyHostDisabledByEnv({})).toBe(false)
    expect(typeof ptyHostDisabledByEnv()).toBe('boolean')
  })

  it('does nothing without a spawner or when disabled', () => {
    startPtyHost({})
    expect(ptyHostReady()).toBe(false)
    const spawner = vi.fn(() => fakeTransport())
    setPtyHostSpawner(spawner)
    startPtyHost({ TERMPOLIS_NO_PTY_HOST: '1' })
    expect(spawner).not.toHaveBeenCalled()
  })

  it('is not ready until the host says so, then is; a second start is a no-op', () => {
    const t = fakeTransport()
    const spawner = vi.fn(() => t)
    setPtyHostSpawner(spawner)
    startPtyHost({})
    expect(ptyHostReady()).toBe(false)
    expect(() => spawnInPtyHost('cmd', [], OPTS)).toThrow('pty host not ready')
    t.reply({ kind: 'ready' })
    expect(ptyHostReady()).toBe(true)
    startPtyHost({})
    expect(spawner).toHaveBeenCalledTimes(1)
  })

  it('a spawner that throws leaves terminals in main for good', () => {
    const spawner = vi.fn(() => { throw new Error('no fork') })
    setPtyHostSpawner(spawner)
    startPtyHost({})
    expect(ptyHostReady()).toBe(false)
    setPtyHostSpawner(() => fakeTransport())
    startPtyHost({})
    expect(ptyHostReady()).toBe(false)
    expect(errSpy).toHaveBeenCalled()
  })

  it('a host that is not ready in time is killed and never used', () => {
    vi.useFakeTimers()
    const t = fakeTransport()
    setPtyHostSpawner(() => t)
    startPtyHost({})
    vi.advanceTimersByTime(READY_TIMEOUT_MS)
    expect(t.kill).toHaveBeenCalled()
    t.reply({ kind: 'ready' }) // too late: no longer the current transport
    expect(ptyHostReady()).toBe(false)
  })

  it('the ready timer is cleared by ready', () => {
    vi.useFakeTimers()
    const t = readyHost()
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2)
    expect(t.kill).not.toHaveBeenCalled()
    expect(ptyHostReady()).toBe(true)
  })
})

describe('ptyHostClient: a terminal in the host', () => {
  it('spawns by key, learns its pid, forwards data, writes, resizes, kills, and exits', async () => {
    const t = readyHost()
    const p = spawnInPtyHost('pwsh.exe', ['-NoLogo'], OPTS)
    expect(isHostPty(p)).toBe(true)
    expect(isHostPty({})).toBe(false)
    expect(isHostPty(null)).toBe(false)
    expect(p.pid).toBe(0)
    expect(t.sent[0]).toEqual({ kind: 'spawn', key: 1, file: 'pwsh.exe', args: ['-NoLogo'], opts: OPTS })
    expect(ptyHostTerminalCount()).toBe(1)
    // Writes before 'spawned' go out at once and arrive behind the spawn.
    p.write('early')
    t.reply({ kind: 'spawned', key: 1, pid: 4242 })
    expect(await p.spawned).toBe(4242)
    expect(p.pid).toBe(4242)
    const data: string[] = []
    const exits: number[] = []
    const sub = p.onData((d) => data.push(d))
    p.onExit((e) => exits.push(e.exitCode))
    t.reply({ kind: 'data', key: 1, data: 'PS> ' })
    sub.dispose()
    t.reply({ kind: 'data', key: 1, data: 'unheard' })
    p.resize(100, 30)
    p.kill([4242, 5])
    p.kill()
    expect(t.sent.slice(1)).toEqual([
      { kind: 'write', key: 1, data: 'early' },
      { kind: 'resize', key: 1, cols: 100, rows: 30 },
      { kind: 'kill', key: 1, consolePids: [4242, 5] },
      { kind: 'kill', key: 1, consolePids: null },
    ])
    t.reply({ kind: 'exit', key: 1, code: 0 })
    t.reply({ kind: 'exit', key: 1, code: 9 }) // already gone: ignored
    expect(data).toEqual(['PS> '])
    expect(exits).toEqual([0])
    expect(ptyHostTerminalCount()).toBe(0)
    // After exit nothing more is sent.
    const before = t.sent.length
    p.write('x'); p.resize(1, 1); p.kill()
    expect(t.sent.length).toBe(before)
  })

  it('keys are never reused and replies for unknown keys or junk are dropped', () => {
    const t = readyHost()
    const a = spawnInPtyHost('a', [], OPTS)
    const b = spawnInPtyHost('b', 'b --x', OPTS)
    expect(t.sent.map((m) => (m as { key: number }).key)).toEqual([1, 2])
    t.reply({ kind: 'spawned', key: 99, pid: 1 })
    t.reply(null as any)
    t.reply('x' as any)
    expect(a.pid).toBe(0)
    expect(b.pid).toBe(0)
  })

  it('a listener that throws does not stop the others', () => {
    const t = readyHost()
    const p = spawnInPtyHost('a', [], OPTS)
    const seen: string[] = []
    p.onData(() => { throw new Error('boom') })
    p.onData((d) => seen.push(d))
    const exits: number[] = []
    const ex = p.onExit(() => { throw new Error('boom') })
    p.onExit((e) => exits.push(e.exitCode))
    ex.dispose()
    p.onExit(() => { throw new Error('boom again') })
    t.reply({ kind: 'spawned', key: 1, pid: 7 })
    t.reply({ kind: 'data', key: 1, data: 'x' })
    t.reply({ kind: 'exit', key: 1, code: 2 })
    expect(seen).toEqual(['x'])
    expect(exits).toEqual([2])
  })

  it('a spawn the host could not make rejects spawned, and only that', async () => {
    const t = readyHost()
    const p = spawnInPtyHost('nope.exe', [], OPTS)
    const data = vi.fn()
    const exit = vi.fn()
    p.onData(data)
    p.onExit(exit)
    t.reply({ kind: 'spawn-error', key: 1, message: 'File not found' })
    await expect(p.spawned).rejects.toThrow('File not found')
    expect(data).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(ptyHostTerminalCount()).toBe(0)
    const n = t.sent.length
    p.write('x')
    expect(t.sent.length).toBe(n)
  })

  it('exitOnSpawnError: the message becomes the terminal output, then exit(-1)', async () => {
    const t = readyHost()
    const p = spawnInPtyHost('claude', [], OPTS, { exitOnSpawnError: true })
    const data: string[] = []
    const exits: number[] = []
    p.onData((d) => data.push(d))
    p.onExit((e) => exits.push(e.exitCode))
    t.reply({ kind: 'spawn-error', key: 1, message: 'Access denied' })
    await expect(p.spawned).rejects.toThrow('Access denied')
    expect(data).toEqual(['Access denied\r\n'])
    expect(exits).toEqual([-1])
  })

  it('a post that throws is logged, not thrown', () => {
    const t = readyHost()
    ;(t.postMessage as any).mockImplementation(() => { throw new Error('channel closed') })
    expect(() => spawnInPtyHost('a', [], OPTS)).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('ptyHostClient: the host going away', () => {
  it('a crash ends every terminal with the note, fails pending spawns, and is never restarted', async () => {
    const t = readyHost()
    const running = spawnInPtyHost('a', [], OPTS)
    const pending = spawnInPtyHost('b', [], OPTS)
    t.reply({ kind: 'spawned', key: 1, pid: 10 })
    const data: string[] = []
    const exits: number[] = []
    running.onData((d) => data.push(d))
    running.onExit((e) => exits.push(e.exitCode))
    t.die(3)
    expect(data).toEqual([HOST_LOST_NOTE])
    expect(exits).toEqual([-1])
    await expect(pending.spawned).rejects.toThrow('the terminal process stopped')
    expect(t.kill).not.toHaveBeenCalled() // it exited on its own
    expect(ptyHostReady()).toBe(false)
    expect(ptyHostTerminalCount()).toBe(0)
    // Later messages from the dead host, and its sends, go nowhere.
    t.reply({ kind: 'ready' })
    expect(ptyHostReady()).toBe(false)
    const n = t.sent.length
    running.write('x')
    expect(t.sent.length).toBe(n)
    // Never restarted.
    const spawner = vi.fn(() => fakeTransport())
    setPtyHostSpawner(spawner)
    startPtyHost({})
    expect(spawner).not.toHaveBeenCalled()
    // A second exit report from the old transport is ignored.
    expect(() => t.die(1)).not.toThrow()
  })

  it('shutdown kills the host quietly: terminals exit with no note', () => {
    const t = readyHost()
    const p = spawnInPtyHost('a', [], OPTS)
    t.reply({ kind: 'spawned', key: 1, pid: 10 })
    const data: string[] = []
    const exits: number[] = []
    p.onData((d) => data.push(d))
    p.onExit((e) => exits.push(e.exitCode))
    shutdownPtyHost()
    expect(t.kill).toHaveBeenCalled()
    expect(data).toEqual([])
    expect(exits).toEqual([-1])
    expect(ptyHostReady()).toBe(false)
  })

  it('shutdown before any host keeps one from starting; a kill that throws is swallowed', () => {
    shutdownPtyHost()
    const spawner = vi.fn(() => fakeTransport())
    setPtyHostSpawner(spawner)
    startPtyHost({})
    expect(spawner).not.toHaveBeenCalled()
    _resetPtyHostClientForTests()
    const t = readyHost()
    ;(t.kill as any).mockImplementation(() => { throw new Error('gone') })
    expect(() => shutdownPtyHost()).not.toThrow()
    // The test reset tolerates a throwing kill too.
    const t2 = readyHost()
    void t2
  })

  it('a second ready is harmless, and shutdown before ready clears the ready timer', () => {
    vi.useFakeTimers()
    const t = readyHost()
    t.reply({ kind: 'ready' })
    expect(ptyHostReady()).toBe(true)
    _resetPtyHostClientForTests()
    const t2 = fakeTransport()
    setPtyHostSpawner(() => t2)
    startPtyHost({})
    shutdownPtyHost()
    expect(t2.kill).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2)
    expect(t2.kill).toHaveBeenCalledTimes(1)
  })

  it('a pty of a transport that is no longer current sends nothing', () => {
    const t = readyHost()
    const p = spawnInPtyHost('a', [], OPTS)
    _resetPtyHostClientForTests()
    const n = t.sent.length
    p.write('x')
    expect(t.sent.length).toBe(n)
  })

  it('the test reset tolerates a transport whose kill throws', () => {
    _resetPtyHostClientForTests()
    const t = fakeTransport()
    ;(t.kill as any).mockImplementation(() => { throw new Error('gone') })
    setPtyHostSpawner(() => t)
    startPtyHost({})
    expect(() => _resetPtyHostClientForTests()).not.toThrow()
  })
})

describe('ptyHostClient: the direct typing line (1.61.0)', () => {
  it('passes a direct spec with the spawn, and leaves it out when there is none', () => {
    const t = readyHost()
    spawnInPtyHost('pwsh', [], OPTS, { direct: { id: 'term', base: 7 } })
    spawnInPtyHost('pwsh', [], OPTS)
    expect(t.sent).toEqual([
      { kind: 'spawn', key: 1, file: 'pwsh', args: [], opts: OPTS, direct: { id: 'term', base: 7 } },
      { kind: 'spawn', key: 2, file: 'pwsh', args: [], opts: OPTS },
    ])
  })

  it('hands writes from the host to the listeners, checked; a throwing listener does not stop the rest', () => {
    const t = readyHost()
    const got: PtyHostInput[] = []
    onPtyHostInput(() => { throw new Error('boom') })
    onPtyHostInput((i) => got.push(i))
    t.reply({ kind: 'typed', key: 3, id: 'a', data: 'x' })
    t.reply({ kind: 'via-main', key: null, id: 'b', data: 'y' })
    t.reply({ kind: 'via-main', key: 'k' as unknown as number, id: 'c', data: 'z' })
    t.reply({ kind: 'typed', key: 1, id: 5 as unknown as string, data: 'x' })
    t.reply({ kind: 'typed', key: 1, id: 'a', data: null as unknown as string })
    expect(got).toEqual([
      { kind: 'typed', key: 3, id: 'a', data: 'x' },
      { kind: 'via-main', key: null, id: 'b', data: 'y' },
      { kind: 'via-main', key: null, id: 'c', data: 'z' },
    ])
  })

  it('tells listeners when the host is ready and when it goes', () => {
    const ready = vi.fn()
    const down = vi.fn()
    onPtyHostReady(() => { throw new Error('r') })
    onPtyHostReady(ready)
    onPtyHostDown(() => { throw new Error('d') })
    onPtyHostDown(down)
    const t = readyHost()
    expect(ready).toHaveBeenCalledTimes(1)
    t.die(1)
    expect(down).toHaveBeenCalledTimes(1)
  })

  it('routed and sync go to the host; nothing is sent with no host, and a failing post is swallowed', () => {
    ptyHostRouted(1) // no host: nothing
    const t = readyHost()
    ptyHostRouted(4)
    ptyHostSync('a', 9)
    expect(t.sent).toEqual([{ kind: 'routed', key: 4 }, { kind: 'sync', id: 'a', n: 9 }])
    ;(t.postMessage as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('gone') })
    expect(() => ptyHostRouted(5)).not.toThrow()
  })

  it('connectRendererPort: only a ready host whose transport takes ports gets one', () => {
    expect(connectRendererPort({})).toBe(false) // no host
    const t = fakeTransport()
    setPtyHostSpawner(() => t)
    startPtyHost({})
    const port = { p: 1 }
    expect(connectRendererPort(port)).toBe(false) // not ready
    t.reply({ kind: 'ready' })
    expect(connectRendererPort(port)).toBe(false) // no postPort
    const postPort = vi.fn()
    t.postPort = postPort
    expect(connectRendererPort(port)).toBe(true)
    expect(postPort).toHaveBeenCalledWith(port)
    postPort.mockImplementation(() => { throw new Error('closed') })
    expect(connectRendererPort(port)).toBe(false)
  })

  it('gateHostPty: a hold reaches a host pty until it exits; a pty in main is left alone', () => {
    const t = readyHost()
    const p = spawnInPtyHost('pwsh', [], OPTS)
    gateHostPty(p, 500)
    gateHostPty({ write: () => {} }, 500)
    gateHostPty(undefined, 500)
    expect(t.sent.filter((m) => m.kind === 'gate')).toEqual([{ kind: 'gate', key: 1, until: 500 }])
    t.reply({ kind: 'exit', key: 1, code: 0 })
    gateHostPty(p, 0)
    expect(t.sent.filter((m) => m.kind === 'gate')).toHaveLength(1)
  })
})
