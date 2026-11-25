// WP4b F-R6: a person can stop the first mapping of a project. cancelCompile stops the snapshot's reads and the compile
// that started before it: no file is read after the stop, nothing is saved (no world, no stage cache), a first map drawn
// from the listing goes, and the run answers in plain words at once. A compile asked for after the stop runs as ever.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import type { StageCache } from '../../src/main/world/stageCache'
import type { CompileDeps } from '../../src/main/world/compile'
import { COMPILE_STOPPED_MESSAGE, createWorldHost, stoppable, type Stop, type WorldHostDeps, type WorldHostRequest, type WorldHostResponse } from '../../src/main/world/worldHost'
import type { WorldDoc } from '../../src/shared/world/types'

const HEAD = { head: 'h1', dirty: false }
const TEXTS: Record<string, string> = {
  'src/app/main.ts': "import { util } from '../lib/util'\nexport const main = util\n",
  'src/app/view.ts': "import { main } from './main'\nexport const view = main\n",
  'src/lib/util.ts': 'export const util = 1\n',
  'src/lib/more.ts': "import { util } from './util'\nexport const more = util\n"
}
const FILES = Object.keys(TEXTS).sort()
const SNAP: GraphSnapshot = { root: '/r', files: FILES, symbols: [], callEdges: [], fileImports: {} }
const relOf = (p: string): string => p.replace(/\\/g, '/').replace(/^\/r\d*\//, '')

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-stop-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

function setup(over: WorldHostDeps = {}) {
  const out: WorldHostResponse[] = []
  const docs = new Map<string, WorldDoc>()
  const stages = new Map<string, StageCache>()
  const state = { readGate: null as Promise<void> | null, globGate: null as Promise<void> | null }
  const store = {
    load: async (k: string) => docs.get(k) ?? null,
    save: async (d: WorldDoc) => void docs.set(d.projectKey, d),
    labelCache: { get: async () => null, set: async () => undefined },
    loadStages: async (k: string) => stages.get(k) ?? null,
    saveStages: async (k: string, c: StageCache) => void stages.set(k, c)
  }
  const readSource = vi.fn(async (p: string) => {
    if (state.readGate) await state.readGate
    return Object.hasOwn(TEXTS, relOf(p)) ? TEXTS[relOf(p)] : null
  })
  const glob = vi.fn(async () => {
    if (state.globGate) await state.globGate
    return [] as string[]
  })
  const host = createWorldHost((m) => out.push(m), {
    createStore: () => store,
    runsTimeoutMs: 5,
    readSource,
    glob,
    listFiles: async () => FILES,
    provisionalMinFiles: 3,
    ...over
  })
  let id = 0
  /** A call's answer: the result, or the error's words. */
  const call = async <T,>(fn: string, ...args: unknown[]): Promise<{ ok: true; result: T } | { ok: false; error: string }> => {
    const me = ++id
    await host.handle({ kind: 'call', id: me, fn, args } as WorldHostRequest)
    const r = out.find((m) => m.kind === 'result' && m.id === me) as { ok: boolean; result?: T; error?: { message: string } }
    return r.ok ? { ok: true, result: r.result as T } : { ok: false, error: r.error?.message ?? '' }
  }
  const progress = (key = 'k1'): number => out.filter((m) => m.kind === 'progress' && m.projectKey === key).length
  const failures = (key = 'k1'): string[] =>
    out.flatMap((m) => (m.kind === 'updated' && m.projectKey === key && typeof m.error === 'string' ? [m.error] : []))
  const init = () => host.handle({ kind: 'init', userDataPath: join(dir, 'ud'), labelling: false })
  return { out, docs, stages, state, readSource, glob, host, call, progress, failures, init }
}

const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`until: still not true after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const early = { projectKey: 'k1', head: HEAD }

describe('stopping the first mapping of a project (WP4b F-R6)', () => {
  it('cancelCompile with nothing running stops nothing and answers false', async () => {
    const h = setup()
    await h.init()
    expect(await h.call('cancelCompile', 'k1')).toEqual({ ok: true, result: false })
    // A compile after it runs as ever.
    const done = await h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    expect(done.ok).toBe(true)
    expect(h.docs.has('k1')).toBe(true)
  })

  it('a stop while the snapshot reads answers at once in plain words, reads no file more, and drops the first map', async () => {
    const h = setup()
    await h.init()
    const reads = gate()
    h.state.readGate = reads.wait
    const snapshot = h.call<GraphSnapshot>('snapshotFromFiles', '/r', early)
    await until(() => h.readSource.mock.calls.length > 0 && h.failures().length === 0 && h.out.some((m) => m.kind === 'updated'))
    const asked = h.readSource.mock.calls.length
    expect(await h.call('cancelCompile', 'k1')).toEqual({ ok: true, result: true })
    // Answered while every read still waits: the stop does not wait for them.
    expect(await snapshot).toEqual({ ok: false, error: COMPILE_STOPPED_MESSAGE })
    expect(h.failures()).toEqual([COMPILE_STOPPED_MESSAGE])
    const shown = h.progress()
    reads.open()
    await new Promise((r) => setTimeout(r, 30))
    expect(h.readSource.mock.calls.length).toBe(asked)
    expect(h.progress()).toBe(shown)
    // No first map is served any more, and nothing was saved.
    expect(await h.call('get', 'k1', { provisional: true })).toEqual({ ok: true, result: null })
    expect(h.docs.size).toBe(0)
  })

  it('a stop while the compile runs saves no world and no stage cache, and answers in plain words', async () => {
    const h = setup()
    await h.init()
    const reads = gate()
    h.state.readGate = reads.wait
    h.state.globGate = gate().wait
    const run = h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    await until(() => h.readSource.mock.calls.length > 0)
    const asked = h.readSource.mock.calls.length
    expect(await h.call('cancelCompile', 'k1')).toEqual({ ok: true, result: true })
    expect(await run).toEqual({ ok: false, error: COMPILE_STOPPED_MESSAGE })
    reads.open()
    await new Promise((r) => setTimeout(r, 30))
    expect(h.readSource.mock.calls.length).toBe(asked)
    expect(h.docs.size).toBe(0)
    expect(h.stages.size).toBe(0)
  })

  it('a compile queued behind the stopped one stops too; one asked for after the stop maps and saves', async () => {
    const h = setup()
    await h.init()
    const reads = gate()
    h.state.readGate = reads.wait
    const first = h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    const queued = h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    await until(() => h.readSource.mock.calls.length > 0)
    await h.call('cancelCompile', 'k1')
    expect(await first).toEqual({ ok: false, error: COMPILE_STOPPED_MESSAGE })
    expect(await queued).toEqual({ ok: false, error: COMPILE_STOPPED_MESSAGE })
    h.state.readGate = null
    reads.open()
    const after = await h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    expect(after.ok).toBe(true)
    expect(h.docs.get('k1')?.projectKey).toBe('k1')
    expect(h.stages.has('k1')).toBe(true)
  })

  it('a stop for one project leaves another project\'s mapping running', async () => {
    const h = setup()
    await h.init()
    const reads = gate()
    h.state.readGate = reads.wait
    const mine = h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    const theirs = h.call<WorldDoc>('compile', 'k2', SNAP, HEAD)
    await until(() => h.readSource.mock.calls.length > 0)
    await h.call('cancelCompile', 'k1')
    expect(await mine).toEqual({ ok: false, error: COMPILE_STOPPED_MESSAGE })
    reads.open()
    expect((await theirs).ok).toBe(true)
    expect(h.docs.has('k2')).toBe(true)
    expect(h.docs.has('k1')).toBe(false)
  })

  it('a stop that lands after the compile read everything still keeps that run from saving', async () => {
    let held: (() => void) | null = null
    const h = setup({
      compile: async (input) => {
        // Every read is done; the stop comes while the world is built.
        await new Promise<void>((r) => (held = r))
        return { projectKey: input.projectKey } as unknown as WorldDoc
      }
    })
    await h.init()
    const run = h.call<WorldDoc>('compile', 'k1', SNAP, HEAD)
    await until(() => held !== null)
    await h.call('cancelCompile', 'k1')
    ;(held as unknown as () => void)()
    expect(await run).toEqual({ ok: false, error: COMPILE_STOPPED_MESSAGE })
    expect(h.docs.size).toBe(0)
  })

  it('cancelCompile needs a key', async () => {
    const h = setup()
    await h.init()
    const r = await h.call('cancelCompile', '')
    expect(r.ok).toBe(false)
  })

  describe('the compile deps a stop cuts', () => {
    const stopOf = (): Stop & { fire: () => void } => {
      let cut = false
      let fire!: () => void
      const when = new Promise<void>((r) => (fire = r))
      return { stopped: () => cut, when, release: () => undefined, fire: () => { cut = true; fire() } }
    }
    const base = () => ({
      readFile: vi.fn(async () => 'f'),
      readSource: vi.fn(async () => 's'),
      glob: vi.fn(async () => ['a.ts']),
      transcriptRuns: vi.fn(async () => []),
      ciRuns: vi.fn(async () => []),
      copyAnnotations: vi.fn(async () => undefined),
      onProgress: vi.fn()
    })

    it('before a stop every dep passes through', async () => {
      const d = base()
      const w = stoppable(d as unknown as CompileDeps, stopOf())
      expect(await w.readFile('/p')).toBe('f')
      expect(await w.readSource?.('/p')).toBe('s')
      expect(await w.glob('/r', ['*'])).toEqual(['a.ts'])
      expect(await w.transcriptRuns?.()).toEqual([])
      expect(await w.ciRuns?.()).toEqual([])
      await w.copyAnnotations?.({ a: 'b' })
      w.onProgress?.('boundaries', 10)
      expect(d.copyAnnotations).toHaveBeenCalledWith({ a: 'b' })
      expect(d.onProgress).toHaveBeenCalledWith('boundaries', 10)
    })

    it('after a stop nothing is read, waited for, copied or reported', async () => {
      const d = base()
      const stop = stopOf()
      const w = stoppable(d as unknown as CompileDeps, stop)
      stop.fire()
      expect(await w.readFile('/p')).toBeNull()
      expect(await w.readSource?.('/p')).toBeNull()
      expect(await w.glob('/r', ['*'])).toEqual([])
      expect(await w.transcriptRuns?.()).toBeNull()
      expect(await w.ciRuns?.()).toBeNull()
      await w.copyAnnotations?.({ a: 'b' })
      w.onProgress?.('boundaries', 10)
      for (const f of Object.values(d)) expect(f).not.toHaveBeenCalled()
    })

    it('a read waiting when the stop comes answers at once', async () => {
      const d = base()
      d.readFile.mockImplementationOnce(() => new Promise(() => undefined))
      const stop = stopOf()
      const w = stoppable(d as unknown as CompileDeps, stop)
      const read = w.readFile('/p')
      stop.fire()
      expect(await read).toBeNull()
    })

    it('the optional deps stay absent when the compile has none', () => {
      const w = stoppable({ readFile: async () => null, glob: async () => [] } as unknown as CompileDeps, stopOf())
      for (const k of ['readSource', 'transcriptRuns', 'ciRuns', 'copyAnnotations', 'onProgress']) expect(k in w).toBe(false)
    })
  })
})
