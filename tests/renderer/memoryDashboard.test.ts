import { describe, it, expect } from 'vitest'
import {
  compactNumber,
  pct,
  dashboardReceipts,
  compositionRows,
  reliabilityTiles,
  teachingRows,
  competenceRows,
  isBrainEmpty,
  hasUnreadableShards,
  svgLine,
  portabilityRows,
  codeGraphReceipt,
} from '../../src/renderer/src/lib/memoryDashboard'
import type { MemoryMetrics } from '../../src/renderer/src/types'

function mm(over: Partial<MemoryMetrics> = {}): MemoryMetrics {
  return {
    ledger: {
      generatedTs: 0,
      recalls: 0, recallFiredRate: 0, avgHits: 0, avgTopScore: 0, avgLatencyMs: 0,
      byPath: { vector: 0, keyword: 0, cache: 0 },
      embedAvailability: 1, writes: 0, writeDurability: 1,
      injects: 0, tokensInjected: 0, reusedSolutions: 0, tokensSavedEstimate: 0,
      feedbackCount: 0, feedbackHelpfulRate: 0,
      lessonsLearned: 0, crossAgentRecalls: 0, teachingMatrix: {},
      ...(over.ledger || {}),
    },
    store: { total: 0, capacity: 500000, byType: {}, bySource: {}, lessons: 0, timeline: [], ...(over.store || {}) },
    graph: { nodes: 0, edges: 0, byRelation: {}, ...(over.graph || {}) },
    competence: over.competence || [],
    recentActivity: over.recentActivity || [],
    codeGraph: over.codeGraph,
  }
}

describe('memoryDashboard — formatters', () => {
  it('compactNumber abbreviates thousands and millions', () => {
    expect(compactNumber(0)).toBe('0')
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1000)).toBe('1k')
    expect(compactNumber(1500)).toBe('1.5k')
    expect(compactNumber(12847)).toBe('12.8k')
    expect(compactNumber(1840000)).toBe('1.84M')
    expect(compactNumber(2000000)).toBe('2M')
  })

  it('pct rounds and clamps to 0..100', () => {
    expect(pct(0.5)).toBe('50%')
    expect(pct(0.9234)).toBe('92%')
    expect(pct(1.5)).toBe('100%')
    expect(pct(-1)).toBe('0%')
  })
})

