// ptyHost — the direct typing line's far end (src/main/ptyHost.ts, 1.61.0), driven with a fake spawn, a recording
// `post` to main and fake renderer ports.
//
// What must hold:
//   * a write from the renderer reaches the pty at once, and main gets a copy (`typed`) for what watches writes;
//   * a write main must judge first (a relaunch hold, a possible strict-mode `gemini`) goes to main unwritten
//     (`via-main`), and every later write to that terminal waits until main says it is done (`routed`), so order holds;
//   * a write marked behind writes that went through main waits for main's mark (`sync`);
//   * output still goes to main whole, and to the renderer only for a terminal with a pane, tagged with its end on main's
//     buffer scale;
//   * nothing is lost when a terminal ends, a port is replaced or a pane goes.

import { describe, it, expect, vi } from 'vitest'
import { createPtyHostHandler, type DirectPort, type HostedPty, type PtyHostReply, type PtyHostSpawnOptions } from '../../src/main/ptyHost'
import type { DirectFromHost } from '../../src/shared/ptyDirect'

const OPTS: PtyHostSpawnOptions = { name: 'xterm-256color', cols: 80, rows: 24, cwd: 'C:/', env: {} }

function fakePty(pid: number) {
  const data: Array<(d: string) => void> = []
  const exit: Array<(e: { exitCode: number }) => void> = []
  return {
    pid,
    onData: (cb: (d: string) => void) => { data.push(cb) },
    onExit: (cb: (e: { exitCode: number }) => void) => { exit.push(cb) },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emit: (d: string) => { for (const cb of data) cb(d) },
    end: (code = 0) => { for (const cb of exit) cb({ exitCode: code }) },
  }
}

function fakePort(fail = false) {
  const got: DirectFromHost[] = []
  const port: DirectPort = {
    postMessage: (m) => {
      if (fail) throw new Error('closed')
      got.push(m)
    },
  }
  return { port, got }
}

function setup() {
  let t = 1000
  const timers: Array<() => void> = []
  const made: Array<ReturnType<typeof fakePty>> = []
  const posts: PtyHostReply[] = []
  const host = createPtyHostHandler(
    () => {
      const p = fakePty(2000 + made.length)
      made.push(p)
      return p as unknown as HostedPty
    },
    (r) => posts.push(r),
    {
      now: () => t,
      setTimer: (fn) => { timers.push(fn); return timers.length },
      clearTimer: () => {},
    },
  )
  const spawn = (key: number, id = 'term', base = 0): ReturnType<typeof fakePty> => {
    host.handle({ kind: 'spawn', key, file: 'pwsh', args: [], opts: OPTS, direct: { id, base } })
    return made[made.length - 1]
  }
  const fire = (): void => { for (const f of timers.splice(0)) f() }
  const ofKind = <K extends PtyHostReply['kind']>(k: K) => posts.filter((p) => p.kind === k) as Array<Extract<PtyHostReply, { kind: K }>>
  return { host, made, posts, spawn, fire, ofKind, setNow: (n: number) => { t = n } }
}

