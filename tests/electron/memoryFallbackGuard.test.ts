// v1.54.5 (typing hotfix, lane C, package P6) — the pure parts of the in-process fallback guard.
//
// memoryClientFallback.test.ts drives the whole client against a scripted host. This file pins the
// small deterministic pieces underneath it, each of which has a way to be quietly wrong:
//   - the limit and its kill switch (an env var a person types: whitespace, case, nonsense),
//   - the backoff table (counters, never wall-clock),
//   - the size probe, which must count exactly the files the real store loads and no others
//     (checked against a store written, and rotated, by the REAL swarmMemory),
//   - the fixed error text agents see, and the status record the Settings panel reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_INPROC_MAX_BYTES, GUARD_ENV, LIMIT_ENV, resolveInprocGuard, measureMemoryStoreBytes,
  RETRY_BASE_MS, RETRY_CAP_MS, retryDelayMs, retryReadyTimeoutMs,
  UNAVAILABLE_PREFIX, unavailableMessage, isMemoryUnavailableMessage,
  setMemoryUnavailableState, memoryUnavailableInfo, isMemoryUnavailable, type MemoryUnavailableState,
} from '../../src/main/memoryFallbackGuard'
import {
  initSwarmMemory, memoryWrite, memoryCount, _resetForTests, _setEmbeddingsAvailable, _setMaxShardBytesForTests,
} from '../../src/main/swarmMemory'

const MB = 1024 * 1024

