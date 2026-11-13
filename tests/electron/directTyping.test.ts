/**
 * The direct typing line, main's part (src/main/directTyping.ts, 1.61.0): main sets the line up on every page load and
 * when the host becomes ready, tells the page to forget it when the host goes, runs terminal:write's watchers for every
 * write the host made and the whole handler for every write the host handed back, passes the renderer's marks and the
 * relaunch holds to the host, and gives spawns their offset base. Every Electron piece is a fake.
 */
import { describe, it, expect, vi } from 'vitest'
import { installDirectTyping, type DirectTypingDeps, type DirectWindowLike } from '../../src/main/directTyping'
import type { PtyHostInput } from '../../src/main/ptyHostClient'

interface Port { close: ReturnType<typeof vi.fn>; name: string }

function setup(over: Partial<DirectTypingDeps<Port>> = {}, win?: Partial<{ destroyed: boolean; wcDestroyed: boolean; loading: boolean }>) {
  const state = { destroyed: false, wcDestroyed: false, loading: false, ...win }
  const loadCbs: Array<() => void> = []
  const posted: Array<{ channel: string; transfer: Port[] }> = []
  const sentToPage: string[] = []
  const window: DirectWindowLike<Port> = {
    isDestroyed: () => state.destroyed,
    webContents: {
      on: (_e, cb) => { loadCbs.push(cb) },
      isLoading: () => state.loading,
      isDestroyed: () => state.wcDestroyed,
      postMessage: (channel, _m, transfer) => { posted.push({ channel, transfer }) },
      send: (channel) => { sentToPage.push(channel) },
    },
  }
  let ready: () => void = () => {}
  let down: () => void = () => {}
  let input: (i: PtyHostInput) => void = () => {}
  let mark: (m: { id?: unknown; n?: unknown } | undefined) => void = () => {}
  let lock: (id: string, hold: { until: number } | undefined) => void = () => {}
  let made = 0
  const deps: DirectTypingDeps<Port> = {
    platform: 'win32',
    env: {},
    window: () => window,
    makeChannel: () => {
      made++
      return { port1: { close: vi.fn(), name: `p1-${made}` }, port2: { close: vi.fn(), name: `p2-${made}` } }
    },
    connectPort: vi.fn(() => true),
    onHostReady: (cb) => { ready = cb },
    onHostDown: (cb) => { down = cb },
    onHostInput: (cb) => { input = cb },
    routed: vi.fn(),
    sync: vi.fn(),
    handleWrite: vi.fn(),
    onMark: (cb) => { mark = cb },
    onLockChange: (cb) => { lock = cb },
    lockUntil: vi.fn(() => 0),
    gate: vi.fn(),
    bufferTotal: vi.fn(() => 42),
    ...over,
  }
  const dt = installDirectTyping(deps)
  return {
    dt, deps, window, state, posted, sentToPage, loadCbs,
    ready: () => ready(), down: () => down(), input: (i: PtyHostInput) => input(i),
    mark: (m: { id?: unknown; n?: unknown } | undefined) => mark(m), lock: (id: string, h?: { until: number }) => lock(id, h),
  }
}

