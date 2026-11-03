// The wiring of P4, against REAL files in a scratch tree: configureConversationIngest() is called once at
// start-up, and every runConversationIngest after it (the three call sites in index.ts, unchanged) gets the
// watermark, the byte budget, the time slices, the typing gate and the pause switch. The counters are the
// real fs.promises calls and the pass ring, never clocks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runConversationIngest, type IngestMemory } from '../../src/main/conversationIngest'
import { configureConversationIngest, getIngestRuntime, INGEST_PASS_BYTES, INGEST_SLICE_MS, makeDrainRun, passResult, resetIngestRuntime } from '../../src/main/ingestRuntime'
import { WATERMARK_FILE } from '../../src/main/ingestWatermark'
import { noteTyping, resetTypingQuiet } from '../../src/main/typingQuiet'
import { resetPasses, snapshotPasses } from '../../src/main/passCounters'
import { sessionText } from './_ingestCorpus'
import { assistantLine, lines, userLine } from './_transcriptFixture'

let root = ''
let userData = ''
let projects = ''

function store(): IngestMemory & { known: Set<string>; writes: number } {
  const known = new Set<string>()
  const m = {
    known,
    writes: 0,
    hasHashes: async (hs: string[]) => hs.filter((h) => known.has(h)),
    write: async (i: { hash: string }) => { known.add(i.hash); m.writes++; return { id: i.hash } },
  }
  return m as unknown as IngestMemory & { known: Set<string>; writes: number }
}

const sessions = (n: number): string[] => {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const p = join(projects, `proj-${i % 3}`, `s${i}.jsonl`)
    mkdirSync(join(projects, `proj-${i % 3}`), { recursive: true })
    writeFileSync(p, sessionText(i, 3))
    out.push(p)
  }
  return out
}

/** Count the real async fs calls a pass makes. */
function counters() {
  const names = ['open', 'stat', 'readFile', 'readdir'] as const
  const c: Record<string, number> = { open: 0, stat: 0, readFile: 0, readdir: 0 }
  const spies = names.map((n) => {
    const real = (fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>)[n]
    return vi.spyOn(fs.promises as never, n as never).mockImplementation(((...a: unknown[]) => { c[n]++; return real.apply(fs.promises, a) }) as never)
  })
  return { c, reset: () => { for (const n of names) c[n] = 0 }, restore: () => spies.forEach((s) => s.mockRestore()) }
}

const run = (m: IngestMemory, opts: Record<string, unknown> = {}) => runConversationIngest(m, { roots: { claude: projects }, sources: ['claude'], ...opts })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ingest-rt-'))
  userData = join(root, 'userData')
  projects = join(root, 'projects')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projects, { recursive: true })
  resetIngestRuntime()
  resetPasses()
  resetTypingQuiet()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetIngestRuntime()
  rmSync(root, { recursive: true, force: true })
})

const configure = (over: Record<string, unknown> = {}) =>
  configureConversationIngest({ userData, appVersion: '1.54.5', isLocked: async () => false, paused: () => false, env: {}, ...over })

