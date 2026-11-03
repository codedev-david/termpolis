import { describe, it, expect, beforeEach } from 'vitest'
import { PASS_LIMITS, recordPass, resetPasses, snapshotPasses } from '../../src/main/passCounters'

// passCounters is the in-memory ring that the background passes (reflect-session today) write one
// line of COUNTERS into, so a support bundle can say how many reads, parses and joins a pass cost
// without anyone attaching a profiler. It is read by the diagnostics record at merge time, never
// by anything that reacts to it (a sampler wired into the loop it measures is a feedback loop).

beforeEach(() => {
  resetPasses()
})

describe('recordPass / snapshotPasses', () => {
  it('keeps a per-kind total (count, sum, max) and the recent passes, oldest first', () => {
    recordPass('reflect', { opens: 1, bytes: 100, turns: 4 })
    recordPass('reflect', { opens: 0, bytes: 0, turns: 0 })
    recordPass('reflect', { opens: 1, bytes: 300, turns: 2 })
    recordPass('list', { stats: 12 })

    const s = snapshotPasses()
    expect(s.v).toBe(1)
    expect(s.records).toBe(4)
    expect(s.dropped).toBe(0)
    expect(s.kinds.reflect.n).toBe(3)
    expect(s.kinds.reflect.sum).toEqual({ opens: 2, bytes: 400, turns: 6 })
    expect(s.kinds.reflect.max).toEqual({ opens: 1, bytes: 300, turns: 4 })
    expect(s.kinds.list.n).toBe(1)
    expect(s.recent.map((r) => r.kind)).toEqual(['reflect', 'reflect', 'reflect', 'list'])
    expect(s.recent[0].f).toEqual({ opens: 1, bytes: 100, turns: 4 })
    expect(s.recent.every((r) => typeof r.at === 'number' && r.at > 0)).toBe(true)
  })

  it('starts empty and stays JSON-serialisable', () => {
    const s = snapshotPasses()
    expect(s).toMatchObject({ v: 1, records: 0, dropped: 0, kinds: {}, recent: [] })
    expect(JSON.parse(JSON.stringify(snapshotPasses()))).toEqual(s)
  })

  it('returns a copy: changing a snapshot never changes the ring', () => {
    recordPass('reflect', { opens: 1 })
    const s = snapshotPasses()
    s.recent[0].f.opens = 999
    s.kinds.reflect.sum.opens = 999
    s.recent.length = 0
    const again = snapshotPasses()
    expect(again.recent).toHaveLength(1)
    expect(again.recent[0].f.opens).toBe(1)
    expect(again.kinds.reflect.sum.opens).toBe(1)
  })

  it('never stores content: only finite numbers survive, under short names', () => {
    const secret = 's3cr3t-'.repeat(8)
    recordPass('reflect', {
      opens: 1,
      path: secret as unknown as number,
      text: { a: secret } as unknown as number,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ['k'.repeat(200)]: 5,
    })
    const json = JSON.stringify(snapshotPasses())
    expect(json).not.toContain('s3cr3t')
    const f = snapshotPasses().recent[0].f
    expect(Object.keys(f).sort()).toEqual(['k'.repeat(PASS_LIMITS.maxName), 'opens'].sort())
    expect(f.opens).toBe(1)
  })

  it('shortens a long kind and ignores a kind that is not a string', () => {
    recordPass('x'.repeat(500), { a: 1 })
    recordPass(undefined as unknown as string, { a: 1 })
    recordPass(42 as unknown as string, { a: 1 })
    const s = snapshotPasses()
    expect(Object.keys(s.kinds)).toEqual(['x'.repeat(PASS_LIMITS.maxName)])
    expect(s.records).toBe(1)
  })

  it('two names that clean to the same short name are ONE counter: the first value wins', () => {
    recordPass('reflect', { 'a b': 1, a_b: 2, ['x'.repeat(30)]: 3, ['x'.repeat(40)]: 4 })
    expect(snapshotPasses().recent[0].f).toEqual({ a_b: 1, ['x'.repeat(PASS_LIMITS.maxName)]: 3 })
  })

  it('caps the number of fields kept per pass', () => {
    const many: Record<string, number> = {}
    for (let i = 0; i < 100; i++) many[`f${i}`] = i
    recordPass('reflect', many)
    expect(Object.keys(snapshotPasses().recent[0].f)).toHaveLength(PASS_LIMITS.maxFields)
  })

  it('never throws, whatever it is handed', () => {
    const evil = {} as Record<string, number>
    Object.defineProperty(evil, 'boom', { enumerable: true, get() { throw new Error('getter') } })
    expect(() => recordPass('reflect', evil)).not.toThrow()
    expect(() => recordPass('reflect', null as unknown as Record<string, number>)).not.toThrow()
    expect(() => recordPass('reflect', 'str' as unknown as Record<string, number>)).not.toThrow()
    expect(() => recordPass('reflect', undefined as unknown as Record<string, number>)).not.toThrow()
    expect(() => snapshotPasses()).not.toThrow()
  })

  it('folds kinds past the cap into one "other" bucket instead of growing', () => {
    for (let i = 0; i < PASS_LIMITS.maxKinds + 10; i++) recordPass(`kind${i}`, { a: 1 })
    const s = snapshotPasses()
    expect(Object.keys(s.kinds).length).toBeLessThanOrEqual(PASS_LIMITS.maxKinds + 1)
    expect(s.kinds.other.n).toBe(10)
    expect(s.records).toBe(PASS_LIMITS.maxKinds + 10)
  })

  it('stops adding new field names to a kind past the cap, and keeps adding to the ones it has', () => {
    const first: Record<string, number> = {}
    for (let i = 0; i < PASS_LIMITS.maxFields; i++) first[`a${i}`] = 1
    recordPass('reflect', first)
    recordPass('reflect', { zzz: 5, a0: 2 })
    const k = snapshotPasses().kinds.reflect
    expect(k.sum.zzz).toBeUndefined()
    expect(k.sum.a0).toBe(3)
    expect(k.max.a0).toBe(2)
  })
})

