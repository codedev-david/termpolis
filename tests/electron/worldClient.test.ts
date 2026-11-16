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
import { graphKeyForRoot } from '../../src/main/codeGraph'
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
    await client.compile(ROOT)
    expect(spawned[0].posted[0]).toMatchObject({ userDataPath: '/fake-userdata' })
    const snap = spawned[0].calls()[0].args[1] as GraphSnapshot
    expect(snap.root).toBe(ROOT)
    expect(Array.isArray(snap.files)).toBe(true)
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
})