describe('the first pass and the steady pass', () => {
  it('reads every file once, keeps a watermark file, and the next pass opens no file at all', async () => {
    const files = sessions(10)
    configure()
    const m = store()
    const k = counters()
    const first = await run(m)
    expect(first.filesScanned).toBe(10)
    expect(k.c.open).toBe(10)
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(join(userData, WATERMARK_FILE), 'utf8')).files).sort()).toEqual(files.sort())

    k.reset()
    const second = await run(m)
    expect(k.c.open).toBe(0)
    expect(k.c.readFile).toBe(0)
    expect(k.c.stat).toBe(10)
    expect(second).toMatchObject({ filesScanned: 0, unchanged: 10, chunksWritten: 0, truncated: false })
    k.restore()
  })

  it('appending to one file reopens that file and no other', async () => {
    const files = sessions(8)
    configure()
    const m = store()
    await run(m)
    appendFileSync(files[3], lines(userLine('one more thing', { sessionId: 'sess-3', cwd: '/r' }), assistantLine('noted')))
    const k = counters()
    const s = await run(m)
    expect(k.c.open).toBe(1)
    expect(s).toMatchObject({ filesScanned: 1, unchanged: 7 })
    k.restore()
  })

  it('the marks survive a restart: a new configure over the same userData skips everything', async () => {
    sessions(6)
    configure()
    const m = store()
    await run(m)
    resetIngestRuntime()
    configure()
    const k = counters()
    expect((await run(m)).filesScanned).toBe(0)
    expect(k.c.open).toBe(0)
    k.restore()
  })

  it('another app version means a fresh start: one budgeted re-scan, never a wrong skip', async () => {
    sessions(4)
    configure()
    const m = store()
    await run(m)
    resetIngestRuntime()
    configure({ appVersion: '1.54.6' })
    expect((await run(m)).filesScanned).toBe(4)
  })

  it('a store that is locked keeps no marks: the whole pass is redone once it is unlocked', async () => {
    sessions(4)
    configure({ isLocked: async () => true })
    const m = store()
    await run(m)
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(false)
    expect((await run(m)).filesScanned).toBe(4)
    resetIngestRuntime()
    configure({ isLocked: async () => false })
    await run(m)
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(true)
  })

  it('the manual "index everything" pass has no byte budget; a background pass has one (8 MiB)', async () => {
    expect(INGEST_PASS_BYTES).toBe(8 * 1024 * 1024)
    expect(INGEST_SLICE_MS).toBe(25)
    sessions(5)
    configure()
    const m = store()
    const budgeted = await run(m, { maxBytes: 1 })
    expect(budgeted).toMatchObject({ truncated: true, stop: 'bytes', filesScanned: 1 })
    const manual = await run(m, { maxBytes: Number.POSITIVE_INFINITY })
    expect(manual.truncated).toBe(false)
    expect(manual.filesScanned).toBe(4)
  })

  it('a file read as pieces gives exactly the chunks the whole-file read gives', async () => {
    const dir = join(projects, 'p')
    mkdirSync(dir)
    writeFileSync(join(dir, 'u.jsonl'), sessionText('u', 8, 500) + lines(userLine('日本語 🎉 é€', { sessionId: 'sess-u', cwd: '/r' }), assistantLine('é'.repeat(900))))
    const viaPieces = store()
    configure()
    await run(viaPieces)
    resetIngestRuntime() // no runtime: today's whole-file read
    const viaWhole = store()
    await run(viaWhole)
    expect([...viaPieces.known].sort()).toEqual([...viaWhole.known].sort())
    expect(viaWhole.known.size).toBeGreaterThan(3)
  })
})

describe('the pause switch (a pass reads 0 files)', () => {
  it('with the switch off a pass lists nothing, stats nothing and opens nothing, and says it stopped', async () => {
    sessions(10)
    const flag = { paused: true }
    configure({ paused: () => flag.paused })
    const m = store()
    const k = counters()
    const s = await run(m)
    expect(k.c).toEqual({ open: 0, stat: 0, readFile: 0, readdir: 0 })
    expect(s).toMatchObject({ filesScanned: 0, chunksWritten: 0, truncated: true, stop: 'stopped' }) // truncated: the one-time rechecks must not run on a pass that read nothing
    expect(m.writes).toBe(0)
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(false)
    // and it is counted: a support bundle can see a paused pass
    expect(snapshotPasses().kinds.ingest.n).toBe(1)
    expect(snapshotPasses().recent.find((r) => r.kind === 'ingest')!.f).toMatchObject({ files: 0, truncated: 1 })

    // NEGATIVE CONTROL: the same tree with the switch on is read.
    flag.paused = false
    k.reset()
    const on = await run(m)
    expect(k.c.open).toBe(10)
    expect(on.filesScanned).toBe(10)
    k.restore()
  })

  it('switching off in the middle of a pass stops it at the next file, and keeps no marks from it', async () => {
    sessions(10)
    const flag = { paused: false }
    configure({ paused: () => flag.paused })
    const m = store()
    let writes = 0
    const watching: IngestMemory = { ...m, write: async (i) => { if (++writes === 3) flag.paused = true; return (m as unknown as { write: (x: unknown) => Promise<unknown> }).write(i) } } as IngestMemory
    const s = await run(watching)
    expect(s).toMatchObject({ truncated: true, stop: 'stopped' })
    expect(s.filesScanned).toBeLessThan(10)
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(false)
    flag.paused = false
    expect((await run(m)).filesScanned).toBe(10) // nothing was lost, nothing was marked: all of it is done now
  })

  it('a caller-supplied stopped() still works beside the switch', async () => {
    sessions(4)
    configure()
    const s = await run(store(), { stopped: () => true })
    expect(s).toMatchObject({ truncated: true, stop: 'stopped', filesScanned: 0 })
  })
})

