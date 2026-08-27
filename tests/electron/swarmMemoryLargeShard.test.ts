// Regression + durability suite for the v1.27.4 crash: a swarm-memory shard that grew past V8's max
// string length (~512 MiB) crashed the memory host on load AND crashed the main process when the
// in-process fallback re-read it. Root cause: the loader decoded the whole shard with
// `fs.readFileSync(path, 'utf8')`, whose Node 20 fast path FATALS uncatchably
// ("v8::ToLocalChecked Empty MaybeLocal") once the decoded string would exceed the limit. The fix
// reads shard BYTES and decodes one line at a time, so no single string can ever hit the cliff.
//
// v1.37.2 (F31) found the SECOND ceiling the same way: reading BYTES dodged the V8 string cliff but
// `fs.readFileSync` has a hard cap of its own — kIoMaxLength (2**31-1 = 2 GiB) — which applies to
// Buffers too. A real 2.27 GB store hit `ERR_FS_FILE_TOO_LARGE`, reloadFrom's per-shard `catch`
// treated the throw as an empty shard, and the brain came up with 0 memories and 0 lessons looking
// brand new. So forEachShardLine no longer reads whole files at all: it streams fixed-size chunks
// and carries partial lines across the seam as BYTES. These tests pin all three properties — no
// whole-file read, correct decoding across a chunk boundary, and a loud health flag when a shard
// genuinely can't be read.
//
// The always-on tests below lock the fix in (they would fail on the pre-fix code); the true
// >512 MiB reproduction is gated behind RUN_HUGE_STORE_TEST=1 because it writes/reads ~560 MB — run
// it on demand to prove the fix end to end:
//   RUN_HUGE_STORE_TEST=1 npx vitest run tests/electron/swarmMemoryLargeShard.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import * as nodeBuffer from 'node:buffer'

// V8 max string length (~512 MiB) — the cliff the loader must never decode across. Resolved the same
// defensive way the source does, so the test and the code under test agree on the threshold.
const MAX_SINGLE_STRING_BYTES = nodeBuffer.constants?.MAX_STRING_LENGTH ?? 0x1fffffe8

// Record every fs.readFileSync so we can prove the shard loader reads BYTES — never a whole-file
// 'utf8' decode, the pattern that fatally (uncatchably) crashed on a >512 MiB shard. ESM module
// namespaces can't be spied (vi.spyOn → "not configurable in ESM"), so we mock the module and wrap
// only the one method we watch; everything else passes straight through to the real fs.
const { readCalls } = vi.hoisted(() => ({ readCalls: [] as Array<{ path: unknown; enc: unknown }> }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = ((p: unknown, enc?: unknown) => {
    readCalls.push({ path: p, enc })
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, enc)
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})
vi.mock('../../src/main/telemetry', () => ({
  recordSwarmError: vi.fn(),
}))

import * as fs from 'fs'

import {
  initSwarmMemory,
  memoryWrite,
  memoryCount,
  memoryList,
  memoryStats,
  memoryDashboardStats,
  getSyncStatus,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setMaxShardBytesForTests,
} from '../../src/main/swarmMemory'
import { forEachBufferLine, forEachShardLine } from '../../src/main/fileLines'

const RUN_HUGE_STORE_TEST = process.env.RUN_HUGE_STORE_TEST === '1'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-large-shard-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false) // keyword fallback — no bge model needed in CI
})

afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  vi.restoreAllMocks()
})

