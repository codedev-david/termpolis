import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTerminalDataRouter, type RouterIpc } from '../../src/preload/terminalDataRouter'

// How the renderer hears terminal output (1.54.5, plan package P9).
//
// The base registered one ipcRenderer.on('terminal:data') listener per onTerminalData call, i.e. one per MOUNTED PANE,
// and each pane filtered by id inside its own callback: for N panes one message was N handler runs and N crossings of
// the context bridge (the string is copied each time), N-1 of them for nothing. The counters here are the handler
// runs: ipcRenderer.on registrations alive, shared-listener runs and callback runs per message.
//
// Every claim has a NEGATIVE CONTROL in this file: the all-terminal API (onTerminalData, kept for aiProfiles) is the
// base's per-listener behaviour, and the same traffic shows what routing changes.

interface FakeIpc extends RouterIpc {
  /** ipcRenderer.on registrations that are alive, per channel. */
  alive: (channel: string) => number
  /** Everything ever registered (never decremented). */
  registrations: () => number
  /** Deliver one main-process message to every registered listener of the channel, as Electron's emitter does. */
  emit: (channel: string, ...args: unknown[]) => number
  sent: Array<{ channel: string; args: unknown[] }>
}

function fakeIpc(): FakeIpc {
  const listeners = new Map<string, Array<(e: unknown, ...a: unknown[]) => void>>()
  let registrations = 0
  const sent: FakeIpc['sent'] = []
  return {
    sent,
    on(channel, listener) {
      registrations++
      const list = listeners.get(channel) ?? []
      list.push(listener as (e: unknown, ...a: unknown[]) => void)
      listeners.set(channel, list)
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) ?? []
      const i = list.indexOf(listener as (e: unknown, ...a: unknown[]) => void)
      if (i >= 0) list.splice(i, 1)
    },
    send(channel, ...args) { sent.push({ channel, args }) },
    alive: (channel) => (listeners.get(channel) ?? []).length,
    registrations: () => registrations,
    emit(channel, ...args) {
      const list = (listeners.get(channel) ?? []).slice()
      for (const l of list) l({}, ...args)
      return list.length
    },
  }
}

const announcements = (ipc: FakeIpc) => ipc.sent.filter((s) => s.channel.startsWith('terminal:'))

describe('preload routing: one listener for every pane', () => {
  it('10 panes and 1 message = 1 listener run and 1 callback run (the base: 10 and 10)', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const cbs = Array.from({ length: 10 }, () => vi.fn())
    cbs.forEach((cb, i) => router.onFor(`t${i}`, cb))

    expect(ipc.alive('terminal:data')).toBe(1)
    const listenerRuns = ipc.emit('terminal:data', 't3', 'hello', 5)
    expect(listenerRuns).toBe(1)
    expect(cbs.map((cb) => cb.mock.calls.length)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(cbs[3]).toHaveBeenCalledWith('t3', 'hello', 5)
  })

  it('NEGATIVE CONTROL: the all-terminal API keeps one listener per call, so 10 of them run for 1 message (the base)', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const cbs = Array.from({ length: 10 }, () => vi.fn())
    cbs.forEach((cb) => router.onAll(cb))
    expect(ipc.alive('terminal:data')).toBe(10)
    expect(ipc.emit('terminal:data', 't3', 'hello', 5)).toBe(10)
    expect(cbs.every((cb) => cb.mock.calls.length === 1)).toBe(true)
  })

  it('crossings of the context bridge per message: 1 for a pane, however many panes are mounted', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    let crossings = 0
    for (let i = 0; i < 25; i++) router.onFor(`t${i}`, () => { crossings++ })
    for (let m = 0; m < 1000; m++) ipc.emit('terminal:data', `t${m % 25}`, 'x'.repeat(64), m)
    expect(crossings).toBe(1000)
    expect(ipc.registrations()).toBe(1)
  })

  it('delivers the chunk to the pane of its terminal only, with the end offset main tagged it with', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const a = vi.fn()
    const b = vi.fn()
    router.onFor('a', a)
    router.onFor('b', b)
    ipc.emit('terminal:data', 'a', 'one', 3)
    ipc.emit('terminal:data', 'b', 'two')
    ipc.emit('terminal:data', 'c', 'nobody listens')
    expect(a.mock.calls).toEqual([['a', 'one', 3]])
    expect(b.mock.calls).toEqual([['b', 'two', undefined]])
  })

  it('two panes for one terminal (a remount that has not yet cleaned up) both hear it', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const first = vi.fn()
    const second = vi.fn()
    router.onFor('a', first)
    router.onFor('a', second)
    ipc.emit('terminal:data', 'a', 'x', 1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('a pane that unsubscribes while a message is being delivered does not break the others', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const later = vi.fn()
    let unsubFirst: () => void = () => undefined
    unsubFirst = router.onFor('a', () => { unsubFirst() })
    router.onFor('a', later)
    ipc.emit('terminal:data', 'a', 'x', 1)
    expect(later).toHaveBeenCalledTimes(1)
    ipc.emit('terminal:data', 'a', 'y', 2)
    expect(later).toHaveBeenCalledTimes(2)
  })

  it('a callback that throws does not stop the other callbacks of the message, and the error is reported, not lost', () => {
    const ipc = fakeIpc()
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const router = createTerminalDataRouter(ipc, 1)
      const boom = new Error('pane exploded')
      router.onFor('a', () => { throw boom })
      const ok = vi.fn()
      router.onFor('a', ok)
      ipc.emit('terminal:data', 'a', 'x', 1)
      expect(ok).toHaveBeenCalledTimes(1)
      expect(err).toHaveBeenCalledTimes(1)
      expect(err.mock.calls[0]).toContain(boom)
    } finally {
      err.mockRestore()
    }
  })

  it('removes the shared listener when the last pane goes, and installs it again for the next pane', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const unsubA = router.onFor('a', vi.fn())
    const unsubB = router.onFor('b', vi.fn())
    expect(ipc.alive('terminal:data')).toBe(1)
    unsubA()
    expect(ipc.alive('terminal:data')).toBe(1)
    unsubB()
    expect(ipc.alive('terminal:data')).toBe(0)
    router.onFor('c', vi.fn())
    expect(ipc.alive('terminal:data')).toBe(1)
    expect(ipc.registrations()).toBe(2)
  })

  it('an unsubscribe called twice changes nothing the second time', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const unsub = router.onFor('a', vi.fn())
    const other = vi.fn()
    router.onFor('a', other)
    unsub()
    unsub()
    ipc.emit('terminal:data', 'a', 'x', 1)
    expect(other).toHaveBeenCalledTimes(1)
    expect(announcements(ipc).filter((s) => s.channel === 'terminal:unsubscribe')).toEqual([])
    expect(router.stats()).toMatchObject({ panes: 1, ids: 1 }) // the second call did not take another pane off the count
  })

  it('an unsubscribe removes ITS OWN callback, not the first one registered', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const first = vi.fn()
    const second = vi.fn()
    router.onFor('a', first)
    const unsubSecond = router.onFor('a', second)
    unsubSecond()
    ipc.emit('terminal:data', 'a', 'x', 1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(router.stats()).toMatchObject({ panes: 1, ids: 1 })
  })
})