describe('the kill switch TERMPOLIS_INGEST_FAST=off', () => {
  it('restores today: every pass reads every file, no watermark file, no stat, and the pause switch still works', async () => {
    sessions(6)
    const flag = { paused: false }
    configure({ env: { TERMPOLIS_INGEST_FAST: 'off' }, paused: () => flag.paused })
    expect(getIngestRuntime()).not.toBeNull() // the pause switch lives on
    const m = store()
    const k = counters()
    await run(m)
    k.reset()
    const second = await run(m)
    expect(k.c.readFile).toBe(6)
    expect(second.filesScanned).toBe(6)
    expect(second.unchanged).toBeUndefined()
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(false)
    flag.paused = true
    k.reset()
    expect((await run(m)).stop).toBe('stopped')
    expect(k.c.readFile).toBe(0)
    k.restore()
    // still counted, and marked legacy so the two modes can be told apart in a support bundle
    const passes = snapshotPasses().recent.filter((r) => r.kind === 'ingest')
    expect(passes.length).toBe(3)
    expect(passes[0].f.legacy).toBe(1)
  })
})

describe('the typing gate', () => {
  it('a pass that finds the user typing waits for the quiet period before it reads anything', async () => {
    sessions(3)
    configure()
    noteTyping(Date.now())
    const k = counters()
    const m = store()
    const t0 = Date.now()
    const running = run(m)
    await new Promise((r) => setTimeout(r, 100))
    expect(k.c.open).toBe(0) // still waiting for 500 ms of quiet
    const s = await running
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(s.filesScanned).toBe(3)
    k.restore()
  })

  it('a pass over unchanged files never waits (a skip is free)', async () => {
    sessions(3)
    configure()
    const m = store()
    await run(m)
    noteTyping(Date.now())
    const t0 = Date.now()
    expect((await run(m)).unchanged).toBe(3)
    expect(Date.now() - t0).toBeLessThan(300)
  })
})

describe('the counters of a pass', () => {
  it('every pass leaves one record with files, skipped, MB, parse time, hashes, written and the drain count', async () => {
    sessions(5)
    configure()
    const m = store()
    await run(m)
    await run(m, { drainPass: 2 })
    const recs = snapshotPasses().recent.filter((r) => r.kind === 'ingest').map((r) => r.f)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ files: 5, skipped: 0, truncated: 0, drain: 0, legacy: 0 })
    expect(recs[0].hashed).toBeGreaterThan(5)
    expect(recs[0].written).toBe(recs[0].hashed)
    expect(recs[0].mb).toBeGreaterThan(0)
    expect(recs[0]).toHaveProperty('parseMsSum')
    expect(recs[0]).toHaveProperty('parseMsMax')
    expect(recs[1]).toMatchObject({ files: 0, skipped: 5, written: 0, hashed: 0, drain: 2 })
  })

  it('never any content: a record is numbers under short names', async () => {
    sessions(2)
    configure()
    await run(store())
    expect(snapshotPasses().recent.some((r) => r.kind === 'ingest')).toBe(true) // there IS a record to look at
    const text = JSON.stringify(snapshotPasses())
    expect(text).not.toContain('proj-')
    expect(text).not.toContain('ask ')
    expect(text).not.toContain(projects.replace(/\\/g, '\\\\'))
  })
})

