// WPA items 1 and 2: the memory host's interactive lane and cancel, end to end through the real dispatcher.
//
// The host side is driven through handleMessage (what the forked child runs for each message). The client side goes through
// memoryClient with a fake transport that runs that same dispatcher across a structuredClone boundary, so a signal that tried
// to cross the wire would fail here, as it would in a real fork.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake' },
  utilityProcess: { fork: () => { throw new Error('utilityProcess.fork must not be called in unit tests') } },
}))

import {
  handleMessage, handleCancel, argsWithSignal, CANCELLABLE_READS, LANE_FREE_CALLS, HOST_HANDLERS, _resetHostForTests, _setHostLoweredForTests, _hostLaneForTests,
  type HostRequest, type HostResponse,
} from '../../src/main/memoryHost'
import {
  startMemoryHost, setMemoryHostSpawner, _resetMemoryClientForTests, memorySearch, memoryList, memoryWrite,
  type MemoryHostTransport,
} from '../../src/main/memoryClient'
import {
  initSwarmMemory, memoryWrite as inprocWrite, _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { __setHostPriorityDepsForTests } from '../../src/main/hostPriority'
import { LANE_LINGER_MS, BACKGROUND_MAX_WAIT_MS } from '../../src/main/hostLane'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** An embedder that answers only when the test says so: the search is then parked at its first await point. */
function gatedEmbed(): { open: () => void; calls: () => number } {
  let release: (() => void) | null = null
  let n = 0
  const gate = new Promise<void>((r) => { release = r })
  _setEmbedFnForTests(async () => { n++; await gate; return null })
  return { open: () => release?.(), calls: () => n }
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memcancel-'))
  _resetForTests()
  _resetHostForTests()
  _resetMemoryClientForTests()
  _setEmbeddingsAvailable(false)
})
afterEach(() => {
  _resetMemoryClientForTests()
  _resetHostForTests()
  _setEmbedFnForTests(null)
  _resetForTests()
  __setHostPriorityDepsForTests(null)
  vi.restoreAllMocks()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function initHost(): Promise<void> {
  const res = await handleMessage({ kind: 'init', userDataPath: tmp, syncDir: null, encKeyB64: null } as HostRequest)
  expect(res?.kind).toBe('ready')
}
const call = (id: number, fn: string, args: unknown[], lane?: 'interactive' | 'background'): Promise<HostResponse | null> =>
  handleMessage({ kind: 'call', id, fn, args, ...(lane ? { lane } : {}) })

describe('memory host: cancel', () => {
  it('a search cancelled while it waits on the embed stops there, answers AbortError, and its result is never cached', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'the lighthouse keeper logs every storm' })
    const g = gatedEmbed()
    const p = call(1, 'memorySearch', [{ query: 'lighthouse storm', limit: 5 }], 'interactive')
    await tick()
    expect(g.calls()).toBe(1)
    expect(_hostLaneForTests()).toEqual({ interactive: 1, waiting: 0, inflight: 1 })
    expect(await handleMessage({ kind: 'cancel', id: 1 })).toBeNull() // a cancel is never answered
    g.open()
    const res = await p
    expect(res).toMatchObject({ kind: 'result', id: 1, ok: false, error: { name: 'AbortError' } })
    expect(_hostLaneForTests()).toEqual({ interactive: 0, waiting: 0, inflight: 0 })
    // Not cached: the same search, uncancelled, runs again (the embedder is asked again) and answers.
    const again = await call(2, 'memorySearch', [{ query: 'lighthouse storm', limit: 5 }])
    expect(g.calls()).toBe(2)
    expect(again).toMatchObject({ ok: true })
    expect((again as { result: unknown[] }).result.length).toBe(1)
  })

  it('a background read waiting behind an interactive one is dropped by a cancel and never runs', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'alpha beta gamma' })
    const g = gatedEmbed()
    const fast = call(1, 'memorySearch', [{ query: 'alpha', limit: 5 }], 'interactive')
    await tick()
    const slow = call(2, 'memorySearch', [{ query: 'beta', limit: 5 }]) // background: waits in the lane
    await tick()
    expect(_hostLaneForTests()).toEqual({ interactive: 1, waiting: 1, inflight: 2 })
    handleCancel({ kind: 'cancel', id: 2 })
    expect(await slow).toMatchObject({ ok: false, error: { name: 'AbortError' } })
    expect(g.calls()).toBe(1) // the dropped read never reached the store
    g.open()
    expect(await fast).toMatchObject({ ok: true })
  })

  it('a cancel for a write, an unknown id or a finished call changes nothing: a write that started finishes', async () => {
    await initHost()
    const w = call(1, 'memoryWrite', [{ agentId: 'a', kind: 'fact', content: 'writes are never cancelled' }])
    handleCancel({ kind: 'cancel', id: 1 })
    handleCancel({ kind: 'cancel', id: 999 })
    expect(await w).toMatchObject({ ok: true })
    const list = await call(2, 'memoryList', [{}])
    expect((list as { result: Array<{ content: string }> }).result.map((e) => e.content)).toContain('writes are never cancelled')
    handleCancel({ kind: 'cancel', id: 2 })
    expect(_hostLaneForTests().inflight).toBe(0)
  })

  it('memoryList is a cancellable read: dropped while it waits for the lane', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'x y z' })
    const g = gatedEmbed()
    const fast = call(1, 'memorySearch', [{ query: 'x', limit: 5 }], 'interactive')
    await tick()
    const list = call(2, 'memoryList', [{}], 'background')
    await tick()
    handleCancel({ kind: 'cancel', id: 2 })
    expect(await list).toMatchObject({ ok: false, error: { name: 'AbortError' } })
    g.open()
    await fast
  })

  it('a read cancelled after it entered the lane but before it ran is refused before the store is touched', async () => {
    await initHost()
    // The cancel lands between the lane letting the call in and the store being called (the same microtask gap).
    const p = call(1, 'memoryList', [{}], 'interactive')
    handleCancel({ kind: 'cancel', id: 1 })
    expect(await p).toMatchObject({ ok: false, error: { name: 'AbortError' } })
  })

  it('argsWithSignal: only memorySearch gets the signal, in its options; other calls and no signal keep their arguments', () => {
    const ctl = new AbortController()
    const a = [{ limit: 1 }]
    expect(argsWithSignal('memoryList', a, ctl.signal)).toBe(a)
    expect(argsWithSignal('memorySearch', a, undefined)).toBe(a)
    expect(argsWithSignal('memorySearch', [{ query: 'q' }, 7], ctl.signal)).toEqual([{ query: 'q', signal: ctl.signal }, 7])
    expect(argsWithSignal('memorySearch', [], ctl.signal)).toEqual([{ signal: ctl.signal }])
    expect(argsWithSignal('memorySearch', ['nonsense'], ctl.signal)).toEqual([{ signal: ctl.signal }])
    expect(CANCELLABLE_READS.has('memoryWrite')).toBe(false)
    expect(CANCELLABLE_READS.has('memorySearch')).toBe(true)
  })
})

