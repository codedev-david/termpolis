import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isHighValueEpisode, type Episode } from '../../src/main/mnemeReflect'
import { initMemoryGraph, addMemoryEdge, graphRelationStats, _resetGraphForTests } from '../../src/main/memoryGraph'

vi.mock('../../src/main/telemetry', () => ({ recordSwarmError: vi.fn() }))
import {
  initSwarmMemory,
  memoryWrite,
  memoryLink,
  memoryRelated,
  memoryGraphRelationStats,
  _resetForTests,
  _setEmbeddingsAvailable,
} from '../../src/main/swarmMemory'

const ep = (over: Partial<Episode> = {}): Episode => ({ id: 'e', turns: [], ...over })

describe('isHighValueEpisode — the distiller value gate (C7)', () => {
  it('is true only for a substantive, grounded, successful episode', () => {
    const turns = [{ role: 'user' as const, text: 'do X' }, { role: 'assistant' as const, text: 'fixed X in a.ts' }]
    expect(isHighValueEpisode(ep({ turns, outcome: { kind: 'test', success: true } }))).toBe(true)
    expect(isHighValueEpisode(ep({ turns, outcome: { kind: 'test', success: false } }))).toBe(false) // failed
    expect(isHighValueEpisode(ep({ turns }))).toBe(false) // no outcome
    expect(isHighValueEpisode(ep({ turns: [turns[0]], outcome: { kind: 'test', success: true } }))).toBe(false) // thin
  })
})

describe('graphRelationStats — relation-quality breakdown (C7)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grs-')); _resetGraphForTests(); initMemoryGraph(dir) })
  afterEach(() => { _resetGraphForTests(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('counts edges by relation so the high-signal ratio is visible', () => {
    addMemoryEdge({ from: 'a', to: 'b', relation: 'relates-to', weight: 0.5, ts: 1 })
    addMemoryEdge({ from: 'a', to: 'c', relation: 'relates-to', weight: 0.5, ts: 1 })
    addMemoryEdge({ from: 'd', to: 'e', relation: 'solves', weight: 1, ts: 1 })
    const stats = graphRelationStats()
    expect(stats['relates-to']).toBe(2)
    expect(stats['solves']).toBe(1)
  })
})

describe('memory_related is UNDIRECTED (C7) — follow the thread from a fix back to its bug', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')); _resetForTests(); initSwarmMemory(dir); _setEmbeddingsAvailable(false) })
  afterEach(() => { _resetForTests(); vi.restoreAllMocks(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('surfaces a node reachable only via an INCOMING edge', async () => {
    // Deliberately dissimilar content, so ONLY the edge path (not vector overlap) can connect them.
    const bug = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'zzz alpha widget crash on startup' })
    const fix = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'qqq beta gadget throttle tuning' })
    memoryLink({ from: bug.id, to: fix.id, relation: 'solves' }) // bug --solves--> fix (fix has only an INCOMING edge)

    const related = await memoryRelated({ id: fix.id })
    expect(related.some((r) => r.id === bug.id)).toBe(true) // reachable via the inverse (solved-by) — edgesFrom would miss it
  })

  it('exposes the relation-quality breakdown through the store passthrough', async () => {
    const a = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'one' })
    const b = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'two' })
    memoryLink({ from: a.id, to: b.id, relation: 'supersedes' })
    expect(memoryGraphRelationStats()['supersedes']).toBeGreaterThanOrEqual(1)
  })
})