describe('preload routing: what main is told', () => {
  it('announces a terminal when its first pane mounts and when its last pane unmounts, once each', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 123)
    const unsub1 = router.onFor('a', vi.fn())
    const unsub2 = router.onFor('a', vi.fn())
    expect(announcements(ipc)).toEqual([{ channel: 'terminal:subscribe', args: [{ id: 'a', epoch: 123 }] }])
    unsub1()
    expect(announcements(ipc)).toHaveLength(1)
    unsub2()
    expect(announcements(ipc)).toEqual([
      { channel: 'terminal:subscribe', args: [{ id: 'a', epoch: 123 }] },
      { channel: 'terminal:unsubscribe', args: [{ id: 'a', epoch: 123 }] },
    ])
  })

  it('the announcement is sent before the listener returns, so a pane can ask for its replay right after (main reads both in order)', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const order: string[] = []
    const send = ipc.send
    ipc.send = (channel, ...args) => { order.push(channel); send(channel, ...args) }
    router.onFor('a', vi.fn())
    order.push('replay-request')
    expect(order).toEqual(['terminal:subscribe', 'replay-request'])
  })

  it('the all-terminal API announces once for any number of subscribers and withdraws with the last', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 7)
    const u1 = router.onAll(vi.fn())
    const u2 = router.onAll(vi.fn())
    expect(announcements(ipc)).toEqual([{ channel: 'terminal:subscribe', args: [{ all: true, epoch: 7 }] }])
    u1()
    expect(announcements(ipc)).toHaveLength(1)
    u2()
    u2()
    expect(announcements(ipc)[1]).toEqual({ channel: 'terminal:unsubscribe', args: [{ all: true, epoch: 7 }] })
    expect(announcements(ipc)).toHaveLength(2)
    expect(ipc.alive('terminal:data')).toBe(0)
  })

  it('every announcement of one page carries the same epoch, and a default epoch is the page load time', () => {
    const ipc = fakeIpc()
    const before = Date.now()
    const router = createTerminalDataRouter(ipc)
    router.onFor('a', vi.fn())
    router.onAll(vi.fn())
    const epochs = announcements(ipc).map((s) => (s.args[0] as { epoch: number }).epoch)
    expect(new Set(epochs).size).toBe(1)
    expect(epochs[0]).toBeGreaterThanOrEqual(before)
    expect(epochs[0]).toBeLessThanOrEqual(Date.now())
  })

  it('an announcement that cannot be sent never stops the listener from being installed', () => {
    const ipc = fakeIpc()
    ipc.send = () => { throw new Error('channel closed') }
    const router = createTerminalDataRouter(ipc, 1)
    const cb = vi.fn()
    expect(() => router.onFor('a', cb)).not.toThrow()
    ipc.emit('terminal:data', 'a', 'x', 1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(() => router.onAll(vi.fn())).not.toThrow()
  })
})

