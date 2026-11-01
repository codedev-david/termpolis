// @vitest-environment node
// The freshness lane against the REAL memory store and the REAL correction store: what a fake cannot show. The lane is
// a newest-first listing, and a listing used to skip every filter a search applies. Here a store holds seven recent
// memories, five of which a search would never hand an agent (one superseded, one suppressed, one retracted, one
// demoted, one amended), and the digest has to carry the two that stand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))

import {
  _resetForTests,
  _setEmbeddingsAvailable,
  initSwarmMemory,
  memoryFeedback,
  memoryLink,
  memoryList,
  memorySearch,
  memoryWrite,
} from '../../src/main/swarmMemory'
import { applyEntryCorrections, correctMemory, initMemoryCorrections, resetMemoryCorrections, revokeMemoryCorrection } from '../../src/main/memoryCorrectionStore'
import { buildContextPrimer, type PrimerHit, type PrimerRecent } from '../../src/main/contextPrimer'
import { createPrimerRecent } from '../../src/main/primerLane'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 86_400_000
const REPO = 'C:/repos/lane-app'
/** Long enough for the lane (120 characters), with wording of its own so nothing is taken for a copy of anything else. */
const body = (topic: string): string => `${topic}: ${Array.from({ length: 24 }, (_, i) => `${topic.split(' ')[0]}${i}`).join(' ')}`

let tmp = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'primer-lane-'))
  _resetForTests()
  resetMemoryCorrections()
  initSwarmMemory(tmp)
  initMemoryCorrections(tmp)
  _setEmbeddingsAvailable(false)
})

afterEach(() => {
  _resetForTests()
  resetMemoryCorrections()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function put(topic: string, hoursAgo: number, over: Partial<Parameters<typeof memoryWrite>[0]> = {}) {
  return memoryWrite({ agentId: 'claude-history', kind: 'message', source: 'claude', project: REPO, content: body(topic), ts: NOW - hoursAgo * HOUR, ...over })
}

/** The lane as index.ts builds it, and the lane as it was before 1.55 (the raw listing). */
const laneNow: PrimerRecent = createPrimerRecent({ list: memoryList, correct: applyEntryCorrections })
const laneBefore: PrimerRecent = async (o) =>
  (await memoryList({ limit: o.limit, project: o.project, since: o.since })).map((e) => ({ content: e.content, source: e.source, kind: e.kind, score: 0, id: e.id, project: e.project, ts: e.ts }) as PrimerHit)

const digest = (recent: PrimerRecent, extra: Record<string, unknown> = {}) =>
  buildContextPrimer(async () => [], { query: 'q', project: 'lane-app', projectPath: REPO, recent, now: NOW, ...extra })
const rows = (out: string | null): string[] => (out ?? '').split('\n').filter((l) => l.startsWith('- ['))

describe('the freshness lane against the real stores', () => {
  async function seed() {
    const live = await put('shipped the installer check', 1)
    const replaced = await put('the old port was nine three one four', 2)
    const replacement = await put('the port moved to nine three one five', 3)
    const suppressed = await put('a fix that kept failing the build', 4)
    const retracted = await put('a claim that turned out to be wrong', 5)
    const demoted = await put('a shaky guess about the cache', 6)
    const amended = await put('a detail that was misremembered', 7)
    const other = await put('wired the release workflow', 8)
    memoryLink({ from: replacement.id, to: replaced.id, relation: 'supersedes' })
    for (let i = 0; i < 3; i++) memoryFeedback({ id: suppressed.id, helpful: false })
    correctMemory({ id: retracted.id, kind: 'retract', reason: 'wrong', by: 'user' })
    correctMemory({ id: demoted.id, kind: 'demote', reason: 'unreliable', by: 'user' })
    correctMemory({ id: amended.id, kind: 'amend', reason: 'misremembered', replacement: 'the corrected detail', by: 'user' })
    return { live, replaced, replacement, suppressed, retracted, demoted, amended, other }
  }

  it('the raw listing it replaced carried all eight, and its digest showed a memory that had been replaced', async () => {
    await seed()
    const all = await laneBefore({ limit: 100, project: REPO, since: NOW - 7 * DAY })
    expect(all).toHaveLength(8)
    const before = await digest(laneBefore, { limit: 100 }) // three slots, newest first: live, replaced, replacement
    expect(rows(before)).toHaveLength(3)
    expect(before).toContain('nine three one four')
    expect(await digest(laneNow, { limit: 100 })).not.toContain('nine three one four')
  })

  it('carries only what a search would still return, and gives no slot to the rest', async () => {
    const m = await seed()
    const all = await laneNow({ limit: 100, project: REPO, since: NOW - 7 * DAY })
    expect(all.map((h) => h.id).sort()).toEqual([m.live.id, m.replacement.id, m.demoted.id, m.amended.id, m.other.id].sort()) // superseded, suppressed and retracted are gone at the source
    const out = await digest(laneNow, { limit: 100 }) // three lane slots, newest first, minus what the builder drops
    expect(rows(out)).toHaveLength(3)
    expect(out).toContain('shipped the installer check')
    expect(out).toContain('the port moved to nine three one five')
    expect(out).toContain('wired the release workflow')
    for (const gone of ['nine three one four', 'kept failing the build', 'turned out to be wrong', 'shaky guess', 'misremembered', 'the corrected detail']) expect(out).not.toContain(gone)
  })

  it('gives an agent no corrected memory even when nothing else is recent', async () => {
    const m = await seed()
    correctMemory({ id: m.live.id, kind: 'retract', reason: 'wrong', by: 'user' })
    correctMemory({ id: m.replacement.id, kind: 'retract', reason: 'wrong', by: 'user' })
    correctMemory({ id: m.other.id, kind: 'retract', reason: 'wrong', by: 'user' })
    expect(await digest(laneNow, { limit: 100 })).toBeNull() // demoted and amended are marked and dropped by the builder: no digest at all
  })

  it('takes a memory back into the lane when the feedback recovers or the correction is lifted', async () => {
    const m = await seed()
    const listed = async () => (await laneNow({ limit: 100, project: REPO, since: NOW - 7 * DAY })).map((h) => h.id)
    expect(await listed()).not.toContain(m.suppressed.id)
    expect(await listed()).not.toContain(m.retracted.id)
    for (let i = 0; i < 3; i++) memoryFeedback({ id: m.suppressed.id, helpful: true }) // net 0 again
    revokeMemoryCorrection(m.retracted.id)
    const ids = await listed()
    expect(ids).toContain(m.suppressed.id)
    expect(ids).toContain(m.retracted.id)
  })

  it('agrees with the search path: what the lane leaves out, relevance leaves out too, and what stands is shown', async () => {
    await seed()
    const search = async (o: { query: string; limit?: number; project?: string }) => (await memorySearch({ query: o.query, limit: o.limit, project: o.project })) as PrimerHit[]
    const out = await buildContextPrimer(search, { query: 'port fix installer release', project: 'lane-app', projectPath: REPO, recent: laneNow, now: NOW, limit: 100 })
    expect(out).toContain('the port moved to nine three one five') // the replacement stands
    expect(out).not.toContain('nine three one four') // superseded: a search never returns it either
    expect(out).not.toContain('kept failing the build') // suppressed: nor this
  })
})