describe('installDirectTyping', () => {
  it('is on for Windows alone, and off with the kill switch', () => {
    expect(setup().dt.enabled).toBe(true)
    expect(setup({ platform: 'darwin' }).dt.enabled).toBe(false)
    expect(setup({ env: { TERMPOLIS_NO_DIRECT_TYPING: '1' } }).dt.enabled).toBe(false)
    expect(setup({ env: { TERMPOLIS_NO_DIRECT_TYPING: ' true ' } }).dt.enabled).toBe(false)
    expect(setup({ env: { TERMPOLIS_NO_DIRECT_TYPING: '0' } }).dt.enabled).toBe(true)
  })

  it('connect: one end to the host, the other to the page', () => {
    const s = setup()
    expect(s.dt.connect()).toBe(true)
    expect(s.deps.connectPort).toHaveBeenCalledWith(expect.objectContaining({ name: 'p1-1' }))
    expect(s.posted).toEqual([{ channel: 'pty:direct-port', transfer: [expect.objectContaining({ name: 'p2-1' })] }])
  })

  it('connect does nothing when off, with no window, or a destroyed one', () => {
    expect(setup({ platform: 'linux' }).dt.connect()).toBe(false)
    expect(setup({ window: () => null }).dt.connect()).toBe(false)
    expect(setup({}, { destroyed: true }).dt.connect()).toBe(false)
    expect(setup({}, { wcDestroyed: true }).dt.connect()).toBe(false)
  })

  it('connect closes both ends when the host will not take one, and survives a channel that cannot be made', () => {
    const ports: Port[] = []
    const s = setup({
      connectPort: () => false,
      makeChannel: () => {
        const c = { port1: { close: vi.fn(), name: 'a' }, port2: { close: vi.fn(), name: 'b' } }
        ports.push(c.port1, c.port2)
        return c
      },
    })
    expect(s.dt.connect()).toBe(false)
    expect(ports.map((p) => p.close.mock.calls.length)).toEqual([1, 1])
    expect(s.posted).toEqual([])
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = setup({ makeChannel: () => { throw new Error('no channel') } })
    expect(t.dt.connect()).toBe(false)
    err.mockRestore()
  })

  it('connect: a page that will not take its end closes it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup()
    s.window.webContents.postMessage = () => { throw new Error('gone') }
    expect(s.dt.connect()).toBe(false)
    err.mockRestore()
  })

  it('attachWindow connects on every load of the page; not when off, nor for a window with no `on`', () => {
    const s = setup()
    s.dt.attachWindow(s.window)
    expect(s.loadCbs).toHaveLength(1)
    s.loadCbs[0]()
    s.loadCbs[0]()
    expect(s.posted).toHaveLength(2)
    const off = setup({ platform: 'darwin' })
    off.dt.attachWindow(off.window)
    expect(off.loadCbs).toHaveLength(0)
    const bare = setup()
    bare.dt.attachWindow({ ...bare.window, webContents: { ...bare.window.webContents, on: undefined } })
    expect(bare.loadCbs).toHaveLength(0)
  })

  it('host ready: a loaded page gets a line at once; a loading one waits for its load', () => {
    const s = setup()
    s.ready()
    expect(s.posted).toHaveLength(1)
    const l = setup({}, { loading: true })
    l.ready()
    expect(l.posted).toHaveLength(0)
    const none = setup({ window: () => null })
    none.ready()
    const gone = setup({}, { destroyed: true })
    gone.ready()
    expect(gone.posted).toHaveLength(0)
    const wcGone = setup({}, { wcDestroyed: true })
    wcGone.ready()
    expect(wcGone.posted).toHaveLength(0)
  })

  it('host down: the page is told to forget the line, when there is a page', () => {
    const s = setup()
    s.down()
    expect(s.sentToPage).toEqual(['pty:direct-reset'])
    setup({ window: () => null }).down()
    const d = setup({}, { destroyed: true })
    d.down()
    expect(d.sentToPage).toEqual([])
    const w = setup({}, { wcDestroyed: true })
    w.down()
    expect(w.sentToPage).toEqual([])
    const t = setup()
    t.window.webContents.send = () => { throw new Error('page going') }
    expect(() => t.down()).not.toThrow()
  })

  it('a write the host made runs the watchers only; one it handed back runs the whole handler, then frees the host', () => {
    const s = setup()
    s.input({ kind: 'typed', key: 1, id: 't', data: 'a' })
    expect(s.deps.handleWrite).toHaveBeenLastCalledWith('t', 'a', undefined, true)
    expect(s.deps.routed).not.toHaveBeenCalled()
    s.input({ kind: 'via-main', key: 2, id: 't', data: 'gemini\r' })
    expect(s.deps.handleWrite).toHaveBeenLastCalledWith('t', 'gemini\r', undefined, false)
    expect(s.deps.routed).toHaveBeenCalledWith(2)
    s.input({ kind: 'via-main', key: null, id: 't', data: 'x' }) // a closed terminal's leftovers: nobody waits
    expect(s.deps.routed).toHaveBeenCalledTimes(1)
  })

  it('the host is freed even when the handler throws', () => {
    const s = setup({ handleWrite: () => { throw new Error('boom') } })
    expect(() => s.input({ kind: 'via-main', key: 7, id: 't', data: 'x' })).toThrow('boom')
    expect(s.deps.routed).toHaveBeenCalledWith(7)
  })

  it('passes a well-formed mark on to the host and nothing else', () => {
    const s = setup()
    s.mark({ id: 't', n: 5 })
    s.mark(undefined)
    s.mark({ id: 1, n: 5 })
    s.mark({ id: 't', n: '5' })
    s.mark({ id: 't', n: Number.NaN })
    expect(s.deps.sync).toHaveBeenCalledTimes(1)
    expect(s.deps.sync).toHaveBeenCalledWith('t', 5)
  })

  it('passes a relaunch hold to the host when it is set and when it is lifted', () => {
    const s = setup()
    s.lock('t', { until: 99 })
    s.lock('t')
    expect(s.deps.gate).toHaveBeenNthCalledWith(1, 't', 99)
    expect(s.deps.gate).toHaveBeenNthCalledWith(2, 't', 0)
  })

  it('spawnOption: the buffer total as the base when on, nothing when off', () => {
    expect(setup().dt.spawnOption('t')).toEqual({ base: 42 })
    expect(setup({ platform: 'darwin' }).dt.spawnOption('t')).toBeUndefined()
    expect(setup({ lockUntil: () => 77 }).dt.spawnOption('t')).toEqual({ base: 42, until: 77 })
  })

  it('afterSpawn: a hold already on the id applies to the new pty', () => {
    const s = setup({ lockUntil: () => 77 })
    s.dt.afterSpawn('t')
    expect(s.deps.gate).toHaveBeenCalledWith('t', 77)
    const n = setup()
    n.dt.afterSpawn('t')
    expect(n.deps.gate).not.toHaveBeenCalled()
    const off = setup({ platform: 'darwin', lockUntil: () => 77 })
    off.dt.afterSpawn('t')
    expect(off.deps.gate).not.toHaveBeenCalled()
  })
})
