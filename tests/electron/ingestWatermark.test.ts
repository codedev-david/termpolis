// The persisted per-file watermark: "this file was COMPLETELY ingested when it looked like this".
// Skipping a file on a wrong mark loses memory silently, so everything that is not a clean yes is a no:
// a different size, a different mtime, a different tier, a different stamp, a damaged file.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  INGEST_FORMAT_VERSION,
  WATERMARK_FILE,
  fileWatermarkIO,
  ingestFastEnabled,
  openWatermark,
  type WatermarkIO,
} from '../../src/main/ingestWatermark'

/** An in-memory file, counting what is done to it. */
function memoryIO(initial: string | null = null): WatermarkIO & { text: string | null; reads: number; writes: number; failWrites: boolean; failReads: boolean } {
  const io = {
    text: initial,
    reads: 0,
    writes: 0,
    failWrites: false,
    failReads: false,
    async read(): Promise<string | null> {
      io.reads++
      if (io.failReads) throw new Error('disk gone')
      return io.text
    },
    async write(text: string): Promise<void> {
      io.writes++
      if (io.failWrites) throw new Error('disk full')
      io.text = text
    },
  }
  return io
}

const A = { size: 100, mtimeMs: 1_000 }

describe('the mark itself', () => {
  it('knows nothing at first, and remembers exactly the file, size and mtime it was told', async () => {
    const wm = await openWatermark(memoryIO(), 's1')
    expect(wm.isDone('/a.jsonl', A, 'full')).toBe(false)
    wm.markDone('/a.jsonl', A, 'full')
    expect(wm.isDone('/a.jsonl', A, 'full')).toBe(true)
    expect(wm.isDone('/a.jsonl', { size: 101, mtimeMs: 1_000 }, 'full')).toBe(false) // it grew
    expect(wm.isDone('/a.jsonl', { size: 100, mtimeMs: 1_001 }, 'full')).toBe(false) // it was touched
    expect(wm.isDone('/b.jsonl', A, 'full')).toBe(false) // another file
  })

  it('a full mark covers a sealed pass; a sealed mark does not cover a full pass (the trailing partial chunk)', async () => {
    const wm = await openWatermark(memoryIO(), 's1')
    wm.markDone('/s.jsonl', A, 'sealed')
    expect(wm.isDone('/s.jsonl', A, 'sealed')).toBe(true)
    expect(wm.isDone('/s.jsonl', A, 'full')).toBe(false)
    wm.markDone('/s.jsonl', A, 'full')
    expect(wm.isDone('/s.jsonl', A, 'full')).toBe(true)
    expect(wm.isDone('/s.jsonl', A, 'sealed')).toBe(true)
    wm.markDone('/s.jsonl', A, 'sealed') // a later sealed pass never takes the full mark back
    expect(wm.isDone('/s.jsonl', A, 'full')).toBe(true)
  })

  it('a mark for a changed file replaces the old one (no stale tier survives a new size)', async () => {
    const wm = await openWatermark(memoryIO(), 's1')
    wm.markDone('/a.jsonl', A, 'full')
    wm.markDone('/a.jsonl', { size: 200, mtimeMs: 2_000 }, 'sealed')
    expect(wm.isDone('/a.jsonl', { size: 200, mtimeMs: 2_000 }, 'full')).toBe(false)
    expect(wm.isDone('/a.jsonl', { size: 200, mtimeMs: 2_000 }, 'sealed')).toBe(true)
    expect(wm.isDone('/a.jsonl', A, 'sealed')).toBe(false)
  })

  it('refuses a stamp that is not a real size and time (never a wrong skip)', async () => {
    const wm = await openWatermark(memoryIO(), 's1')
    for (const bad of [{ size: -1, mtimeMs: 1 }, { size: 1, mtimeMs: Number.NaN }, { size: Number.POSITIVE_INFINITY, mtimeMs: 1 }, { size: '1' as unknown as number, mtimeMs: 1 }]) {
      wm.markDone('/x.jsonl', bad, 'full')
      expect(wm.isDone('/x.jsonl', bad, 'full')).toBe(false)
    }
    expect(wm.pending).toBe(0)
  })
})

