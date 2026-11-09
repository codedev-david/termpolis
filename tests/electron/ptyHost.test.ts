// ptyHost — the terminal process host's handler (src/main/ptyHost.ts), driven with a fake spawn.
//
// Load-bearing, and invisible when it works:
//   * a spawn that throws comes back as `spawn-error`, never a crash of the host (every terminal in it would go).
//   * `spawned` goes out before the first data, so main knows the pid before any byte.
//   * node-pty's Windows kill() lists the console's programs by forking a helper; from a utility process that fork is
//     not guaranteed to start Node. The handler replaces that lookup on spawn, and at kill with main's list.

import { describe, it, expect, vi } from 'vitest'
import { createPtyHostHandler, type HostedPty, type PtyHostReply, type PtyHostSpawnOptions } from '../../src/main/ptyHost'

const OPTS: PtyHostSpawnOptions = { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'C:/', env: { A: '1' } }

function fakePty(pid: number, agent = true) {
  const data: Array<(d: string) => void> = []
  const exit: Array<(e: { exitCode: number }) => void> = []
  const forked = vi.fn(() => Promise.resolve([pid]))
  const p = {
    pid,
    _agent: agent ? { innerPid: pid + 1, _getConsoleProcessList: forked } as { innerPid?: number; _getConsoleProcessList: () => Promise<number[]> } : undefined,
    onData: (cb: (d: string) => void) => { data.push(cb) },
    onExit: (cb: (e: { exitCode: number }) => void) => { exit.push(cb) },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emit: (d: string) => { for (const cb of data) cb(d) },
    end: (e: any) => { for (const cb of exit) cb(e) },
    forked,
  }
  return p
}

function setup() {
  const made: Array<ReturnType<typeof fakePty>> = []
  const spawn = vi.fn((_f: string, _a: string[] | string, _o: PtyHostSpawnOptions) => {
    const p = fakePty(1000 + made.length)
    made.push(p)
    return p as unknown as HostedPty
  })
  const posts: PtyHostReply[] = []
  const host = createPtyHostHandler(spawn, (r) => posts.push(r))
  return { spawn, posts, host, made }
}

