/**
 * The direct typing line, the page's end (1.61.0): src/preload/directLine.ts and the router's dedupe of the two copies
 * of a terminal's output (src/preload/terminalDataRouter.ts).
 *
 * The contract proven here: a pane sees every byte of its terminal's stream exactly once, in order, whichever copy
 * (main's terminal:data or the host's direct `d`) arrives first, however the two copies are cut into chunks; and with no
 * line, or a line that fails, every write and every chunk takes exactly the path it took before 1.61.0.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTerminalDataRouter, type RouterIpc } from '../../src/preload/terminalDataRouter'
import { createDirectLine, type DirectPortLike } from '../../src/preload/directLine'

type Listener = (e: unknown, ...a: unknown[]) => void

function fakeIpc() {
  const listeners = new Map<string, Listener[]>()
  const sent: Array<{ channel: string; args: unknown[] }> = []
  const ipc: RouterIpc & { send: (channel: string, ...args: unknown[]) => void } = {
    on(channel, listener) {
      const list = listeners.get(channel) ?? []
      list.push(listener as Listener)
      listeners.set(channel, list)
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) ?? []
      const i = list.indexOf(listener as Listener)
      if (i >= 0) list.splice(i, 1)
    },
    send(channel, ...args) { sent.push({ channel, args }) },
  }
  const emit = (channel: string, event: unknown, ...args: unknown[]): void => {
    for (const l of (listeners.get(channel) ?? []).slice()) l(event, ...args)
  }
  return { ipc, sent, emit }
}

function fakePort() {
  const posted: unknown[] = []
  const port: DirectPortLike & { posted: unknown[]; started: number; closed: number; fail: boolean; failStart: boolean } = {
    posted,
    started: 0,
    closed: 0,
    fail: false,
    failStart: false,
    onmessage: null,
    postMessage(m) {
      if (port.fail) throw new Error('port closed')
      posted.push(m)
    },
    start() {
      if (port.failStart) throw new Error('no start')
      port.started++
    },
    close() {
      port.closed++
      throw new Error('already closed') // closing must never be able to break the line's teardown
    },
  }
  const fromHost = (m: unknown): void => port.onmessage?.({ data: m })
  return { port, fromHost }
}

/** A pane on terminal `id` collecting what it was given. */
function pane(router: ReturnType<typeof createTerminalDataRouter>, id = 't') {
  const got: Array<{ data: string; end?: number }> = []
  const off = router.onFor(id, (_id, data, end) => got.push({ data, end }))
  return { got, text: () => got.map((g) => g.data).join(''), off }
}