describe('persistence', () => {
  it('flush writes once, and a store opened later with the same stamp knows what was marked', async () => {
    const io = memoryIO()
    const wm = await openWatermark(io, 's1')
    wm.markDone('/a.jsonl', A, 'full')
    wm.markDone('/b.jsonl', { size: 5, mtimeMs: 6 }, 'sealed')
    expect(wm.pending).toBe(2)
    expect(io.writes).toBe(0) // nothing is written until flush: a pass decides when its marks are safe to keep
    expect(await wm.flush()).toBe(true)
    expect(io.writes).toBe(1)
    expect(wm.pending).toBe(0)

    const again = await openWatermark(io, 's1')
    expect(again.size).toBe(2)
    expect(again.isDone('/a.jsonl', A, 'full')).toBe(true)
    expect(again.isDone('/b.jsonl', { size: 5, mtimeMs: 6 }, 'sealed')).toBe(true)
    expect(again.isDone('/b.jsonl', { size: 5, mtimeMs: 6 }, 'full')).toBe(false)
  })

  it('a flush with nothing new does not touch the disk (a steady pass writes nothing)', async () => {
    const io = memoryIO()
    const wm = await openWatermark(io, 's1')
    expect(await wm.flush()).toBe(false)
    wm.markDone('/a.jsonl', A, 'full')
    await wm.flush()
    const writes = io.writes
    expect(await wm.flush()).toBe(false)
    expect(io.writes).toBe(writes)
  })

  it('a different stamp (another app version or chunker format) starts empty: one budgeted re-scan, never a wrong skip', async () => {
    const io = memoryIO()
    const wm = await openWatermark(io, 'fmt1|1.54.5')
    wm.markDone('/a.jsonl', A, 'full')
    await wm.flush()
    const next = await openWatermark(io, 'fmt1|1.54.6')
    expect(next.size).toBe(0)
    expect(next.isDone('/a.jsonl', A, 'full')).toBe(false)
  })

  it('a damaged, odd or unreadable file is an empty store, never an error', async () => {
    for (const text of ['', '{', 'null', '[]', '{"v":1}', '{"v":99,"stamp":"s1","files":{}}', '{"v":1,"stamp":"s1","files":[]}', '{"v":1,"stamp":"s1","files":{"/a":"x","/b":[1],"/c":[1,2,9],"/d":[-1,2,2],"/e":[1,"2",2]}}']) {
      const wm = await openWatermark(memoryIO(text), 's1')
      expect(wm.size).toBe(0)
      expect(wm.isDone('/a', { size: 1, mtimeMs: 2 }, 'full')).toBe(false)
    }
    const io = memoryIO('{"v":1,"stamp":"s1","files":{}}')
    io.failReads = true
    expect((await openWatermark(io, 's1')).size).toBe(0)
  })

  it('keeps the good entries of a file that also has bad ones', async () => {
    const text = JSON.stringify({ v: 1, stamp: 's1', files: { '/good': [10, 20, 2], '/bad': [10, 20, 7], '/worse': 'x' } })
    const wm = await openWatermark(memoryIO(text), 's1')
    expect(wm.size).toBe(1)
    expect(wm.isDone('/good', { size: 10, mtimeMs: 20 }, 'full')).toBe(true)
  })

  it('a failed write is reported, keeps the marks, and the next flush tries again', async () => {
    const io = memoryIO()
    io.failWrites = true
    const wm = await openWatermark(io, 's1')
    wm.markDone('/a.jsonl', A, 'full')
    expect(await wm.flush()).toBe(false)
    expect(wm.isDone('/a.jsonl', A, 'full')).toBe(true)
    io.failWrites = false
    expect(await wm.flush()).toBe(true)
    expect(JSON.parse(io.text as string).files['/a.jsonl']).toEqual([100, 1_000, 2])
  })

  it('discard drops the marks made since the last flush and nothing before it', async () => {
    const io = memoryIO()
    const wm = await openWatermark(io, 's1')
    wm.markDone('/kept.jsonl', A, 'full')
    await wm.flush()
    wm.markDone('/lost.jsonl', A, 'full')
    wm.markDone('/kept.jsonl', { size: 7, mtimeMs: 7 }, 'full') // a newer mark over a flushed one
    wm.discard()
    expect(wm.pending).toBe(0)
    expect(wm.isDone('/lost.jsonl', A, 'full')).toBe(false)
    expect(wm.isDone('/kept.jsonl', A, 'full')).toBe(true) // back to what was flushed
    expect(wm.isDone('/kept.jsonl', { size: 7, mtimeMs: 7 }, 'full')).toBe(false)
    expect(await wm.flush()).toBe(false)
  })

  it('forgetMissing drops the files that are gone, so the file stays the size of the corpus', async () => {
    const io = memoryIO()
    const wm = await openWatermark(io, 's1')
    for (const f of ['/a', '/b', '/c']) wm.markDone(f, A, 'full')
    await wm.flush()
    expect(wm.forgetMissing(new Set(['/a', '/c']))).toBe(1)
    expect(wm.size).toBe(2)
    expect(wm.isDone('/b', A, 'full')).toBe(false)
    expect(await wm.flush()).toBe(true) // the pruned file is written
    expect(Object.keys(JSON.parse(io.text as string).files).sort()).toEqual(['/a', '/c'])
    expect(wm.forgetMissing(new Set(['/a', '/c']))).toBe(0)
    expect(await wm.flush()).toBe(false)
  })

  it('the file is small: well under 200 bytes per file even with long paths', async () => {
    const io = memoryIO()
    const wm = await openWatermark(io, 's1')
    for (let i = 0; i < 2_000; i++) wm.markDone(`C:\\Users\\someone\\.claude\\projects\\C--Users-someone-repos-project\\${'0'.repeat(8)}-${i}-aaaa-bbbb-cccc.jsonl`, { size: 123_456 + i, mtimeMs: 1_762_000_000_000.5 + i }, 'full')
    await wm.flush()
    expect((io.text as string).length / 2_000).toBeLessThan(200)
  })
})

