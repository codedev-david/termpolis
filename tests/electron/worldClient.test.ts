import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake-userdata' },
  utilityProcess: {
    fork: () => {
      throw new Error('no utilityProcess in tests')
    }
  }
}))

import type { GraphSnapshot } from '../../src/main/codeGraph'
import { _resetCodeGraphForTests, graphKeyForRoot, indexFileContent } from '../../src/main/codeGraph'
import { createWorldClient, type WorldClientOptions, type WorldHostTransport } from '../../src/main/world/worldClient'
import { createLlmGate, GATE_SETTLE_GRACE_MS, WORLD_LLM_HOST_LIMIT } from '../../src/main/world/llmGate'
import { LABEL_ANSWER_LIMIT_MS, LABEL_CALL_TIMEOUT_MS, LABEL_PREP_ALLOWANCE_MS } from '../../src/main/world/label'
import { LLM_TIMEOUT_MS } from '../../src/main/world/worldHost'
import type { WorldHostRequest, WorldHostResponse } from '../../src/main/world/worldHost'
import { worldFileName } from '../../src/main/world/worldStore'
import { captureConsole, clearAppLog, readAppLog, type ConsoleLike } from '../../src/main/appLog'
import type { WorldDoc } from '../../src/shared/world/types'

const ROOT = 'C:/repos/demo'
const KEY = graphKeyForRoot(ROOT)
const SNAP: GraphSnapshot = { root: ROOT, files: ['src/a.ts', 'src/b.ts'], symbols: [], callEdges: [], fileImports: {} }
const DOC = { projectKey: KEY, version: 1 } as unknown as WorldDoc

type CallMsg = Extract<WorldHostRequest, { kind: 'call' }>

class FakeTransport implements WorldHostTransport {
  posted: WorldHostRequest[] = []
  killed = 0
  pid = 4242
  msgCb: ((m: WorldHostResponse) => void) | null = null
  exitCb: ((code: number) => void) | null = null
  /** Answers each call; return undefined to leave it pending. */
  reply: ((m: CallMsg) => WorldHostResponse | undefined) | null = null
  autoReady = true
  throwOnPost = false
  throwOnKill = false
  postMessage(m: WorldHostRequest): void {
    if (this.throwOnPost && m.kind !== 'init') throw this.throwOnPost === true ? new Error('port closed') : this.throwOnPost
    this.posted.push(m)
    if (m.kind === 'init' && this.autoReady) queueMicrotask(() => this.emit({ kind: 'ready', pid: this.pid }))
    if (m.kind === 'call' && this.reply) {
      const r = this.reply(m)
      if (r) queueMicrotask(() => this.emit(r))
    }
  }
  onMessage(cb: (m: WorldHostResponse) => void): void {
    this.msgCb = cb
  }
  onExit(cb: (code: number) => void): void {
    this.exitCb = cb
  }
  kill(): void {
    this.killed++
    if (this.throwOnKill) throw new Error('already dead')
  }
  emit(m: WorldHostResponse): void {
    this.msgCb?.(m)
  }
  exit(code: number): void {
    this.exitCb?.(code)
  }
  calls(): CallMsg[] {
    return this.posted.filter((m): m is CallMsg => m.kind === 'call')
  }
}