describe('ptyHost direct line: writes', () => {
  it('a direct spawn binds the terminal for the renderer (fresh), and re-binds every terminal on a new port without fresh', () => {
    const s = setup()
    const a = fakePort()
    s.host.attachRenderer(a.port)
    s.spawn(1, 'term')
    expect(a.got).toEqual([{ t: 'bind', id: 'term', fresh: true }])
    const b = fakePort()
    s.host.attachRenderer(b.port)
    expect(b.got).toEqual([{ t: 'bind', id: 'term' }])
  })

  it('a spawn without a valid direct spec is not on the line', () => {
    const s = setup()
    const a = fakePort()
    s.host.attachRenderer(a.port)
    s.host.handle({ kind: 'spawn', key: 1, file: 'x', args: [], opts: OPTS })
    s.host.handle({ kind: 'spawn', key: 2, file: 'x', args: [], opts: OPTS, direct: { id: '', base: 0 } })
    s.host.handle({ kind: 'spawn', key: 3, file: 'x', args: [], opts: OPTS, direct: { id: 'x', base: -1 } })
    s.host.handle({ kind: 'spawn', key: 4, file: 'x', args: [], opts: OPTS, direct: { id: 'x', base: Number.NaN } })
    expect(a.got).toEqual([])
    s.host.fromRenderer({ t: 'w', id: 'x', data: 'a' })
    expect(s.ofKind('via-main')).toEqual([{ kind: 'via-main', key: null, id: 'x', data: 'a' }])
  })

  it('a hold that came with the spawn gates the new pty from its first write', () => {
    const s = setup()
    s.host.handle({ kind: 'spawn', key: 8, file: 'pwsh', args: [], opts: OPTS, direct: { id: 'held', base: 0, until: 2000 } })
    s.host.handle({ kind: 'spawn', key: 9, file: 'pwsh', args: [], opts: OPTS, direct: { id: 'odd', base: 0, until: Number.NaN } })
    s.host.fromRenderer({ t: 'w', id: 'held', data: 'x' })
    s.host.fromRenderer({ t: 'w', id: 'odd', data: 'y' })
    expect(s.made[0].write).not.toHaveBeenCalled()
    expect(s.ofKind('via-main')).toEqual([{ kind: 'via-main', key: 8, id: 'held', data: 'x' }])
    expect(s.made[1].write).toHaveBeenCalledWith('y')
  })

  it('a write reaches the pty at once and main gets a copy', () => {
    const s = setup()
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'l' })
    expect(p.write).toHaveBeenCalledWith('l')
    expect(s.ofKind('typed')).toEqual([{ kind: 'typed', key: 5, id: 'term', data: 'l' }])
  })

  it('a write to a terminal the host does not hold goes to main, with no key to wait on', () => {
    const s = setup()
    s.host.fromRenderer({ t: 'w', id: 'nope', data: 'x' })
    expect(s.ofKind('via-main')).toEqual([{ kind: 'via-main', key: null, id: 'nope', data: 'x' }])
  })

  it('a possible strict-mode launch goes to main unwritten; later writes wait for main, then flow in order', () => {
    const s = setup()
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'gemini\r' })
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'a' })
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'b' })
    expect(p.write).not.toHaveBeenCalled()
    expect(s.ofKind('via-main')).toEqual([{ kind: 'via-main', key: 5, id: 'term', data: 'gemini\r' }])
    s.host.handle({ kind: 'routed', key: 5 })
    expect(p.write.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    s.host.handle({ kind: 'routed', key: 5 }) // nothing waiting: ignored
    s.host.handle({ kind: 'routed', key: 99 })
  })

  it('a relaunch hold sends every write through main until it lifts or runs out', () => {
    const s = setup()
    const p = s.spawn(5)
    s.host.handle({ kind: 'gate', key: 5, until: 2000 })
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'x' })
    expect(s.ofKind('via-main')).toHaveLength(1)
    s.host.handle({ kind: 'routed', key: 5 })
    s.setNow(2000) // expired
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'y' })
    expect(p.write).toHaveBeenCalledWith('y')
    s.host.handle({ kind: 'gate', key: 5, until: 5000 })
    s.host.handle({ kind: 'gate', key: 5, until: 0 }) // lifted
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'z' })
    expect(p.write).toHaveBeenLastCalledWith('z')
    s.host.handle({ kind: 'gate', key: 99, until: 5000 })
    s.host.handle({ kind: 'gate', key: 5, until: 'soon' as unknown as number })
  })

  it('a marked write waits for main to confirm the mark, and everything behind it waits too', () => {
    const s = setup()
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'a', sync: 10 })
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'b' })
    expect(p.write).not.toHaveBeenCalled()
    s.host.handle({ kind: 'sync', id: 'term', n: 9 })
    expect(p.write).not.toHaveBeenCalled()
    s.host.handle({ kind: 'sync', id: 'term', n: 10 })
    expect(p.write.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    s.host.handle({ kind: 'sync', id: 'term', n: 3 }) // marks never go back
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'c', sync: 10 })
    expect(p.write).toHaveBeenLastCalledWith('c')
    s.host.handle({ kind: 'sync', id: 'other', n: 1 }) // a mark for a terminal not here is kept for later
    s.host.handle({ kind: 'sync', id: 5 as unknown as string, n: 1 })
    s.host.handle({ kind: 'sync', id: 'term', n: '1' as unknown as number })
  })

  it('a write to a closed pty is still copied to main, and nothing throws', () => {
    const s = setup()
    const p = s.spawn(5)
    p.write.mockImplementation(() => { throw new Error('closed') })
    expect(() => s.host.fromRenderer({ t: 'w', id: 'term', data: 'a' })).not.toThrow()
    expect(s.ofKind('typed')).toHaveLength(1)
  })

  it('writes still queued when the terminal ends go to main with no key; the renderer is told it is unbound', () => {
    const s = setup()
    const r = fakePort()
    s.host.attachRenderer(r.port)
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'gemini' })
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'left' })
    p.end(0)
    expect(s.ofKind('via-main').at(-1)).toEqual({ kind: 'via-main', key: null, id: 'term', data: 'left' })
    expect(r.got.at(-1)).toEqual({ t: 'unbind', id: 'term' })
    expect(s.ofKind('exit')).toEqual([{ kind: 'exit', key: 5, code: 0 }])
  })

  it('ignores malformed renderer messages', () => {
    const s = setup()
    s.spawn(5)
    s.host.fromRenderer(null as never)
    s.host.fromRenderer({ t: 'w', id: 5 } as never)
    s.host.fromRenderer({ t: 'w', id: 'term', data: 5 } as never)
    s.host.fromRenderer({ t: 'what', id: 'term' } as never)
    expect(s.ofKind('typed')).toEqual([])
    expect(s.ofKind('via-main')).toEqual([])
  })
})

