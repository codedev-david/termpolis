// int8 vector quantization — turning it ON, turning it back OFF, and proving nothing is lost either way.
//
// This is the safety case for shipping it as a user-facing toggle. The claim the UI makes is:
//
//   "Nothing is ever destroyed — this is an in-RAM representation, not a data migration."
//
// That claim is only true because the JSONL on disk always holds EXACT floats and the packed store
// re-packs from it on load. If that ever stopped being true, a user who tried int8 and switched
// back would silently keep a degraded brain forever. So the tests that matter here are the
// ROUND TRIPS — especially "write memories WHILE quantized, then turn it off" — because that is
// the case where a naive implementation would have quantized the source of truth.
//
// Uses an injected deterministic embedder, so this runs identically with or without the bge model
// (CI runs coverage WITHOUT it).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  setVectorQuantization,
  vectorRamStats,
  _resetForTests,
  _isVectorStoreQuantizedForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => dir }, safeStorage: undefined }))

let dir: string

/** Deterministic token-hash embedding. Shared tokens → high cosine, so recall is meaningful
 *  without a model. 384 dims to match EMBED_DIM so it lands in the packed store. */
async function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(384).fill(0)
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
    v[h % 384] += 1
  }
  return v
}

const CORPUS = [
  'the auth token refresh bug lives in authRefresh dot ts and rotates on every use',
  'postgres connection pooling is configured in dbPool with a max of twenty sockets',
  'the terminal renderer batches pty writes inside a requestAnimationFrame loop',
]
const write = (content: string) => memoryWrite({ agentId: 'a', kind: 'fact', content })
const topHit = async (query: string) => (await memorySearch({ query, limit: 3 }))[0]?.content ?? ''

beforeEach(async () => {
  _resetForTests()
  dir = mkdtempSync(join(tmpdir(), 'vq-'))
  _setEmbedFnForTests(fakeEmbed)
  _setEmbeddingsAvailable(true)
  initSwarmMemory(dir)
})

afterEach(() => {
  _setEmbedFnForTests(null)
  _resetForTests()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the default is EXACT — you opt in to the approximation', () => {
  it('a fresh store is float32, not quantized', () => {
    expect(_isVectorStoreQuantizedForTests()).toBe(false)
    expect(vectorRamStats().quantized).toBe(false)
  })
})

describe('turning int8 ON', () => {
  it('re-packs the store and drops vector RAM to a quarter', async () => {
    for (const c of CORPUS) await write(c)
    const before = vectorRamStats()
    expect(before.quantized).toBe(false)
    expect(before.vectors).toBe(CORPUS.length)
    expect(before.ramBytes).toBe(before.vectors * 384 * 4)

    const after = setVectorQuantization(true)
    expect(after.quantized).toBe(true)
    expect(_isVectorStoreQuantizedForTests()).toBe(true)
    expect(after.vectors).toBe(CORPUS.length)          // every vector survived the rebuild
    expect(after.ramBytes).toBe(after.vectors * 384)   // 1 B/component, not 4
    expect(after.ramBytes).toBe(before.ramBytes / 4)   // the advertised 4x
  })

  it('memories written BEFORE the flip are still recallable after it', async () => {
    for (const c of CORPUS) await write(c)
    expect(await topHit('auth token refresh')).toMatch(/authRefresh/)

    setVectorQuantization(true)

    // The store was rebuilt from disk in int8 — recall must still work.
    expect(await topHit('auth token refresh')).toMatch(/authRefresh/)
    expect(await topHit('postgres connection pooling')).toMatch(/dbPool/)
  })
})