let tmp: string
const tmpDirs: string[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-'))
  tmpDirs.push(tmp)
  setMemoryUnavailableState(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  setMemoryUnavailableState(null)
  _resetForTests()
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('resolveInprocGuard — the limit and its kill switch', () => {
  it('defaults to ON at 256 MB', () => {
    expect(DEFAULT_INPROC_MAX_BYTES).toBe(256 * MB)
    expect(resolveInprocGuard({})).toEqual({ enabled: true, maxBytes: 256 * MB })
  })

  it.each(['0', 'off', 'OFF', 'Off', 'false', 'FALSE', 'no', 'No', '  off  ', ' 0 '])('%j switches the guard off', (v) => {
    expect(resolveInprocGuard({ [GUARD_ENV]: v }).enabled).toBe(false)
  })

  it.each(['1', 'on', 'true', 'yes', '', 'banana', 'offf', '00'])('%j does NOT switch it off (only an explicit "off" word does)', (v) => {
    expect(resolveInprocGuard({ [GUARD_ENV]: v }).enabled).toBe(true)
  })

  it('takes the limit in MB, fractions allowed, floored to whole bytes', () => {
    expect(resolveInprocGuard({ [LIMIT_ENV]: '512' }).maxBytes).toBe(512 * MB)
    expect(resolveInprocGuard({ [LIMIT_ENV]: ' 600 ' }).maxBytes).toBe(600 * MB)
    expect(resolveInprocGuard({ [LIMIT_ENV]: '0.5' }).maxBytes).toBe(MB / 2)
    expect(resolveInprocGuard({ [LIMIT_ENV]: '0.001' }).maxBytes).toBe(Math.floor(0.001 * MB))
  })

  it.each(['', '0', '-5', 'abc', 'NaN', 'Infinity', '12MB', '1e999'])('ignores %j and keeps the default limit', (v) => {
    expect(resolveInprocGuard({ [LIMIT_ENV]: v }).maxBytes).toBe(DEFAULT_INPROC_MAX_BYTES)
  })

  it('reads process.env when given no argument', () => {
    const before = { g: process.env[GUARD_ENV], l: process.env[LIMIT_ENV] }
    try {
      process.env[GUARD_ENV] = 'off'
      process.env[LIMIT_ENV] = '300'
      expect(resolveInprocGuard()).toEqual({ enabled: false, maxBytes: 300 * MB })
    } finally {
      if (before.g === undefined) delete process.env[GUARD_ENV]; else process.env[GUARD_ENV] = before.g
      if (before.l === undefined) delete process.env[LIMIT_ENV]; else process.env[LIMIT_ENV] = before.l
    }
  })
})

describe('the backoff: capped, exponential, and never stalled by a bad input', () => {
  it('10 s, 20 s, 40 s, 80 s, 160 s, then 300 s for ever', () => {
    expect(RETRY_BASE_MS).toBe(10_000)
    expect(RETRY_CAP_MS).toBe(300_000)
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(retryDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000])
  })

  it('treats nonsense as the first attempt, and never overflows', () => {
    for (const bad of [0, -3, Number.NaN, Number.NEGATIVE_INFINITY]) expect(retryDelayMs(bad)).toBe(10_000)
    expect(retryDelayMs(1.9)).toBe(10_000)            // floored
    expect(retryDelayMs(Number.POSITIVE_INFINITY)).toBe(300_000)
    expect(retryDelayMs(5000)).toBe(300_000)          // 2 ** 4999 is Infinity: min() still caps it
  })

  it('a retry is allowed longer to become ready each time, up to 5x the first start', () => {
    const base = 120_000
    expect(retryReadyTimeoutMs(base, 0)).toBe(120_000)
    expect([1, 2, 3, 4, 5, 9].map((n) => retryReadyTimeoutMs(base, n))).toEqual([240_000, 360_000, 480_000, 600_000, 600_000, 600_000])
    expect(retryReadyTimeoutMs(base, Number.NaN)).toBe(120_000)
    expect(retryReadyTimeoutMs(base, -4)).toBe(120_000)
  })
})

describe('the fixed text an agent sees', () => {
  it('begins with the prefix the MCP layer lets through, and says what an agent needs to hear', () => {
    const m = unavailableMessage()
    expect(m.startsWith(UNAVAILABLE_PREFIX)).toBe(true)
    expect(UNAVAILABLE_PREFIX).toBe('Memory is unavailable (')
    expect(isMemoryUnavailableMessage(m)).toBe(true)
    expect(m).toMatch(/nothing was read/i)
    expect(m).toMatch(/nothing was saved/i)
    expect(m).toMatch(/try again/i)
  })

  it('is the same every time, and carries nothing internal (no path, no pid, no number)', () => {
    expect(unavailableMessage()).toBe(unavailableMessage())
    expect(unavailableMessage()).not.toMatch(/[A-Za-z]:\\|\/Users\/|\.jsonl|pid|\d/)
  })

  it('is recognised only by its own prefix', () => {
    expect(isMemoryUnavailableMessage('Memory is locked (key-unreadable): ...')).toBe(false)
    expect(isMemoryUnavailableMessage('memory is unavailable (')).toBe(false)
    expect(isMemoryUnavailableMessage('Memory is unavailable')).toBe(false)
    expect(isMemoryUnavailableMessage(undefined)).toBe(false)
    expect(isMemoryUnavailableMessage(42)).toBe(false)
  })
})

describe('measureMemoryStoreBytes — exactly the files the store loads', () => {
  // MEM-F5: the store also loads its ANN index (memory-hnsw.json, in userData whatever the sync mode) at init, and that
  // load is on main too when the store falls back in process. It counts toward the limit.
  it('MEM-F5: counts memory-hnsw.json from userData, in local and in sync mode; none there counts nothing', async () => {
    fs.writeFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'x'.repeat(1_000))
    expect(await measureMemoryStoreBytes(tmp, null)).toBe(1_000)
    fs.writeFileSync(path.join(tmp, 'memory-hnsw.json'), 'x'.repeat(600))
    expect(await measureMemoryStoreBytes(tmp, null)).toBe(1_600)
    const sync = path.join(tmp, 'share-hnsw')
    fs.mkdirSync(sync)
    fs.writeFileSync(path.join(sync, 'peer.jsonl'), 'x'.repeat(2_000))
    expect(await measureMemoryStoreBytes(tmp, sync)).toBe(2_600)
  })

  it("MEM-F5: the file it counts is the one swarmMemory loads (same name)", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'swarmMemory.ts'), 'utf8')
    expect(src).toContain("const HNSW_FILE = 'memory-hnsw.json'")
  })

  it('matches a real store, rotated by the real swarmMemory, and ignores everything else in the folder', async () => {
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp, {})
    _setMaxShardBytesForTests(600) // a few entries per shard: forces swarm-memory.<n>.jsonl
    for (let i = 0; i < 14; i++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `a fact worth rotating a shard for, number ${i}` })

    const real = fs.readdirSync(tmp).filter((f) => /^swarm-memory(\.\d+)?\.jsonl$/.test(f))
    expect(real.length).toBeGreaterThan(1)                         // the active shard AND rotated generations
    expect(real.some((f) => /^swarm-memory\.\d+\.jsonl$/.test(f))).toBe(true)
    const expected = real.reduce((n, f) => n + fs.statSync(path.join(tmp, f)).size, 0)
    expect(expected).toBeGreaterThan(600)

    // Decoys the store does not load at init, or that are not the store at all.
    fs.writeFileSync(path.join(tmp, 'swarm-memory.archive.jsonl'), 'x'.repeat(50_000)) // the cold archive
    fs.writeFileSync(path.join(tmp, 'agent-events.jsonl'), 'x'.repeat(50_000))          // someone else's log
    fs.writeFileSync(path.join(tmp, 'swarm-memory.1.jsonl.bak'), 'x'.repeat(50_000))    // a leftover
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x'.repeat(50_000))

    expect(await measureMemoryStoreBytes(tmp, null)).toBe(expected)
  })

  it('the fixture e2e/memory-host-unavailable.spec.ts seeds (a shard of blank lines) is measured, and loads as an empty store', async () => {
    // That spec cannot run here, so its one assumption is pinned here: a 4 KB shard of blank lines is
    // 4,000 bytes to the probe, and the real store reads it as having no memories rather than failing.
    fs.writeFileSync(path.join(tmp, 'swarm-memory.jsonl'), '\n'.repeat(4_000))
    expect(await measureMemoryStoreBytes(tmp, null)).toBe(4_000)
    _resetForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp, {})
    expect(await memoryCount()).toBe(0)
  })

  it('in sync mode counts every shard in the sync folder, own and peers\', and nothing else', async () => {
    const sync = path.join(tmp, 'shared')
    fs.mkdirSync(sync)
    fs.writeFileSync(path.join(sync, 'device-a.jsonl'), 'x'.repeat(1_000))
    fs.writeFileSync(path.join(sync, 'device-b.jsonl'), 'x'.repeat(2_000))
    fs.writeFileSync(path.join(sync, 'device-b.1.jsonl'), 'x'.repeat(4_000))
    fs.writeFileSync(path.join(sync, 'memory-sync.json'), 'x'.repeat(9_000))
    fs.writeFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'x'.repeat(8_000))   // the local store: not read in sync mode
    expect(await measureMemoryStoreBytes(tmp, sync)).toBe(7_000)
  })

  it('an empty or storeless folder is 0 bytes (small: the old behaviour applies), not "unknown"', async () => {
    expect(await measureMemoryStoreBytes(tmp, null)).toBe(0)
    const sync = path.join(tmp, 'empty-share')
    fs.mkdirSync(sync)
    expect(await measureMemoryStoreBytes(tmp, sync)).toBe(0)
  })

  it('a folder that cannot be listed is null ("cannot tell": the guard fails open)', async () => {
    expect(await measureMemoryStoreBytes(path.join(tmp, 'does-not-exist'), null)).toBeNull()
    expect(await measureMemoryStoreBytes(tmp, path.join(tmp, 'no-such-share'))).toBeNull()
    const aFile = path.join(tmp, 'plain-file')
    fs.writeFileSync(aFile, 'x')
    expect(await measureMemoryStoreBytes(aFile, null)).toBeNull()   // readdir of a file
  })

  it('a shard that vanishes between the listing and the stat (a compaction swap) counts as nothing, not as a failure', async () => {
    fs.writeFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'x'.repeat(3_000))
    fs.writeFileSync(path.join(tmp, 'swarm-memory.2.jsonl'), 'x'.repeat(5_000))
    // readdir lists swarm-memory.2.jsonl; by the time we stat it, it is gone.
    const realStat = fs.promises.stat.bind(fs.promises)
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('swarm-memory.2.jsonl')) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      return (realStat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest)
    }) as typeof fs.promises.stat)
    expect(await measureMemoryStoreBytes(tmp, null)).toBe(3_000)
  })
})

