// ccrStore: the proxy stashes the original of every compressed result it forwards, and used to write each one to disk
// SYNCHRONOUSLY on the main thread (the file was a request's worth of bytes, per request, while the user types). The
// write goes to the thread pool now. These pin the three things that could go wrong: a read in the window before the
// write lands, a write that fails, and anything synchronous creeping back. Counters only.
// IMPORT ORDER: the counters first (they patch fs before the module under test loads).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { offMainFiles } from '../../src/main/offMainFiles'
import { ccrStash, ccrRetrieve, ccrStats, resetCcr, setCcrDir, CCR_MAX_ENTRIES } from '../../src/main/headroom/ccrStore'

let dir: string
beforeEach(() => {
  resetCcr()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-async-'))
  setCcrDir(dir)
})
afterEach(async () => {
  await offMainFiles.idle()
  resetCcr()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})
afterAll(() => { uninstall() })

describe('ccr store writes on the thread pool', () => {
  it('stashing 300 results makes no synchronous call on the main thread, and the files land', async () => {
    arm()
    const tokens: string[] = []
    for (let i = 0; i < 300; i++) tokens.push(ccrStash({ n: i, pad: 'x'.repeat(200) }))
    const during = disarm()
    expect(describeCounts(during)).toBe('')
    await offMainFiles.idle()
    const onDisk = fs.readdirSync(dir).filter((n) => n.startsWith('hr_'))
    expect(onDisk.length).toBe(ccrStats().diskEntries)
    expect(onDisk.length).toBeGreaterThan(0)
    expect(tokens.every((t) => ccrRetrieve(t) !== undefined)).toBe(true)
  })

  it('a record is answered in the window before its write has landed (indexed, never "indexed but missing")', async () => {
    const token = ccrStash({ big: 'y'.repeat(400) })
    // Push it out of memory at once, before any write could have run (nothing here awaits the disk).
    for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrStash(`fill-${i}`)
    expect(fs.existsSync(path.join(dir, `${token}.json`))).toBe(false) // the write has not run: nothing awaited the pool
    expect(ccrRetrieve(token)).toEqual({ big: 'y'.repeat(400) })
    await offMainFiles.idle()
    expect(fs.existsSync(path.join(dir, `${token}.json`))).toBe(true)
  })

  it('a write that FAILS is taken back out of the index and the memory copy is kept (nothing is lost)', async () => {
    // The folder becomes a file: every write under it now fails with ENOTDIR.
    fs.rmSync(dir, { recursive: true, force: true })
    fs.writeFileSync(dir, 'not a folder')
    const token = ccrStash({ keep: 'me' })
    expect(ccrStats().diskEntries).toBe(1) // counted durable at once, as the synchronous version did on success
    await offMainFiles.idle()
    expect(ccrStats().diskEntries).toBe(0) // the failure took it back
    expect(ccrStats().memoryOnlyEntries).toBe(1) // ...and pinned the memory copy against the LRU
    expect(ccrRetrieve(token)).toEqual({ keep: 'me' })
  })

  it('a write that fails after its entry was already evicted from the disk index takes nothing back twice', async () => {
    const { _setCcrLimits } = await import('../../src/main/headroom/ccrStore')
    _setCcrLimits(1200, 1000) // room for about two entries: the rest are evicted from the index as they come
    fs.rmSync(dir, { recursive: true, force: true })
    fs.writeFileSync(dir, 'not a folder') // every write fails
    for (let i = 0; i < 6; i++) ccrStash({ i, pad: 'z'.repeat(500) })
    expect(ccrStats().diskEntries).toBeLessThanOrEqual(2) // the older ones are no longer indexed...
    await offMainFiles.idle() // ...when their writes fail
    expect(ccrStats().diskEntries).toBe(0)
    expect(ccrStats().diskBytes).toBe(0) // the byte count did not go negative or drift
  })

  it('a failed write for a record whose memory copy is gone is forgotten (it can no longer be retrieved), not pinned', async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.writeFileSync(dir, 'not a folder') // every write fails
    const first = ccrStash({ first: true })
    for (let i = 0; i < CCR_MAX_ENTRIES + 20; i++) ccrStash({ i }) // pushes the first out of the memory LRU while its write is queued
    await offMainFiles.idle()
    expect(ccrRetrieve(first)).toBeUndefined() // gone from memory, and its write failed: nothing to retrieve
    expect(ccrStats().memoryOnlyEntries).toBeLessThanOrEqual(CCR_MAX_ENTRIES) // the ones still in memory are pinned, the gone one is not
  })

  it('evicting past the byte cap deletes the oldest files on the pool, after their writes', async () => {
    const { _setCcrLimits } = await import('../../src/main/headroom/ccrStore')
    _setCcrLimits(2000, 1500)
    const tokens: string[] = []
    for (let i = 0; i < 10; i++) tokens.push(ccrStash({ i, pad: 'z'.repeat(600) }))
    await offMainFiles.idle()
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('hr_'))
    expect(files.length).toBe(ccrStats().diskEntries)
    expect(files.length).toBeLessThan(10)
    expect(files.includes(`${tokens[0]}.json`)).toBe(false) // the oldest went first
    expect(files.includes(`${tokens[9]}.json`)).toBe(true)
  })
})