describe('turning int8 back OFF — the de-implement path', () => {
  it('restores exact float32 and full vector RAM', async () => {
    for (const c of CORPUS) await write(c)
    setVectorQuantization(true)
    expect(_isVectorStoreQuantizedForTests()).toBe(true)

    const back = setVectorQuantization(false)
    expect(back.quantized).toBe(false)
    expect(_isVectorStoreQuantizedForTests()).toBe(false)
    expect(back.vectors).toBe(CORPUS.length)
    expect(back.ramBytes).toBe(back.vectors * 384 * 4) // exact floats again
  })

  // THE ONE THAT PROVES THE UI'S CLAIM. A user tries int8, writes work under it, then reverts.
  // If the flip had quantized the SOURCE OF TRUTH, those memories would come back degraded — or
  // not at all. Disk keeps exact floats, so they must come back whole.
  it('memories written WHILE quantized survive being switched back to exact', async () => {
    setVectorQuantization(true)
    for (const c of CORPUS) await write(c)
    expect(await topHit('terminal renderer pty writes')).toMatch(/requestAnimationFrame/)

    setVectorQuantization(false)

    expect(vectorRamStats().vectors).toBe(CORPUS.length)
    expect(await topHit('terminal renderer pty writes')).toMatch(/requestAnimationFrame/)
    expect(await topHit('auth token refresh')).toMatch(/authRefresh/)
  })

  it('a full round trip (off → on → off) leaves recall identical', async () => {
    for (const c of CORPUS) await write(c)
    const q = 'postgres connection pooling sockets'
    const first = await topHit(q)

    setVectorQuantization(true)
    setVectorQuantization(false)

    expect(await topHit(q)).toBe(first) // byte-for-byte the same memory comes back
  })

  it('never rewrites the JSONL — the disk copy stays exactly as it was', async () => {
    for (const c of CORPUS) await write(c)
    const shard = () => {
      const f = readdirSync(dir).find((n) => n.endsWith('.jsonl'))
      return f ? readFileSync(join(dir, f), 'utf8') : ''
    }
    const onDiskBefore = shard()
    expect(onDiskBefore.length).toBeGreaterThan(0)

    setVectorQuantization(true)
    setVectorQuantization(false)

    // Quantization is an IN-RAM representation. If the flip ever touched the source of truth,
    // this is the assertion that catches it.
    expect(shard()).toBe(onDiskBefore)
  })
})

describe('the explicit choice is authoritative (the one-way latch is fixed)', () => {
  // The original code was `quantizeVectors = quantizeVectors || env`, which could turn the flag ON
  // but never OFF — so a user un-ticking the box would have been silently ignored. Wiring a UI
  // switch to a one-way latch is exactly the kind of bug that ships.
  it('an explicit false overrides a previously-set true', async () => {
    await write(CORPUS[0])
    setVectorQuantization(true)
    expect(_isVectorStoreQuantizedForTests()).toBe(true)

    setVectorQuantization(false)
    expect(_isVectorStoreQuantizedForTests()).toBe(false)

    // …and it STAYS off across a re-init (the latch used to re-assert itself here).
    initSwarmMemory(dir)
    expect(_isVectorStoreQuantizedForTests()).toBe(false)
  })

  it('an explicit false beats the TERMPOLIS_MEM_QUANTIZE env var', () => {
    const prev = process.env.TERMPOLIS_MEM_QUANTIZE
    process.env.TERMPOLIS_MEM_QUANTIZE = '1'
    try {
      setVectorQuantization(false) // the user said no; the dev env var must not overrule them
      expect(_isVectorStoreQuantizedForTests()).toBe(false)
      initSwarmMemory(dir)
      expect(_isVectorStoreQuantizedForTests()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.TERMPOLIS_MEM_QUANTIZE
      else process.env.TERMPOLIS_MEM_QUANTIZE = prev
    }
  })

  it('the env var still works as the dev/bench escape hatch when nothing explicit was chosen', () => {
    const prev = process.env.TERMPOLIS_MEM_QUANTIZE
    process.env.TERMPOLIS_MEM_QUANTIZE = '1'
    try {
      _resetForTests()       // clears any explicit choice
      _setEmbedFnForTests(fakeEmbed)
      _setEmbeddingsAvailable(true)
      initSwarmMemory(dir)
      expect(_isVectorStoreQuantizedForTests()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.TERMPOLIS_MEM_QUANTIZE
      else process.env.TERMPOLIS_MEM_QUANTIZE = prev
    }
  })
})

describe('vectorRamStats reports honest arithmetic', () => {
  it('float and int8 projections are 4 B and 1 B per component regardless of current mode', async () => {
    for (const c of CORPUS) await write(c)
    const s = vectorRamStats()
    expect(s.dim).toBe(384)
    expect(s.ramBytesFloat).toBe(s.vectors * 384 * 4)
    expect(s.ramBytesInt8).toBe(s.vectors * 384 * 1)
    expect(s.ramBytes).toBe(s.ramBytesFloat) // currently exact

    const q = setVectorQuantization(true)
    expect(q.ramBytes).toBe(q.ramBytesInt8)  // now int8
    expect(q.ramBytesFloat).toBe(q.vectors * 384 * 4) // the counterfactual is still reported
  })

  it('an empty store reports zeroes rather than NaN', () => {
    const s = vectorRamStats()
    expect(s.vectors).toBe(0)
    expect(s.ramBytes).toBe(0)
    expect(s.ramBytesInt8).toBe(0)
  })
})