describe('memoryUnavailableInfo — what the Settings panel reads', () => {
  const state = (over: Partial<MemoryUnavailableState> = {}): MemoryUnavailableState => ({
    attempt: 3,
    nextRetryAt: 1_000_000 + 40_000,
    retrying: false,
    storeBytes: 475 * MB,
    limitBytes: 256 * MB,
    reason: 'memory host exited during startup (code 9)',
    since: 900_000,
    ...over,
  })

  it('is empty when the memory is not unavailable (so the IPC payload is exactly what it was)', () => {
    expect(memoryUnavailableInfo()).toEqual({})
    setMemoryUnavailableState(state())
    setMemoryUnavailableState(null)
    expect(memoryUnavailableInfo()).toEqual({})
  })

  it('isMemoryUnavailable() follows the record: true while it is set, false once it is cleared', () => {
    expect(isMemoryUnavailable()).toBe(false)
    setMemoryUnavailableState(state())
    expect(isMemoryUnavailable()).toBe(true)
    setMemoryUnavailableState(null)
    expect(isMemoryUnavailable()).toBe(false)
  })

  it('reports the attempt, the countdown, the sizes in whole MB and the cause', () => {
    setMemoryUnavailableState(state())
    expect(memoryUnavailableInfo(1_000_000)).toEqual({
      attempt: 3, retrying: false, retryInMs: 40_000, storeMB: 475, limitMB: 256,
      reason: 'memory host exited during startup (code 9)',
    })
  })

  it('counts down from a clock it is given, and never goes negative', () => {
    setMemoryUnavailableState(state())
    expect(memoryUnavailableInfo(1_030_000).retryInMs).toBe(10_000)
    expect(memoryUnavailableInfo(2_000_000).retryInMs).toBe(0)
  })

  it('while a retry is running there is no countdown, and the store size may be unknown', () => {
    setMemoryUnavailableState(state({ retrying: true, nextRetryAt: null, storeBytes: null }))
    expect(memoryUnavailableInfo(1_000_000)).toEqual({
      attempt: 3, retrying: true, retryInMs: null, storeMB: null, limitMB: 256,
      reason: 'memory host exited during startup (code 9)',
    })
  })

  it('shortens a long cause to a sentence the panel can show', () => {
    setMemoryUnavailableState(state({ reason: 'x'.repeat(5_000) }))
    const r = memoryUnavailableInfo(1_000_000).reason as string
    expect(r.length).toBeLessThanOrEqual(240)
    expect(r.startsWith('xxx')).toBe(true)
  })

  it('does not hand out the live record: mutating the answer cannot change the next one', () => {
    setMemoryUnavailableState(state())
    const first = memoryUnavailableInfo(1_000_000) as { attempt: number }
    first.attempt = 99
    expect(memoryUnavailableInfo(1_000_000).attempt).toBe(3)
  })
})
