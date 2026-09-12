import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
const { ccrStash, ccrPut, ccrRetrieve, ccrRetrieveRecord, ccrNoteMiss, ccrStats, resetCcr, setCcrDir, _setCcrLimits, CCR_MAX_ENTRIES, CCR_MAX_BYTES, CCR_MAX_ENTRY_BYTES } =
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
    // Entry files only: the store also keeps a _forgotten.json sidecar beside them.
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('hr_')).length).toBe(ccrStats().diskEntries)
    // The trim destroyed content that existed nowhere else, and the store records exactly that —
    // so redeeming one of these tokens later is a real miss, not an unrecognised handle.
    expect(ccrStats().forgottenEntries).toBeGreaterThan(0)
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

  it('books a miss ONLY for a token it held and then destroyed', () => {
    // The number that can falsify the whole scheme — but it only means that if it rests on
    // evidence. Tokens are content hashes, so "looks like one of ours" is a property that a
    // one-character typo of a real token has too. Shape cannot tell a broken promise apart from
    // a handle we never issued, and reading it as proof is what fired the "should never happen"
    // banner over four calls that had destroyed nothing.
    _setCcrLimits(CCR_MAX_BYTES, 8) // 8-byte entry cap: nothing reaches the durable tier
    const doomed = ccrStash({ v: 'the only copy' })
    for (let i = 0; i <= CCR_MAX_ENTRIES; i++) ccrStash({ filler: i })
    expect(ccrRetrieve(doomed)).toBeUndefined()
    expect(ccrNoteMiss(doomed)).toBe('forgotten')
    expect(ccrStats().misses).toBe(1)
    expect(ccrStats().unbackedEvictions).toBeGreaterThan(0)
  })

  it('does NOT book a miss for a well-shaped token it never held', () => {
    expect(ccrNoteMiss('hr_0123456789abcdef')).toBe('unknown')
    expect(ccrStats().misses).toBe(0)
    expect(ccrStats().unknownTokens).toBe(1)
  })

  it('remembers what it destroyed across a restart', () => {
    // A forgotten token that stops being forgotten at the next launch would let the one honest
    // alarm this store can raise evaporate on restart.
    _setCcrLimits(CCR_MAX_BYTES, 8)
    const doomed = ccrStash({ v: 'the only copy' })
    for (let i = 0; i <= CCR_MAX_ENTRIES; i++) ccrStash({ filler: i })
    expect(ccrNoteMiss(doomed)).toBe('forgotten')
    setCcrDir(dir) // relaunch against the same directory
    expect(ccrNoteMiss(doomed)).toBe('forgotten')
  })

  it('heals an indexed file it cannot read back, and counts the loss', () => {
    const t = ccrStash({ v: 'truncated by a hard kill' })
    for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrPut(`hr_${i.toString(16).padStart(16, '0')}`, i)
    fs.writeFileSync(path.join(dir, `${t}.json`), '{ truncated', 'utf8')
    expect(ccrRetrieve(t)).toBeUndefined()
    expect(ccrNoteMiss(t)).toBe('forgotten')
    // Left indexed, diskPut's hash short-circuit would never rewrite it and the damage would be
    // permanent. Dropping the index entry lets an identical original heal the file.
    ccrPut(t, { v: 'truncated by a hard kill' })
    expect(ccrRetrieve(t)).toEqual({ v: 'truncated by a hard kill' })
  })

  it('does NOT count a token shape it never mints as a miss', () => {
    expect(ccrNoteMiss('hr_NotAShapeWeMint')).toBe('badShape')
    expect(ccrStats().badTokens).toBe(1)
    expect(ccrStats().misses).toBe(0)
  })

  it('still resolves a caller-supplied token of an odd shape', () => {
    ccrPut('hr_legacyCallerToken', { v: 1 })
    expect(ccrRetrieve('hr_legacyCallerToken')).toEqual({ v: 1 })
    expect(ccrStats().badTokens).toBe(0)
  })

  it('ignores a forgotten-set file it cannot make sense of, rather than failing the launch', () => {
    // The sidecar sits in a directory users can open. A hand-edited or half-written file must cost
    // at most the memory of what was destroyed — never the ability to start the durable tier.
    _setCcrLimits(CCR_MAX_BYTES, 8) // 8-byte entry cap: nothing reaches disk, so the LRU destroys
    const doomed = ccrStash({ v: 'the only copy' })
    for (let i = 0; i <= CCR_MAX_ENTRIES; i++) ccrStash({ filler: i })
    expect(ccrNoteMiss(doomed)).toBe('forgotten')
    fs.writeFileSync(path.join(dir, '_forgotten.json'), '{ not an array', 'utf8')
    setCcrDir(dir)
    expect(ccrStats().forgottenEntries).toBe(0)
    expect(ccrStats().dir).toBe(dir) // the tier still came up
    fs.writeFileSync(path.join(dir, '_forgotten.json'), JSON.stringify(['hr_aaaaaaaaaaaaaaaa']), 'utf8')
    setCcrDir(dir)
    expect(ccrStats().forgottenEntries).toBe(0) // an array is the pre-cause shape: no causes in it
    const map = { hr_aaaaaaaaaaaaaaaa: 'evicted', hr_bbbbbbbbbbbbbbbb: 'expired', hr_cccccccccccccccc: 'gibberish' }
    fs.writeFileSync(path.join(dir, '_forgotten.json'), JSON.stringify(map), 'utf8')
    setCcrDir(dir)
    expect(ccrStats().forgottenEntries).toBe(3)
    expect(ccrNoteMiss('hr_aaaaaaaaaaaaaaaa')).toBe('forgotten')
    expect(ccrNoteMiss('hr_bbbbbbbbbbbbbbbb')).toBe('expired')
    // A cause this build does not understand reads as the MILDER one. Guessing "defect" from a
    // file we cannot parse would raise exactly the unfounded alarm this whole change exists to end.
    expect(ccrNoteMiss('hr_cccccccccccccccc')).toBe('expired')
  })

  it('caps the forgotten set, so a pathological session cannot grow the sidecar without limit', () => {
    // Memory-only (no dir): every stash is unbacked, so the LRU destroys one per insert once full.
    setCcrDir(null)
    const first = ccrStash({ first: true })
    for (let i = 0; i < 5200; i++) ccrStash({ filler: i })
    expect(ccrStats().forgottenEntries).toBeLessThanOrEqual(4096)
    expect(ccrStats().forgottenEntries).toBeGreaterThan(4000)
    // Oldest drop out first, so the earliest casualty is the one that stops being remembered.
    expect(ccrNoteMiss(first)).toBe('unknown')
  })

  it('keeps only the most recent failures, with the token that failed', () => {
    for (let i = 0; i < 25; i++) ccrNoteMiss(`hr_${i.toString(16).padStart(16, '0')}`)
    const recent = ccrStats().recentFailures
    expect(recent.length).toBe(20)
    expect(recent[0].token).toBe('hr_' + (5).toString(16).padStart(16, '0')) // 0-4 aged out
    expect(recent[19].token).toBe('hr_' + (24).toString(16).padStart(16, '0'))
    expect(recent.every((r) => r.kind === 'unknown')).toBe(true)
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

  it('files a disk-cap trim as expiry, not as a defect anyone should report', () => {
    // Measured on the reporting install: 85.5 MB of the 200 MB cap and climbing. Once it fills,
    // every ordinary trim would have raised "Report this; it should never happen" — the same false
    // alarm that started all this, arriving through a different door.
    const doomed = ccrStash({ v: 'x'.repeat(400) }) // oldest and fattest: first out, and enough
    for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrPut(`hr_${i.toString(16).padStart(16, '0')}`, i)
    // Checked on disk, not through ccrRetrieve: a retrieve would pull it back into memory and the
    // memory copy would then answer after the trim, hiding the very loss this test is about.
    expect(fs.existsSync(path.join(dir, `${doomed}.json`))).toBe(true)

    // A cap just under what is already stored, so the next write trims the oldest entry and stops.
    // A cap of zero would sweep the whole tier and pin every resident record, which measures the
    // LRU's reaction to an absurd setting rather than what a full cache does.
    _setCcrLimits(ccrStats().diskBytes - 1, CCR_MAX_ENTRY_BYTES)
    ccrPut('hr_' + 'ff'.repeat(8), 1)

    expect(ccrRetrieve(doomed)).toBeUndefined() // really gone — the cap is not a soft limit
    expect(ccrNoteMiss(doomed)).toBe('expired')
    expect(ccrStats().expiredTokens).toBe(1)
    expect(ccrStats().misses).toBe(0)            // ...and the alarm stayed silent
    expect(ccrStats().unbackedEvictions).toBe(0)
  })

  it('never downgrades a recorded defect to expiry when the cap later sweeps the same token', () => {
    // Tokens are content hashes, so a handle the store destroyed once can be minted again by the
    // same original and then destroyed a second way. The louder verdict has to win, or a routine
    // cap sweep quietly launders a defect the store already caught itself committing.
    _setCcrLimits(CCR_MAX_BYTES, 8) // 8-byte entry cap: nothing is durable, so the LRU destroys
    const doomed = ccrStash({ v: 'x'.repeat(400) })
    for (let i = 0; i <= CCR_MAX_ENTRIES; i++) ccrStash({ filler: i })
    expect(ccrStats().unbackedEvictions).toBeGreaterThan(0)
    expect(ccrNoteMiss(doomed)).toBe('forgotten')

    _setCcrLimits(CCR_MAX_BYTES, CCR_MAX_ENTRY_BYTES) // durable again
    ccrPut(doomed, { v: 'x'.repeat(400) })            // same content, same token, back on disk
    for (let i = 0; i < CCR_MAX_ENTRIES + 5; i++) ccrPut(`hr_a${i.toString(16).padStart(15, '0')}`, i)
    _setCcrLimits(ccrStats().diskBytes - 1, CCR_MAX_ENTRY_BYTES)
    ccrPut('hr_' + 'ee'.repeat(8), 1)

    expect(ccrRetrieve(doomed)).toBeUndefined()
    expect(ccrNoteMiss(doomed)).toBe('forgotten') // still the alarm, not 'expired'
    expect(ccrStats().expiredTokens).toBe(0)
  })
})