describe('the real file', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'wm-')); dirs.push(d); return d }

  it('reads null for a file that is not there, writes it whole, and leaves no temp file behind', async () => {
    const dir = tmp()
    const io = fileWatermarkIO(join(dir, WATERMARK_FILE))
    expect(await io.read()).toBeNull()
    await io.write('{"hello":1}')
    expect(readFileSync(join(dir, WATERMARK_FILE), 'utf8')).toBe('{"hello":1}')
    await io.write('{"hello":2}')
    expect(readFileSync(join(dir, WATERMARK_FILE), 'utf8')).toBe('{"hello":2}')
    expect(readdirSync(dir)).toEqual([WATERMARK_FILE])
  })

  it('creates the folder if userData does not exist yet, and a real store round-trips through it', async () => {
    const dir = join(tmp(), 'not', 'yet')
    const io = fileWatermarkIO(join(dir, WATERMARK_FILE))
    const wm = await openWatermark(io, 's1')
    wm.markDone('/a', A, 'full')
    expect(await wm.flush()).toBe(true)
    expect(existsSync(join(dir, WATERMARK_FILE))).toBe(true)
    expect((await openWatermark(fileWatermarkIO(join(dir, WATERMARK_FILE)), 's1')).isDone('/a', A, 'full')).toBe(true)
  })

  it('a path that runs through a file instead of a folder simply reads as "not there"', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'asdir'), 'x')
    const io = fileWatermarkIO(join(dir, 'asdir', WATERMARK_FILE)) // ENOTDIR or ENOENT, depending on the OS
    await expect(io.read()).resolves.toBeNull()
    expect((await openWatermark(io, 's1')).size).toBe(0)
  })
})

describe('the kill switch and the format version', () => {
  it('TERMPOLIS_INGEST_FAST=off|0|false|no turns the whole mechanism off; anything else leaves it on', () => {
    expect(ingestFastEnabled({})).toBe(true)
    expect(ingestFastEnabled({ TERMPOLIS_INGEST_FAST: '1' })).toBe(true)
    expect(ingestFastEnabled({ TERMPOLIS_INGEST_FAST: '' })).toBe(true)
    for (const v of ['off', 'OFF', '0', 'false', 'No', ' off ']) expect(ingestFastEnabled({ TERMPOLIS_INGEST_FAST: v }), v).toBe(false)
  })

  it('INGEST_FORMAT_VERSION is the one the golden fixture was made for (change one, change both)', () => {
    const golden = JSON.parse(readFileSync(join(__dirname, '../fixtures/ingest-golden.json'), 'utf8'))
    expect(golden._format).toBe(INGEST_FORMAT_VERSION)
  })
})