describe('byte cap', () => {
  it('holds a bounded ring however many passes are recorded, and still counts every one', () => {
    const N = 100_000
    const naive: Array<{ kind: string; f: Record<string, number> }> = []
    for (let i = 0; i < N; i++) {
      recordPass('reflect', { opens: 1, bytes: i, turns: 3, listStats: 14, reads: 2, ms: 7 })
      naive.push({ kind: 'reflect', f: { opens: 1, bytes: i, turns: 3, listStats: 14, reads: 2, ms: 7 } })
    }
    const s = snapshotPasses()
    // control: an unbounded list of the very same passes keeps all of them; the ring does not
    expect(naive).toHaveLength(N)
    expect(s.recent.length).toBeLessThanOrEqual(PASS_LIMITS.maxRecords)
    expect(JSON.stringify(s.recent).length).toBeLessThanOrEqual(PASS_LIMITS.maxBytes)
    // ...but the totals saw every pass
    expect(s.records).toBe(N)
    expect(s.kinds.reflect.n).toBe(N)
    expect(s.kinds.reflect.sum.opens).toBe(N)
    expect(s.dropped).toBe(N - s.recent.length)
    // the ring holds the NEWEST passes
    expect(s.recent[s.recent.length - 1].f.bytes).toBe(N - 1)
  })

  it('evicts oldest-first when the byte budget, not the record count, is the limit', () => {
    // 11 wide fields + `seq` = the 12 fields a pass may carry; ~460 bytes a record, so the 16 KB
    // budget runs out (at ~35 records) long before the 64-record count does.
    const wide: Record<string, number> = {}
    for (let i = 0; i < PASS_LIMITS.maxFields - 1; i++) wide['n'.repeat(PASS_LIMITS.maxName - 3) + String(100 + i)] = 123456789
    const passes = 50
    expect(passes).toBeLessThan(PASS_LIMITS.maxRecords)
    for (let i = 0; i < passes; i++) recordPass('reflect', { ...wide, seq: i })
    const s = snapshotPasses()
    expect(JSON.stringify(s.recent).length).toBeLessThanOrEqual(PASS_LIMITS.maxBytes)
    expect(s.recent.length).toBeLessThan(passes)
    expect(s.dropped).toBe(passes - s.recent.length)
    const seqs = s.recent.map((r) => r.f.seq)
    // whatever survived is a contiguous newest run, in order
    expect(seqs[seqs.length - 1]).toBe(passes - 1)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1)
  })

  it('names are cut to a safe short form, so a name can never carry a path or a sentence', () => {
    recordPass('re flect/with:path', { 'C:\\Users\\someone\\file.txt': 1 })
    const s = snapshotPasses()
    const kind = Object.keys(s.kinds)[0]
    expect(kind).toMatch(/^[A-Za-z0-9_.:-]+$/)
    expect(Object.keys(s.recent[0].f)[0]).toMatch(/^[A-Za-z0-9_.:-]+$/)
  })
})

describe('resetPasses', () => {
  it('forgets everything', () => {
    recordPass('reflect', { a: 1 })
    resetPasses()
    expect(snapshotPasses()).toMatchObject({ records: 0, dropped: 0, kinds: {}, recent: [] })
  })
})
