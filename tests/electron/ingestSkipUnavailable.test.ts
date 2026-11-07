// MEM-F6 and MEM-F7 (1.54.5 fixer round 1), against real files in a scratch tree. Counted, never timed: the
// real fs.promises calls a pass makes, and the pass counters.
//
// MEM-F6: while memory is "unavailable" (the store refused to start; memoryFallbackGuard), every store call throws,
// yet the fast tier (90 s) and the full tier (30 min) went on walking, statting, reading and parsing up to 8 MiB a
// pass, on a machine that is starved already. Now the pass is skipped before it touches a file, and counted.
// Kill switch: TERMPOLIS_INGEST_UNAVAILABLE_SKIP=off.
//
// MEM-F7: the fast tier's freshness filter stats each transcript, and the walk stats each fresh one again for its
// stamp. The filter's stat is now the stamp (taken before the read, as the stamp must be).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  conversationIngestCounters, runConversationIngest, _resetConversationIngestCountersForTests, type IngestMemory,
} from '../../src/main/conversationIngest'
import { configureConversationIngest, passResult, resetIngestRuntime } from '../../src/main/ingestRuntime'
import { setMemoryUnavailableState } from '../../src/main/memoryFallbackGuard'
import { resetTypingQuiet } from '../../src/main/typingQuiet'
import { resetPasses } from '../../src/main/passCounters'
import { sessionText } from './_ingestCorpus'

let root = ''
let userData = ''
let projects = ''

function store(): IngestMemory & { writes: number } {
  const known = new Set<string>()
  const m = {
    writes: 0,
    hasHashes: async (hs: string[]) => hs.filter((h) => known.has(h)),
    write: async (i: { hash: string }) => { known.add(i.hash); m.writes++; return { id: i.hash } },
  }
  return m as unknown as IngestMemory & { writes: number }
}

const sessions = (n: number): string[] => {
  const out: string[] = []
  mkdirSync(join(projects, 'proj'), { recursive: true })
  for (let i = 0; i < n; i++) {
    const p = join(projects, 'proj', `s${i}.jsonl`)
    writeFileSync(p, sessionText(i, 3))
    out.push(p)
  }
  return out
}

function counters() {
  const names = ['open', 'stat', 'readFile', 'readdir'] as const
  const c: Record<string, number> = { open: 0, stat: 0, readFile: 0, readdir: 0 }
  for (const n of names) {
    const real = (fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>)[n]
    vi.spyOn(fs.promises as never, n as never).mockImplementation(((...a: unknown[]) => { c[n]++; return real.apply(fs.promises, a) }) as never)
  }
  return c
}

const run = (m: IngestMemory, opts: Record<string, unknown> = {}) =>
  runConversationIngest(m, { roots: { claude: projects }, sources: ['claude'], maxChunks: 250, ...opts })
const configure = (env: Record<string, string> = {}) =>
  configureConversationIngest({ userData, appVersion: '1.54.5', isLocked: async () => false, paused: () => false, env })
const unavailable = (): void => setMemoryUnavailableState({
  attempt: 1, nextRetryAt: null, retrying: false, storeBytes: null, limitBytes: 1, reason: 'synthetic', since: 0,
})

let savedSkip: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ingest-unavail-'))
  userData = join(root, 'userData')
  projects = join(root, 'projects')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projects, { recursive: true })
  resetIngestRuntime()
  resetPasses()
  resetTypingQuiet()
  _resetConversationIngestCountersForTests()
  savedSkip = process.env.TERMPOLIS_INGEST_UNAVAILABLE_SKIP
  delete process.env.TERMPOLIS_INGEST_UNAVAILABLE_SKIP
})
afterEach(() => {
  vi.restoreAllMocks()
  setMemoryUnavailableState(null)
  resetIngestRuntime()
  if (savedSkip === undefined) delete process.env.TERMPOLIS_INGEST_UNAVAILABLE_SKIP
  else process.env.TERMPOLIS_INGEST_UNAVAILABLE_SKIP = savedSkip
  rmSync(root, { recursive: true, force: true })
})