// Collect every line the byte splitter yields.
function collect(input: string | Buffer): string[] {
  const out: string[] = []
  forEachBufferLine(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'), (l) => { out.push(l) })
  return out
}

describe('forEachBufferLine — the byte-level shard splitter', () => {
  it('splits LF-delimited lines (no trailing newline)', () => {
    expect(collect('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('drops only the empty final element after a trailing newline (the sole, immaterial divergence from split)', () => {
    // split('\n') would yield a trailing '' here; every caller skips blank lines, so we don't emit it.
    expect(collect('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
    expect('a\nb\nc\n'.split('\n')).toEqual(['a', 'b', 'c', '']) // documents the difference
  })

  it('preserves empty lines in the MIDDLE (identical to split)', () => {
    expect(collect('a\n\nb')).toEqual(['a', '', 'b'])
  })

  it('preserves a trailing \\r exactly as split() leaves it (CRLF shards)', () => {
    expect(collect('a\r\nb\r\n')).toEqual(['a\r', 'b\r'])
  })

  it('is empty for an empty buffer', () => {
    expect(collect('')).toEqual([])
  })

  it('yields one empty line for a lone newline', () => {
    expect(collect('\n')).toEqual([''])
  })

  it('decodes multi-byte UTF-8 within lines without corruption (accents, CJK, emoji)', () => {
    expect(collect('héllo\nwörld\n中文\n😀 done')).toEqual(['héllo', 'wörld', '中文', '😀 done'])
  })

  it('never splits inside a multi-byte sequence (only the 0x0A byte terminates a line)', () => {
    // '😀' is F0 9F 98 80 — no byte is 0x0A, so it can never be a false line boundary.
    const round = collect('a😀b\nc😀d')
    expect(round).toEqual(['a😀b', 'c😀d'])
    expect(round[0]).toContain('😀')
  })

  it('matches raw.split(\\n) for arbitrary content, modulo the trailing empty element', () => {
    for (const s of ['', 'x', 'x\n', '\n\n', 'a\nb', '{"id":1}\n{"id":2}\n', 'tab\there\nline']) {
      const expected = s.split('\n')
      if (s.endsWith('\n')) expected.pop() // our one documented divergence
      if (s === '') expected.length = 0
      expect(collect(s)).toEqual(expected)
    }
  })

  it('stops early when onLine returns false', () => {
    const seen: string[] = []
    forEachBufferLine(Buffer.from('a\nb\nc\nd', 'utf8'), (l) => {
      seen.push(l)
      return l === 'b' ? false : undefined
    })
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('reloadFrom — shards are never decoded as one string', () => {
  it('never calls readFileSync on a shard AT ALL — not utf8, not even for bytes (F31: readFileSync caps at 2 GiB)', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha fact one' })
    await memoryWrite({ agentId: 'b', kind: 'fact', content: 'beta fact two' })
    const shard = path.resolve(path.join(tmpDir, 'swarm-memory.jsonl'))

    _resetForTests()
    readCalls.length = 0 // watch only the reload triggered below
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)

    const shardReads = readCalls.filter((c) => typeof c.path === 'string' && path.resolve(c.path as string) === shard)

    // v1.27.4 accepted a whole-file BUFFER read here. That is exactly what threw ERR_FS_FILE_TOO_LARGE
    // on a 2.27 GB store, so the contract is now stricter: the shard is streamed, never slurped.
    expect(shardReads).toHaveLength(0)
    expect(memoryCount()).toBe(2) // and the entries still survived the streamed load
  })

  it('decodes a multi-byte character that straddles a read-chunk boundary (the seam is carried as bytes)', () => {
    // Chunks are 8 MiB. Each line is 'x' + 'é'×100 + '\n' = 202 bytes, so byte 8388608 lands 153
    // bytes into a line's 2-byte-per-char region — i.e. deliberately MID-CHARACTER. Carrying the
    // seam as a decoded string instead of bytes corrupts it into U+FFFD here.
    const line = 'x' + 'é'.repeat(100)
    expect(Buffer.byteLength(line + '\n')).toBe(202)
    const count = 41_530 // ~8.39 MB — comfortably past one chunk
    const p = path.join(tmpDir, 'seam.jsonl')
    const fd = fs.openSync(p, 'w')
    try { for (let i = 0; i < count; i++) fs.writeSync(fd, line + '\n') } finally { fs.closeSync(fd) }
    expect(fs.statSync(p).size).toBeGreaterThan(8 * 1024 * 1024)

    let seen = 0
    let bad = 0
    forEachShardLine(p, (l) => {
      seen++
      if (l !== line) bad++
    })
    expect(seen).toBe(count)
    expect(bad).toBe(0)
  })

  it('honours an early stop across chunks and emits a final unterminated line', () => {
    const p = path.join(tmpDir, 'stop.jsonl')
    fs.writeFileSync(p, 'a\nb\nc') // no trailing newline — 'c' must still be emitted
    const all: string[] = []
    forEachShardLine(p, (l) => { all.push(l) })
    expect(all).toEqual(['a', 'b', 'c'])

    const some: string[] = []
    forEachShardLine(p, (l) => { some.push(l); return l === 'b' ? false : undefined })
    expect(some).toEqual(['a', 'b'])
  })

  it('carries a single line across MORE than two chunks without corrupting it', () => {
    // 20 MiB on one line = three 8 MiB chunks. This is the arm where `carry` is concatenated onto
    // itself; getting it wrong truncates the line to its last chunk and the entry silently vanishes.
    const body = 'q'.repeat(20 * 1024 * 1024)
    const p = path.join(tmpDir, 'onebigline.jsonl')
    fs.writeFileSync(p, `head\n${body}\ntail`)

    const out: string[] = []
    forEachShardLine(p, (l) => { out.push(l) })
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('head')
    expect(out[1].length).toBe(body.length)
    expect(out[1]).toBe(body)
    expect(out[2]).toBe('tail')
  }, 60_000)

  // A single LINE past V8's string cliff cannot be decoded at all without the uncatchable fatal, so
  // it is dropped rather than taking the process down — one absurd line lost beats every line lost.
  // Gated with the other half-gigabyte case: writing it costs ~530 MB.
  ;(RUN_HUGE_STORE_TEST ? it : it.skip)('skips a single line past V8 max string length instead of fatally decoding it', () => {
    const p = path.join(tmpDir, 'monsterline.jsonl')
    const fd = fs.openSync(p, 'w')
    try {
      fs.writeSync(fd, 'before\n')
      const block = Buffer.alloc(16 * 1024 * 1024, 0x71) // 'q'
      let written = 0
      while (written <= MAX_SINGLE_STRING_BYTES) { fs.writeSync(fd, block); written += block.length }
      fs.writeSync(fd, '\nafter\n')
    } finally {
      fs.closeSync(fd)
    }

    const out: string[] = []
    forEachShardLine(p, (l) => { out.push(l) }) // pre-fix shape: process abort
    expect(out).toEqual(['before', 'after'])    // the monster is skipped; its neighbours survive
  }, 300_000)

  it('is empty for an empty file and still closes the descriptor', () => {
    const p = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(p, '')
    const out: string[] = []
    forEachShardLine(p, (l) => { out.push(l) })
    expect(out).toEqual([])
  })

  it('throws (does not silently succeed) when the file cannot be opened', () => {
    expect(() => forEachShardLine(path.join(tmpDir, 'nope.jsonl'), () => {})).toThrow()
  })

  it('loads a real add line that sits AFTER non-record filler lines (proxy for the huge-shard case)', async () => {
    const sentinel = await makeSentinelLine('SENTINEL-after-filler')
    writeShardWithSentinel(tmpDir, `{"filler":"${'x'.repeat(64)}"}\n`, 3, sentinel)

    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)

    expect(memoryCount()).toBe(1)
    expect(memoryList().some((e) => e.content.includes('SENTINEL-after-filler'))).toBe(true)
  })

  // The genuine article: a shard whose sentinel entry lives BEYOND the ~512 MiB V8 string cliff.
  // On the pre-fix loader this aborts the whole process; here it must load cleanly. Gated because it
  // writes and reads ~560 MB (heavy for CI); run locally to prove the fix.
  ;(RUN_HUGE_STORE_TEST ? it : it.skip)('loads a shard larger than V8 max string length without crashing', async () => {
    const sentinel = await makeSentinelLine('SENTINEL-beyond-the-cliff')
    // ~1 MB filler lines (valid JSON, but no id → classified 'skip', so they add no heap-heavy entries).
    const fillerLine = `{"filler":"${'a'.repeat(1_000_000)}"}\n`
    const target = MAX_SINGLE_STRING_BYTES + 16 * 1024 * 1024 // comfortably past the cliff
    const fillerCount = Math.ceil(target / fillerLine.length)
    writeShardWithSentinel(tmpDir, fillerLine, fillerCount, sentinel)

    const size = fs.statSync(path.join(tmpDir, 'swarm-memory.jsonl')).size
    expect(size).toBeGreaterThan(MAX_SINGLE_STRING_BYTES) // the read that used to fatal

    _resetForTests()
    initSwarmMemory(tmpDir) // pre-fix: process aborts here; post-fix: streams the bytes
    _setEmbeddingsAvailable(false)

    expect(memoryCount()).toBe(1)
    expect(memoryList().some((e) => e.content.includes('SENTINEL-beyond-the-cliff'))).toBe(true)
  }, 120_000)
})

// F31: an unreadable shard used to be indistinguishable from an empty one — the exact failure that
// made a 2.27 GB brain present itself as a fresh install with zero lessons.
describe('reloadFrom — an unreadable shard is reported, not silently treated as empty', () => {
  it('flags the shard in memoryStats / getSyncStatus / memoryDashboardStats instead of reporting an empty brain', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a memory that really is on disk' })
    const shard = path.join(tmpDir, 'swarm-memory.jsonl')
    expect(fs.statSync(shard).size).toBeGreaterThan(0)

    _resetForTests()
    // Simulate ERR_FS_FILE_TOO_LARGE: the file exists and stats fine, but the OS refuses the read.
    const realOpen = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(shard) && rest[0] === 'r') {
        const err: NodeJS.ErrnoException = new Error(`File size (2264811480) is greater than 2 GiB`)
        err.code = 'ERR_FS_FILE_TOO_LARGE'
        throw err
      }
      return (realOpen as (...a: unknown[]) => number)(p, ...rest)
    }) as typeof fs.openSync)
    try {
      initSwarmMemory(tmpDir)
      _setEmbeddingsAvailable(false)
    } finally {
      spy.mockRestore()
    }

    expect(memoryCount()).toBe(0) // nothing loaded — that part is unavoidable
    const stats = memoryStats()
    expect(stats.unreadableShards).toHaveLength(1)
    expect(path.resolve(stats.unreadableShards[0])).toBe(path.resolve(shard))
    expect(getSyncStatus().unreadableShards).toBe(1)
    // The dashboard number is what stops the UI printing "your brain is empty" over a full store.
    expect(memoryDashboardStats().unreadableShards).toBe(1)
  })

  it('reports zero unreadable shards on a healthy store', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'healthy' })
    expect(memoryStats().unreadableShards).toEqual([])
    expect(getSyncStatus().unreadableShards).toBe(0)
    expect(memoryDashboardStats().unreadableShards).toBe(0)
  })
})