describe('memory host: the interactive lane', () => {
  it('a background read waits while an interactive call runs, then runs', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'one two three' })
    const g = gatedEmbed()
    const order: string[] = []
    const fast = call(1, 'memorySearch', [{ query: 'one', limit: 5 }], 'interactive').then((r) => { order.push('interactive'); return r })
    await tick()
    const bg = call(2, 'memoryList', [{ limit: 5 }], 'background').then((r) => { order.push('background'); return r })
    await tick(); await tick()
    expect(order).toEqual([])
    g.open()
    await Promise.all([fast, bg])
    expect(order).toEqual(['interactive', 'background'])
  })

  it('a background read under an interactive call that never ends goes after BACKGROUND_MAX_WAIT_MS (WPA fix I4)', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'one two three' })
    const g = gatedEmbed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fast = call(1, 'memorySearch', [{ query: 'one', limit: 5 }], 'interactive')
      await vi.advanceTimersByTimeAsync(0)
      let done = false
      const bg = call(2, 'memoryList', [{ limit: 5 }], 'background').then((r) => { done = true; return r })
      await vi.advanceTimersByTimeAsync(BACKGROUND_MAX_WAIT_MS - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
      expect((await bg)?.ok).toBe(true)
      g.open()
      await fast
    } finally { vi.useRealTimers() }
  })

  it("a background write is not let in between the Ask's reads: it waits through the linger after the search, so the listing runs first (world-responsive t3)", async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'one two three' })
    const g = gatedEmbed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const order: string[] = []
      const search = call(1, 'memorySearch', [{ query: 'one', limit: 5 }], 'interactive').then((r) => { order.push('search'); return r })
      await vi.advanceTimersByTimeAsync(0)
      const write = call(2, 'memoryDelete', ['no-such-note'], 'background').then((r) => { order.push('write'); return r })
      await vi.advanceTimersByTimeAsync(0)
      g.open()
      expect((await search)?.ok).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(order).toEqual(['search']) // the lane is empty now, but lingering: the write still waits
      expect(_hostLaneForTests().waiting).toBe(1)
      const list = await call(3, 'memoryList', [{ limit: 5 }], 'interactive') // the Ask's next read: at once
      order.push('list')
      expect(list?.ok).toBe(true)
      await vi.advanceTimersByTimeAsync(BACKGROUND_MAX_WAIT_MS)
      expect((await write)?.ok).toBe(true) // and it never starves: its max wait still holds
      expect(order).toEqual(['search', 'list', 'write'])
      expect(LANE_LINGER_MS).toBeGreaterThan(BACKGROUND_MAX_WAIT_MS)
    } finally { vi.useRealTimers() }
  })

  it('a single write, the router learn and the status reads never queue on the lane: they answer while an interactive call runs (WPA fix round 2, R-I1)', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'one two three' })
    const g = gatedEmbed()
    const fast = call(1, 'memorySearch', [{ query: 'one', limit: 5 }], 'interactive')
    await tick()
    // (a write that embeds would wait on the gated embedder itself, not the lane: a delete is a write that does not embed)
    const w = await call(2, 'memoryDelete', ['no-such-note'])
    expect(w?.ok).toBe(true)
    const c = await call(3, 'memoryCount', [])
    expect(c?.ok).toBe(true)
    const s = await call(4, 'getSyncStatus', [])
    expect(s?.ok).toBe(true)
    const r = await call(5, 'memoryReleaseSupersedes', ['no-such-note'])
    expect(r?.ok).toBe(true)
    expect(_hostLaneForTests().waiting).toBe(0)
    g.open()
    await fast
  })

  it('a write, a delete or a link sent on the background lane (ingest, the notes pass) waits like any bulk call, at most BACKGROUND_MAX_WAIT_MS (WPA fix round 3, R2-M1)', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'one two three' })
    const g = gatedEmbed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fast = call(1, 'memorySearch', [{ query: 'one', limit: 5 }], 'interactive')
      await vi.advanceTimersByTimeAsync(0)
      const done = new Set<string>()
      const bulk: Array<[string, unknown[]]> = [
        ['memoryDelete', ['no-such-note']], ['memoryLink', [{ from: 'x', to: 'y', relation: 'follows' }]], ['memoryCount', []],
      ]
      const replies = bulk.map(([fn, args], i) => call(20 + i, fn, args, 'background').then((r) => { done.add(fn); return r }))
      // The same calls sent with no lane (an agent's tool call, a click) still answer at once.
      expect((await call(30, 'memoryDelete', ['no-such-note']))?.ok).toBe(true)
      expect(_hostLaneForTests().waiting).toBe(bulk.length)
      await vi.advanceTimersByTimeAsync(BACKGROUND_MAX_WAIT_MS - 1)
      expect(done.size).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(_hostLaneForTests().waiting).toBe(0)
      for (const r of await Promise.all(replies)) expect(r?.kind).toBe('result')
      g.open()
      await fast
    } finally { vi.useRealTimers() }
  })

  it('the calls that skip the lane are exactly the single writes someone waits on and the status reads (Ruling 13)', () => {
    expect([...LANE_FREE_CALLS].sort()).toEqual([
      'embeddingsReady', 'getSyncStatus', 'memoryCount', 'memoryDelete', 'memoryFeedback', 'memoryHasHash', 'memoryLink',
      'memoryReleaseSupersedes', 'memoryWrite', 'routerLearn',
    ])
    for (const fn of LANE_FREE_CALLS) expect(typeof HOST_HANDLERS[fn]).toBe('function')
    for (const fn of ['reloadMemoryFromSync', 'compactSelfShard', 'importMemorySnapshot', 'importGraphEdges', 'memorySupersedePass',
      'memoryArchive', 'memoryForget', 'weaveCandidates', 'weaveNeighboursBatch', 'consolidationCandidates', 'consolidationSimMatrix',
      'persistMemoryIndex', 'memoryBackfillVectors', 'routerWarm']) {
      expect(LANE_FREE_CALLS.has(fn)).toBe(false)
    }
  })

  it('a bulk call (sync reload, compaction, import, supersede, forget, Weave) cannot start while an interactive call runs, and starts after BACKGROUND_MAX_WAIT_MS anyway (WPA fix round 2, R-I1)', async () => {
    await initHost()
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'one two three' })
    const g = gatedEmbed()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fast = call(1, 'memorySearch', [{ query: 'one', limit: 5 }], 'interactive')
      await vi.advanceTimersByTimeAsync(0)
      const done = new Set<string>()
      const bulk: Array<[string, unknown[]]> = [
        ['reloadMemoryFromSync', []], ['compactSelfShard', []], ['importGraphEdges', [[]]], ['memorySupersedePass', [{ max: 0 }]],
        ['memoryForget', [{ max: 0 }]], ['weaveCandidates', [{ limit: 1 }]],
      ]
      const replies = bulk.map(([fn, args], i) => call(10 + i, fn, args).then((r) => { done.add(fn); return r }))
      await vi.advanceTimersByTimeAsync(0)
      expect(_hostLaneForTests().waiting).toBe(bulk.length) // parked on the lane: none of them has started
      await vi.advanceTimersByTimeAsync(BACKGROUND_MAX_WAIT_MS - 1)
      expect(done.size).toBe(0)
      expect(_hostLaneForTests().waiting).toBe(bulk.length)
      await vi.advanceTimersByTimeAsync(1)
      expect(_hostLaneForTests().waiting).toBe(0) // the cap ran out: every one has started, the interactive call still running
      expect(done.has('reloadMemoryFromSync')).toBe(true) // the synchronous ones have already answered
      expect(done.has('memoryForget')).toBe(true)
      g.open()
      await fast
      for (const r of await Promise.all(replies)) expect(r?.kind).toBe('result')
    } finally { vi.useRealTimers() }
  })

  it('the forked host goes to normal priority while an interactive call is in the lane, and back below normal after', async () => {
    const calls: Array<[number, number]> = []
    __setHostPriorityDepsForTests({
      env: {},
      os: { setPriority: (pid: number, p: number) => { calls.push([pid, p]) }, constants: { priority: { PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0 } } },
    })
    await initHost()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await call(1, 'memoryCount', [], 'interactive')
      vi.advanceTimersByTime(LANE_LINGER_MS)
      expect(calls).toEqual([]) // control: a host that never lowered itself (main, this suite) is never touched
      _setHostLoweredForTests(true)
      await call(2, 'memoryCount', [], 'interactive')
      expect(calls).toEqual([[0, 0]])
      await call(3, 'memoryCount', [], 'interactive') // the primer's next read, inside the linger: no flap
      expect(calls).toEqual([[0, 0]])
      vi.advanceTimersByTime(LANE_LINGER_MS)
      expect(calls).toEqual([[0, 0], [0, 10]]) // below normal once the lane has been empty for the linger
      await call(4, 'memoryCount', [], 'background')
      expect(calls).toHaveLength(2) // background work never raises it
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── the client: signal and lane, never on the wire as arguments ──────────────────────────────────

interface Fake { transport: MemoryHostTransport; posted: HostRequest[] }
function fakeHost(opts: { swallow?: string } = {}): Fake {
  const posted: HostRequest[] = []
  let cb: ((m: HostResponse) => void) | null = null
  const transport: MemoryHostTransport = {
    postMessage: (msg) => {
      const inbound = structuredClone(msg) // an AbortSignal in the args would throw right here
      posted.push(inbound)
      if (inbound.kind === 'call' && opts.swallow === inbound.fn) return
      void handleMessage(inbound).then((res) => { if (res) cb?.(structuredClone(res)) })
    },
    onMessage: (c) => { cb = c },
    onExit: () => {},
    kill: () => {},
    pid: 4243,
  }
  return { transport, posted }
}
async function startFake(opts: { swallow?: string } = {}): Promise<Fake> {
  let f: Fake | null = null
  setMemoryHostSpawner(() => { f = fakeHost(opts); return f.transport })
  expect(await startMemoryHost({ userDataPath: tmp, syncDir: null })).toBe('host')
  return f as unknown as Fake
}

describe('memory client: cancel and lane', () => {
  it('the route is taken off the options: the lane rides on the message, the signal never crosses', async () => {
    const f = await startFake()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'routes stay on this side' })
    const ctl = new AbortController()
    const hits = await memorySearch({ query: 'routes', limit: 3, signal: ctl.signal, lane: 'interactive' })
    expect(hits.length).toBe(1)
    const sent = f.posted.find((m) => m.kind === 'call' && m.fn === 'memorySearch') as Extract<HostRequest, { kind: 'call' }>
    expect(sent.lane).toBe('interactive')
    expect(sent.args).toEqual([{ query: 'routes', limit: 3 }])
    await memoryList({ limit: 2, lane: 'background' })
    const l = f.posted.find((m) => m.kind === 'call' && m.fn === 'memoryList') as Extract<HostRequest, { kind: 'call' }>
    expect(l.lane).toBe('background')
    expect(l.args).toEqual([{ limit: 2 }])
    const plain = f.posted.find((m) => m.kind === 'call' && m.fn === 'memoryWrite') as Extract<HostRequest, { kind: 'call' }>
    expect('lane' in plain).toBe(false)
  })

  it('cancelling drops the pending call at once, rejects AbortError and tells the host to stop', async () => {
    const f = await startFake()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'parked search' })
    const g = gatedEmbed()
    const ctl = new AbortController()
    const p = memorySearch({ query: 'parked', limit: 3, signal: ctl.signal, lane: 'interactive' })
    await tick(); await tick()
    expect(g.calls()).toBe(1)
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    const call = f.posted.find((m) => m.kind === 'call' && m.fn === 'memorySearch') as Extract<HostRequest, { kind: 'call' }>
    expect(f.posted).toContainEqual({ kind: 'cancel', id: call.id })
    g.open()
    await tick(); await tick()
    expect(_hostLaneForTests().inflight).toBe(0) // the host stopped too, and its late reply was dropped
    ctl.abort() // a second abort is harmless
  })

  it('an already-cancelled call is never sent', async () => {
    const f = await startFake()
    const ctl = new AbortController()
    ctl.abort()
    await expect(memorySearch({ query: 'never sent', signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.posted.some((m) => m.kind === 'call' && m.fn === 'memorySearch')).toBe(false)
  })

  it('a call that answers first removes its abort listener: a later abort changes nothing', async () => {
    await startFake()
    const ctl = new AbortController()
    const spy = vi.spyOn(ctl.signal, 'removeEventListener')
    await memoryList({ signal: ctl.signal })
    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function))
    ctl.abort()
  })

  it('the 60 s timeout sends the same cancel to the host', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = await startFake({ swallow: 'memorySearch' })
      const ctl = new AbortController()
      const p = memorySearch({ query: 'hangs', signal: ctl.signal })
      const settled = p.catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(0)
      const call = f.posted.find((m) => m.kind === 'call' && m.fn === 'memorySearch') as Extract<HostRequest, { kind: 'call' }>
      await vi.advanceTimersByTimeAsync(60_000)
      expect(String(await settled)).toMatch(/timed out after 60000ms/)
      expect(f.posted).toContainEqual({ kind: 'cancel', id: call.id })
      ctl.abort() // after the timeout: nothing left to cancel, nothing posted twice
      expect(f.posted.filter((m) => m.kind === 'cancel')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a timeout without a signal still sends the cancel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = await startFake({ swallow: 'memoryList' })
      const settled = memoryList({}).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(String(await settled)).toMatch(/timed out/)
      expect(f.posted.some((m) => m.kind === 'cancel')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a host that dies while the cancel is sent: the caller is still answered with AbortError', async () => {
    const f = await startFake()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the host dies mid search' })
    const g = gatedEmbed()
    const ctl = new AbortController()
    const p = memorySearch({ query: 'dies', signal: ctl.signal })
    await tick(); await tick()
    f.transport.postMessage = () => { throw new Error('channel closed') }
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    g.open()
  })

  it('a post that throws for a call with a signal rejects with that error and leaves no listener behind', async () => {
    const f = await startFake()
    f.transport.postMessage = () => { throw new Error('channel closed') }
    const ctl = new AbortController()
    await expect(memoryList({ signal: ctl.signal })).rejects.toThrow('channel closed')
    ctl.abort()
  })
})

describe('memory client: cancel in process (no host)', () => {
  async function startInproc(): Promise<void> {
    setMemoryHostSpawner(() => { throw new Error('no fork here') })
    expect(await startMemoryHost({ userDataPath: tmp, syncDir: null })).toBe('inproc')
  }

  it('the search gets the signal and the caller is answered at once', async () => {
    await startInproc()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'in process search' })
    const g = gatedEmbed()
    const ctl = new AbortController()
    const p = memorySearch({ query: 'process', signal: ctl.signal })
    await tick()
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    g.open()
  })

  it('uncancelled, it answers; a failing call with a signal rejects with its own error', async () => {
    await startInproc()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'in process answer' })
    const ctl = new AbortController()
    expect((await memorySearch({ query: 'answer', signal: ctl.signal })).length).toBe(1)
    expect(await memoryList({ signal: ctl.signal })).toHaveLength(1)
    await expect(memoryList({ signal: ctl.signal, since: Symbol('x') } as never)).rejects.toThrow(TypeError)
  })

  it('initSwarmMemory is the only init here (control: the store answered from this suite\'s folder)', () => {
    expect(() => initSwarmMemory(tmp)).not.toThrow()
  })
})