describe('router: two copies of one stream', () => {
  it('with no direct copy, main chunks pass untouched (the pre-1.61 behaviour, byte for byte)', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    emit('terminal:data', {}, 't', 'abc', 3)
    emit('terminal:data', {}, 't', 'abc', 3) // even a repeat (main never sends one): no dedupe until the line has spoken
    emit('terminal:data', {}, 't', 'banner') // no end: always passed on
    expect(p.got).toEqual([{ data: 'abc', end: 3 }, { data: 'abc', end: 3 }, { data: 'banner', end: undefined }])
    expect(router.stats()).toMatchObject({ direct: 0, deduped: 0 })
  })

  it('direct first: main copies of what was delivered are dropped, and a straddling one is trimmed', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    emit('terminal:data', {}, 't', 'hello', 5) // establishes where the pane is
    router.direct('t', ' wor', 9)
    router.direct('t', 'ld', 11)
    emit('terminal:data', {}, 't', ' wo', 8) // wholly delivered already: dropped
    emit('terminal:data', {}, 't', 'rld!', 12) // main cut it differently and is one char ahead: trimmed
    expect(p.text()).toBe('hello world!')
    expect(p.got.at(-1)).toEqual({ data: '!', end: 12 })
    expect(router.stats()).toMatchObject({ direct: 2, deduped: 2 })
  })

  it('main first: the direct copy is dropped or trimmed', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    emit('terminal:data', {}, 't', 'abcdef', 6)
    router.direct('t', 'abcd', 4) // all old
    router.direct('t', 'efgh', 8) // two of it new
    expect(p.text()).toBe('abcdefgh')
    expect(p.got.at(-1)).toEqual({ data: 'gh', end: 8 })
  })

  it('a direct chunk ahead of the pane waits for main to close the gap, then goes in order', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    router.direct('t', 'xyz', 3) // nothing known yet: held
    expect(p.got).toEqual([])
    emit('terminal:data', {}, 't', 'x', 1) // main reaches 1: x delivered, then the held 'yz'
    expect(p.text()).toBe('xyz')
    router.direct('t', 'Q', 10) // a gap 3..9: held
    router.direct('t', 'R', 11)
    expect(p.text()).toBe('xyz')
    emit('terminal:data', {}, 't', 'abcdef', 9) // main closes the gap; the held chunks follow
    expect(p.text()).toBe('xyzabcdefQR')
  })

  it('a replay reply moves the pane on: held direct chunks before nextOffset are dropped, later ones delivered', () => {
    const { ipc } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    router.direct('t', 'old', 3)
    router.direct('t', 'new', 6)
    router.noteReplay('t', 3)
    expect(p.got).toEqual([{ data: 'new', end: 6 }])
    router.noteReplay('t', 1) // never backwards
    router.direct('t', 'new', 6)
    expect(p.got).toHaveLength(1)
    router.noteReplay('nobody', 5)
    router.noteReplay('t', Number.NaN)
  })

  it('caps what it holds: past the cap the held chunks go and main serves', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    const big = 'x'.repeat(200 * 1024)
    router.direct('t', big, big.length + 10)
    router.direct('t', big, 2 * big.length + 10) // over 256K held: everything held is dropped
    emit('terminal:data', {}, 't', 'y'.repeat(10), 10)
    expect(p.text()).toBe('y'.repeat(10))
  })

  it('ignores a direct chunk for a terminal with no pane, an empty one, or a bad end', () => {
    const { ipc } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    router.direct('t', 'x', 1)
    const p = pane(router)
    router.noteReplay('t', 0)
    router.direct('t', '', 0)
    router.direct('t', 'x', Number.POSITIVE_INFINITY)
    router.direct('t', 'x', 'nope' as unknown as number)
    expect(p.got).toEqual([])
  })

  it('a new shell under the same id: main restarting its offsets is a fresh stream, not old output', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    emit('terminal:data', {}, 't', 'abcdef', 6)
    router.direct('t', 'gh', 8)
    emit('terminal:data', {}, 't', 'gh', 8) // deduped
    // The terminal was killed and opened again under the same id: main's buffer starts over at 0.
    emit('terminal:data', {}, 't', 'NEW', 3)
    expect(p.text()).toBe('abcdefghNEW')
    emit('terminal:data', {}, 't', 'NEW', 3) // a repeat is no longer deduped: no direct copy in this stream yet
    expect(p.text()).toBe('abcdefghNEWNEW')
  })

  it('resetDirect (a fresh bind) forgets where the old stream stood, whichever side of main it lands', () => {
    const { ipc, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p = pane(router)
    emit('terminal:data', {}, 't', 'abcdef', 6)
    router.direct('t', 'gh', 8)
    router.resetDirect('t') // the new shell's bind came before main's first chunk of it
    router.direct('t', 'N', 1) // held: where the pane stands in the new stream is not known yet
    expect(p.text()).toBe('abcdefgh')
    emit('terminal:data', {}, 't', 'NE', 2) // starts before main's last end: a new stream
    expect(p.text()).toBe('abcdefghNE')
    router.direct('t', 'EW', 3)
    expect(p.text()).toBe('abcdefghNEW')
    router.resetDirect('nobody')
  })

  it('tells listeners about first and last panes, and lists the listened terminals', () => {
    const { ipc } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const seen: Array<[string, boolean]> = []
    router.onListen((id, on) => seen.push([id, on]))
    router.onListen(() => { throw new Error('one bad listener') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = pane(router, 'a')
    const a2 = pane(router, 'a')
    pane(router, 'b')
    expect(router.listened()).toEqual(['a', 'b'])
    a.off()
    a2.off()
    expect(seen).toEqual([['a', true], ['b', true], ['a', false]])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('a chunk to several panes: each gets it once', () => {
    const { ipc } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const p1 = pane(router)
    const p2 = pane(router)
    router.noteReplay('t', 0)
    router.direct('t', 'hi', 2)
    expect([p1.text(), p2.text()]).toEqual(['hi', 'hi'])
  })

  it('PROPERTY: any interleaving of two differently-cut copies gives the pane the stream exactly once', () => {
    const stream = 'The quick brown fox jumps over the lazy dog, 0123456789 — ünïcödé too.'
    const cuts = (seed: number): Array<{ data: string; end: number }> => {
      const out: Array<{ data: string; end: number }> = []
      let at = 0
      let s = seed
      while (at < stream.length) {
        s = (s * 1103515245 + 12345) % 2147483648
        const n = 1 + (s % 7)
        const end = Math.min(stream.length, at + n)
        out.push({ data: stream.slice(at, end), end })
        at = end
      }
      return out
    }
    for (let seed = 1; seed <= 200; seed++) {
      const { ipc, emit } = fakeIpc()
      const router = createTerminalDataRouter(ipc, 1)
      const p = pane(router)
      const main = cuts(seed)
      const direct = cuts(seed * 7 + 3)
      let s = seed
      while (main.length || direct.length) {
        s = (s * 1103515245 + 12345) % 2147483648
        const fromMain = direct.length === 0 || (main.length > 0 && s % 2 === 0)
        if (fromMain) {
          const c = main.shift()!
          emit('terminal:data', {}, 't', c.data, c.end)
        } else {
          const c = direct.shift()!
          router.direct('t', c.data, c.end)
        }
      }
      expect(p.text()).toBe(stream)
      // In order, too: every chunk's end is past the one before.
      const ends = p.got.map((g) => g.end!)
      expect(ends).toEqual([...ends].sort((a, b) => a - b))
    }
  })
})

describe('directLine', () => {
  function setup() {
    const { ipc, sent, emit } = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    let t = 1000
    const line = createDirectLine(ipc, router, () => t)
    const { port, fromHost } = fakePort()
    const give = (p: DirectPortLike | null = port): void => emit('pty:direct-port', { ports: p ? [p] : [] })
    return { ipc, sent, emit, router, line, port, fromHost, give, setNow: (n: number) => { t = n } }
  }

  it('with no port, nothing goes direct', () => {
    const { line } = setup()
    expect(line.write('t', 'a')).toBe(false)
    expect(line.state()).toEqual({ port: false, bound: 0 })
  })

  it('subscribes the listened terminals on adoption, and follows panes coming and going', () => {
    const { router, port, give } = setup()
    const p = pane(router, 'a')
    give()
    expect(port.started).toBe(1)
    expect(port.posted).toEqual([{ t: 'sub', id: 'a' }])
    pane(router, 'b')
    p.off()
    expect(port.posted).toEqual([{ t: 'sub', id: 'a' }, { t: 'sub', id: 'b' }, { t: 'unsub', id: 'a' }])
  })

  it('writes go direct only to a bound terminal, and never a keyed (relaunch) write', () => {
    const { line, port, fromHost, give } = setup()
    give()
    expect(line.write('t', 'a')).toBe(false) // not bound yet
    fromHost({ t: 'bind', id: 't' })
    expect(line.write('t', 'a', 'relaunch-key')).toBe(false)
    expect(line.write('t', 'a')).toBe(true)
    expect(port.posted.at(-1)).toEqual({ t: 'w', id: 't', data: 'a' })
    fromHost({ t: 'unbind', id: 't' })
    expect(line.write('t', 'b')).toBe(false)
    expect(line.state()).toEqual({ port: true, bound: 0 })
  })

  it('the first direct write after one through main carries a mark that also goes to main, behind it', () => {
    const { line, port, fromHost, give, sent, setNow } = setup()
    give()
    fromHost({ t: 'bind', id: 't' })
    line.wentViaMain('t')
    expect(line.write('t', 'x')).toBe(true)
    const mark = sent.find((s) => s.channel === 'terminal:direct-sync')!.args[0] as { id: string; n: number }
    expect(mark).toEqual({ id: 't', n: 1_000_000 })
    expect(port.posted.at(-1)).toEqual({ t: 'w', id: 't', data: 'x', sync: 1_000_000 })
    expect(line.write('t', 'y')).toBe(true) // no new mark: nothing went through main since
    expect(port.posted.at(-1)).toEqual({ t: 'w', id: 't', data: 'y' })
    // Marks only ever grow, even when the clock does not.
    setNow(0)
    line.wentViaMain('t')
    line.write('t', 'z')
    expect(port.posted.at(-1)).toEqual({ t: 'w', id: 't', data: 'z', sync: 1_000_001 })
  })

  it('a mark that cannot be sent keeps the write on the path through main', () => {
    const { ipc, line, port, fromHost, give } = setup()
    give()
    fromHost({ t: 'bind', id: 't' })
    line.wentViaMain('t')
    ipc.send = () => { throw new Error('ipc gone') }
    expect(line.write('t', 'x')).toBe(false)
    expect(port.posted.filter((m) => (m as { t: string }).t === 'w')).toEqual([])
  })

  it('a port that throws drops the line: this write and all later ones go through main', () => {
    const { line, port, fromHost, give } = setup()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    give()
    fromHost({ t: 'bind', id: 't' })
    port.fail = true
    expect(line.write('t', 'x')).toBe(false)
    expect(line.state()).toEqual({ port: false, bound: 0 })
    port.fail = false
    expect(line.write('t', 'x')).toBe(false)
    err.mockRestore()
  })

  it('a port that will not start is not kept', () => {
    const { line, port, give } = setup()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    port.failStart = true
    give()
    expect(line.state().port).toBe(false)
    err.mockRestore()
  })

  it('reset (the host went away) and a new port each drop what the old line had bound', () => {
    const { line, port, fromHost, give, emit } = setup()
    give()
    fromHost({ t: 'bind', id: 't' })
    emit('pty:direct-reset', {})
    expect(line.state()).toEqual({ port: false, bound: 0 })
    expect(port.onmessage).toBeNull()
    give()
    fromHost({ t: 'bind', id: 't' })
    const second = fakePort()
    give(second.port)
    expect(line.state()).toEqual({ port: true, bound: 0 })
    give(null) // a message with no port: no line
    expect(line.state().port).toBe(false)
    emit('pty:direct-port', undefined)
  })

  it('output from the host reaches the pane through the router; a fresh bind resets the stream', () => {
    const { router, fromHost, give, emit } = setup()
    const p = pane(router)
    give()
    emit('terminal:data', {}, 't', 'ab', 2)
    fromHost({ t: 'd', id: 't', data: 'cd', end: 4 })
    emit('terminal:data', {}, 't', 'cd', 4)
    expect(p.text()).toBe('abcd')
    const reset = vi.spyOn(router, 'resetDirect')
    fromHost({ t: 'bind', id: 't', fresh: true })
    expect(reset).toHaveBeenCalledWith('t')
  })

  it('ignores malformed messages from the port', () => {
    const { line, fromHost, give, router } = setup()
    const direct = vi.spyOn(router, 'direct')
    give()
    fromHost(null)
    fromHost('x')
    fromHost({ t: 'bind' })
    fromHost({ t: 'd', id: 't', data: 5, end: 1 })
    fromHost({ t: 'd', id: 't', data: 'x' })
    fromHost({ t: 'what', id: 't' })
    expect(direct).not.toHaveBeenCalled()
    expect(line.state().bound).toBe(0)
    expect(line.write('t', 5 as unknown as string)).toBe(false)
  })
})