function setup(opts: WorldClientOptions = {}, configure?: (t: FakeTransport) => void) {
  const spawned: FakeTransport[] = []
  const spawn = vi.fn(() => {
    const t = new FakeTransport()
    t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? null : DOC })
    configure?.(t)
    spawned.push(t)
    return t
  })
  // Each test gets its own gate, as main's one per process would carry one test's running calls into the next.
  const llmGate = createLlmGate({ graceMs: LABEL_CALL_TIMEOUT_MS + GATE_SETTLE_GRACE_MS })
  const client = createWorldClient(spawn, { userDataPath: '/ud', snapshot: () => SNAP, llmGate, ...opts })
  return { client, spawn, spawned }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-client-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('createWorldClient', () => {
  it('spawns lazily, inits once with userData + labelling, and reuses the host', async () => {
    const { client, spawn, spawned } = setup()
    expect(spawn).not.toHaveBeenCalled()
    expect(client.pid).toBeUndefined()
    expect(await client.compile(ROOT)).toEqual(DOC)
    expect(await client.get(ROOT)).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(client.pid).toBe(4242)
    const t = spawned[0]
    expect(t.posted[0]).toEqual({ kind: 'init', userDataPath: '/ud', labelling: true })
    expect(t.calls().map((c) => [c.fn, c.args])).toEqual([
      ['compile', [KEY, SNAP, { head: '', dirty: false }]],
      ['get', [KEY]]
    ])
  })

  it('takes userData from a function, labelling off, and head from the option', async () => {
    const head = vi.fn(async () => ({ head: 'abc', dirty: true }))
    const { client, spawned } = setup({ userDataPath: () => '/ud2', labelling: () => false, head })
    await client.relayout(ROOT)
    expect(spawned[0].posted[0]).toEqual({ kind: 'init', userDataPath: '/ud2', labelling: false })
    expect(spawned[0].calls()[0].args).toEqual([KEY, SNAP, { head: 'abc', dirty: true }, { relayout: true }])
    expect(head).toHaveBeenCalledWith(ROOT)
  })

  it('defaults userData to app.getPath and the snapshot to the code graph', async () => {
    const spawned: FakeTransport[] = []
    const client = createWorldClient(() => {
      const t = new FakeTransport()
      t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: DOC })
      spawned.push(t)
      return t
    })
    indexFileContent(`${ROOT}/src/a.ts`, 'export function alpha() { return 1 }', KEY)
    try {
      await client.compile(ROOT)
      expect(spawned[0].posted[0]).toMatchObject({ userDataPath: '/fake-userdata' })
      const snap = spawned[0].calls()[0].args[1] as GraphSnapshot
      expect(snap.root).toBe(ROOT)
      expect(snap.files).toEqual(['src/a.ts'])
      // Structure only: the indexed symbol is not copied across.
      expect(snap.symbols).toEqual([])
      expect(snap.callEdges).toEqual([])
    } finally {
      _resetCodeGraphForTests()
    }
  })

  it('with no spawner it tries the real utilityProcess, fails, and tries again on the next call', async () => {
    const client = createWorldClient()
    await expect(client.get(ROOT)).rejects.toThrow('no utilityProcess in tests')
    await expect(client.get(ROOT)).rejects.toThrow('no utilityProcess in tests')
  })

  it('correlates request ids under concurrency', async () => {
    const { client, spawned } = setup({}, (t) => {
      t.reply = null
    })
    const a = client.read(ROOT, { text: 'a' })
    const b = client.read(ROOT, { text: 'b' })
    const c = client.read(ROOT, undefined as never)
    await vi.waitFor(() => expect(spawned[0]?.calls()).toHaveLength(3))
    const [ca, cb, cc] = spawned[0].calls()
    expect(new Set([ca.id, cb.id, cc.id]).size).toBe(3)
    expect(cc.args).toEqual([KEY, {}])
    spawned[0].emit({ kind: 'result', id: cb.id, ok: true, result: 'B' })
    spawned[0].emit({ kind: 'result', id: 999, ok: true, result: 'stray' })
    spawned[0].emit({ kind: 'result', id: ca.id, ok: true, result: 'A' })
    spawned[0].emit({ kind: 'result', id: cc.id, ok: false, error: { name: 'TypeError', message: 'bad query' } })
    expect(await a).toBe('A')
    expect(await b).toBe('B')
    await expect(c).rejects.toMatchObject({ name: 'TypeError', message: 'bad query' })
  })

  it('a host error without detail still rejects with a message', async () => {
    const { client } = setup({}, (t) => {
      t.reply = (m) => ({ kind: 'result', id: m.id, ok: false, error: undefined as never })
    })
    await expect(client.get(ROOT)).rejects.toMatchObject({ name: 'Error', message: 'Lumopolis host call failed' })
  })

  it('host exit rejects pending calls and the next call starts a fresh host', async () => {
    let n = 0
    const { client, spawned, spawn } = setup({}, (t) => {
      if (n++ === 0) t.reply = null
    })
    const pending = client.compile(ROOT)
    await vi.waitFor(() => expect(spawned[0]?.calls()).toHaveLength(1))
    spawned[0].exit(3)
    await expect(pending).rejects.toThrow('Lumopolis host exited (code 3)')
    expect(client.pid).toBeUndefined()
    expect(await client.compile(ROOT)).toEqual(DOC)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawned[1].posted[0].kind).toBe('init')
    // a late exit or message from the old host changes nothing
    spawned[0].exit(1)
    spawned[0].emit({ kind: 'updated', projectKey: KEY })
    expect(await client.get(ROOT)).toBeNull()
  })

  it('a host that dies before ready rejects the call', async () => {
    const { client, spawned } = setup({}, (t) => {
      t.autoReady = false
    })
    const p = client.get(ROOT)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    spawned[0].exit(9)
    await expect(p).rejects.toThrow('code 9')
  })

  it('init-error rejects, kills that host (even if kill throws), and the next call respawns', async () => {
    let n = 0
    const { client, spawned } = setup({}, (t) => {
      if (n++ === 0) {
        t.autoReady = false
        t.throwOnKill = true
      }
    })
    const p = client.get(ROOT)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    spawned[0].emit({ kind: 'init-error', error: { name: 'Error', message: 'disk full' } })
    await expect(p).rejects.toThrow('disk full')
    expect(spawned[0].killed).toBe(1)
    expect(await client.get(ROOT)).toBeNull()
    expect(spawned).toHaveLength(2)
  })

  it('a host that never answers init is given up on after 30 s, killed, and the next call respawns', async () => {
    vi.useFakeTimers()
    let n = 0
    const { client, spawned } = setup({}, (t) => {
      if (n++ === 0) {
        t.autoReady = false
        t.throwOnKill = true
      }
    })
    const p = client.get(ROOT)
    const seen = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawned).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(spawned[0].killed).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect((await seen as Error).message).toBe('Lumopolis host did not start in time')
    expect(spawned[0].killed).toBe(1)
    const next = client.get(ROOT)
    await vi.advanceTimersByTimeAsync(0)
    expect(await next).toBeNull()
    expect(spawned).toHaveLength(2)
    // A host that did answer in time is never killed by the stale timer.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawned[1].killed).toBe(0)
  })

  it('takes a custom init timeout', async () => {
    vi.useFakeTimers()
    const { client, spawned } = setup({ initTimeoutMs: 50 }, (t) => {
      t.autoReady = false
    })
    const seen = client.get(ROOT).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(50)
    expect((await seen as Error).message).toContain('did not start in time')
    expect(spawned[0].killed).toBe(1)
  })

  it('ignores junk messages and unknown kinds', async () => {
    const { client, spawned } = setup()
    await client.get(ROOT)
    spawned[0].emit(null as never)
    spawned[0].emit({ kind: 'mystery' } as never)
    expect(await client.get(ROOT)).toBeNull()
  })

  it('times a call out', async () => {
    const { client } = setup({ callTimeoutMs: 5 }, (t) => {
      t.reply = null
    })
    await expect(client.get(ROOT)).rejects.toThrow('Lumopolis host call "get" timed out')
  })

  it('a post that throws rejects that call', async () => {
    const { client, spawned } = setup({}, (t) => {
      t.throwOnPost = true
    })
    await expect(client.get(ROOT)).rejects.toThrow('port closed')
    spawned[0].throwOnPost = 'raw' as never
    await expect(client.get(ROOT)).rejects.toThrow('raw')
  })

  it('rejects a root that is not a project folder', async () => {
    const { client, spawn } = setup()
    await expect(client.get('')).rejects.toThrow('Lumopolis needs a project folder')
    await expect(client.compile('justaname')).rejects.toThrow('Lumopolis needs a project folder')
    await expect(client.read(42 as unknown as string, {})).rejects.toThrow('Lumopolis needs a project folder')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('maps progress and updated pushes back to the root; subscribers are isolated and can leave', async () => {
    const { client, spawned } = setup()
    const progress: unknown[] = []
    const updated: unknown[] = []
    const offBad = client.onProgress(() => {
      throw new Error('bad subscriber')
    })
    const off = client.onProgress((e) => progress.push(e))
    const offU = client.onUpdated((e) => updated.push(e))
    await client.compile(ROOT)
    const t = spawned[0]
    t.emit({ kind: 'progress', projectKey: KEY, stage: 'layout', pct: 50 })
    t.emit({ kind: 'progress', projectKey: 'unknown', stage: 'structure', pct: 0 })
    t.emit({ kind: 'updated', projectKey: KEY })
    t.emit({ kind: 'updated', projectKey: 'unknown' })
    expect(progress).toEqual([
      { root: ROOT, projectKey: KEY, stage: 'layout', pct: 50 },
      { root: '', projectKey: 'unknown', stage: 'structure', pct: 0 }
    ])
    expect(updated).toEqual([
      { root: ROOT, projectKey: KEY },
      { root: '', projectKey: 'unknown' }
    ])
    off()
    offBad()
    offU()
    t.emit({ kind: 'progress', projectKey: KEY, stage: 'layout', pct: 90 })
    t.emit({ kind: 'updated', projectKey: KEY })
    expect(progress).toHaveLength(2)
    expect(updated).toHaveLength(2)
  })

  it('answers labelling requests with the llm option, and null when it is absent, throws or returns junk', async () => {
    const llm = vi.fn(async (_root: string, prompt: string) => {
      if (prompt === 'throw') throw new Error('model down')
      if (prompt === 'junk') return 5 as unknown as string
      return `answer:${prompt}`
    })
    const { client, spawned } = setup({ llm })
    await client.compile(ROOT)
    const t = spawned[0]
    t.emit({ kind: 'llm', id: 1, projectKey: KEY, prompt: 'hi' })
    t.emit({ kind: 'llm', id: 2, projectKey: KEY, prompt: 'throw' })
    t.emit({ kind: 'llm', id: 3, projectKey: KEY, prompt: 'junk' })
    t.emit({ kind: 'llm', id: 4, projectKey: 'unknown', prompt: 'hi' })
    await vi.waitFor(() => expect(t.posted.filter((m) => m.kind === 'llm-result')).toHaveLength(4))
    const answers = t.posted.filter((m) => m.kind === 'llm-result')
    expect(answers).toEqual(
      expect.arrayContaining([
        { kind: 'llm-result', id: 1, text: 'answer:hi' },
        { kind: 'llm-result', id: 2, text: null },
        { kind: 'llm-result', id: 3, text: null },
        { kind: 'llm-result', id: 4, text: null }
      ])
    )
    expect(llm).toHaveBeenCalledWith(ROOT, 'hi', expect.any(AbortSignal))
    // Each call that ran was told to the host as it started, so its limit counts the call and never a wait for a slot.
    expect(t.posted.filter((m) => m.kind === 'llm-started')).toEqual([1, 2, 3].map((id) => ({ kind: 'llm-started', id })))
    expect(llm).toHaveBeenCalledTimes(3)

    const plain = setup()
    await plain.client.compile(ROOT)
    plain.spawned[0].emit({ kind: 'llm', id: 7, projectKey: KEY, prompt: 'x' })
    await vi.waitFor(() => expect(plain.spawned[0].posted).toContainEqual({ kind: 'llm-result', id: 7, text: null }))

    // a host that died while the model ran: the answer is dropped quietly
    t.throwOnPost = true
    t.emit({ kind: 'llm', id: 8, projectKey: KEY, prompt: 'late' })
    await flush()
  })

  it('every world shares one labelling gate: two projects asking 4 calls each run at most 4 at once (caveat 4)', async () => {
    const ROOT2 = 'C:/repos/other'
    const KEY2 = graphKeyForRoot(ROOT2)
    const running = new Map<string, (t: string) => void>()
    let most = 0
    const llm = vi.fn(
      (_root: string, prompt: string) =>
        new Promise<string | null>((resolve) => {
          running.set(prompt, resolve)
          most = Math.max(most, running.size)
        })
    )
    const { client, spawned } = setup({ llm })
    await client.compile(ROOT)
    await client.compile(ROOT2)
    const t = spawned[0]
    for (let i = 1; i <= 4; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `a${i}` })
    for (let i = 5; i <= 8; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY2, prompt: `b${i}` })
    await flush()
    expect(llm).toHaveBeenCalledTimes(4)
    expect([...running.keys()]).toEqual(['a1', 'a2', 'a3', 'a4'])
    // The four that started were told so (the host starts their limits); the waiting four were not.
    expect(t.posted.filter((m) => m.kind === 'llm-started')).toEqual([1, 2, 3, 4].map((id) => ({ kind: 'llm-started', id })))
    // In order of asking, the next starts as each one ends.
    const end = async (prompt: string): Promise<void> => {
      running.get(prompt)?.(`done ${prompt}`)
      running.delete(prompt)
      await flush()
    }
    await end('a1')
    expect([...running.keys()]).toEqual(['a2', 'a3', 'a4', 'b5'])
    for (const p of ['a2', 'a3', 'a4', 'b5', 'b6', 'b7', 'b8']) await end(p)
    expect(most).toBe(4)
    expect(t.posted.filter((m) => m.kind === 'llm-result')).toHaveLength(8)
    expect(t.posted).toContainEqual({ kind: 'llm-result', id: 8, text: 'done b8' })
  })

  it('a waiting labelling call never starts its CLI once the host cancels it, its world is removed or labelling goes off (caveat 4)', async () => {
    const ROOT2 = 'C:/repos/other'
    const KEY2 = graphKeyForRoot(ROOT2)
    const running = new Map<string, { resolve(t: string): void; signal: AbortSignal }>()
    let on = true
    const llm = vi.fn(
      (_root: string, prompt: string, signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          running.set(prompt, { resolve, signal })
        })
    )
    const { client, spawned } = setup({ llm, labelling: () => on })
    await client.compile(ROOT)
    await client.compile(ROOT2)
    const t = spawned[0]
    const result = (id: number) => t.posted.find((m) => m.kind === 'llm-result' && m.id === id)
    for (let i = 1; i <= 4; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `busy${i}` })
    t.emit({ kind: 'llm', id: 5, projectKey: KEY, prompt: 'cancelled by the host' })
    t.emit({ kind: 'llm', id: 6, projectKey: KEY2, prompt: 'world removed' })
    t.emit({ kind: 'llm', id: 7, projectKey: KEY, prompt: 'kept' })
    await flush()
    expect(llm).toHaveBeenCalledTimes(4)

    // The host stopped waiting for 5; an llm-cancel for an id nobody waits on changes nothing.
    t.emit({ kind: 'llm-cancel', id: 5 })
    t.emit({ kind: 'llm-cancel', id: 99 })
    // The other project's world is removed from the home.
    client.cancelLabelling(KEY2)
    await flush()
    expect(result(5)).toEqual({ kind: 'llm-result', id: 5, text: null })
    expect(result(6)).toEqual({ kind: 'llm-result', id: 6, text: null })
    expect(result(7)).toBeUndefined()

    // A slot frees: 7 starts, never 5 or 6.
    running.get('busy1')?.resolve('one')
    await flush()
    expect(running.has('kept')).toBe(true)
    expect(running.has('cancelled by the host')).toBe(false)
    expect(running.has('world removed')).toBe(false)
    expect(t.posted).toContainEqual({ kind: 'llm-started', id: 7 })
    expect(t.posted).not.toContainEqual({ kind: 'llm-started', id: 5 })
    expect(t.posted).not.toContainEqual({ kind: 'llm-started', id: 6 })

    // Settings applied with labelling still on change nothing; turned off, every call is answered null and running CLIs are told to stop.
    client.applySettings()
    expect(running.get('kept')?.signal.aborted).toBe(false)
    t.emit({ kind: 'llm', id: 8, projectKey: KEY, prompt: 'behind' })
    await flush()
    on = false
    client.applySettings()
    await flush()
    expect(running.get('kept')?.signal.aborted).toBe(true)
    expect(running.get('busy2')?.signal.aborted).toBe(true)
    expect(result(7)).toEqual({ kind: 'llm-result', id: 7, text: null })
    expect(result(8)).toEqual({ kind: 'llm-result', id: 8, text: null })
    expect(running.has('behind')).toBe(false)
  })

  it('a removed world starts no CLI for any labelling request it asks later, until it is asked for again (caveat 4, round 1)', async () => {
    const llm = vi.fn(async (_root: string, prompt: string) => `done ${prompt}`)
    const { client, spawned } = setup({ llm })
    await client.compile(ROOT)
    const t = spawned[0]
    const result = (id: number) => t.posted.find((m) => m.kind === 'llm-result' && m.id === id)
    client.cancelLabelling(KEY)
    // The host is told, so its label run for the world stops asking.
    expect(t.posted).toContainEqual({ kind: 'labelling-stopped', keys: [KEY] })
    // The label run's next batches, and its second chances for the dropped ones, start nothing.
    for (let i = 1; i <= 6; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `later${i}` })
    await flush()
    for (let i = 1; i <= 6; i++) expect(result(i)).toEqual({ kind: 'llm-result', id: i, text: null })
    expect(llm).not.toHaveBeenCalled()
    expect(t.posted.some((m) => m.kind === 'llm-started')).toBe(false)
    // Removing it twice tells the host the same set; asking for another world leaves it removed.
    client.cancelLabelling(KEY)
    expect(t.posted.filter((m) => m.kind === 'labelling-stopped').slice(-1)[0]).toEqual({ kind: 'labelling-stopped', keys: [KEY] })
    await client.compile('C:/repos/other')
    t.emit({ kind: 'llm', id: 7, projectKey: KEY, prompt: 'still removed' })
    await flush()
    expect(llm).not.toHaveBeenCalled()
    // Opened again (re-added), it labels again, and the host is told it is no longer removed.
    await client.compile(ROOT)
    expect(t.posted.filter((m) => m.kind === 'labelling-stopped').slice(-1)[0]).toEqual({ kind: 'labelling-stopped', keys: [] })
    t.emit({ kind: 'llm', id: 8, projectKey: KEY, prompt: 'back' })
    await flush()
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result(8)).toEqual({ kind: 'llm-result', id: 8, text: 'done back' })
  })

  it('an agent or Ask reading a removed world does not take it back: no CLI starts and its label run is not resumed (caveat 4, round 2)', async () => {
    const llm = vi.fn(async (_root: string, prompt: string) => `done ${prompt}`)
    const { client, spawned } = setup({ llm })
    await client.compile(ROOT)
    const t = spawned[0]
    const told = () => t.posted.filter((m) => m.kind === 'labelling-stopped')
    const result = (id: number) => t.posted.find((m) => m.kind === 'llm-result' && m.id === id)
    client.cancelLabelling(KEY)
    // An agent's world tool reads it; Ask loads it without a refresh, then reads it.
    await client.read(ROOT, { text: 'who calls it' })
    await client.get(ROOT, { refresh: false })
    // The host is never told it is back, so its label run stays stopped, and a request of the world starts no CLI.
    expect(told()).toEqual([{ kind: 'labelling-stopped', keys: [KEY] }])
    t.emit({ kind: 'llm', id: 1, projectKey: KEY, prompt: 'after the read' })
    await flush()
    expect(llm).not.toHaveBeenCalled()
    expect(result(1)).toEqual({ kind: 'llm-result', id: 1, text: null })
    // A person opening it (the pane's get) takes it back.
    await client.get(ROOT)
    expect(told().slice(-1)[0]).toEqual({ kind: 'labelling-stopped', keys: [] })
    t.emit({ kind: 'llm', id: 2, projectKey: KEY, prompt: 'opened' })
    await flush()
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result(2)).toEqual({ kind: 'llm-result', id: 2, text: 'done opened' })
  })

  it('a host started after a world was removed is told which worlds are removed before any call (caveat 4, round 2)', async () => {
    const { client, spawned } = setup({ llm: vi.fn(async () => 'x') })
    await client.compile(ROOT)
    // None removed: a host is told nothing.
    expect(spawned[0].posted.some((m) => m.kind === 'labelling-stopped')).toBe(false)
    client.cancelLabelling(KEY)
    // The host exits; the next host, started by a call for another world, is told at once.
    spawned[0].exit(1)
    await client.compile('C:/repos/other')
    const t = spawned[1]
    expect(t.posted.slice(0, 3).map((m) => m.kind)).toEqual(['init', 'labelling-stopped', 'call'])
    expect(t.posted[1]).toEqual({ kind: 'labelling-stopped', keys: [KEY] })
  })

  it('a world removed while no host runs, or while the host cannot be told, still starts no CLI for its labelling requests (caveat 4, round 2)', async () => {
    const llm = vi.fn(async () => 'x')
    const { client, spawned } = setup({ llm })
    const result = (id: number) => spawned[0].posted.find((m) => m.kind === 'llm-result' && m.id === id)
    // Removed before any host runs; an agent's read then starts one.
    client.cancelLabelling(KEY)
    await client.read(ROOT, { text: 'q' })
    const t = spawned[0]
    t.emit({ kind: 'llm', id: 1, projectKey: KEY, prompt: 'no host when removed' })
    await flush()
    expect(llm).not.toHaveBeenCalled()
    expect(result(1)).toEqual({ kind: 'llm-result', id: 1, text: null })
    // Opened again, it labels.
    await client.compile(ROOT)
    t.emit({ kind: 'llm', id: 2, projectKey: KEY, prompt: 'opened' })
    await flush()
    expect(llm).toHaveBeenCalledTimes(1)
    // Removed again while the host cannot be told: that throws nothing, and its next request still starts no CLI.
    const post = t.postMessage.bind(t)
    t.postMessage = (m) => {
      if (m.kind === 'labelling-stopped') throw new Error('gone')
      post(m)
    }
    expect(() => client.cancelLabelling(KEY)).not.toThrow()
    t.emit({ kind: 'llm', id: 3, projectKey: KEY, prompt: 'host not told' })
    await flush()
    expect(llm).toHaveBeenCalledTimes(1)
    expect(result(3)).toEqual({ kind: 'llm-result', id: 3, text: null })
  })

  it('a running call the host gives up on is answered null at once and its CLI told to stop, but its slot waits until that CLI exits (caveat 4)', async () => {
    const running = new Map<string, { resolve(t: string | null): void; signal: AbortSignal }>()
    const llm = vi.fn((_root: string, prompt: string, signal: AbortSignal) => new Promise<string | null>((resolve) => running.set(prompt, { resolve, signal })))
    const { client, spawned } = setup({ llm })
    await client.compile(ROOT)
    const t = spawned[0]
    for (let i = 1; i <= 5; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `p${i}` })
    await flush()
    t.emit({ kind: 'llm-cancel', id: 1 })
    await flush()
    expect(t.posted).toContainEqual({ kind: 'llm-result', id: 1, text: null })
    expect(running.get('p1')?.signal.aborted).toBe(true)
    // The stopped CLI still runs: a fifth would make five processes, so the waiting call stays waiting.
    expect(running.has('p5')).toBe(false)
    running.get('p1')?.resolve(null)
    await flush()
    expect(running.has('p5')).toBe(true)
    expect(llm).toHaveBeenCalledTimes(5)
  })

  it("main's limit on a started call is the host's, the CLI's own limit plus the time main takes to start it, so a reply the CLI gives in time is never dropped (caveat 4, round 1)", async () => {
    expect(LABEL_CALL_TIMEOUT_MS).toBe(120_000)
    expect(LABEL_PREP_ALLOWANCE_MS).toBe(30_000)
    expect(LABEL_ANSWER_LIMIT_MS).toBe(LABEL_CALL_TIMEOUT_MS + LABEL_PREP_ALLOWANCE_MS)
    // The host times the same call from the same moment (llm-started) with the same figure.
    expect(LLM_TIMEOUT_MS).toBe(LABEL_ANSWER_LIMIT_MS)
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      // Main spends most of its allowance before the CLI starts (settings, launch env, proxy), and the CLI then answers
      // a moment before its own 120 s.
      const llm = vi.fn((_root: string, prompt: string, signal: AbortSignal) => {
        signals.push(signal)
        return new Promise<string | null>((resolve) => setTimeout(() => resolve(`late ${prompt}`), prompt === 'in time' ? LABEL_PREP_ALLOWANCE_MS - 1000 + LABEL_CALL_TIMEOUT_MS - 1 : 10 * LABEL_ANSWER_LIMIT_MS))
      })
      const { client, spawned } = setup({ llm })
      const compiled = client.compile(ROOT)
      await vi.advanceTimersByTimeAsync(0)
      await compiled
      const t = spawned[0]
      const result = (id: number) => t.posted.find((m) => m.kind === 'llm-result' && m.id === id)
      t.emit({ kind: 'llm', id: 1, projectKey: KEY, prompt: 'in time' })
      t.emit({ kind: 'llm', id: 2, projectKey: KEY, prompt: 'never' })
      await vi.advanceTimersByTimeAsync(LABEL_PREP_ALLOWANCE_MS - 1000 + LABEL_CALL_TIMEOUT_MS - 1)
      expect(result(1)).toEqual({ kind: 'llm-result', id: 1, text: 'late in time' })
      // The other is answered null at exactly the limit, and its CLI told to stop.
      await vi.advanceTimersByTimeAsync(LABEL_ANSWER_LIMIT_MS - (LABEL_PREP_ALLOWANCE_MS - 1000 + LABEL_CALL_TIMEOUT_MS - 1) - 1)
      expect(result(2)).toBeUndefined()
      expect(signals[1].aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(result(2)).toEqual({ kind: 'llm-result', id: 2, text: null })
      expect(signals[1].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two clients made without a gate share the one gate of the process: a second client cannot double the limit (caveat 4, round 1)', async () => {
    const running = new Map<string, (t: string) => void>()
    const llm = vi.fn((_root: string, prompt: string) => new Promise<string | null>((resolve) => running.set(prompt, resolve)))
    const a = setup({ llm, llmGate: undefined })
    const b = setup({ llm, llmGate: undefined })
    await a.client.compile(ROOT)
    await b.client.compile(ROOT)
    for (let i = 1; i <= WORLD_LLM_HOST_LIMIT; i++) a.spawned[0].emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `a${i}` })
    b.spawned[0].emit({ kind: 'llm', id: 1, projectKey: KEY, prompt: 'b1' })
    await flush()
    expect(llm).toHaveBeenCalledTimes(WORLD_LLM_HOST_LIMIT)
    expect(running.has('b1')).toBe(false)
    // One of the first client's calls ends: the second client's call takes its slot.
    running.get('a1')?.('one')
    await flush()
    expect(running.has('b1')).toBe(true)
    // (the shared gate is left empty for any later test)
    for (const p of ['a2', 'a3', 'a4', 'b1']) running.get(p)?.('done')
    await flush()
    expect(b.spawned[0].posted).toContainEqual({ kind: 'llm-result', id: 1, text: 'done' })
  })

  it('a stopped CLI that never exits holds its slot for at most its own limit and the grace after it', async () => {
    vi.useFakeTimers()
    try {
      const started: string[] = []
      const llm = vi.fn((_root: string, prompt: string) => new Promise<string | null>(() => { started.push(prompt) }))
      const { client, spawned } = setup({ llm })
      const compiled = client.compile(ROOT)
      await vi.advanceTimersByTimeAsync(0)
      await compiled
      const t = spawned[0]
      for (let i = 1; i <= 5; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `p${i}` })
      await vi.advanceTimersByTimeAsync(0)
      t.emit({ kind: 'llm-cancel', id: 1 })
      await vi.advanceTimersByTimeAsync(LABEL_CALL_TIMEOUT_MS + GATE_SETTLE_GRACE_MS - 1)
      expect(started).toEqual(['p1', 'p2', 'p3', 'p4'])
      await vi.advanceTimersByTimeAsync(1)
      expect(started).toContain('p5')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a call that gets its slot after labelling went off (no settings message yet) is answered null without a CLI; a host exit drops its waiting calls', async () => {
    const running = new Map<string, (t: string) => void>()
    let on = true
    const llm = vi.fn((_root: string, prompt: string) => new Promise<string | null>((resolve) => running.set(prompt, resolve)))
    const { client, spawned } = setup({ llm, labelling: () => on })
    await client.compile(ROOT)
    const t = spawned[0]
    for (let i = 1; i <= 5; i++) t.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `p${i}` })
    await flush()
    on = false
    running.get('p1')?.('one')
    await flush()
    expect(llm).toHaveBeenCalledTimes(4)
    expect(t.posted).toContainEqual({ kind: 'llm-started', id: 5 })
    expect(t.posted).toContainEqual({ kind: 'llm-result', id: 5, text: null })

    // Another client's host: a fifth call waits, the host exits, and it never starts.
    const llm2 = vi.fn((_r: string, p: string) => new Promise<string | null>((resolve) => running.set(`second ${p}`, resolve)))
    const second = setup({ llm: llm2 })
    await second.client.compile(ROOT)
    const t2 = second.spawned[0]
    for (let i = 1; i <= 5; i++) t2.emit({ kind: 'llm', id: i, projectKey: KEY, prompt: `q${i}` })
    await flush()
    t2.exit(1)
    running.get('second q1')?.('late')
    await flush()
    expect(llm2).toHaveBeenCalledTimes(4)
    expect(running.has('second q5')).toBe(false)
    expect(t2.posted).not.toContainEqual({ kind: 'llm-started', id: 5 })
    // With no host running, turning labelling off cancels nothing and starts no host.
    const idle = setup({ labelling: () => false })
    idle.client.applySettings()
    expect(idle.spawned).toHaveLength(0)
  })

  it('worldClient answers runs requests from the transcript and CI hooks, and an absent or failing hook gives none', async () => {
    const run = { file: 'a.test.ts', passed: true, at: 1, source: 'ci' as const }
    const transcriptFiles = vi.fn(async (_root: string) => ['a.jsonl'])
    const ciRuns = vi.fn(async (root: string): Promise<(typeof run)[]> => {
      if (ciRuns.mock.calls.length === 1) throw new Error('gh down')
      return 5 as never
    })
    const { client, spawned } = setup({ transcriptFiles, ciRuns })
    await client.compile(ROOT)
    const t = spawned[0]
    t.emit({ kind: 'runs', id: 1, projectKey: KEY, source: 'transcript' })
    t.emit({ kind: 'runs', id: 2, projectKey: KEY, source: 'ci' })
    t.emit({ kind: 'runs', id: 3, projectKey: 'unknown', source: 'transcript' })
    t.emit({ kind: 'runs', id: 4, projectKey: KEY, source: 'other' as never })
    await vi.waitFor(() => expect(t.posted.filter((m) => m.kind === 'runs-result')).toHaveLength(4))
    t.emit({ kind: 'runs', id: 5, projectKey: KEY, source: 'ci' })
    await vi.waitFor(() => expect(t.posted.filter((m) => m.kind === 'runs-result')).toHaveLength(5))
    expect(t.posted.filter((m) => m.kind === 'runs-result')).toEqual(
      expect.arrayContaining([
        { kind: 'runs-result', id: 1, runs: [], files: ['a.jsonl'] },
        { kind: 'runs-result', id: 2, runs: [], files: [] },
        { kind: 'runs-result', id: 3, runs: [], files: [] },
        { kind: 'runs-result', id: 4, runs: [], files: [] },
        { kind: 'runs-result', id: 5, runs: [], files: [] }
      ])
    )
    expect(transcriptFiles).toHaveBeenCalledWith(ROOT)
    // a CI answer that is a list is passed on
    const ok = setup({ ciRuns: async () => [run] })
    await ok.client.compile(ROOT)
    ok.spawned[0].emit({ kind: 'runs', id: 6, projectKey: KEY, source: 'ci' })
    await vi.waitFor(() => expect(ok.spawned[0].posted).toContainEqual({ kind: 'runs-result', id: 6, runs: [run], files: [] }))
    // a transcript hook that fails, or answers with a non-list, names no files
    const bad = setup({ transcriptFiles: async () => 5 as never })
    await bad.client.compile(ROOT)
    bad.spawned[0].emit({ kind: 'runs', id: 9, projectKey: KEY, source: 'transcript' })
    await vi.waitFor(() => expect(bad.spawned[0].posted).toContainEqual({ kind: 'runs-result', id: 9, runs: [], files: [] }))
    const thrown = setup({ transcriptFiles: async () => { throw new Error('x') } })
    await thrown.client.compile(ROOT)
    thrown.spawned[0].emit({ kind: 'runs', id: 10, projectKey: KEY, source: 'transcript' })
    await vi.waitFor(() => expect(thrown.spawned[0].posted).toContainEqual({ kind: 'runs-result', id: 10, runs: [], files: [] }))

    const plain = setup()
    await plain.client.compile(ROOT)
    plain.spawned[0].emit({ kind: 'runs', id: 7, projectKey: KEY, source: 'ci' })
    await vi.waitFor(() => expect(plain.spawned[0].posted).toContainEqual({ kind: 'runs-result', id: 7, runs: [], files: [] }))

    // a host that died while main looked: the answer is dropped quietly
    t.throwOnPost = true
    t.emit({ kind: 'runs', id: 8, projectKey: KEY, source: 'transcript' })
    await flush()
  })

  it('worldClient relays context requests from the host to the main-side hook', async () => {
    const context = vi.fn(async (_root: string, members: string[]) => {
      if (members[0] === 'throw') throw new Error('brain down')
      if (members[0] === 'junk') return 5 as never
      return [{ kind: 'commit' as const, ref: 'abc1234', excerpt: `about ${members.join(',')}` }]
    })
    const { client, spawned } = setup({ context })
    await client.compile(ROOT)
    const t = spawned[0]
    t.emit({ kind: 'context', id: 1, projectKey: KEY, members: ['a.ts', 7 as never] })
    t.emit({ kind: 'context', id: 2, projectKey: KEY, members: ['throw'] })
    t.emit({ kind: 'context', id: 3, projectKey: KEY, members: ['junk'] })
    t.emit({ kind: 'context', id: 4, projectKey: 'unknown', members: ['a.ts'] })
    t.emit({ kind: 'context', id: 5, projectKey: KEY, members: 'nope' as never })
    await vi.waitFor(() => expect(t.posted.filter((m) => m.kind === 'context-result')).toHaveLength(5))
    const answers = t.posted.filter((m) => m.kind === 'context-result')
    expect(answers).toEqual(
      expect.arrayContaining([
        { kind: 'context-result', id: 1, evidence: [{ kind: 'commit', ref: 'abc1234', excerpt: 'about a.ts' }] },
        { kind: 'context-result', id: 2, evidence: [] },
        { kind: 'context-result', id: 3, evidence: [] },
        { kind: 'context-result', id: 4, evidence: [] },
        { kind: 'context-result', id: 5, evidence: [] }
      ])
    )
    expect(context).toHaveBeenCalledWith(ROOT, ['a.ts'])

    const plain = setup()
    await plain.client.compile(ROOT)
    plain.spawned[0].emit({ kind: 'context', id: 7, projectKey: KEY, members: ['a.ts'] })
    await vi.waitFor(() => expect(plain.spawned[0].posted).toContainEqual({ kind: 'context-result', id: 7, evidence: [] }))

    // labelling off: main reads nothing
    let on = false
    const off = setup({ context, labelling: () => on })
    await off.client.compile(ROOT)
    off.spawned[0].emit({ kind: 'context', id: 8, projectKey: KEY, members: ['a.ts'] })
    await vi.waitFor(() => expect(off.spawned[0].posted).toContainEqual({ kind: 'context-result', id: 8, evidence: [] }))
    on = true

    // a host that died while main looked: the answer is dropped quietly
    t.throwOnPost = true
    t.emit({ kind: 'context', id: 9, projectKey: KEY, members: ['a.ts'] })
    await flush()
  })

  it('turning labelling off mid-session answers the next labelling request with null, without asking the model', async () => {
    let on = true
    const llm = vi.fn(async () => 'label')
    const { client, spawned } = setup({ llm, labelling: () => on })
    await client.compile(ROOT)
    const t = spawned[0]
    expect(t.posted[0]).toEqual({ kind: 'init', userDataPath: '/ud', labelling: true })
    t.emit({ kind: 'llm', id: 1, projectKey: KEY, prompt: 'a' })
    await vi.waitFor(() => expect(t.posted).toContainEqual({ kind: 'llm-result', id: 1, text: 'label' }))
    on = false
    t.emit({ kind: 'llm', id: 2, projectKey: KEY, prompt: 'b' })
    await vi.waitFor(() => expect(t.posted).toContainEqual({ kind: 'llm-result', id: 2, text: null }))
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('applySettings tells a live host the current labelling setting, and never starts one', async () => {
    let on = true
    const { client, spawn, spawned } = setup({ labelling: () => on })
    client.applySettings() // no host yet: nothing to tell, nothing spawned
    expect(spawn).not.toHaveBeenCalled()
    await client.compile(ROOT)
    on = false
    client.applySettings()
    expect(spawned[0].posted[spawned[0].posted.length - 1]).toEqual({ kind: 'settings', labelling: false })
    on = true
    client.applySettings()
    expect(spawned[0].posted[spawned[0].posted.length - 1]).toEqual({ kind: 'settings', labelling: true })
    // A port that throws (the host is going away) is swallowed: its exit restarts it with the new value.
    spawned[0].throwOnPost = true
    expect(() => client.applySettings()).not.toThrow()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  describe('clone', () => {
    it('clone and cancelClone call the host fns, with and without a ref; clone progress has root ""', async () => {
      const { client, spawned } = setup({}, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'cancelClone' ? true : { ok: true, root: '/r' } })
      })
      const progress: unknown[] = []
      client.onProgress((e) => progress.push(e))
      expect(await client.clone('https://h/a.git')).toEqual({ ok: true, root: '/r' })
      expect(await client.clone('https://h/a.git', 'dev')).toEqual({ ok: true, root: '/r' })
      expect(await client.cancelClone('https://h/a.git')).toBe(true)
      expect(await client.cancelClone('https://h/a.git', 'dev')).toBe(true)
      const t = spawned[0]
      expect(t.calls().map((c) => [c.fn, c.args])).toEqual([
        ['cloneSource', ['https://h/a.git']],
        ['cloneSource', ['https://h/a.git', 'dev']],
        ['cancelClone', ['https://h/a.git']],
        ['cancelClone', ['https://h/a.git', 'dev']]
      ])
      t.emit({ kind: 'progress', projectKey: 'clone:abc', stage: 'cloning', pct: 0 })
      expect(progress).toEqual([{ root: '', projectKey: 'clone:abc', stage: 'cloning', pct: 0 }])
    })

    it('clone and updateSource carry the access and the remembered login as call arguments', async () => {
      const { client, spawned } = setup({}, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'updateSource' ? { ok: true, changed: true } : { ok: true, root: '/r' } })
      })
      const machine = { mode: 'machine' } as const
      const tok = { mode: 'token', value: 'neutral-value-2' } as const
      expect(await client.clone('https://h/a.git', undefined, machine)).toEqual({ ok: true, root: '/r' })
      expect(await client.clone('https://h/a.git', 'dev', tok)).toEqual({ ok: true, root: '/r' })
      expect(await client.updateSource('https://h/a.git')).toEqual({ ok: true, changed: true })
      expect(await client.updateSource('https://h/a.git', 'dev', 'machine')).toEqual({ ok: true, changed: true })
      expect(await client.updateSource('https://h/a.git', undefined, 'token', tok)).toEqual({ ok: true, changed: true })
      expect(spawned[0].calls().map((c) => [c.fn, c.args])).toEqual([
        ['cloneSource', ['https://h/a.git', undefined, machine]],
        ['cloneSource', ['https://h/a.git', 'dev', tok]],
        ['updateSource', ['https://h/a.git']],
        ['updateSource', ['https://h/a.git', 'dev', 'machine']],
        ['updateSource', ['https://h/a.git', undefined, 'token', tok]]
      ])
    })

    it('the askpass path reaches the host in init, beside userData, from a string or a function', async () => {
      const a = setup({ askpassPath: '/res/git-askpass/askpass.sh' })
      await a.client.get(ROOT)
      expect(a.spawned[0].posted[0]).toEqual({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: '/res/git-askpass/askpass.sh' })
      const b = setup({ askpassPath: () => '/app/resources/git-askpass/askpass.sh' })
      await b.client.get(ROOT)
      expect(b.spawned[0].posted[0]).toEqual({ kind: 'init', userDataPath: '/ud', labelling: true, askpassPath: '/app/resources/git-askpass/askpass.sh' })
      const c = setup({ askpassPath: () => '' })
      await c.client.get(ROOT)
      expect(c.spawned[0].posted[0]).not.toHaveProperty('askpassPath')
    })

    it('no token in the app log after a failed, a timed-out and a crashed clone', async () => {
      const T = 'neutral-value-3'
      const access = { mode: 'token', value: ` ${T}\n` } as const
      const uninstall = captureConsole(console as unknown as ConsoleLike, 'main')
      clearAppLog()
      const errors: string[] = []
      const errorOf = async (p: Promise<unknown>): Promise<void> => {
        try {
          const r = (await p) as { ok: boolean; error?: string }
          errors.push(String(r.error))
        } catch (e) {
          errors.push((e as Error).message)
        }
      }
      try {
        // failed: the host answers a failed result, and (worse) an error that repeats the value
        const failed = setup({}, (t) => {
          t.reply = (m) =>
            m.id === 1
              ? { kind: 'result', id: m.id, ok: true, result: { ok: false, error: `fatal: could not read for ${T}` } }
              : { kind: 'result', id: m.id, ok: false, error: { name: 'Error', message: `git said ${T}` } }
        })
        await errorOf(failed.client.clone('https://h/a.git', undefined, access))
        await errorOf(failed.client.clone('https://h/a.git', undefined, access))
        await errorOf(failed.client.updateSource('https://h/a.git', undefined, 'token', access))
        // a failed result with no text, and one for a run with no token, pass through unchanged
        const plain = setup({}, (t) => {
          t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.id === 1 ? { ok: false } : { ok: false, error: 'plain' } })
        })
        expect(await plain.client.clone('https://h/a.git', undefined, access)).toEqual({ ok: false })
        expect(await plain.client.clone('https://h/a.git', undefined, { mode: 'machine' })).toEqual({ ok: false, error: 'plain' })
        // timed out
        const slow = setup({ callTimeoutMs: 5 }, (t) => {
          t.reply = null
        })
        await errorOf(slow.client.clone('https://h/a.git', 'dev', access))
        // crashed mid-clone
        const crash = setup({}, (t) => {
          t.reply = null
        })
        const pending = errorOf(crash.client.clone('https://h/a.git', undefined, access))
        await flush()
        crash.spawned[0].exit(1)
        await pending
        // a thrown non-Error is text too
        const odd = setup({}, (t) => {
          t.throwOnPost = `odd ${T}` as never
        })
        await errorOf(odd.client.clone('https://h/a.git', undefined, access))
      } finally {
        uninstall()
      }
      expect(errors).toHaveLength(6)
      expect(errors.some((e) => e.includes('timed out'))).toBe(true)
      expect(errors.some((e) => e.includes('exited'))).toBe(true)
      for (const e of errors) expect(e).not.toContain(T)
      for (const entry of readAppLog(1000)) expect(entry.msg).not.toContain(T)
    })
  })

  it('snapshotFromFiles asks the host for a structure-only snapshot of the folder', async () => {
    const snap = { root: '/r', files: ['a.ts'], symbols: [], callEdges: [], fileImports: { 'a.ts': [] } }
    const { client, spawned } = setup({}, (t) => {
      t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: snap })
    })
    expect(await client.snapshotFromFiles('/r')).toEqual(snap)
    expect(spawned[0].calls().map((c) => [c.fn, c.args])).toEqual([['snapshotFromFiles', ['/r']]])
  })

  describe('notifyChanged', () => {
    it('refreshes a world compiled this run, with normalised files', async () => {
      const head = vi.fn(async () => ({ head: 'h', dirty: false }))
      const { client, spawned } = setup({ head, hasStoredWorld: () => false })
      await client.compile(ROOT)
      client.notifyChanged(ROOT, ['src\\a.ts', './src/b.ts', '', 7 as unknown as string])
      await vi.waitFor(() => expect(spawned[0].calls().map((c) => c.fn)).toContain('notifyChanged'))
      expect(spawned[0].calls()[1].args).toEqual([KEY, SNAP, { head: 'h', dirty: false }, ['src/a.ts', 'src/b.ts']])
    })

    it('asks for the snapshot, the git head and the linked plan at once, so a slow git costs no extra wait (round 3 D)', async () => {
      let release: (v: { head: string; dirty: boolean }) => void = () => undefined
      let calls = 0
      const head = vi.fn(() => (++calls === 1 ? Promise.resolve({ head: 'h', dirty: false }) : new Promise<{ head: string; dirty: boolean }>((r) => { release = r })))
      const planFor = vi.fn(async () => null)
      const { client, spawned } = setup({ head, planFor, hasStoredWorld: () => true })
      await client.compile(ROOT)
      planFor.mockClear()
      client.notifyChanged(ROOT, ['src/a.ts'])
      // git has not answered, and the plan is already being read
      await vi.waitFor(() => expect(planFor).toHaveBeenCalledWith(KEY))
      release({ head: 'h2', dirty: true })
      await vi.waitFor(() => expect(spawned[0].calls().map((c) => c.fn)).toContain('notifyChanged'))
      expect(spawned[0].calls().find((c) => c.fn === 'notifyChanged')?.args.slice(0, 4)).toEqual([KEY, SNAP, { head: 'h2', dirty: true }, ['src/a.ts']])
    })

    it('an empty list counts every indexed file as changed; a non-array is empty', async () => {
      const { client, spawned } = setup({ hasStoredWorld: () => true })
      await client.get(ROOT) // starts the host; null keeps the root unknown, so the store is asked
      client.notifyChanged(ROOT, [])
      client.notifyChanged(ROOT, 'x' as unknown as string[])
      await vi.waitFor(() => expect(spawned[0]?.calls()).toHaveLength(3))
      expect(spawned[0].calls()[1].args[3]).toEqual(SNAP.files)
      expect(spawned[0].calls()[2].args[3]).toEqual(SNAP.files)
    })

    it('a watcher never starts the world process: with no host running it does nothing', async () => {
      const hasStoredWorld = vi.fn(() => true)
      const { client, spawn } = setup({ hasStoredWorld })
      client.notifyChanged(ROOT, ['src/a.ts'])
      await flush()
      expect(spawn).not.toHaveBeenCalled()
      expect(hasStoredWorld).not.toHaveBeenCalled()
    })

    it('never spawns or compiles for a project without a world', async () => {
      const { client, spawn } = setup({ hasStoredWorld: () => false })
      await client.get(ROOT) // null: still unknown
      spawn.mockClear()
      client.notifyChanged(ROOT, ['src/a.ts'])
      client.notifyChanged('', ['src/a.ts'])
      client.notifyChanged(5 as unknown as string, ['src/a.ts'])
      await flush()
      expect(spawn).not.toHaveBeenCalled()
    })

    it('a world loaded by get counts as known', async () => {
      const hasStoredWorld = vi.fn(() => false)
      const { client, spawned } = setup({ hasStoredWorld }, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? DOC : true })
      })
      await client.get(ROOT)
      client.notifyChanged(ROOT, ['src/a.ts'])
      await vi.waitFor(() => expect(spawned[0].calls().map((c) => c.fn)).toEqual(['get', 'notifyChanged']))
      expect(hasStoredWorld).not.toHaveBeenCalled()
    })

    it('by default checks the store file under userData (a missing or broken path is no world)', async () => {
      const key = KEY
      await mkdir(join(dir, 'world'), { recursive: true })
      const none = setup({ userDataPath: dir })
      await none.client.get(ROOT)
      none.client.notifyChanged(ROOT, ['src/a.ts'])
      await flush()
      expect(none.spawned[0].calls().map((c) => c.fn)).toEqual(['get'])

      // The host's init gets a path; the store check afterwards finds none.
      let asked = 0
      const broken = setup({
        userDataPath: () => {
          if (asked++ > 0) throw new Error('no userData')
          return dir
        }
      })
      await broken.client.get(ROOT)
      broken.client.notifyChanged(ROOT, ['src/a.ts'])
      await flush()
      expect(broken.spawned[0].calls().map((c) => c.fn)).toEqual(['get'])

      await writeFile(join(dir, 'world', worldFileName(key)), '{}')
      const some = setup({ userDataPath: dir })
      await some.client.get(ROOT)
      some.client.notifyChanged(ROOT, ['src/a.ts'])
      await vi.waitFor(() => expect(some.spawned[0]?.calls().map((c) => c.fn)).toEqual(['get', 'notifyChanged']))
    })

    it('swallows failures', async () => {
      const { client } = setup({
        hasStoredWorld: () => true,
        snapshot: () => {
          throw new Error('graph gone')
        }
      })
      await client.get(ROOT)
      expect(() => client.notifyChanged(ROOT, ['a.ts'])).not.toThrow()
      await flush()
    })
  })

  describe('annotate', () => {
    const CLAIM = { text: 'ok', state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'confirmed in Lumopolis' }] }

    it('asks the host about a world compiled this run, or stored (a design too), and answers its doc', async () => {
      const hasStoredWorld = vi.fn((key: string) => key === 'design:d1')
      const { client, spawned } = setup({ hasStoredWorld })
      await client.compile(ROOT)
      expect(await client.annotate(KEY, 'b1', CLAIM)).toEqual(DOC)
      expect(await client.annotate('design:d1', 'b1', CLAIM)).toEqual(DOC)
      expect(spawned[0].calls().map((c) => [c.fn, c.args])).toContainEqual(['annotate', ['design:d1', 'b1', CLAIM]])
    })

    it('rejects a key no world has, an empty or non-string one, and a check that throws', async () => {
      const { client, spawn } = setup({ hasStoredWorld: () => false })
      for (const key of ['nope', '', 42 as unknown as string]) await expect(client.annotate(key, 'b1', CLAIM)).rejects.toThrow('No world with that key.')
      const throwing = setup({ hasStoredWorld: () => { throw new Error('disk gone') } })
      await expect(throwing.client.annotate('k', 'b1', CLAIM)).rejects.toThrow('No world with that key.')
      expect(spawn).not.toHaveBeenCalled()
    })

    it('carries the host answer for an unknown part through', async () => {
      const { client } = setup({}, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: m.fn !== 'annotate', result: DOC, error: { message: 'No part with that id.', name: 'Error' } } as WorldHostResponse)
      })
      await client.compile(ROOT)
      await expect(client.annotate(KEY, 'zz', CLAIM)).rejects.toThrow('No part with that id.')
    })
  })

  describe('hasWorld', () => {
    it('answers from the store check without starting the world process', async () => {
      const hasStoredWorld = vi.fn((key: string) => key === KEY)
      const { client, spawn } = setup({ hasStoredWorld })
      expect(await client.hasWorld(ROOT)).toBe(true)
      expect(await client.hasWorld('C:/repos/other')).toBe(false)
      expect(hasStoredWorld).toHaveBeenCalledWith(KEY)
      expect(spawn).not.toHaveBeenCalled()
    })

    it('a world compiled this run counts without asking the store', async () => {
      const hasStoredWorld = vi.fn(() => false)
      const { client } = setup({ hasStoredWorld })
      await client.compile(ROOT)
      expect(await client.hasWorld(ROOT)).toBe(true)
      expect(hasStoredWorld).not.toHaveBeenCalled()
    })

    it('a folder with no key, a non-string, a throwing or non-boolean check is no world', async () => {
      const throwing = setup({
        hasStoredWorld: () => {
          throw new Error('disk gone')
        }
      })
      expect(await throwing.client.hasWorld(ROOT)).toBe(false)
      expect(await throwing.client.hasWorld('demo')).toBe(false)
      expect(await throwing.client.hasWorld(42 as unknown as string)).toBe(false)
      const junk = setup({ hasStoredWorld: () => 'yes' as unknown as boolean })
      expect(await junk.client.hasWorld(ROOT)).toBe(false)
    })

    it('by default checks the store file under userData', async () => {
      const ud = await mkdtemp(join(tmpdir(), 'world-has-'))
      try {
        const { client } = setup({ userDataPath: ud })
        expect(await client.hasWorld(ROOT)).toBe(false)
        await mkdir(join(ud, 'world'), { recursive: true })
        await writeFile(join(ud, 'world', worldFileName(KEY)), '{}')
        expect(await client.hasWorld(ROOT)).toBe(true)
      } finally {
        await rm(ud, { recursive: true, force: true })
      }
    })
  })

  it('dispose kills the host, rejects what is pending, and refuses later calls', async () => {
    const { client, spawned } = setup({}, (t) => {
      t.reply = null
      t.throwOnKill = true
    })
    client.dispose() // nothing running yet: fine
    const fresh = setup({}, (t) => {
      t.reply = null
    })
    const p = fresh.client.get(ROOT)
    await vi.waitFor(() => expect(fresh.spawned[0]?.calls()).toHaveLength(1))
    fresh.client.dispose()
    await expect(p).rejects.toThrow('Lumopolis host is shut down')
    expect(fresh.spawned[0].killed).toBe(1)
    await expect(fresh.client.get(ROOT)).rejects.toThrow('Lumopolis host is shut down')
    fresh.client.notifyChanged(ROOT, ['a.ts'])
    await flush()
    expect(fresh.spawn).toHaveBeenCalledTimes(1)
    expect(spawned).toHaveLength(0)

    // kill throwing during dispose is swallowed
    const thrower = setup({}, (t) => {
      t.throwOnKill = true
    })
    await thrower.client.get(ROOT)
    expect(() => thrower.client.dispose()).not.toThrow()
  })

  describe('world:get stale refresh', () => {
    /** The stored world, stamped with the commit it was compiled at. */
    const at = (head: string, dirty = false): WorldDoc => ({ ...DOC, sourceRevision: { head, dirty } }) as unknown as WorldDoc
    const compiles = (t: FakeTransport): CallMsg[] => t.calls().filter((c) => c.fn === 'compile')

    it('world:get serves a stored world from an older commit at once and refreshes it in the background', async () => {
      const head = vi.fn(async () => ({ head: 'new', dirty: false }))
      const { client, spawned } = setup({ head }, (t) => {
        // The refresh compile never answers here: get must not wait for it.
        t.reply = (m) => (m.fn === 'get' ? { kind: 'result', id: m.id, ok: true, result: at('old') } : undefined)
      })
      expect(await client.get(ROOT)).toEqual(at('old'))
      await vi.waitFor(() => expect(compiles(spawned[0])).toHaveLength(1))
      // The same compile world:compile runs (no relayout), so the host saves and pushes updated.
      expect(compiles(spawned[0])[0].args).toEqual([KEY, SNAP, { head: 'new', dirty: false }])
      expect(head).toHaveBeenCalledWith(ROOT)
    })

    it('world:get does not refresh when the stored head matches HEAD, or only dirty differs', async () => {
      const head = vi.fn(async () => ({ head: 'abc', dirty: true }))
      let stored = at('abc', true)
      const { client, spawned } = setup({ head }, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? stored : DOC })
      })
      expect(await client.get(ROOT)).toEqual(at('abc', true))
      await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(1))
      await flush()
      stored = at('abc', false) // uncommitted edits alone: the watcher covers those
      await client.get(ROOT)
      await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(2))
      await flush()
      expect(spawned[0].calls().map((c) => c.fn)).toEqual(['get', 'get'])
    })

    it('two world:get calls for one stale root start one refresh', async () => {
      const head = vi.fn(async () => ({ head: 'new', dirty: false }))
      const { client, spawned } = setup({ head }, (t) => {
        t.reply = (m) => (m.fn === 'get' ? { kind: 'result', id: m.id, ok: true, result: at('old') } : undefined)
      })
      await Promise.all([client.get(ROOT), client.get(ROOT)])
      await vi.waitFor(() => expect(compiles(spawned[0])).toHaveLength(1))
      await client.get(ROOT) // still in flight: no second refresh
      await flush()
      expect(compiles(spawned[0])).toHaveLength(1)
      // Once it is done, a world that is still stale may refresh again.
      spawned[0].emit({ kind: 'result', id: compiles(spawned[0])[0].id, ok: true, result: at('new') })
      await flush()
      await client.get(ROOT)
      await vi.waitFor(() => expect(compiles(spawned[0])).toHaveLength(2))
    })

    it('a failed background refresh is logged and never rejects world:get', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { client } = setup({ head: async () => ({ head: 'new', dirty: false }) }, (t) => {
          t.reply = (m) =>
            m.fn === 'get'
              ? { kind: 'result', id: m.id, ok: true, result: at('old') }
              : { kind: 'result', id: m.id, ok: false, error: { name: 'Error', message: 'disk full' } }
        })
        expect(await client.get(ROOT)).toEqual(at('old'))
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
        expect(warn.mock.calls[0][0]).toContain('[world] background refresh failed')
        expect(String(warn.mock.calls[0][1])).toContain('disk full')
      } finally {
        warn.mockRestore()
      }
    })

    it('get with refresh:false never starts a background refresh', async () => {
      const head = vi.fn(async () => ({ head: 'new', dirty: false }))
      const { client, spawned } = setup({ head }, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? at('old') : DOC })
      })
      expect(await client.get(ROOT, { refresh: false })).toEqual(at('old'))
      await flush()
      await flush()
      expect(head).not.toHaveBeenCalled()
      expect(spawned[0].calls().map((c) => c.fn)).toEqual(['get'])
    })

    it('a failed refresh backs off for 5 minutes at the same HEAD; a new commit or the end of the wait tries again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let now = 1_000_000
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      try {
        let current = 'new'
        let failing = true
        const head = vi.fn(async () => ({ head: current, dirty: false }))
        const { client, spawned } = setup({ head }, (t) => {
          t.reply = (m) =>
            m.fn === 'get'
              ? { kind: 'result', id: m.id, ok: true, result: at('old') }
              : failing
                ? { kind: 'result', id: m.id, ok: false, error: { name: 'Error', message: 'graph failed' } }
                : { kind: 'result', id: m.id, ok: true, result: at(current) }
        })
        const settled = async (n: number): Promise<void> => {
          await vi.waitFor(() => expect(head.mock.calls.length).toBeGreaterThanOrEqual(n))
          for (let i = 0; i < 4; i++) await flush()
        }
        const compileCount = (): number => compiles(spawned[0]).length
        await client.get(ROOT)
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
        await flush()
        expect(compileCount()).toBe(1)
        // Same HEAD, inside the wait: no new compile.
        now += 60_000
        await client.get(ROOT)
        await settled(3)
        expect(compileCount()).toBe(1)
        // A new commit tries at once.
        current = 'newer'
        await client.get(ROOT)
        await vi.waitFor(() => expect(compileCount()).toBe(2))
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
        await flush()
        // The wait is over: the same HEAD is tried again.
        now += 5 * 60_000
        failing = false
        await client.get(ROOT)
        await vi.waitFor(() => expect(compileCount()).toBe(3))
        await flush()
        await flush()
        expect(warn).toHaveBeenCalledTimes(2)
      } finally {
        clock.mockRestore()
        warn.mockRestore()
      }
    })

    it('no head lookup result means no refresh', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        let n = 0
        const head = vi.fn(async () => {
          if (n++ === 0) return { head: '', dirty: false } // not a git repository
          throw new Error('git missing')
        })
        const { client, spawned } = setup({ head }, (t) => {
          t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? at('old') : DOC })
        })
        expect(await client.get(ROOT)).toEqual(at('old'))
        await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(1))
        await flush()
        expect(await client.get(ROOT)).toEqual(at('old'))
        await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(2))
        await flush()
        expect(spawned[0].calls().map((c) => c.fn)).toEqual(['get', 'get'])
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('linked design (plan versus built)', () => {
    const PLAN = { projectKey: 'design:p', generatedAt: 9 } as unknown as WorldDoc
    const withPlan = (head: string, planAt: number | null): WorldDoc =>
      ({
        ...DOC,
        sourceRevision: { head, dirty: false },
        layers: { plan: planAt === null ? [] : [{ id: 'design:p', reconcile: { matched: {}, missing: [], extra: [], planAt } }] }
      }) as unknown as WorldDoc
    const compiles = (t: { calls(): CallMsg[] }): CallMsg[] => t.calls().filter((c) => c.fn === 'compile')

    it('compile and relayout send the linked design; none, or a failed lookup, sends nothing extra', async () => {
      const planFor = vi.fn(async (key: string) => (key === KEY ? PLAN : null))
      const head = async () => ({ head: 'h', dirty: false })
      const { client, spawned } = setup({ head, planFor })
      await client.compile(ROOT)
      await client.relayout(ROOT)
      expect(compiles(spawned[0]).map((c) => c.args[3])).toEqual([{ plan: PLAN }, { relayout: true, plan: PLAN }])
      expect(planFor).toHaveBeenCalledWith(KEY)

      const failing = setup({ head, planFor: async () => Promise.reject(new Error('registry gone')) })
      await failing.client.compile(ROOT)
      expect(compiles(failing.spawned[0])[0].args).toHaveLength(3)
      const none = setup({ head, planFor: async () => undefined as unknown as null })
      await none.client.compile(ROOT)
      expect(compiles(none.spawned[0])[0].args).toHaveLength(3)
    })

    it('notifyChanged passes the linked design to the watcher recompile', async () => {
      const head = vi.fn(async () => ({ head: 'h', dirty: false }))
      const { client, spawned } = setup({ head, planFor: async () => PLAN, hasStoredWorld: () => false })
      await client.compile(ROOT)
      client.notifyChanged(ROOT, ['src/a.ts'])
      await vi.waitFor(() => expect(spawned[0].calls().map((c) => c.fn)).toContain('notifyChanged'))
      expect(spawned[0].calls()[1].args).toEqual([KEY, SNAP, { head: 'h', dirty: false }, ['src/a.ts'], PLAN])
    })

    it('a design saved since the world was compiled refreshes it at the same HEAD; a matching stamp does not', async () => {
      let stored = withPlan('h', 3)
      let fresh = withPlan('h', 9)
      const planFor = vi.fn(async () => PLAN)
      const head = async () => ({ head: 'h', dirty: false })
      const { client, spawned } = setup({ head, planFor }, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? stored : fresh })
      })
      await client.get(ROOT)
      await vi.waitFor(() => expect(compiles(spawned[0])).toHaveLength(1))
      expect(compiles(spawned[0])[0].args[3]).toEqual({ plan: PLAN })
      for (let i = 0; i < 4; i++) await flush()
      stored = withPlan('h', 9)
      await client.get(ROOT)
      await vi.waitFor(() => expect(planFor).toHaveBeenCalledTimes(2))
      for (let i = 0; i < 4; i++) await flush()
      expect(compiles(spawned[0])).toHaveLength(1)

      // A refresh whose world still lacks the plan (the overlay did not validate) backs off.
      stored = withPlan('h', null)
      fresh = withPlan('h', null)
      await client.get(ROOT)
      await vi.waitFor(() => expect(compiles(spawned[0])).toHaveLength(2))
      for (let i = 0; i < 4; i++) await flush()
      await client.get(ROOT)
      await vi.waitFor(() => expect(planFor).toHaveBeenCalledTimes(4))
      for (let i = 0; i < 4; i++) await flush()
      expect(compiles(spawned[0])).toHaveLength(2)
    })

    it('readDesign reads a stored design world by key, and answers null without starting the host when none is stored', async () => {
      const stored = new Set(['design:a'])
      const { client, spawn, spawned } = setup({ hasStoredWorld: (k) => stored.has(k) }, (t) => {
        t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: { items: [], evidence: [], args: m.args } })
      })
      expect(await client.readDesign('design:none', { text: 'x' })).toBeNull()
      expect(spawn).not.toHaveBeenCalled()
      expect(await client.readDesign('design:a', { text: 'auth' })).toMatchObject({ args: ['design:a', { text: 'auth' }] })
      expect(await client.readDesign('design:a', undefined as unknown as { text: string })).toMatchObject({ args: ['design:a', {}] })
      expect(spawned[0].calls().map((c) => c.fn)).toEqual(['read', 'read'])
    })
  })
})