describe('ptyHost handler', () => {
  it('spawns, says spawned with the pid, then forwards data and exit by key', () => {
    const { spawn, posts, host, made } = setup()
    host.handle({ kind: 'spawn', key: 7, file: 'cmd.exe', args: ['/k'], opts: OPTS })
    expect(spawn).toHaveBeenCalledWith('cmd.exe', ['/k'], OPTS)
    expect(posts).toEqual([{ kind: 'spawned', key: 7, pid: 1000 }])
    expect(host.size).toBe(1)
    made[0].emit('hello')
    made[0].end({ exitCode: 3 })
    expect(posts.slice(1)).toEqual([{ kind: 'data', key: 7, data: 'hello' }, { kind: 'exit', key: 7, code: 3 }])
    expect(host.size).toBe(0)
  })

  it('an exit with no numeric code reports -1', () => {
    const { posts, host, made } = setup()
    host.handle({ kind: 'spawn', key: 1, file: 'x', args: 'x --y', opts: OPTS })
    made[0].end(undefined)
    expect(posts.at(-1)).toEqual({ kind: 'exit', key: 1, code: -1 })
  })

  it('a spawn that throws comes back as spawn-error with its message, and the host keeps going', () => {
    const posts: PtyHostReply[] = []
    let n = 0
    const host = createPtyHostHandler(() => {
      n++
      if (n === 1) throw new Error('File not found: nope.exe')
      if (n === 2) throw 'plain string'
      if (n === 3) throw new Error('')
      return fakePty(5) as unknown as HostedPty
    }, (r) => posts.push(r))
    host.handle({ kind: 'spawn', key: 1, file: 'nope.exe', args: [], opts: OPTS })
    host.handle({ kind: 'spawn', key: 2, file: 'x', args: [], opts: OPTS })
    host.handle({ kind: 'spawn', key: 3, file: 'x', args: [], opts: OPTS })
    host.handle({ kind: 'spawn', key: 4, file: 'ok', args: [], opts: OPTS })
    expect(posts).toEqual([
      { kind: 'spawn-error', key: 1, message: 'File not found: nope.exe' },
      { kind: 'spawn-error', key: 2, message: 'plain string' },
      { kind: 'spawn-error', key: 3, message: 'Error' },
      { kind: 'spawned', key: 4, pid: 5 },
    ])
    expect(host.size).toBe(1)
  })

  it('write and resize reach the right pty; unknown keys and a throwing pty are ignored', () => {
    const { host, made } = setup()
    host.handle({ kind: 'spawn', key: 1, file: 'a', args: [], opts: OPTS })
    host.handle({ kind: 'spawn', key: 2, file: 'b', args: [], opts: OPTS })
    host.handle({ kind: 'write', key: 2, data: 'ls\r' })
    host.handle({ kind: 'resize', key: 1, cols: 120, rows: 40 })
    host.handle({ kind: 'write', key: 99, data: 'lost' })
    host.handle({ kind: 'resize', key: 99, cols: 1, rows: 1 })
    expect(made[1].write).toHaveBeenCalledWith('ls\r')
    expect(made[0].write).not.toHaveBeenCalled()
    expect(made[0].resize).toHaveBeenCalledWith(120, 40)
    made[0].write.mockImplementation(() => { throw new Error('closed') })
    made[0].resize.mockImplementation(() => { throw new Error('closed') })
    expect(() => host.handle({ kind: 'write', key: 1, data: 'x' })).not.toThrow()
    expect(() => host.handle({ kind: 'resize', key: 1, cols: 2, rows: 2 })).not.toThrow()
  })

  it('never forks for the console list: replaced on spawn (shell alone), and at kill with main\'s list', async () => {
    const { host, made } = setup()
    host.handle({ kind: 'spawn', key: 1, file: 'a', args: [], opts: OPTS })
    const p = made[0]
    // Before any kill: the shell alone (innerPid), and node-pty's forking original is gone.
    expect(await p._agent!._getConsoleProcessList()).toEqual([1001])
    host.handle({ kind: 'kill', key: 1, consolePids: [1001, 2002, 3003] })
    expect(p.kill).toHaveBeenCalledTimes(1)
    expect(await p._agent!._getConsoleProcessList()).toEqual([1001, 2002, 3003])
    // An empty or absent list falls back to the shell alone.
    host.handle({ kind: 'kill', key: 1, consolePids: [] })
    expect(await p._agent!._getConsoleProcessList()).toEqual([1001])
    host.handle({ kind: 'kill', key: 1 })
    expect(await p._agent!._getConsoleProcessList()).toEqual([1001])
    expect(p.forked).not.toHaveBeenCalled()
  })

  it('the console-list fallback uses pid when the agent has no innerPid, and ptys with no agent are left alone', async () => {
    const posts: PtyHostReply[] = []
    const noInner = fakePty(50)
    delete (noInner._agent as { innerPid?: number }).innerPid
    const noAgent = fakePty(60, false)
    const queue = [noInner, noAgent]
    const host = createPtyHostHandler(() => queue.shift() as unknown as HostedPty, (r) => posts.push(r))
    host.handle({ kind: 'spawn', key: 1, file: 'a', args: [], opts: OPTS })
    host.handle({ kind: 'spawn', key: 2, file: 'b', args: [], opts: OPTS })
    expect(await noInner._agent!._getConsoleProcessList()).toEqual([50])
    host.handle({ kind: 'kill', key: 2, consolePids: [1] })
    expect(noAgent.kill).toHaveBeenCalled()
  })

  it('kill of an unknown key does nothing, and a kill that throws is swallowed', () => {
    const { host, made } = setup()
    expect(() => host.handle({ kind: 'kill', key: 5 })).not.toThrow()
    host.handle({ kind: 'spawn', key: 1, file: 'a', args: [], opts: OPTS })
    made[0].kill.mockImplementation(() => { throw new Error('gone') })
    expect(() => host.handle({ kind: 'kill', key: 1 })).not.toThrow()
  })

  it('ignores messages that are not objects', () => {
    const { host, posts } = setup()
    host.handle(null as any)
    host.handle('spawn' as any)
    host.handle({ kind: 'nonsense' } as any)
    expect(posts).toEqual([])
  })
})