describe('MEM-F6: while memory is unavailable a pass touches no file', () => {
  it('lists, stats and opens nothing, writes nothing, is counted, and asks for no follow-up or linked-history recheck', async () => {
    sessions(3)
    configure()
    unavailable()
    const m = store()
    const c = counters()
    const stats = await run(m)
    expect(c).toEqual({ open: 0, stat: 0, readFile: 0, readdir: 0 })
    expect(m.writes).toBe(0)
    expect(conversationIngestCounters().unavailableSkips).toBe(1)
    expect(stats.filesScanned).toBe(0)
    // truncated: the full pass must not take this for "read every transcript" (its linked-history recheck), and
    // stop 'stopped' asks the scheduler for no follow-up.
    expect(stats.truncated).toBe(true)
    expect(passResult(stats).more).toBe(false)
  })

  it('the fast tier is skipped the same way', async () => {
    sessions(2)
    configure()
    unavailable()
    const c = counters()
    await run(store(), { freshSinceTs: Date.now() - 10 * 60_000 })
    expect(c.readdir + c.stat + c.open + c.readFile).toBe(0)
    expect(conversationIngestCounters().unavailableSkips).toBe(1)
  })

  it('once memory is back the next pass reads everything (nothing was marked while it was down)', async () => {
    sessions(3)
    configure()
    unavailable()
    const m = store()
    await run(m)
    setMemoryUnavailableState(null)
    const stats = await run(m)
    expect(stats.filesScanned).toBe(3)
    expect(m.writes).toBeGreaterThan(0)
    expect(conversationIngestCounters().unavailableSkips).toBe(1)
  })

  it('kill switch: TERMPOLIS_INGEST_UNAVAILABLE_SKIP=off reads as before (and nothing is skipped)', async () => {
    process.env.TERMPOLIS_INGEST_UNAVAILABLE_SKIP = 'off'
    sessions(3)
    configure()
    unavailable()
    const c = counters()
    const stats = await run(store())
    expect(stats.filesScanned).toBe(3)
    expect(c.readdir).toBeGreaterThan(0)
    expect(conversationIngestCounters().unavailableSkips).toBe(0)
  })
})

describe('MEM-F7: the fast tier stats each fresh transcript once', () => {
  it('3 fresh and 2 cold files: 3 stats by the filter for the fresh ones plus 2 for the cold, and none again for the stamp', async () => {
    const files = sessions(5)
    const old = (Date.now() - 60 * 60_000) / 1000
    utimesSync(files[3], old, old)
    utimesSync(files[4], old, old)
    configure()
    const c = counters()
    const stats = await run(store(), { freshSinceTs: Date.now() - 10 * 60_000 })
    expect(stats.filesScanned).toBe(3)
    expect(c.stat).toBe(5)
    expect(conversationIngestCounters().freshStampsReused).toBe(3)
  })

  it('the reused stamp is the one marked: the next fast pass skips all three unread', async () => {
    const files = sessions(3)
    configure()
    const m = store()
    await run(m, { freshSinceTs: Date.now() - 10 * 60_000 })
    const c = counters()
    const stats = await run(m, { freshSinceTs: Date.now() - 10 * 60_000 })
    expect(stats.filesScanned).toBe(0)
    expect(stats.unchanged).toBe(files.length)
    expect(c.open + c.readFile).toBe(0)
  })

  it('a link named like a transcript that leads to a folder keeps no stamp: the pass asks its own stat, and reads nothing there', async () => {
    sessions(2)
    const target = join(root, 'not-a-transcript')
    mkdirSync(target)
    symlinkSync(target, join(projects, 'proj', 'link.jsonl'), 'junction')
    configure()
    const c = counters()
    const stats = await run(store(), { freshSinceTs: Date.now() - 10 * 60_000 })
    expect(stats.filesScanned).toBe(2)
    expect(conversationIngestCounters().freshStampsReused).toBe(2)
    expect(c.stat).toBe(4) // three by the filter, one by the pass for the link (no stamp kept for a folder)
  })

  it('control: the full tier (no freshness filter) stats each file once, for its stamp, as before', async () => {
    sessions(3)
    configure()
    const c = counters()
    await run(store())
    expect(c.stat).toBe(3)
    expect(conversationIngestCounters().freshStampsReused).toBe(0)
  })

  it('control: under TERMPOLIS_INGEST_FAST=off there is no stamp to reuse, and the filter stats as in 1.54.4', async () => {
    sessions(3)
    configure({ TERMPOLIS_INGEST_FAST: 'off' })
    const c = counters()
    await run(store(), { freshSinceTs: Date.now() - 10 * 60_000 })
    expect(c.stat).toBe(3)
    expect(conversationIngestCounters().freshStampsReused).toBe(0)
  })
})