describe('read with cards and plan', () => {
  it('passes the flags to the host and returns what it answers', async () => {
    const answer = { items: [], evidence: [], cards: { b1: 'B1 card' }, plan: { proposals: [] } }
    const { client, spawned } = setup({}, (t) => {
      t.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: answer })
    })
    expect(await client.read(ROOT, { cards: true, plan: true })).toEqual(answer)
    expect(spawned[0].calls()[0].args).toEqual([KEY, { cards: true, plan: true }])
  })
})

describe('WP4a: a long first compile, the code graph after it, and the listing first map', () => {
  it('progress for the project keeps a compile from timing out; a silent one still times out', async () => {
    vi.useFakeTimers()
    let t!: FakeTransport
    const { client } = setup({ callTimeoutMs: 100 }, (x) => {
      t = x
      x.reply = () => undefined
    })
    const doc = client.compile(ROOT)
    let settled: unknown = 'pending'
    doc.then((v) => (settled = v), (e: Error) => (settled = e.message))
    await vi.advanceTimersByTimeAsync(0)
    const call = t.calls()[0]
    // Five times the timeout passes, with the host reporting progress more often than the timeout: no error.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(60)
      t.emit({ kind: 'progress', projectKey: KEY, stage: 'boundaries', pct: 10 + i })
      // Progress for another project does not count for this one.
      t.emit({ kind: 'progress', projectKey: 'other', stage: 'boundaries', pct: 10 + i })
    }
    expect(settled).toBe('pending')
    t.emit({ kind: 'result', id: call.id, ok: true, result: DOC })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toEqual(DOC)
    // A compile whose host goes quiet times out as before.
    const quiet = client.compile(ROOT).catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60)
    t.emit({ kind: 'progress', projectKey: 'other', stage: 'layout', pct: 50 })
    await vi.advanceTimersByTimeAsync(60)
    expect(await quiet).toBe('Lumopolis host call "compile" timed out')
  })

  it('whenCompiled resolves at once with no compile, and otherwise once every compile of the folder ended, failed or not', async () => {
    let t!: FakeTransport
    const { client } = setup({}, (x) => {
      t = x
      x.reply = () => undefined
    })
    let done = false
    await client.whenCompiled(ROOT)
    await client.whenCompiled('')
    const first = client.compile(ROOT)
    const second = client.relayout(ROOT).catch((e: Error) => e.message)
    const waited = client.whenCompiled(ROOT).then(() => (done = true))
    await flush()
    const [a, b] = t.calls()
    t.emit({ kind: 'result', id: a.id, ok: true, result: DOC })
    expect(await first).toEqual(DOC)
    await flush()
    expect(done).toBe(false)
    t.emit({ kind: 'result', id: b.id, ok: false, error: { message: 'boom' } })
    expect(await second).toBe('boom')
    await waited
    expect(done).toBe(true)
    // Nothing is left in flight: it answers at once again.
    await client.whenCompiled(ROOT)
  })

  it('the snapshot made for a compile in flight carries the project and commit, so the host can draw a first map', async () => {
    let client!: ReturnType<typeof setup>['client']
    const made = setup({ head: async () => ({ head: 'abc', dirty: true }), snapshot: (root) => client.snapshotFromFiles(root) }, (x) => {
      x.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'snapshotFromFiles' ? SNAP : DOC })
    })
    client = made.client
    expect(await client.compile(ROOT)).toEqual(DOC)
    // On its own (no compile running) the snapshot asks for nothing more.
    expect(await client.snapshotFromFiles(ROOT)).toEqual(SNAP)
    expect(made.spawned[0].calls().map((c) => [c.fn, c.args])).toEqual([
      ['snapshotFromFiles', [ROOT, { projectKey: KEY, head: { head: 'abc', dirty: true } }]],
      ['compile', [KEY, SNAP, { head: 'abc', dirty: true }]],
      ['snapshotFromFiles', [ROOT]]
    ])
  })

  it('a first map from the listing is shown but never marks the world known, so no refresh starts from it', async () => {
    const head = vi.fn(async () => ({ head: 'abc', dirty: false }))
    const { client, spawned } = setup({ head }, (x) => {
      x.reply = (m) => ({ kind: 'result', id: m.id, ok: true, result: m.fn === 'get' ? { ...DOC, provisional: true } : DOC })
    })
    expect(await client.get(ROOT)).toEqual({ ...DOC, provisional: true })
    await flush()
    expect(spawned[0].calls().map((c) => c.fn)).toEqual(['get'])
    expect(head).not.toHaveBeenCalled()
    // A watcher event for a world that is not known yet starts nothing.
    client.notifyChanged(ROOT, ['src/a.ts'])
    await flush()
    expect(spawned[0].calls().map((c) => c.fn)).toEqual(['get'])
  })
})

