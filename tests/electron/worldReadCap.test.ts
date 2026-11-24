// WP4a: how a first map reads a big project. Reads run a bounded number at a time, each file is read once, a listing
// of more than MAP_FILE_CAP files has every file shown but only MAP_FILE_CAP read (source first, folders taking
// turns), and progress only rises, moving while the compile waits on test results.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../src/main/codeGraph'
import { MAP_FILE_CAP } from '../../src/main/repoFileList'
import { MAX_DETECT_FILE_CHARS } from '../../src/main/world/detectors'
import { compileWorldStaged, readBeat, scanFile, SEARCH_TIME_MS, SLOW_STAGE_MS, STATUS_BEAT_MS, type CompileDeps, type CompileStage } from '../../src/main/world/compile'
import { RUNS_GRACE_MS, RUNS_WAIT_MS, testClaims, type TestRun } from '../../src/main/world/testStatus'
import { snapshotFromFiles } from '../../src/main/world/fileSnapshot'
import { cappedReads, eachLimit, READ_CONCURRENCY, readOrder, readTier } from '../../src/main/world/readCap'

// testClaims as it is, unless a test makes one call slow (the status pass's time in the slow-stage log, N3).
vi.mock('../../src/main/world/testStatus', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/world/testStatus')>()
  return { ...real, testClaims: vi.fn(real.testClaims) }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ROOT = '/repo'
const HEAD = { head: 'h1', dirty: false }

/** A read that tracks how many reads are open at once, and how often each path was read. */
function tracker(text: (rel: string) => string | null = () => 'export const x = 1\n') {
  const counts = new Map<string, number>()
  let open = 0
  let peak = 0
  const read = async (p: string): Promise<string | null> => {
    const rel = p.replace(/^\/repo\//, '')
    counts.set(rel, (counts.get(rel) ?? 0) + 1)
    open++
    peak = Math.max(peak, open)
    await new Promise((r) => setTimeout(r, 0))
    open--
    return text(rel)
  }
  return { read, counts, peak: () => peak }
}

describe('readCap', () => {
  it('readTier: source first, then tests, then type declarations', () => {
    expect(['src/a.ts', 'src/a.test.ts', 'pkg/x_test.go', 'tests/helper.ts', 'py/test_mod.py', 'App/FooTests.cs', 'src/a.d.ts', 'src/a.d.mts'].map(readTier)).toEqual([0, 1, 1, 1, 1, 1, 2, 2])
    expect(readTier('test_mod.py')).toBe(1)
    expect(readTier('contest.ts')).toBe(0)
  })

  it('readOrder: by tier, then each folder takes a turn, so a cut anywhere leaves every folder some files', () => {
    const files = ['b/2.ts', 'b/1.ts', 'a/1.ts', 'a/2.ts', 'a/3.ts', 'top.ts', 'a/1.test.ts', 'a/x.d.ts', 'b/1.ts']
    expect(readOrder(files)).toEqual(['top.ts', 'a/1.ts', 'b/1.ts', 'a/2.ts', 'b/2.ts', 'a/3.ts', 'a/1.test.ts', 'a/x.d.ts'])
  })

  it('cappedReads: null while every file fits, else the first cap files in read order', () => {
    expect(cappedReads(['a.ts', 'b.ts', 'a.ts'], 2)).toBeNull()
    expect([...(cappedReads(['a/1.ts', 'a/2.ts', 'b/1.ts', 'a/1.test.ts'], 2) as Set<string>)]).toEqual(['a/1.ts', 'b/1.ts'])
    expect(cappedReads(['x.ts'])).toBeNull()
    expect(READ_CONCURRENCY).toBe(32)
  })

  it('eachLimit: never more than the limit at once, every item once with its index, a rejection rejects the run', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    let open = 0
    let peak = 0
    const seen: number[] = []
    await eachLimit(items, 7, async (item, i) => {
      expect(item).toBe(i)
      open++
      peak = Math.max(peak, open)
      await new Promise((r) => setTimeout(r, 0))
      open--
      seen.push(i)
    })
    expect(peak).toBe(7)
    expect(seen.sort((a, b) => a - b)).toEqual(items)
    // A limit below one still runs (one at a time); no items, no calls.
    const one: number[] = []
    await eachLimit([1, 2], 0, async (n) => void one.push(n))
    expect(one).toEqual([1, 2])
    const none = vi.fn(async () => {})
    await eachLimit([], 4, none)
    expect(none).not.toHaveBeenCalled()
    await expect(eachLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom') })).rejects.toThrow('boom')
  })

  it('eachLimit: after a rejection no item starts; the other workers only finish the one they hold (fix round 1, M9)', async () => {
    const started: number[] = []
    const items = Array.from({ length: 50 }, (_, i) => i)
    const run = eachLimit(items, 4, async (n) => {
      started.push(n)
      await new Promise((r) => setTimeout(r, n === 1 ? 1 : 10))
      if (n === 1) throw new Error('read failed')
    })
    await expect(run).rejects.toThrow('read failed')
    // Let the three items still held finish: none starts another.
    await new Promise((r) => setTimeout(r, 40))
    expect(started).toEqual([0, 1, 2, 3])
  })
})

describe('snapshotFromFiles reads (WP4a)', () => {
  it('reports the listing before any read, reads each file once and at most `concurrency` at a time, and hands each text on', async () => {
    const files = Array.from({ length: 40 }, (_, i) => `src/m${String(i).padStart(2, '0')}.ts`)
    const t = tracker((rel) => (rel === 'src/m03.ts' ? null : `import './m00'\nexport const v = 1\n`))
    const order: string[] = []
    const texts: string[] = []
    const reads: [number, number][] = []
    const snap = await snapshotFromFiles(ROOT, {
      listFiles: async () => [...files, 'src/m00.ts'],
      read: async (p) => {
        order.push('read')
        return t.read(p)
      },
      concurrency: 5,
      onListed: (paths: GraphSnapshot) => {
        order.push('listed')
        expect(paths.files).toEqual(files)
        expect(Object.values(paths.fileImports).every((v) => v.length === 0)).toBe(true)
        expect(paths).not.toHaveProperty('filesCapped')
      },
      onText: (rel) => void texts.push(rel),
      onRead: (done, total) => void reads.push([done, total])
    })
    expect(order[0]).toBe('listed')
    expect(order.filter((o) => o === 'listed')).toHaveLength(1)
    expect(t.peak()).toBe(5)
    expect([...t.counts.values()].every((n) => n === 1)).toBe(true)
    expect(t.counts.size).toBe(40)
    // The unreadable file is dropped; every other one has its imports.
    expect(snap.files).toEqual(files.filter((f) => f !== 'src/m03.ts'))
    expect(snap.fileImports['src/m10.ts']).toEqual(['./m00'])
    expect(texts.sort()).toEqual(files.filter((f) => f !== 'src/m03.ts'))
    expect(reads.map((r) => r[0])).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    expect(reads.every((r) => r[1] === 40)).toBe(true)
  })

  it('a capped listing says how many it maps; with no concurrency given the default bounds the reads', async () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.ts`)
    const t = tracker()
    const listed: GraphSnapshot[] = []
    const snap = await snapshotFromFiles(ROOT, { listFiles: async () => ({ files, capped: true }), read: t.read, onListed: (p) => void listed.push(p) })
    expect(t.peak()).toBe(READ_CONCURRENCY)
    expect(listed[0].filesCapped).toBe(100)
    expect(snap.filesCapped).toBe(100)
  })

  it('more files than MAP_FILE_CAP: every one is shown, only MAP_FILE_CAP are read, source before tests', async () => {
    const src = Array.from({ length: MAP_FILE_CAP }, (_, i) => `src/d${i % 10}/f${i}.ts`)
    const tests = Array.from({ length: 5 }, (_, i) => `src/d0/f${i}.test.ts`)
    const t = tracker((rel) => (rel.endsWith('.test.ts') ? "import './x'\n" : 'export const x = 1\n'))
    const snap = await snapshotFromFiles(ROOT, { listFiles: async () => [...src, ...tests], read: t.read })
    expect(t.counts.size).toBe(MAP_FILE_CAP)
    expect(tests.some((f) => t.counts.has(f))).toBe(false)
    expect(snap.files).toHaveLength(MAP_FILE_CAP + 5)
    // A file not read is still shown, with no imports.
    expect(snap.fileImports['src/d0/f0.test.ts']).toEqual([])
    expect(snap).not.toHaveProperty('filesCapped')
  })
})

// ── the compile ──────────────────────────────────────────────────────────────────────────────────

const TEXTS: Record<string, string> = {
  'src/app/main.ts': "import { util } from '../lib/util'\nexport const main = util\n",
  'src/app/view.ts': "import { main } from './main'\nexport const view = main\n",
  'src/lib/util.ts': 'export const util = 1\n',
  'src/lib/more.ts': "import { util } from './util'\nexport const more = util\n"
}
const snapOf = (files: string[] = Object.keys(TEXTS).sort()): GraphSnapshot => ({ root: ROOT, files, symbols: [], callEdges: [], fileImports: {} })

function deps(over: Partial<CompileDeps> = {}): CompileDeps & { sources: string[]; pcts: [CompileStage, number][] } {
  const sources: string[] = []
  const pcts: [CompileStage, number][] = []
  return {
    sources,
    pcts,
    readFile: async () => null,
    readSource: async (p) => {
      const rel = p.slice(ROOT.length + 1)
      sources.push(rel)
      return Object.hasOwn(TEXTS, rel) ? TEXTS[rel] : `export const ${rel.replace(/\W/g, '_')} = 1\n`
    },
    glob: async () => [],
    label: { llm: null, cache: { get: async () => null, set: async () => undefined }, excerpt: async () => '' },
    now: () => 1,
    onProgress: (stage, pct) => void pcts.push([stage, pct]),
    ...over
  }
}

const compile = (d: CompileDeps, extra: Record<string, unknown> = {}, snap = snapOf()) =>
  compileWorldStaged({ snap, projectKey: 'k', head: HEAD, previous: null, ...extra }, d)

describe('compileWorldStaged reads and progress (WP4a)', () => {
  it('a file the snapshot already scanned is not read again; a scan of null means read but nothing to scan', async () => {
    const plain = await compile(deps())
    const scans = new Map(Object.entries(TEXTS).map(([f, text]) => [f, scanFile(f, text)]))
    scans.set('src/lib/more.ts', null)
    const d = deps({ scanned: (f) => scans.get(f) })
    const out = await compile(d)
    expect(d.sources).toEqual([])
    expect(out.cache.files['src/app/main.ts']).toEqual(plain.cache.files['src/app/main.ts'])
    expect(out.cache.files).not.toHaveProperty('src/lib/more.ts')
    // Files not scanned (undefined) are read as before.
    const some = deps({ scanned: (f) => (f === 'src/app/main.ts' ? scans.get(f) : undefined) })
    await compile(some)
    expect(some.sources.sort()).toEqual(['src/app/view.ts', 'src/lib/more.ts', 'src/lib/util.ts'])
  })

  it('with a stage cache, a prescan of the same text keeps the cached scan; changed text scans afresh', async () => {
    const first = await compile(deps())
    const kept = first.cache.files['src/app/main.ts']
    const changed = scanFile('src/lib/util.ts', 'export const util = 2\n')
    const d = deps({ scanned: (f) => (f === 'src/lib/util.ts' ? changed : scanFile(f, TEXTS[f])) })
    const out = await compile(d, { cache: first.cache, reread: Object.keys(TEXTS) })
    expect(d.sources).toEqual([])
    expect(out.cache.files['src/app/main.ts']).toBe(kept)
    expect(out.cache.files['src/lib/util.ts']).toEqual(changed)
  })

  it('more files than MAP_FILE_CAP: all are parts of the world, MAP_FILE_CAP are read, and the doc says both counts', async () => {
    const files = [...Array.from({ length: MAP_FILE_CAP + 3 }, (_, i) => `src/d${i % 7}/f${i}.ts`)].sort()
    const d = deps()
    const out = await compile(d, {}, snapOf(files))
    expect(new Set(d.sources).size).toBe(MAP_FILE_CAP)
    expect(d.sources).toHaveLength(MAP_FILE_CAP)
    expect(out.doc.filesRead).toBe(MAP_FILE_CAP)
    expect(out.doc.filesListed).toBe(MAP_FILE_CAP + 3)
    expect(out.doc.buildings.flatMap((b) => b.members)).toHaveLength(MAP_FILE_CAP + 3)
    // A cached file outside the read set is not kept from the cache either: it stays unread.
    const again = deps()
    const next = await compile(again, { cache: out.cache, changed: [] }, snapOf(files))
    expect(again.sources).toEqual([])
    expect(next.doc.filesRead).toBe(MAP_FILE_CAP)
    // Only a read that found text counts: an unreadable or oversized file in the read set was chosen, not read (M7).
    const gaps = deps({
      readSource: async (p) => {
        const rel = p.slice(ROOT.length + 1)
        if (rel === files[0]) return null
        return rel === files[1] ? 'x'.repeat(MAX_DETECT_FILE_CHARS + 1) : 'export const x = 1\n'
      }
    })
    const holes = await compile(gaps, {}, snapOf(files))
    expect(holes.doc.filesRead).toBe(MAP_FILE_CAP - 2)
    expect(holes.doc.filesListed).toBe(MAP_FILE_CAP + 3)
    const small = await compile(deps())
    expect(small.doc).not.toHaveProperty('filesRead')
    expect(small.doc).not.toHaveProperty('filesListed')
  }, 60_000)

  it('progress only rises, the reads move it from 5 to 40, a slow wait for test results keeps it moving, and the status stage reports once more after it (fix round 2, R2)', async () => {
    vi.useFakeTimers()
    let release!: (v: never[]) => void
    const ciRuns = () => new Promise<never[]>((r) => (release = r))
    const d = deps({ ciRuns })
    const running = compile(d)
    // Let the reads finish and the compile reach the status stage.
    for (let i = 0; i < 50 && !d.pcts.some(([s]) => s === 'status'); i++) await vi.advanceTimersByTimeAsync(1)
    expect(d.pcts.filter(([s]) => s === 'boundaries').map(([, p]) => p)).toEqual([5, 13.75, 22.5, 31.25, 40])
    expect(d.pcts[d.pcts.length - 1]).toEqual(['status', 55])
    await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS * 3)
    // A fraction of a point a beat: the 8 points to 63 last as long as the longest wait for main's runs.
    expect(d.pcts.slice(-3)).toEqual([['status', 55.73], ['status', 56.45], ['status', 57.18]])
    release([])
    await vi.advanceTimersByTimeAsync(10)
    await running
    const pcts = d.pcts.map(([, p]) => p)
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1])
    expect(pcts[pcts.length - 1]).toBe(100)
    const labelling = d.pcts.findIndex(([s]) => s === 'labelling')
    expect(d.pcts[labelling - 1]).toEqual(['status', 64])
    // The heartbeat stopped with the wait.
    const n = d.pcts.length
    await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS * 5)
    expect(d.pcts).toHaveLength(n)
  })

  it('a read stuck in the read stage: a beat every STATUS_BEAT_MS in which no read moved the bar, a hundredth each, never the next twentieth; the reads go on from there (fix round 4, M1)', async () => {
    expect([5, 6.85, 6.86, 6.88, 6.89, 31.25].map(readBeat)).toEqual([5.01, 6.86, 6.87, 6.89, 6.89, 31.26])
    vi.useFakeTimers()
    let release!: () => void
    const stuck = new Promise<void>((r) => (release = r))
    const base = deps()
    const d = deps({
      readSource: async (p) => {
        if (p.endsWith('src/lib/more.ts')) await stuck
        return (base.readSource as (p: string) => Promise<string | null>)(p)
      }
    })
    const running = compile(d)
    await vi.advanceTimersByTimeAsync(1)
    const boundaries = (): number[] => d.pcts.filter(([s]) => s === 'boundaries').map(([, p]) => p)
    // Three of four read: the first beat finds the reads moved the bar since the start, and posts nothing.
    expect(boundaries()).toEqual([5, 13.75, 22.5, 31.25])
    await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS)
    expect(boundaries()).toHaveLength(4)
    // Then a hundredth a beat, up to and not onto the next twentieth (31.3), where it holds.
    await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS * 6)
    expect(boundaries().slice(4)).toEqual([31.26, 31.27, 31.28, 31.29])
    release()
    await vi.advanceTimersByTimeAsync(10)
    await running
    expect(boundaries().slice(-1)).toEqual([40])
    // The beat ended with the reads.
    const n = d.pcts.filter(([s]) => s === 'boundaries').length
    await vi.advanceTimersByTimeAsync(STATUS_BEAT_MS * 3)
    expect(boundaries()).toHaveLength(n)
  })

  it('the test-results search is bounded: at SEARCH_TIME_MS its walks are told to stop, main\'s asks keep their own clock, and a building with no result reads as not yet checked (fix round 3, N2)', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const signals: AbortSignal[] = []
    const glob = vi.fn((_root: string, _patterns: string[], opts: { signal: AbortSignal }) => {
      signals.push(opts.signal)
      return new Promise<string[]>(() => undefined)
    })
    const never = vi.fn(() => new Promise<TestRun[]>(() => undefined))
    const times: number[] = []
    const d = deps({ glob, ciRuns: never, transcriptRuns: never })
    const onProgress = d.onProgress as NonNullable<CompileDeps['onProgress']>
    d.onProgress = (s, p) => {
      times.push(Date.now())
      onProgress(s, p)
    }
    let out: Awaited<ReturnType<typeof compile>> | null = null
    void compile(d).then((o) => (out = o))
    await vi.advanceTimersByTimeAsync(SEARCH_TIME_MS - 1)
    expect(out).toBeNull()
    // The report search (inside readTestResults) and the manifest search: one window for both.
    expect(glob).toHaveBeenCalledTimes(2)
    expect(signals.some((s) => s.aborted)).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(signals.every((s) => s.aborted)).toBe(true)
    // Main's asks have their own clock, longer than the host's own wait for main (RUNS_WAIT_MS): still waited for.
    expect(out).toBeNull()
    await vi.advanceTimersByTimeAsync(RUNS_WAIT_MS + RUNS_GRACE_MS - SEARCH_TIME_MS - 40)
    expect(out).toBeNull()
    await vi.advanceTimersByTimeAsync(40)
    const done = out as unknown as Awaited<ReturnType<typeof compile>>
    expect(done).not.toBeNull()
    // No result read and no source complete: no building is called untested (gap); each reads as not yet checked,
    // and the partial results leave no hash a later compile could take for the whole set.
    expect(done.doc.buildings.every((b) => b.status === 'built' && b.claims.length === 0)).toBe(true)
    expect(done.cache.tests).toBe('')
    expect(d.pcts[d.pcts.length - 1]).toEqual(['layout', 100])
    // While it waited, the bar moved at least every STATUS_BEAT_MS, and never past the status stage's 64.
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThanOrEqual(STATUS_BEAT_MS)
    const status = d.pcts.filter(([s]) => s === 'status').map(([, p]) => p)
    expect(status[0]).toBe(55)
    expect(status[status.length - 1]).toBe(64)
    expect(Math.max(...status.slice(0, -1))).toBeLessThan(64)
    // It never sat still: every beat of the wait is above the one before.
    for (let i = 1; i < status.length; i++) expect(status[i]).toBeGreaterThan(status[i - 1])
    // The log names the stage that waited, and says a source ran out of time.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[world compile\] k: .*status \d+ ms.*; a search or a source of test results ran out of time \(searches 16000 ms, main's runs 20000 ms\)$/)
    warn.mockRestore()
  })

  it('a late source keeps the reports already read; a building they say nothing of keeps its last status, or reads as not yet checked (fix round 3, N2)', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const files = [...Object.keys(TEXTS), 'src/lib/util.test.ts'].sort()
    const report = JSON.stringify({ testResults: [{ name: `${ROOT}/src/lib/util.test.ts`, status: 'passed', endTime: 7 }] })
    const reports = (): Partial<CompileDeps> => ({
      glob: async (_root, patterns) => (patterns.some((p) => p.includes('vitest-report')) ? [`${ROOT}/vitest-report.json`] : []),
      readFile: async (p) => (p.endsWith('vitest-report.json') ? report : null)
    })
    const never = () => new Promise<TestRun[]>(() => undefined)
    const run = async (d: CompileDeps, extra: Record<string, unknown> = {}) => {
      let out: Awaited<ReturnType<typeof compile>> | null = null
      void compile(d, extra, snapOf(files)).then((o) => (out = o))
      for (let i = 0; i < 40 && out === null; i++) await vi.advanceTimersByTimeAsync(1000)
      return out as unknown as Awaited<ReturnType<typeof compile>>
    }
    const ownerOf = (doc: { buildings: { id: string; members: string[] }[] }, f: string) => doc.buildings.find((b) => b.members.includes(f)) as { id: string }
    // Complete: the report decides the tested building, and one with no linked test is untested (gap).
    const whole = await run(deps({ ...reports(), ciRuns: async () => [] }))
    const tested = ownerOf(whole.doc, 'src/lib/util.ts').id
    const other = ownerOf(whole.doc, 'src/app/main.ts').id
    expect(tested).not.toBe(other)
    const statusIn = (doc: typeof whole.doc, id: string) => doc.buildings.find((b) => b.id === id) as (typeof whole.doc.buildings)[number]
    expect(statusIn(whole.doc, tested).status).toBe('verified')
    expect(statusIn(whole.doc, other).status).toBe('gap')
    // CI never answers: the report read is kept, and the building it says nothing of reads as not yet checked.
    const late = await run(deps({ ...reports(), ciRuns: never }))
    expect(statusIn(late.doc, tested)).toMatchObject({ status: 'verified', claims: statusIn(whole.doc, tested).claims })
    expect(statusIn(late.doc, other)).toMatchObject({ status: 'built', claims: [] })
    // With a previous world, that building keeps what it showed (its test claims, not a person's).
    const seen = { text: 'Its 1 linked tests passed', state: 'verified' as const, evidence: [{ kind: 'test' as const, ref: 'src/app/main.test.ts', excerpt: 'from a test report' }] }
    const person = { text: 'Checked by hand', state: 'verified' as const, evidence: [{ kind: 'person' as const, ref: 'me', excerpt: '' }] }
    const previous = { ...whole.doc, buildings: whole.doc.buildings.map((b) => (b.id === other ? { ...b, status: 'verified' as const, claims: [seen, person] } : b)) }
    const kept = await run(deps({ ...reports(), ciRuns: never }), { previous })
    expect(statusIn(kept.doc, other)).toMatchObject({ status: 'verified', claims: [seen] })
    expect(statusIn(kept.doc, tested).status).toBe('verified')
    // A watcher compile on partial results judges every building again (no scoped status from a partial hash).
    const scoped = await run(deps({ ...reports(), ciRuns: never }), { previous: kept.doc, cache: kept.cache, changed: [] })
    expect(kept.cache.tests).toBe('')
    expect(statusIn(scoped.doc, other)).toMatchObject({ status: 'verified', claims: [seen] })
  })

  it('every stage reports progress, and a slow label cache or manifest search keeps the bar moving; a slow stage is logged (fix round 2, R2)', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const later = <T,>(v: T, ms: number): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms))
    const times: number[] = []
    const d = deps({
      // Reports come at once; the manifest search takes 12 s.
      glob: (_root, patterns) => (patterns.some((p) => p.includes('junit')) ? Promise.resolve([]) : later([], 12_000)),
      // A model that takes 2.5 s a call and describes nothing (every reply null).
      label: { llm: () => later(null, 2500), cache: { get: async () => null, set: async () => undefined }, excerpt: async () => '' }
    })
    const onProgress = d.onProgress as NonNullable<CompileDeps['onProgress']>
    d.onProgress = (s, p) => {
      times.push(Date.now())
      onProgress(s, p)
    }
    const running = compile(d)
    await vi.advanceTimersByTimeAsync(60_000)
    const out = await running
    expect(out.doc.buildings.length).toBeGreaterThan(0)
    const stages = d.pcts.map(([s]) => s).filter((s, i, all) => all.indexOf(s) === i)
    expect(stages).toEqual(['structure', 'boundaries', 'grouping', 'status', 'labelling', 'layout'])
    const pcts = d.pcts.map(([, p]) => p)
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1])
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThanOrEqual(STATUS_BEAT_MS)
    // The layout stage reports between its steps: the status pass, the manifests, the layout, then 100.
    const layout = d.pcts.filter(([s]) => s === 'layout').map(([, p]) => p)
    expect(layout[0]).toBe(85)
    expect(layout).toContain(86)
    expect(layout).toContain(95)
    expect(layout).toContain(98)
    expect(layout[layout.length - 1]).toBe(100)
    expect(d.pcts.filter(([s]) => s === 'labelling').length).toBeGreaterThan(1)
    // Both slow stages are named in the one log line, each with its time; nothing ran out of time. (The label
    // pass logs its own retries for the replies that said nothing.)
    const lines = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('[world compile]'))
    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line).toMatch(/labelling \d+ ms/)
    expect(line).toMatch(/layout \d+ ms/)
    expect(line).not.toMatch(/ran out of time/)
    warn.mockRestore()
  })

  it('the status pass is timed and reported as the status stage, not as layout (fix round 3, N3)', async () => {
    const claims = vi.mocked(testClaims)
    const real = claims.getMockImplementation() as typeof testClaims
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const d = deps()
    const order: string[] = []
    const onProgress = d.onProgress as NonNullable<CompileDeps['onProgress']>
    d.onProgress = (s, p) => {
      order.push(`${s} ${p}`)
      onProgress(s, p)
    }
    // Each building's status takes 3 s of the clock: a slow status pass.
    claims.mockImplementation((...a) => {
      order.push('claims')
      clock += 3000
      return real(...a)
    })
    try {
      await compile(d)
    } finally {
      claims.mockImplementation(real)
      now.mockRestore()
    }
    // Every building's status is judged after the wait for results and before 64, while the stage is status.
    expect(order.indexOf('claims')).toBeGreaterThan(order.indexOf('status 55'))
    expect(order.lastIndexOf('claims')).toBeLessThan(order.indexOf('status 64'))
    const lines = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('[world compile]'))
    expect(lines).toHaveLength(1)
    const ms = (stage: string): number => Number((new RegExp(`${stage} (\\d+) ms`).exec(lines[0]) as RegExpExecArray)[1])
    expect(ms('status')).toBeGreaterThanOrEqual(3000 * order.filter((o) => o === 'claims').length)
    expect(ms('layout')).toBe(0)
    warn.mockRestore()
  })

  it('a quick compile logs nothing (fix round 2, R2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await compile(deps())
    expect(warn).not.toHaveBeenCalled()
    expect(SLOW_STAGE_MS).toBe(5000)
    expect(SEARCH_TIME_MS).toBe(16_000)
    warn.mockRestore()
  })

  it('a compile that throws still ends its search window (fix round 2, R2)', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const d = deps({
      glob: (_root, _patterns, opts) => {
        signals.push(opts.signal)
        return Promise.resolve([])
      },
      annotations: async () => {
        throw new Error('store down')
      }
    })
    await expect(compile(d)).rejects.toThrow('store down')
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => s.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('layoutFrom: with no previous world, the parts start where the first map drew them; a previous world wins', async () => {
    const plain = await compile(deps())
    // The whole first map drawn 500 to the east: districts and their buildings move together.
    const moved = { seed: plain.doc.layout.seed, positions: Object.fromEntries(Object.entries(plain.doc.layout.positions).map(([id, [x, y, z]]) => [id, [x + 500, y, z] as [number, number, number]])) }
    const out = await compile(deps(), { layoutFrom: moved })
    expect(out.doc.layout.positions).toEqual(moved.positions)
    const prev = await compile(deps(), { previous: plain.doc, layoutFrom: moved })
    expect(prev.doc.layout.positions).toEqual(plain.doc.layout.positions)
  })
})