describe('passResult and makeDrainRun', () => {
  it('passResult turns stats into the scheduler result; the note appears only when the pass did real work', () => {
    expect(passResult({ filesScanned: 0, chunksWritten: 0, chunksSkipped: 0, truncated: false, unchanged: 41 })).toEqual({ written: 0, more: false, note: undefined })
    const busy = passResult({ filesScanned: 9, chunksWritten: 12, chunksSkipped: 3, truncated: true, unchanged: 40, bytesRead: 8 * 1024 * 1024, stop: 'bytes' })
    expect(busy).toMatchObject({ written: 12, more: true })
    expect(busy.note).toMatch(/files 9/)
    expect(busy.note).toMatch(/skipped 40/)
    expect(busy.note).toMatch(/8\.0 MB/)
    expect(busy.note).toMatch(/budget/)
  })

  const deps = (over: Record<string, unknown> = {}) => {
    const calls: Record<string, unknown[]> = { ingest: [], persist: [] }
    return {
      calls,
      hooks: {
        memory: () => ({ marker: 'deps' }) as unknown as IngestMemory,
        isLocked: async () => false,
        persist: async () => { calls.persist.push(1) },
        stopped: () => false,
        ingest: async (_m: IngestMemory, opts: Record<string, unknown>) => { calls.ingest.push(opts); return { filesScanned: 2, chunksWritten: 7, chunksSkipped: 0, truncated: false } },
        ...over,
      },
    }
  }

  it('the drain tier ingests (capped at 250 chunks, told which drain pass it is), persists the index only when caught up, and never plans', async () => {
    const { calls, hooks } = deps()
    const drain = makeDrainRun(hooks)
    expect(await drain({ drainPass: 3 })).toMatchObject({ written: 7, more: false })
    expect(calls.ingest).toHaveLength(1)
    expect(calls.ingest[0]).toMatchObject({ maxChunks: 250, drainPass: 3 })
    expect(calls.persist).toHaveLength(1)

    const more = deps({ ingest: async () => ({ filesScanned: 9, chunksWritten: 250, chunksSkipped: 0, truncated: true, stop: 'chunks' }) })
    expect(await makeDrainRun(more.hooks)({ drainPass: 1 })).toMatchObject({ written: 250, more: true })
    expect(more.calls.persist).toHaveLength(0) // still draining: the index is persisted when the backlog is done
  })

  it('a locked brain makes the drain pass do nothing at all', async () => {
    const { calls, hooks } = deps({ isLocked: async () => true })
    expect(await makeDrainRun(hooks)({ drainPass: 1 })).toEqual({ written: 0 })
    expect(calls.ingest).toHaveLength(0)
  })

  it('a failing persist never loses the pass that already succeeded', async () => {
    const { hooks } = deps({ persist: async () => { throw new Error('hnsw locked') } })
    expect(await makeDrainRun(hooks)({ drainPass: 1 })).toMatchObject({ written: 7, more: false })
  })
})

describe('no runtime configured', () => {
  it('runConversationIngest is exactly what it was: whole-file reads, no stat gate, no watermark, nothing recorded as legacy', async () => {
    sessions(4)
    expect(getIngestRuntime()).toBeNull()
    const m = store()
    const k = counters()
    await run(m)
    k.reset()
    const second = await run(m)
    expect(k.c.readFile).toBe(4)
    expect(k.c.open).toBe(0)
    expect(second.filesScanned).toBe(4)
    expect(second.unchanged).toBeUndefined()
    k.restore()
    expect(existsSync(join(userData, WATERMARK_FILE))).toBe(false)
  })
})