describe('WPA: an Ask that is cancelled lets go of its world step', () => {
  it('a get or read whose signal fires is dropped: it rejects at once, and the host answering later is ignored', async () => {
    const { client, spawned } = setup({}, (t) => { t.reply = () => undefined })
    const ctl = new AbortController()
    const p = client.get(ROOT, { refresh: false, signal: ctl.signal })
    await vi.waitFor(() => expect(spawned[0]?.calls()).toHaveLength(1))
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    const id = spawned[0].calls()[0].id
    spawned[0].emit({ kind: 'result', id, ok: true, result: DOC })
    const r = new AbortController()
    const q = client.read(ROOT, { text: 'auth' }, { signal: r.signal })
    await vi.waitFor(() => expect(spawned[0].calls()).toHaveLength(2))
    r.abort()
    await expect(q).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('an already-cancelled step posts nothing; one cancelled while the host starts posts nothing either', async () => {
    const { client, spawned } = setup({}, (t) => { t.autoReady = false })
    const done = new AbortController()
    done.abort()
    await expect(client.read(ROOT, { text: 'x' }, { signal: done.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const ctl = new AbortController()
    const p = client.get(ROOT, { refresh: false, signal: ctl.signal })
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    ctl.abort()
    spawned[0].emit({ kind: 'ready', pid: 1 })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned[0].calls()).toHaveLength(0)
  })

  it('a step that answers before any cancel lets go of the signal: a later abort changes nothing', async () => {
    const { client } = setup()
    const ctl = new AbortController()
    const remove = vi.spyOn(ctl.signal, 'removeEventListener')
    expect(await client.get(ROOT, { refresh: false, signal: ctl.signal })).toBeNull()
    expect(await client.read(ROOT, { text: 'x' }, { signal: ctl.signal })).toEqual(DOC)
    expect(remove).toHaveBeenCalledTimes(2)
    ctl.abort()
  })
})

describe('WPA: a step with a signal that fails or is refused', () => {
  it('a host error and a failed post still reject with their own error and let go of the signal', async () => {
    const { client } = setup({}, (t) => {
      t.reply = (m) => ({ kind: 'result', id: m.id, ok: false, error: { name: 'Error', message: 'no such world' } })
    })
    const ctl = new AbortController()
    const remove = vi.spyOn(ctl.signal, 'removeEventListener')
    await expect(client.read(ROOT, { text: 'x' }, { signal: ctl.signal })).rejects.toThrow('no such world')
    expect(remove).toHaveBeenCalledTimes(1)
    const posted = setup({}, (t) => { t.throwOnPost = true })
    await expect(posted.client.read(ROOT, { text: 'x' }, { signal: ctl.signal })).rejects.toThrow('port closed')
    expect(remove).toHaveBeenCalledTimes(2)
  })
})
