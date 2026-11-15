// Memory ▸ This week: memoryActivity reports what was learned (lessons + an agent's own decisions, facts
// and notes) and what was replaced (supersedes edges drawn in the window), and memoryGraph's
// supersedeEdgesSince walks the graph for the second half.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory,
  memoryWrite,
  memoryActivity,
  memoryReleaseSupersedes,
  ACTIVITY_LEARNED_MAX,
  ACTIVITY_REPLACED_MAX,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'
import { initMemoryGraph, addMemoryEdge, supersedeEdgesSince, _resetGraphForTests } from '../../src/main/memoryGraph'
import { CANDIDATE_TAG } from '../../src/main/lessonSubstance'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const DAY = 24 * 60 * 60 * 1000

describe('memoryActivity', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'))
    _resetForTests()
    _resetGraphForTests()
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp)
    initMemoryGraph(tmp)
  })
  afterEach(() => {
    _resetForTests()
    _resetGraphForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('an empty store reports nothing, with the default 7-day window', () => {
    const before = Date.now()
    const a = memoryActivity()
    expect(a.counts).toEqual({ lessons: 0, decisions: 0, facts: 0, notes: 0, replaced: 0 })
    expect(a.learned).toEqual([])
    expect(a.replaced).toEqual([])
    expect(a.more).toBe(false)
    expect(a.sinceMs).toBeGreaterThanOrEqual(before - 7 * DAY - 5)
    expect(a.sinceMs).toBeLessThanOrEqual(Date.now() - 7 * DAY + 5)
    // A non-finite sinceMs falls back to the default window too.
    expect(memoryActivity({ sinceMs: Number.NaN }).sinceMs).toBeGreaterThan(0)
  })

  it('counts and lists what was learned in the window, newest first, and leaves out everything else', async () => {
    const now = Date.now()
    await memoryWrite({ agentId: 'claude', kind: 'decision', content: 'Ship the parser behind a flag', project: 'C:/repos/demo', ts: now - 3000 })
    await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'The API listens on port 8080', ts: now - 2000 })
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'Remember to rotate the logs weekly', ts: now - 1000 })
    await memoryWrite({ agentId: 'mneme', kind: 'fact', content: 'Run the linter before pushing', memoryType: 'procedural', source: 'mneme', ts: now - 500 })
    // Not learned: a transcript message, an ingested chunk, a held-back candidate lesson, an entity stub, and an old one.
    await memoryWrite({ agentId: 'claude', kind: 'message', content: 'hello there general', ts: now - 400 })
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'ingested notes chunk text', source: 'notes:x', ts: now - 300 })
    await memoryWrite({ agentId: 'mneme', kind: 'fact', content: 'A candidate lesson held back', memoryType: 'semantic', tags: [CANDIDATE_TAG], ts: now - 200 })
    await memoryWrite({ agentId: 'mneme', kind: 'fact', content: 'Entity: Postgres', memoryType: 'entity', ts: now - 100 })
    await memoryWrite({ agentId: 'claude', kind: 'decision', content: 'An old decision from last month', ts: now - 30 * DAY })

    const a = memoryActivity({ sinceMs: now - 7 * DAY })
    expect(a.counts).toEqual({ lessons: 1, decisions: 1, facts: 1, notes: 1, replaced: 0 })
    expect(a.learned.map((m) => m.content)).toEqual([
      'Run the linter before pushing',
      'Remember to rotate the logs weekly',
      'The API listens on port 8080',
      'Ship the parser behind a flag',
    ])
    expect(a.learned[0]).toMatchObject({ lesson: true, agent: 'mneme', kind: 'fact' })
    expect(a.learned[3]).toMatchObject({ lesson: false, agent: 'claude', kind: 'decision', project: 'demo' })
    expect(a.learned[2].project).toBeUndefined()
  })

  it('cuts long content to a snippet and caps the learned list', async () => {
    const now = Date.now()
    await memoryWrite({ agentId: 'claude', kind: 'note', content: 'x'.repeat(500), ts: now - 10 })
    for (let i = 0; i < ACTIVITY_LEARNED_MAX; i++) {
      await memoryWrite({ agentId: 'claude', kind: 'fact', content: `distinct fact number ${i} about the build`, ts: now - 1000 - i })
    }
    const a = memoryActivity({ sinceMs: now - DAY })
    expect(a.counts.facts + a.counts.notes).toBe(ACTIVITY_LEARNED_MAX + 1)
    expect(a.learned).toHaveLength(ACTIVITY_LEARNED_MAX)
    expect(a.more).toBe(true)
    expect(a.learned[0].content).toHaveLength(240)
    expect(a.learned[0].content.endsWith('…')).toBe(true)
  })

  it('lists replacements drawn in the window with their reason, and Undo brings the older one back', async () => {
    const now = Date.now()
    const old1 = await memoryWrite({ agentId: 'claude', kind: 'decision', content: 'Use MySQL for sessions', project: 'C:/repos/demo', ts: now - 5 * DAY })
    const new1 = await memoryWrite({ agentId: 'claude', kind: 'decision', content: 'Use Postgres for sessions instead of MySQL', project: 'C:/repos/demo', ts: now - 2000 })
    const old2 = await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'Tests run on Node 18', ts: now - 6 * DAY })
    const new2 = await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'Tests run on Node 20 now', ts: now - 1000 })
    const old3 = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'Deploy on Fridays', ts: now - 9 * DAY })
    const new3 = await memoryWrite({ agentId: 'claude', kind: 'note', content: 'Never deploy on Fridays', ts: now - 8 * DAY })
    addMemoryEdge({ from: new1.id, to: old1.id, relation: 'supersedes', createdBy: 'supersede:explicit', ts: now - 2000 })
    // superseded-by is the inverse: the older memory points at the newer one.
    addMemoryEdge({ from: old2.id, to: new2.id, relation: 'superseded-by', createdBy: 'memory_link', ts: now - 1000 })
    // Drawn before the window: not this week.
    addMemoryEdge({ from: new3.id, to: old3.id, relation: 'supersedes', createdBy: 'supersede:contradicts', ts: now - 8 * DAY })
    // An edge whose endpoint is gone from the store is left out.
    addMemoryEdge({ from: 'gone-id', to: old3.id, relation: 'supersedes', createdBy: 'supersede:restated', ts: now - 500 })

    const a = memoryActivity({ sinceMs: now - 7 * DAY })
    expect(a.counts.replaced).toBe(2)
    expect(a.replaced.map((r) => [r.newer.id, r.older.id, r.reason])).toEqual([
      [new2.id, old2.id, 'linked'],
      [new1.id, old1.id, 'explicit'],
    ])
    expect(a.replaced[1].older.content).toBe('Use MySQL for sessions')

    expect(memoryReleaseSupersedes(new1.id)).toBe(1)
    const after = memoryActivity({ sinceMs: now - 7 * DAY })
    expect(after.replaced.map((r) => r.newer.id)).toEqual([new2.id])
  })

  it('caps the replaced list', async () => {
    const now = Date.now()
    for (let i = 0; i < ACTIVITY_REPLACED_MAX + 2; i++) {
      const older = await memoryWrite({ agentId: 'a', kind: 'fact', content: `older statement ${i} alpha`, ts: now - 5000 - i })
      const newer = await memoryWrite({ agentId: 'a', kind: 'fact', content: `newer statement ${i} beta`, ts: now - 100 - i })
      addMemoryEdge({ from: newer.id, to: older.id, relation: 'supersedes', createdBy: 'supersede:restated', ts: now - 100 - i })
    }
    const a = memoryActivity({ sinceMs: now - DAY })
    expect(a.counts.replaced).toBe(ACTIVITY_REPLACED_MAX + 2)
    expect(a.replaced).toHaveLength(ACTIVITY_REPLACED_MAX)
    expect(a.replaced[0].reason).toBe('restated')
    expect(a.more).toBe(true)
  })
})