// F31 part 3: the active shard rolls over so no single file can march toward the 2 GiB ceiling.
describe('shard rotation', () => {
  it('rolls the active shard over and still loads every entry from the rotated generations', async () => {
    _setMaxShardBytesForTests(600) // a few entries per shard
    for (let i = 0; i < 12; i++) {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: `rotating fact number ${i}` })
    }
    const rotated = fs.readdirSync(tmpDir).filter((f) => /^swarm-memory\.\d+\.jsonl$/.test(f))
    expect(rotated.length).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmpDir, 'swarm-memory.jsonl'))).toBe(true) // active shard recreated
    expect(fs.statSync(path.join(tmpDir, 'swarm-memory.jsonl')).size).toBeLessThanOrEqual(600)

    const before = memoryCount()
    expect(before).toBe(12)

    // The real proof: a cold reload must find them all, across every generation.
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
    expect(memoryCount()).toBe(12)
    for (let i = 0; i < 12; i++) {
      expect(memoryList().some((e) => e.content.includes(`rotating fact number ${i}`))).toBe(true)
    }
  })

  it('numbers generations monotonically and never claims a sibling like the archive file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'swarm-memory.archive.jsonl'), '{"not":"a generation"}\n')
    _setMaxShardBytesForTests(400)
    for (let i = 0; i < 10; i++) {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: `gen fact ${i}` })
    }
    const gens = fs
      .readdirSync(tmpDir)
      .map((f) => /^swarm-memory\.(\d+)\.jsonl$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b)
    expect(gens.length).toBeGreaterThan(1)
    expect(gens).toEqual(gens.map((_, i) => i + 1)) // 1,2,3… no gaps, no reuse
    // The archive file is untouched and was never mistaken for generation "archive".
    expect(fs.readFileSync(path.join(tmpDir, 'swarm-memory.archive.jsonl'), 'utf8')).toContain('not')
  })

  it('does not rotate a store that stays under the cap', async () => {
    for (let i = 0; i < 5; i++) {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: `small ${i}` })
    }
    expect(fs.readdirSync(tmpDir).filter((f) => /^swarm-memory\.\d+\.jsonl$/.test(f))).toEqual([])
  })

  it('keeps appending (never drops the write) when the rename fails', async () => {
    _setMaxShardBytesForTests(300)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'first entry before the failed rollover' })
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EPERM') })
    try {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: 'second entry despite the failed rollover' })
    } finally {
      spy.mockRestore()
    }
    expect(memoryCount()).toBe(2)
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
    expect(memoryCount()).toBe(2) // both reached disk
  })
})

// Produce ONE genuine plaintext add-line by writing it through the real path in a throwaway store,
// then reading it back — so the sentinel is a fully-valid entry (id, hash, ts…), not a hand-forgery.
async function makeSentinelLine(content: string): Promise<string> {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-probe-'))
  try {
    _resetForTests()
    initSwarmMemory(probe)
    _setEmbeddingsAvailable(false)
    await memoryWrite({ agentId: 'probe', kind: 'fact', content })
    const line = fs.readFileSync(path.join(probe, 'swarm-memory.jsonl'), 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean).pop()
    if (!line) throw new Error('probe store produced no shard line')
    return line
  } finally {
    _resetForTests()
    try { fs.rmSync(probe, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// Write a shard = N filler lines (each already newline-terminated) followed by the sentinel add-line.
function writeShardWithSentinel(dir: string, fillerLine: string, fillerCount: number, sentinelLine: string): void {
  const p = path.join(dir, 'swarm-memory.jsonl')
  const fd = fs.openSync(p, 'w')
  try {
    for (let i = 0; i < fillerCount; i++) fs.writeSync(fd, fillerLine)
    fs.writeSync(fd, sentinelLine + '\n')
  } finally {
    fs.closeSync(fd)
  }
}
