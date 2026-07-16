// Regression + durability suite for the v1.27.4 crash: a swarm-memory shard that grew past V8's max
// string length (~512 MiB) crashed the memory host on load AND crashed the main process when the
// in-process fallback re-read it. Root cause: the loader decoded the whole shard with
// `fs.readFileSync(path, 'utf8')`, whose Node 20 fast path FATALS uncatchably
// ("v8::ToLocalChecked Empty MaybeLocal") once the decoded string would exceed the limit. The fix
// reads shard BYTES and decodes one line at a time, so no single string can ever hit the cliff.
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
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { forEachBufferLine } from '../../src/main/fileLines'

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
  it('reads the shard as a Buffer, never with a utf8 encoding (the >512 MiB fatal is impossible)', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha fact one' })
    await memoryWrite({ agentId: 'b', kind: 'fact', content: 'beta fact two' })
    const shard = path.resolve(path.join(tmpDir, 'swarm-memory.jsonl'))

    _resetForTests()
    readCalls.length = 0 // watch only the reload triggered below
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)

    const shardReads = readCalls.filter((c) => typeof c.path === 'string' && path.resolve(c.path as string) === shard)
    const usedUtf8 = (c: { enc: unknown }) =>
      c.enc === 'utf8' || (!!c.enc && typeof c.enc === 'object' && (c.enc as { encoding?: string }).encoding === 'utf8')

    const utf8ShardReads = shardReads.filter(usedUtf8)
    const bufferShardReads = shardReads.filter((c) => c.enc === undefined)

    expect(utf8ShardReads).toHaveLength(0)         // the fatal `readFileSync(shard, 'utf8')` is gone
    expect(bufferShardReads.length).toBeGreaterThan(0) // the shard WAS loaded, via the byte path
    expect(memoryCount()).toBe(2)                  // and the entries survived the streamed load
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
