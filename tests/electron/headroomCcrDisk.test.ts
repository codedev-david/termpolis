import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
const { ccrStash, ccrPut, ccrRetrieve, ccrRetrieveRecord, ccrStats, resetCcr, setCcrDir, _setCcrLimits, CCR_MAX_ENTRIES, CCR_MAX_BYTES, CCR_MAX_ENTRY_BYTES } =
  await import('../../src/main/headroom/ccrStore')

/**
 * The durable tier (v1.34.0). Before this, the store was memory-only and 192 entries deep, so a
 * busy session evicted its own stashes within minutes: 2,425 recorded retrieve_full calls against
 * a store that could not have held them, each miss forcing the agent to re-run the original tool
 * and pay full token cost a second time. Aggressive elision is only honest if the escape hatch
 * actually works.
 */
describe('ccr store — durable disk tier', () => {
  let dir: string

  beforeEach(() => {
    resetCcr()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'))
    setCcrDir(dir)
  })
  afterEach(() => {
    resetCcr()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('resolves a token whose memory entry was evicted', () => {
    const token = ccrStash({ big: 'x'.repeat(500) })
    for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrStash(`fill-${i}`)
    expect(ccrStats().memEntries).toBeLessThanOrEqual(CCR_MAX_ENTRIES)
    expect(ccrRetrieve(token)).toEqual({ big: 'x'.repeat(500) }) // came back off disk
  })

  it('survives a full restart — a token issued before the restart still resolves', () => {
    const token = ccrStash({ note: 'issued before restart' })
    resetCcr()                 // simulate process exit: every in-memory tier is gone
    expect(ccrRetrieve(token)).toBeUndefined() // and with no dir set, nothing resolves
    setCcrDir(dir)             // ...startup re-adopts the directory
    expect(ccrRetrieve(token)).toEqual({ note: 'issued before restart' })
  })

  it('remembers which layer issued a token across the restart', () => {
    // The origin is what routes a give-back to the right ledger. Losing it on restart would
    // re-introduce the mis-attribution that made the receipt read -4.6M.
    ccrPut('hr_fromproxy', { v: 1 }, 'proxy')
    const mcpToken = ccrStash({ v: 2 }, 'mcp')
    resetCcr(); setCcrDir(dir)
    expect(ccrRetrieveRecord('hr_fromproxy')?.origin).toBe('proxy')
    expect(ccrRetrieveRecord(mcpToken)?.origin).toBe('mcp')
  })

  it('issues the SAME token for the same content — cache-safe and restart-stable', () => {
    // Counter tokens (hr_1, hr_2, ...) were a correctness bug the moment entries outlived the
    // process: a restart resets the counter and hr_1 resolves to some unrelated older result.
    const a = ccrStash({ same: 'content' })
    const b = ccrStash({ same: 'content' })
    expect(a).toBe(b)
    expect(a).toMatch(/^hr_[0-9a-f]{16}$/)
  })

  it('refuses a token that would escape the ccr directory', () => {
    const outside = path.join(dir, '..', 'escaped.json')
    fs.writeFileSync(outside, JSON.stringify({ value: 'pwned', origin: 'mcp' }), 'utf8')
    try {
      expect(ccrRetrieve('hr_../escaped')).toBeUndefined()
      expect(ccrRetrieve('../escaped')).toBeUndefined()
    } finally {
      try { fs.unlinkSync(outside) } catch { /* best effort */ }
    }
  })

  it('degrades to memory-only when the directory is unusable, never throwing', () => {
    resetCcr()
    // A FILE where the directory should be: mkdirSync fails, so dir is left null.
    const asFile = path.join(dir, 'not-a-dir')
    fs.writeFileSync(asFile, 'x', 'utf8')
    expect(() => setCcrDir(asFile)).not.toThrow()
    expect(ccrStats().dir).toBeNull()
    const token = ccrStash({ still: 'works' })
    expect(ccrRetrieve(token)).toEqual({ still: 'works' }) // memory tier carries it
    expect(ccrStats().diskEntries).toBe(0)
  })

  it('setCcrDir(null) detaches the durable tier without throwing', () => {
    ccrStash({ a: 1 })
    setCcrDir(null)
    expect(ccrStats().dir).toBeNull()
    expect(ccrStats().diskEntries).toBe(0)
  })

  it('keeps a non-serializable value in memory only, with a unique handle', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    const t1 = ccrStash(circular)
    const t2 = ccrStash(circular)
    expect(t1).not.toBe(t2) // no content hash is possible → fall back to a unique counter
    expect(ccrRetrieve(t1)).toBe(circular)
    expect(ccrStats().diskEntries).toBe(0) // JSON.stringify would throw → never written
  })

  it('adopts files already on disk, oldest first, and reports them in stats', () => {
    ccrStash({ one: 1 })
    ccrStash({ two: 2 })
    const before = ccrStats().diskEntries
    expect(before).toBe(2)
    resetCcr(); setCcrDir(dir)
    expect(ccrStats().diskEntries).toBe(2)
    expect(ccrStats().diskBytes).toBeGreaterThan(0)
  })

  it('ignores foreign files in the ccr directory', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8')
    fs.writeFileSync(path.join(dir, 'bogus.json'), '{}', 'utf8') // no hr_ prefix
    resetCcr(); setCcrDir(dir)
    expect(ccrStats().diskEntries).toBe(0)
  })

  it('returns undefined when the on-disk file is corrupt rather than throwing', () => {
    const token = ccrStash({ ok: true })
    fs.writeFileSync(path.join(dir, `${token}.json`), '{ not json', 'utf8')
    resetCcr(); setCcrDir(dir) // memory tier cleared, so this must come off disk
    expect(ccrRetrieve(token)).toBeUndefined()
  })
})

