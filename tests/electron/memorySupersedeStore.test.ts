// The store side of supersession and of entity stubs: memorySupersedePass draws `supersedes` edges from
// the packed vectors, search and the active list drop what was replaced (before the result is cut),
// and entity stubs stay out of search and the active list unless a caller asks for them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memorySupersedePass,
  memoryReleaseSupersedes,
  memoryGraphQuery,
  memoryClear,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'
import { initMemoryGraph, isSuperseded, isSupersedeReleased, addMemoryEdge, _resetGraphForTests } from '../../src/main/memoryGraph'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

// Every text that mentions postgres gets the SAME unit vector (cosine 1 between them); everything else
// gets a deterministic vector pointing elsewhere.
const DIM = 384
const unit = (k: number): number[] => { const v = new Array(DIM).fill(0); v[k] = 1; return v }
const embed = async (text: string): Promise<number[]> => {
  if (/postgres/i.test(text)) return unit(0)
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return unit(1 + (h % (DIM - 1)))
}

describe('supersession and entity stubs in the store', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-'))
    _resetForTests()
    _resetGraphForTests()
    _setEmbeddingsAvailable(true)
    _setEmbedFnForTests(embed)
    initSwarmMemory(tmp)
    initMemoryGraph(tmp)
  })
  afterEach(() => {
    _setEmbedFnForTests(null)
    _resetForTests()
    _resetGraphForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const P = 'C:/repos/demo'

  it('the idle pass replaces an older restated decision, and only within the same project and kind rules', async () => {
    const old = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', project: P, ts: 1000 })
    const transcript = await memoryWrite({ agentId: 'a', kind: 'message', content: 'Use Postgres for the session store database chat', project: P, ts: 1100, source: 'transcript:x' })
    const elsewhere = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database there', project: 'C:/repos/other', ts: 1200 })
    const fresh = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database layer', project: P, ts: 2000 })

    const first = await memorySupersedePass({ batch: 100, max: 200 })
    expect(first).toEqual({ considered: 3, minted: 1 })
    expect(isSuperseded(old.id)).toBe(true)
    expect(isSuperseded(fresh.id)).toBe(false)
    expect(isSuperseded(transcript.id)).toBe(false)
    expect(isSuperseded(elsewhere.id)).toBe(false)

    // Search drops the replaced one BEFORE cutting to `limit`, so limit 1 still answers.
    const hits = await memorySearch({ query: 'postgres session store', limit: 1, project: P })
    expect(hits.map((h) => h.id)).toEqual([fresh.id])
    expect((await memorySearch({ query: 'postgres session store', limit: 10, project: P })).map((h) => h.id)).not.toContain(old.id)
    expect(memoryList({ active: true, project: P }).map((e) => e.id)).not.toContain(old.id)
    expect(memoryList({ project: P }).map((e) => e.id)).toContain(old.id) // the plain list still shows history

    // Everything was checked: a second pass compares nothing.
    expect(await memorySupersedePass()).toEqual({ considered: 0, minted: 0 })
  })

  it('respects batch and max, and a cleared store checks again from scratch', async () => {
    for (let i = 0; i < 4; i++) {
      await memoryWrite({ agentId: 'a', kind: 'decision', content: `Use Postgres for the session store database ${'x'.repeat(i + 1)}`, project: P, ts: 1000 + i })
    }
    expect(await memorySupersedePass({ batch: 1, max: 200 })).toEqual({ considered: 1, minted: 3 })
    memoryClear()
    _resetGraphForTests()
    initMemoryGraph(tmp)
    for (let i = 0; i < 3; i++) {
      await memoryWrite({ agentId: 'a', kind: 'decision', content: `Use Postgres for the session store database ${'y'.repeat(i + 1)}`, project: P, ts: 5000 + i })
    }
    expect(await memorySupersedePass({ max: 1 })).toEqual({ considered: 3, minted: 1 })
  })

  it('an excluded (corrected) memory gets its replaced memories back and takes no part in the pass', async () => {
    const old = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', project: P, ts: 1000 })
    const fresh = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database layer', project: P, ts: 2000 })
    expect(await memorySupersedePass()).toEqual({ considered: 2, minted: 1 })
    expect(isSuperseded(old.id)).toBe(true)

    // fresh was retracted (main's correction overlay): old comes back, and nothing re-mints it.
    const again = await memorySupersedePass({ exclude: [fresh.id] })
    expect(again.minted).toBe(0)
    expect(isSuperseded(old.id)).toBe(false)
    expect(isSupersedeReleased(fresh.id, old.id)).toBe(true)
  })

  it('writing a replaced memory again brings it back, and the pass does not replace it a second time', async () => {
    const old = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', project: P, ts: 1000 })
    const fresh = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database layer', project: P, ts: 2000 })
    await memorySupersedePass()
    expect(isSuperseded(old.id)).toBe(true)

    const rewritten = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', project: P, ts: 3000 })
    expect(rewritten.id).toBe(old.id) // a dedup hit
    expect(isSuperseded(old.id)).toBe(false)
    expect((await memorySearch({ query: 'postgres session store', limit: 10, project: P })).map((h) => h.id)).toContain(old.id)

    // A new memory makes the pass look at the pool again; the released pair stays released.
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Redis caches the rate limits', project: P, ts: 4000 })
    await memorySupersedePass()
    expect(isSuperseded(old.id)).toBe(false)
    expect(isSuperseded(fresh.id)).toBe(false)
  })

  it('memoryReleaseSupersedes frees what a corrected memory replaced, and reports nothing when there is nothing', async () => {
    const old = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', project: P, ts: 1000 })
    const fresh = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database layer', project: P, ts: 2000 })
    await memorySupersedePass()
    expect(memoryReleaseSupersedes(fresh.id)).toBe(1)
    expect(isSuperseded(old.id)).toBe(false)
    expect(memoryReleaseSupersedes(fresh.id)).toBe(0)
  })

  it('a memory the edge budget cut short stays fresh and is finished by the next pass', async () => {
    for (let i = 0; i < 3; i++) {
      await memoryWrite({ agentId: 'a', kind: 'decision', content: `Use Postgres for the session store database ${'z'.repeat(i + 1)}`, project: P, ts: 1000 + i })
    }
    // The newest replaces the two older ones; a budget of 1 lets it draw only one.
    expect(await memorySupersedePass({ batch: 1, max: 1 })).toEqual({ considered: 1, minted: 1 })
    expect(await memorySupersedePass({ batch: 1, max: 200 })).toEqual({ considered: 1, minted: 1 })
  })

  it('memories without a project are never compared', async () => {
    const a = await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', ts: 1000 })
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database layer', ts: 2000 })
    expect(await memorySupersedePass()).toEqual({ considered: 0, minted: 0 })
    expect(isSuperseded(a.id)).toBe(false)
  })

  it('a memory that has no vector yet is skipped and left for a later pass', async () => {
    _setEmbedFnForTests(async () => null)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'Use Postgres for the session store database', project: P, ts: 1000 })
    expect(await memorySupersedePass()).toEqual({ considered: 0, minted: 0 })
  })

  it('entity stubs stay out of search and the active list unless asked for, but still seed a graph walk', async () => {
    const stub = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Postgres', memoryType: 'entity', project: P, ts: 1000 })
    const real = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Postgres holds the session store', project: P, ts: 1100 })
    addMemoryEdge({ from: stub.id, to: real.id, relation: 'mentions' })

    const plain = await memorySearch({ query: 'postgres', limit: 10, project: P })
    expect(plain.map((h) => h.id)).toEqual([real.id])
    const withStubs = await memorySearch({ query: 'postgres', limit: 10, project: P, includeEntities: true })
    expect(withStubs.map((h) => h.id).sort()).toEqual([stub.id, real.id].sort())
    expect(memoryList({ active: true, project: P }).map((e) => e.id)).toEqual([real.id])

    const walk = await memoryGraphQuery({ query: 'Postgres' })
    expect(walk.length).toBeGreaterThan(0)
  })
})