describe('ptyHost direct line: output', () => {
  it('main gets every byte; the renderer only while a pane is subscribed, tagged with the end on main\'s scale', () => {
    const s = setup()
    const r = fakePort()
    s.host.attachRenderer(r.port)
    const p = s.spawn(5, 'term', 100)
    p.emit('ab') // no pane yet: main only
    s.host.fromRenderer({ t: 'sub', id: 'term' })
    p.emit('cd')
    p.emit('') // nothing to add
    expect(s.ofKind('data').map((d) => d.data)).toEqual(['ab', 'cd', ''])
    expect(r.got.filter((m) => m.t === 'd')).toEqual([{ t: 'd', id: 'term', data: 'cd', end: 104 }])
  })

  it('a flowing stream is batched, and the batch carries the end of everything in it', () => {
    const s = setup()
    const r = fakePort()
    s.host.attachRenderer(r.port)
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'sub', id: 'term' })
    p.emit('a') // idle: at once
    p.emit('b') // flowing: held for the window
    p.emit('c')
    s.fire()
    expect(r.got.filter((m) => m.t === 'd')).toEqual([
      { t: 'd', id: 'term', data: 'a', end: 1 },
      { t: 'd', id: 'term', data: 'bc', end: 3 },
    ])
  })

  it('unsub flushes what was held and stops sending; a resize flushes before the new size', () => {
    const s = setup()
    const r = fakePort()
    s.host.attachRenderer(r.port)
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'sub', id: 'term' })
    p.emit('a')
    p.emit('b')
    s.host.handle({ kind: 'resize', key: 5, cols: 100, rows: 30 })
    expect(r.got.filter((m) => m.t === 'd').map((m) => (m as { data: string }).data)).toEqual(['a', 'b'])
    expect(p.resize).toHaveBeenCalledWith(100, 30)
    p.emit('c')
    p.emit('d')
    s.host.fromRenderer({ t: 'unsub', id: 'term' })
    p.emit('e')
    s.fire()
    expect(r.got.filter((m) => m.t === 'd').map((m) => (m as { data: string }).data)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('with no port nothing is pushed, and a port that throws costs nothing', () => {
    const s = setup()
    const p = s.spawn(5)
    s.host.fromRenderer({ t: 'sub', id: 'term' })
    p.emit('a')
    const bad = fakePort(true)
    s.host.attachRenderer(bad.port) // subs cleared by a new port: the page re-subscribes
    s.host.fromRenderer({ t: 'sub', id: 'term' })
    expect(() => p.emit('b')).not.toThrow()
    expect(s.ofKind('data')).toHaveLength(2)
  })

  it('a new spawn under the same id takes the id over: the old one\'s output and end no longer reach the renderer', () => {
    const s = setup()
    const r = fakePort()
    s.host.attachRenderer(r.port)
    const old = s.spawn(1, 'term')
    s.host.fromRenderer({ t: 'sub', id: 'term' })
    old.emit('x')
    old.emit('held') // flowing: held, flushed when the id is taken over
    const next = s.spawn(2, 'term', 0)
    old.emit('late')
    next.emit('new')
    old.end()
    expect(r.got).toEqual([
      { t: 'bind', id: 'term', fresh: true },
      { t: 'd', id: 'term', data: 'x', end: 1 },
      { t: 'd', id: 'term', data: 'held', end: 5 },
      { t: 'bind', id: 'term', fresh: true },
      { t: 'd', id: 'term', data: 'new', end: 3 },
    ])
    // Writes go to the new one.
    s.host.fromRenderer({ t: 'w', id: 'term', data: 'k' })
    expect(next.write).toHaveBeenCalledWith('k')
    expect(old.write).not.toHaveBeenCalled()
  })
})