describe('ccr store — byte cap', () => {
  let dir: string

  beforeEach(() => {
    resetCcr()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-cap-'))
    setCcrDir(dir)
  })
  afterEach(() => {
    resetCcr()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('ships with caps sized for a real working history, not a toy', () => {
    expect(CCR_MAX_BYTES).toBe(200 * 1024 * 1024)
    // 64 MB, not 8: an entry over the cap is memory-only, and memory-only is the ONLY state in
    // which this store can lose content. The cap must sit above anything we realistically elide.
    expect(CCR_MAX_ENTRY_BYTES).toBe(64 * 1024 * 1024)
    expect(CCR_MAX_ENTRIES).toBe(512)
  })

  it('evicts OLDEST-first once the directory exceeds the byte cap, and deletes the files', () => {
    _setCcrLimits(4000, 8 * 1024 * 1024) // ~3 entries' worth
    const tokens = Array.from({ length: 8 }, (_, i) => ccrStash({ i, pad: `${i}`.repeat(1200) }))
    const stats = ccrStats()
    expect(stats.diskBytes).toBeLessThanOrEqual(4000)
    expect(stats.diskEntries).toBeLessThan(8)
    // Oldest gone from disk, newest still there. (Memory still holds all 8 — the cap is a DISK cap.)
    expect(fs.existsSync(path.join(dir, `${tokens[0]}.json`))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${tokens[7]}.json`))).toBe(true)
    resetCcr(); setCcrDir(dir)
    expect(ccrRetrieve(tokens[0])).toBeUndefined()   // evicted → the agent re-runs the tool
    expect(ccrRetrieve(tokens[7])).toBeDefined()     // recent work is what actually gets redeemed
  })

  it('re-evicts on adoption, so a directory over the cap is trimmed at startup too', () => {
    for (let i = 0; i < 8; i++) ccrStash({ i, pad: `${i}`.repeat(1200) })
    expect(ccrStats().diskEntries).toBe(8) // written under the full-size cap
    resetCcr(); setCcrDir(dir)
    _setCcrLimits(4000, 8 * 1024 * 1024)
    expect(ccrStats().diskBytes).toBeLessThanOrEqual(4000)
    expect(fs.readdirSync(dir).length).toBe(ccrStats().diskEntries)
  })

  it('keeps an oversized entry in MEMORY only rather than stalling the hot path on it', () => {
    _setCcrLimits(CCR_MAX_BYTES, 1000)
    const token = ccrStash({ huge: 'z'.repeat(5000) })
    expect(ccrStats().diskEntries).toBe(0)
    expect(ccrRetrieve(token)).toEqual({ huge: 'z'.repeat(5000) }) // memory tier still serves it
    expect(fs.existsSync(path.join(dir, `${token}.json`))).toBe(false)
  })

  it('does not double-count bytes when the same content is stashed twice', () => {
    const a = ccrStash({ same: 'x'.repeat(2000) })
    const after1 = ccrStats().diskBytes
    const b = ccrStash({ same: 'x'.repeat(2000) })
    expect(b).toBe(a)
    expect(ccrStats().diskBytes).toBe(after1)
    expect(ccrStats().diskEntries).toBe(1)
  })

  it('performs NO second write when the same hash token is already on disk', () => {
    // v1.36.0 — every API request re-stashed originals that were already there: 65 synchronous
    // writeFileSync calls and ~101 KB per request on the Electron MAIN thread, growing with the
    // conversation. A sentinel in the file is the only honest proof that no write happened.
    const token = ccrStash({ same: 'x'.repeat(2000) })
    const f = path.join(dir, `${token}.json`)
    fs.writeFileSync(f, 'SENTINEL', 'utf8')
    const before = ccrStats()
    expect(ccrStash({ same: 'x'.repeat(2000) })).toBe(token)
    expect(fs.readFileSync(f, 'utf8')).toBe('SENTINEL')
    expect(ccrStats().diskBytes).toBe(before.diskBytes)   // accounting untouched by the skip
    expect(ccrStats().diskEntries).toBe(before.diskEntries)
  })

  it('still re-writes a caller-supplied token that is not a content hash', () => {
    // Only a sha1 token guarantees the file already holds these exact bytes. The proxy may hand
    // us any token shape, so the skip must never apply to one — it would pin stale content.
    ccrPut('hr_manual', { v: 1 }, 'proxy')
    const after1 = ccrStats().diskBytes
    ccrPut('hr_manual', { v: 2, pad: 'p'.repeat(200) }, 'proxy')
    expect(ccrStats().diskEntries).toBe(1)
    expect(ccrStats().diskBytes).toBeGreaterThan(after1) // re-indexed, old bytes subtracted once
    resetCcr(); setCcrDir(dir)                           // force the read to come off disk
    expect(ccrRetrieve('hr_manual')).toEqual({ v: 2, pad: 'p'.repeat(200) })
  })

  it('keeps the index and the directory in step when a repeat stash is skipped', () => {
    _setCcrLimits(4000, 8 * 1024 * 1024)
    const first = ccrStash({ i: 0, pad: '0'.repeat(1200) })
    ccrStash({ i: 0, pad: '0'.repeat(1200) }) // skipped — must not inflate diskBytes or re-seq
    for (let i = 1; i < 8; i++) ccrStash({ i, pad: `${i}`.repeat(1200) })
    expect(ccrStats().diskBytes).toBeLessThanOrEqual(4000)
    expect(fs.readdirSync(dir).length).toBe(ccrStats().diskEntries)
    expect(fs.existsSync(path.join(dir, `${first}.json`))).toBe(false) // still evicted oldest-first
  })

  it('counts a memory hit, a disk hit, and a miss separately', () => {
    const t = ccrStash({ v: 'hot' })
    ccrRetrieve(t)
    expect(ccrStats().memHits).toBe(1)
    expect(ccrStats().misses).toBe(0)
  })

  it('records a miss when a token redeems nothing', () => {
    // The number that can falsify the whole scheme. An elision the store cannot reverse is
    // content destroyed, and without this counter it would be destroyed silently.
    ccrRetrieve('hr_0123456789abcdef')
    expect(ccrStats().misses).toBe(1)
    expect(ccrStats().memHits + ccrStats().diskHits).toBe(0)
  })

  it('does NOT count a token shape it never mints as a miss', () => {
    ccrRetrieve('hr_NotAShapeWeMint')
    expect(ccrStats().badTokens).toBe(1)
    expect(ccrStats().misses).toBe(0)
  })

  it('still resolves a caller-supplied token of an odd shape', () => {
    ccrPut('hr_legacyCallerToken', { v: 1 })
    expect(ccrRetrieve('hr_legacyCallerToken')).toEqual({ v: 1 })
    expect(ccrStats().badTokens).toBe(0)
  })

  it('pins an entry the disk refused, so the LRU cannot drop the only copy', () => {
    _setCcrLimits(CCR_MAX_BYTES, 8) // 8-byte entry cap: everything is now memory-only
    const t = ccrStash({ v: 'too big for the disk cap' })
    expect(ccrStats().memoryOnlyEntries).toBe(1)
    expect(ccrStats().diskEntries).toBe(0)
    _setCcrLimits(CCR_MAX_BYTES, CCR_MAX_ENTRY_BYTES) // everything after this IS durable
    for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrPut(`hr_${i.toString(16).padStart(16, '0')}`, i)
    expect(ccrRetrieve(t)).toEqual({ v: 'too big for the disk cap' })
    expect(ccrStats().unbackedEvictions).toBe(0)
  })
})
