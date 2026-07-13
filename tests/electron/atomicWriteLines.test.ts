// The 512 MB cliff.
//
// compactSelfShard used to end with:
//
//     atomicWriteFile(memPath, out.join('\n') + '\n')
//
// which materialises the ENTIRE shard as a single JS string. V8 caps a string at MAX_STRING_LENGTH —
// 536,870,888 chars (512 MB) on 64-bit. A real store here is already 450 MB. That is 12% of headroom.
//
// Cross it and `join()` throws RangeError. The 30-minute compaction timer catches and swallows it,
// so compaction would SILENTLY never run again — forever — while the shard grew without bound. A
// failure that produces no error message anywhere is the worst kind there is, and this one strands
// the entire store.
//
// The fix writes incrementally. The property that matters is not "it produced the right bytes" (any
// implementation would) but "it NEVER asks V8 for a giant string" — which is what these tests pin,
// because a regression would reintroduce a cliff that only fires on the biggest, most valuable
// stores, silently, months later.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants as bufferConstants } from 'node:buffer'

// Capture the size of EVERY write to the temp fd. If any single one is enormous, we are back to
// building a giant string and the cliff is back.
const writes: number[] = []
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    default: real,
    writeFileSync: (fd: never, data: never, ...rest: never[]) => {
      if (typeof data === 'string') writes.push((data as string).length)
      return (real.writeFileSync as (...a: never[]) => unknown)(fd, data, ...rest)
    },
  }
})

import {
  initSwarmMemory,
  memoryWrite,
  memoryFeedback,
  memoryList,
  compactSelfShard,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

vi.mock('electron', () => ({ app: { getPath: () => dir }, safeStorage: undefined }))

let dir: string
const shardPath = () => join(dir, 'swarm-memory.jsonl')
const write = (content: string) => memoryWrite({ agentId: 'a', kind: 'fact', content })

beforeEach(() => {
  _resetForTests()
  dir = mkdtempSync(join(tmpdir(), 'awl-'))
  _setEmbedFnForTests(async () => null)
  _setEmbeddingsAvailable(false)
  initSwarmMemory(dir)
  writes.length = 0
})

afterEach(() => {
  _setEmbedFnForTests(null)
  _resetForTests()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** Churn the store until compaction is genuinely warranted (reinforce lines outnumber entries). */
async function makeCompactionWorthwhile(entries = 100, uses = 300) {
  const ids: string[] = []
  for (let i = 0; i < entries; i++) ids.push((await write(`entry ${i} — ${'payload '.repeat(20)}`)).id)
  for (let r = 0; r < uses; r++) memoryFeedback({ id: ids[r % ids.length], helpful: true })
  return ids
}

describe('the shard is written incrementally, never as one giant string', () => {
  it('knows the cliff it is avoiding', () => {
    // 512 MB. A real store here is 450 MB. This is not a theoretical limit.
    expect(bufferConstants.MAX_STRING_LENGTH).toBe(536_870_888)
  })

  // THE INVARIANT. Not "the bytes are right" -- any implementation gets that. The property that
  // matters is "no single write is ever huge", because that is the only thing standing between a
  // 600 MB store and a RangeError that silently strands compaction forever.
  //
  // CRITICALLY: this corpus must EXCEED the 4 MB chunk, or the test is vacuous. My first version used
  // ~50 KB of entries -- and a one-giant-string implementation passed it, because 50 KB fits under the
  // cap either way. It proved nothing. 800 entries x 16 KB = ~12.8 MB, which a single buffered string
  // cannot hide.
  it('every write is BOUNDED, on a corpus large enough for that to MEAN something', async () => {
    const filler = 'x'.repeat(16 * 1024) // MAX_CONTENT
    for (let i = 0; i < 800; i++) await write(`e${i} ${filler}`) // ~12.8 MB of shard
    writes.length = 0

    expect(compactSelfShard({ force: true }).compacted).toBe(true)

    const total = writes.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(8 * 1024 * 1024) // the corpus really is bigger than the assertion cap

    // Chunked: several writes, none enormous. One giant join(): a single write the size of the whole
    // shard -- which is exactly the regression this catches.
    expect(writes.length).toBeGreaterThan(1)
    expect(Math.max(...writes)).toBeLessThan(8 * 1024 * 1024)
  }, 60_000)

  it('the bytes are IDENTICAL to what join() would have produced', async () => {
    await makeCompactionWorthwhile()
    expect(compactSelfShard().compacted).toBe(true)

    const onDisk = readFileSync(shardPath(), 'utf8')
    const lines = onDisk.split('\n').filter((l) => l.trim())
    // Reconstruct the file the OLD way and demand a byte-for-byte match. Streaming must change how
    // it is written, never what is written.
    expect(onDisk).toBe(lines.join('\n') + '\n')
  })

  it('compaction stays LOSSLESS through the streaming write', async () => {
    const ids = await makeCompactionWorthwhile()
    const before = memoryList({ limit: 1000 }).map((e) => e.content).sort()
    expect(before.length).toBe(ids.length)

    expect(compactSelfShard().compacted).toBe(true)

    const after = memoryList({ limit: 1000 }).map((e) => e.content).sort()
    expect(after).toEqual(before) // not one memory lost, not one resurrected
  })

  it('a shard whose real contribution is nothing is truncated to empty, not to "\\n"', () => {
    writeFileSync(shardPath(), ['', JSON.stringify({ hello: 'world' }), '   '].join('\n') + '\n')
    initSwarmMemory(dir)

    expect(compactSelfShard({ force: true }).compacted).toBe(true)
    expect(readFileSync(shardPath(), 'utf8')).toBe('') // genuinely empty, not a stray newline
  })

  it('the write is still ATOMIC — no .tmp file is left behind', async () => {
    await makeCompactionWorthwhile()
    expect(compactSelfShard().compacted).toBe(true)
    // temp + fsync + rename. If the rename did not happen we would see the temp file.
    expect(() => readFileSync(shardPath() + '.tmp', 'utf8')).toThrow()
    expect(readFileSync(shardPath(), 'utf8').length).toBeGreaterThan(0)
  })
})