describe('memoryDashboard — transforms', () => {
  it('dashboardReceipts surfaces the four headline numbers', () => {
    const r = dashboardReceipts(mm({
      store: { total: 12847, capacity: 500000, byType: { episodic: 9000, semantic: 2000 }, bySource: { claude: 6000 }, lessons: 2920, timeline: [] },
      graph: { nodes: 12847, edges: 18431, byRelation: { 'relates-to': 9000, solves: 100 } },
      ledger: { ...mm().ledger, tokensInjected: 3100, injects: 4 },
    }))
    expect(r).toHaveLength(4)
    expect(r[0].value).toBe('12.8k') // memories
    expect(r[1].value).toBe('2.9k')  // lessons
    expect(r[2].value).toBe('18.4k') // connections (edges)
    expect(r[3].value).toBe('3.1k')  // tokens injected
  })

  it('codeGraphReceipt surfaces the indexed code graph as real connections', () => {
    const r = codeGraphReceipt(mm({ codeGraph: { files: 120, symbols: 2440, edges: 12260 } }))
    expect(r).not.toBeNull()
    expect(r!.label).toBe('Code connections')
    expect(r!.value).toBe('12.3k') // call/reference edges — the structural graph
    expect(r!.sub).toContain('2.4k') // symbols
    expect(r!.sub).toContain('120') // files
  })

  it('codeGraphReceipt is null until a repo is indexed (never a fake 0)', () => {
    expect(codeGraphReceipt(mm())).toBeNull()
    expect(codeGraphReceipt(mm({ codeGraph: { files: 0, symbols: 0, edges: 0 } }))).toBeNull()
  })

  it('compositionRows sorts by count and computes fractions', () => {
    const rows = compositionRows({ episodic: 60, semantic: 30, procedural: 10 })
    expect(rows[0]).toMatchObject({ key: 'episodic', count: 60 })
    expect(rows[0].pct).toBeCloseTo(0.6)
    expect(rows[2].key).toBe('procedural')
  })

  it('compositionRows is empty (no NaN) for an empty record', () => {
    expect(compositionRows({})).toEqual([])
  })

  it('reliabilityTiles reads "no data / idle" until events accrue', () => {
    const tiles = reliabilityTiles(mm())
    expect(tiles.every((t) => t.value === 'no data' && t.status === 'idle')).toBe(true)
  })

  it('reliabilityTiles grades recall/embedding/durability/latency once there is data', () => {
    const tiles = reliabilityTiles(mm({
      ledger: { ...mm().ledger, recalls: 100, recallFiredRate: 0.99, embedAvailability: 1, writes: 50, writeDurability: 1, avgLatencyMs: 12 },
    }))
    const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]))
    expect(byLabel['Recall fired'].status).toBe('good')
    expect(byLabel['Recall fired'].value).toBe('99%')
    expect(byLabel['Recall latency'].value).toBe('12ms')
    expect(byLabel['Recall latency'].status).toBe('good')
  })

  it('teachingRows flattens the matrix and flags cross-agent reuse, sorted desc', () => {
    const rows = teachingRows({ gemini: { claude: 96, gemini: 4 }, claude: { codex: 20 } })
    expect(rows[0]).toEqual({ author: 'gemini', reader: 'claude', count: 96, cross: true })
    expect(rows.find((r) => r.author === 'gemini' && r.reader === 'gemini')?.cross).toBe(false)
  })

  it('competenceRows sorts by confidence and grades it', () => {
    const rows = competenceRows(mm({ competence: [
      { domain: 'swarm', attempts: 5, confidence: 0.6 },
      { domain: 'memory-brain', attempts: 20, confidence: 0.94 },
    ] }))
    expect(rows[0].domain).toBe('memory-brain')
    expect(rows[0].status).toBe('good')
    expect(rows[1].status).toBe('bad')
  })

  it('competenceRows grades a thin track record (<3 attempts) as unproven/idle, not a red failure', () => {
    // A lone success has a Wilson lower bound of ~0.21 — mathematically right, but too little
    // evidence to call the brain "bad" at a domain. assessDomain (mnemeMeta) reserves judgement
    // below MIN_EVIDENCE=3; the tile must agree, or a single win paints an alarming red bar.
    const rows = competenceRows(mm({ competence: [
      { domain: 'fresh-1', attempts: 1, confidence: 0.21 },
      { domain: 'fresh-2', attempts: 2, confidence: 0.5 },
    ] }))
    expect(rows.every((r) => r.status === 'idle')).toBe(true)
  })

  it('competenceRows grades a domain on confidence once it has enough evidence (>=3 attempts)', () => {
    const rows = competenceRows(mm({ competence: [
      { domain: 'weak', attempts: 3, confidence: 0.4 },
    ] }))
    expect(rows[0].status).toBe('bad') // three attempts is enough to actually call it
  })

  // F31: total === 0 is NOT proof of an empty brain. A shard the OS refused to hand over loads as
  // zero entries, and the onboarding copy ("your brain is empty — it fills as you work") then lies
  // over a 2.27 GB store. "Empty" and "couldn't be read" have to stay distinguishable.
  it('hasUnreadableShards reports a failed load, and suppresses the empty-brain note', () => {
    const healthy = mm()
    expect(hasUnreadableShards(healthy)).toBe(false)
    expect(isBrainEmpty(healthy)).toBe(true)

    const broken = mm({ store: { total: 0, capacity: 1, byType: {}, bySource: {}, lessons: 0, timeline: [], unreadableShards: 1 } })
    expect(hasUnreadableShards(broken)).toBe(true)
    expect(isBrainEmpty(broken)).toBe(false) // never "your brain is empty" over a store that failed to load

    // Absent (an older main process) reads as zero, not as a failure.
    const legacy = mm({ store: { total: 0, capacity: 1, byType: {}, bySource: {}, lessons: 0, timeline: [] } })
    expect(hasUnreadableShards(legacy)).toBe(false)
  })

  it('isBrainEmpty is true only when nothing is stored', () => {
    expect(isBrainEmpty(mm())).toBe(true)
    expect(isBrainEmpty(mm({ store: { total: 1, capacity: 1, byType: {}, bySource: {}, lessons: 0, timeline: [] } }))).toBe(false)
  })
})

describe('memoryDashboard — chart + portability helpers', () => {
  it('svgLine builds line + closed-area paths and reports the max', () => {
    const { line, area, max } = svgLine([0, 5, 10], 100, 50, 5)
    expect(max).toBe(10)
    expect(line.startsWith('M')).toBe(true)
    expect(area.endsWith('Z')).toBe(true)
    expect(line).toContain('L') // more than one point
  })

  it('svgLine is safe for empty and single-point series', () => {
    expect(svgLine([], 100, 50)).toEqual({ line: '', area: '', max: 0 })
    const one = svgLine([7], 100, 50)
    expect(one.max).toBe(7)
    expect(one.line.startsWith('M')).toBe(true)
  })

  it('portabilityRows shows authored counts (desc) and real cross-agent reuse', () => {
    const rows = portabilityRows(
      { claude: 6000, code: 55000, gemini: 30 },
      { gemini: { claude: 12, gemini: 3 }, claude: { claude: 5 } }, // gemini taught claude 12×; claude only self-reuse
    )
    expect(rows[0]).toMatchObject({ model: 'code', label: 'Code index', wrote: 55000, cross: 0 })
    const gem = rows.find((r) => r.model === 'gemini')!
    expect(gem).toMatchObject({ label: 'Gemini', wrote: 30, cross: 12 })
    const cla = rows.find((r) => r.model === 'claude')!
    expect(cla.cross).toBe(0) // self-reuse is not cross-agent
  })
})
