import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  packEntryLine,
  decodeEmbedding,
  encodeEmbedding,
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  _resetForTests,
  _setEmbedFnForTests,
  _vectorStoreSizeForTests,
} from '../../src/main/swarmMemory'
import type { MemoryEntry } from '../../src/main/swarmMemory'

// The store's append path has always written the embedding as 384 JSON decimals — ~3.8 KB of text
// per memory, where the base64 f32 form is ~2 KB. The compact encoding has shipped since v1.28 and
// the reader has always understood both, but the only two paths that ever WRITE it are compaction,
// which is gated off on a healthy store, and export. The one-time migration that was supposed to
// convert the append path was specified in
// docs/superpowers/specs/2026-07-16-packed-vector-encoding-design.md and never built.
//
// Net effect: every line on disk carries the fat form, and roughly half of a 1.17 GB store is
// decimal text for a number that is already a float32. This is the pure function that fixes the
// growth at its source — from here on, a new line is written packed.

const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 2)

function entry(extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    agentId: 'claude',
    kind: 'note',
    content: 'a lesson worth keeping',
    timestamp: 1_700_000_000_000,
    hash: 'h1',
    ...extra,
  } as MemoryEntry
}

describe('packEntryLine — the append path writes the compact vector, not 384 decimals', () => {
  it('writes the packed field and drops the decimal one', () => {
    const row = JSON.parse(packEntryLine(entry({ embedding: vec } as Partial<MemoryEntry>)))
    expect(typeof row.emb).toBe('string')
    // Both would be strictly worse than today: the line would carry the vector TWICE.
    expect(row.embedding).toBeUndefined()
  })

  it('round-trips through the reader that has always understood both forms', () => {
    const row = JSON.parse(packEntryLine(entry({ embedding: vec } as Partial<MemoryEntry>)))
    const back = decodeEmbedding(row)
    expect(back).not.toBeNull()
    expect(back!.length).toBe(vec.length)
    // f32 storage, so compare at f32 precision rather than demanding bit equality.
    for (let i = 0; i < vec.length; i++) expect(back![i]).toBeCloseTo(vec[i], 6)
  })

  it('agrees with the encoder compaction and export already use', () => {
    // One codec, one format. If these ever diverge, a store would hold two dialects of "packed".
    const row = JSON.parse(packEntryLine(entry({ embedding: vec } as Partial<MemoryEntry>)))
    expect(row.emb).toBe(encodeEmbedding(vec))
  })

  it('keeps every other field exactly as it was', () => {
    const e = entry({ embedding: vec, importance: 0.8, project: 'termpolis' } as Partial<MemoryEntry>)
    const row = JSON.parse(packEntryLine(e))
    expect(row).toMatchObject({
      id: 'm1', agentId: 'claude', kind: 'note', content: 'a lesson worth keeping',
      timestamp: 1_700_000_000_000, hash: 'h1', importance: 0.8, project: 'termpolis',
    })
  })

  it('is materially smaller — which is the entire point', () => {
    const e = entry({ embedding: vec } as Partial<MemoryEntry>)
    const packed = packEntryLine(e).length
    const fat = JSON.stringify(e).length
    expect(packed).toBeLessThan(fat * 0.6)
  })

  it('leaves an entry with no vector byte-identical to what it writes today', () => {
    const e = entry()
    expect(packEntryLine(e)).toBe(JSON.stringify(e))
  })

  it('falls back rather than throwing on a malformed vector — a write must never be lost', () => {
    // Durability outranks bytes. A weird embedding costs disk; a thrown encoder costs the memory.
    const bad = entry({ embedding: 'not a vector' } as unknown as Partial<MemoryEntry>)
    expect(() => packEntryLine(bad)).not.toThrow()
    expect(JSON.parse(packEntryLine(bad)).content).toBe('a lesson worth keeping')
  })

  it('does not pack an empty vector into a field the reader would have to special-case', () => {
    const e = entry({ embedding: [] } as Partial<MemoryEntry>)
    const row = JSON.parse(packEntryLine(e))
    expect(row.emb).toBeUndefined()
  })
})

// -------------------------------------------------------------------------------------------
// The round trip that matters: a packed line has to come BACK as a usable vector on reload.
// Encoding a vector into a form the loader silently drops would not save disk, it would delete
// semantic recall — and it would do it quietly, because keyword search still returns something.
// -------------------------------------------------------------------------------------------
describe('the append path, end to end on a real store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'packline-'))
    _resetForTests()
    _setEmbedFnForTests(async () => vec)
    initSwarmMemory(dir)
  })

  afterEach(() => {
    _setEmbedFnForTests(null)
    _resetForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the packed form to disk', async () => {
    await memoryWrite({ agentId: 'claude', content: 'the packed line reaches the disk', kind: 'note' })
    const raw = readFileSync(join(dir, 'swarm-memory.jsonl'), 'utf8').trim()
    const row = JSON.parse(raw.split('\n').pop()!)
    expect(typeof row.emb).toBe('string')
    expect(row.embedding).toBeUndefined()
  })

  it('brings the vector back on reload — the change must not cost semantic recall', async () => {
    await memoryWrite({ agentId: 'claude', content: 'survives a restart with its vector', kind: 'note' })
    expect(_vectorStoreSizeForTests()).toBe(1)

    // Restart: same directory, fresh process state. This is the launch path.
    _resetForTests()
    _setEmbedFnForTests(async () => vec)
    initSwarmMemory(dir)
    await new Promise((r) => setTimeout(r, 50))

    expect(_vectorStoreSizeForTests()).toBe(1)
    const found = await memorySearch({ query: 'survives a restart' })
    expect(found.map((f) => f.content)).toContain('survives a restart with its vector')
  })

  it('costs materially less per line than the decimal form it replaces', async () => {
    await memoryWrite({ agentId: 'claude', content: 'measure the saving, do not assume it', kind: 'note' })
    const line = readFileSync(join(dir, 'swarm-memory.jsonl'), 'utf8').trim().split('\n').pop()!
    const asDecimals = JSON.stringify({ ...JSON.parse(line), emb: undefined, embedding: vec })
    expect(line.length).toBeLessThan(asDecimals.length * 0.6)
  })
})
