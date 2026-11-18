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
import type { WorldHostRequest, WorldHostResponse } from '../../src/main/world/worldHost'
import { worldFileName } from '../../src/main/world/worldStore'
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
  const client = createWorldClient(spawn, { userDataPath: '/ud', snapshot: () => SNAP, ...opts })
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
    expect(llm).toHaveBeenCalledWith(ROOT, 'hi')
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

  it('worldClient answers runs requests from the transcript and CI hooks, and an absent or failing hook gives none', async () => {
    const run = { file: 'a.test.ts', passed: true, at: 1, source: 'transcript' as const }
    const transcriptRuns = vi.fn(async (_root: string) => [run])
    const ciRuns = vi.fn(async (root: string): Promise<(typeof run)[]> => {
      if (ciRuns.mock.calls.length === 1) throw new Error('gh down')
      return 5 as never
    })
    const { client, spawned } = setup({ transcriptRuns, ciRuns })
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
        { kind: 'runs-result', id: 1, runs: [run] },
        { kind: 'runs-result', id: 2, runs: [] },
        { kind: 'runs-result', id: 3, runs: [] },
        { kind: 'runs-result', id: 4, runs: [] },
        { kind: 'runs-result', id: 5, runs: [] }
      ])
    )
    expect(transcriptRuns).toHaveBeenCalledWith(ROOT)

    const plain = setup()
    await plain.client.compile(ROOT)
    plain.spawned[0].emit({ kind: 'runs', id: 7, projectKey: KEY, source: 'ci' })
    await vi.waitFor(() => expect(plain.spawned[0].posted).toContainEqual({ kind: 'runs-result', id: 7, runs: [] }))

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