describe('preload routing: the all-terminal API is the base\'s own', () => {
  it('registers its own listener, passes (id, data, end) through, and removes exactly that listener', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const cb = vi.fn()
    const unsub = router.onAll(cb)
    ipc.emit('terminal:data', 'tid-1', 'output-data', 42)
    ipc.emit('terminal:data', 'tid-1', 'banner')
    expect(cb.mock.calls).toEqual([['tid-1', 'output-data', 42], ['tid-1', 'banner', undefined]])
    unsub()
    expect(ipc.alive('terminal:data')).toBe(0)
    ipc.emit('terminal:data', 'tid-1', 'after')
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('hears terminals no pane listens to, and is independent of the panes', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    const all = vi.fn()
    const pane = vi.fn()
    router.onAll(all)
    router.onFor('p', pane)
    ipc.emit('terminal:data', 'worker', 'x', 1)
    ipc.emit('terminal:data', 'p', 'y', 1)
    expect(all.mock.calls.map((c) => c[0])).toEqual(['worker', 'p'])
    expect(pane.mock.calls.map((c) => c[1])).toEqual(['y'])
  })
})

describe('preload routing: counters', () => {
  it('reports what is alive, numbers only', () => {
    const ipc = fakeIpc()
    const router = createTerminalDataRouter(ipc, 1)
    expect(router.stats()).toEqual({ shared: false, ids: 0, panes: 0, all: 0, delivered: 0, dropped: 0, direct: 0, deduped: 0 })
    router.onFor('a', vi.fn())
    router.onFor('a', vi.fn())
    router.onFor('b', vi.fn())
    router.onAll(vi.fn())
    ipc.emit('terminal:data', 'a', 'x', 1)
    ipc.emit('terminal:data', 'zzz', 'nobody', 1)
    expect(router.stats()).toEqual({ shared: true, ids: 2, panes: 3, all: 1, delivered: 2, dropped: 1, direct: 0, deduped: 0 })
  })
})

describe('preload routing: through the real preload (electron mocked)', () => {
  const exposed: Record<string, any> = {}
  const ipcRenderer = { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn(), sendSync: vi.fn(() => null) }

  beforeEach(() => {
    vi.resetModules()
    for (const k of Object.keys(exposed)) delete exposed[k]
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api } },
      ipcRenderer,
      webUtils: { getPathForFile: vi.fn() },
    }))
    for (const fn of Object.values(ipcRenderer)) (fn as ReturnType<typeof vi.fn>).mockClear()
  })
  afterEach(() => { vi.doUnmock('electron') })

  it('exposes onTerminalDataFor next to onTerminalData, and 10 panes make ONE ipcRenderer.on', async () => {
    await import('../../src/preload/index')
    expect(typeof exposed.termpolis.onTerminalDataFor).toBe('function')
    expect(typeof exposed.termpolis.onTerminalData).toBe('function')
    expect(exposed.termpolis.terminalDataStats()).toEqual({ shared: false, ids: 0, panes: 0, all: 0, delivered: 0, dropped: 0, direct: 0, deduped: 0 })
    for (let i = 0; i < 10; i++) exposed.termpolis.onTerminalDataFor(`t${i}`, vi.fn())
    expect(exposed.termpolis.terminalDataStats()).toMatchObject({ shared: true, ids: 10, panes: 10, all: 0 })
    const dataListeners = ipcRenderer.on.mock.calls.filter((c: unknown[]) => c[0] === 'terminal:data')
    expect(dataListeners).toHaveLength(1)
    const subscribes = ipcRenderer.send.mock.calls.filter((c: unknown[]) => c[0] === 'terminal:subscribe')
    expect(subscribes).toHaveLength(10)
    expect(subscribes[0][1]).toMatchObject({ id: 't0' })
    expect(typeof subscribes[0][1].epoch).toBe('number')
  })

  it('NEGATIVE CONTROL: ten onTerminalData calls (what 10 panes did on the base) make TEN ipcRenderer.on registrations', async () => {
    await import('../../src/preload/index')
    for (let i = 0; i < 10; i++) exposed.termpolis.onTerminalData(vi.fn())
    const dataListeners = ipcRenderer.on.mock.calls.filter((c: unknown[]) => c[0] === 'terminal:data')
    expect(dataListeners).toHaveLength(10)
  })

  it('routes a message from the registered listener to the pane of its terminal with the end offset', async () => {
    await import('../../src/preload/index')
    const cb = vi.fn()
    const other = vi.fn()
    const unsub = exposed.termpolis.onTerminalDataFor('tid', cb)
    exposed.termpolis.onTerminalDataFor('other', other)
    const handler = ipcRenderer.on.mock.calls.find((c: unknown[]) => c[0] === 'terminal:data')![1]
    handler({}, 'tid', 'data', 9)
    expect(cb).toHaveBeenCalledWith('tid', 'data', 9)
    expect(other).not.toHaveBeenCalled()
    unsub()
    expect(ipcRenderer.send).toHaveBeenCalledWith('terminal:unsubscribe', expect.objectContaining({ id: 'tid' }))
  })
})