describe('supersedeEdgesSince', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supersince-'))
    _resetGraphForTests()
  })
  afterEach(() => {
    _resetGraphForTests()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns one row per pair, newest first, skips other relations, old edges and edges with no ts, and honours max', () => {
    // A log line from before edges carried a timestamp counts as earlier, never as this week.
    // A line with a ts but no provenance comes back without createdBy.
    fs.writeFileSync(
      path.join(tmp, 'memory-graph.jsonl'),
      JSON.stringify({ from: 'n0', to: 'o0', relation: 'supersedes', weight: 1 }) + '\n' +
        JSON.stringify({ from: 'n4', to: 'o4', relation: 'supersedes', weight: 1, ts: 900 }) + '\n',
    )
    initMemoryGraph(tmp)
    addMemoryEdge({ from: 'n1', to: 'o1', relation: 'supersedes', createdBy: 'supersede:restated', ts: 1000 })
    addMemoryEdge({ from: 'o1', to: 'n1', relation: 'superseded-by', ts: 1500 }) // same pair, later
    addMemoryEdge({ from: 'n2', to: 'o2', relation: 'supersedes', ts: 2000 })
    addMemoryEdge({ from: 'n3', to: 'o3', relation: 'supersedes', ts: 10 }) // before the window
    addMemoryEdge({ from: 'a', to: 'b', relation: 'related', ts: 3000 })

    const rows = supersedeEdgesSince(500)
    expect(rows.map((r) => [r.newer, r.older, r.ts])).toEqual([['n2', 'o2', 2000], ['n1', 'o1', 1500], ['n4', 'o4', 900]])
    expect(rows[1].createdBy).toBe('system') // addMemoryEdge's default provenance
    expect(rows[2]).not.toHaveProperty('createdBy')
    expect(supersedeEdgesSince(500, 1)).toHaveLength(1)
    expect(supersedeEdgesSince(500, -3)).toEqual([])
    // An earlier duplicate of a pair already seen keeps the later timestamp.
    addMemoryEdge({ from: 'o2', to: 'n2', relation: 'superseded-by', ts: 600 })
    expect(supersedeEdgesSince(500)[0]).toMatchObject({ newer: 'n2', ts: 2000 })
  })
})
