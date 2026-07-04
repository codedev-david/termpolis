import { describe, it, expect } from 'vitest'
import { weeklyGrowth, activityOp } from '../../src/main/memoryTimeline'

const WEEK = 7 * 86_400_000
const NOW = 1_700_000_000_000

describe('weeklyGrowth — cumulative store growth', () => {
  it('returns one bucket per week, newest last', () => {
    const out = weeklyGrowth([], NOW, 12)
    expect(out).toHaveLength(12)
    expect(out[11].t).toBe(NOW)
    expect(out[0].t).toBe(NOW - 11 * WEEK)
    expect(out.every((b) => b.total === 0)).toBe(true)
  })

  it('accumulates totals and lessons into the right weeks', () => {
    const items = [
      { ts: NOW, lesson: true }, // this week
      { ts: NOW - WEEK, lesson: false }, // last week
      { ts: NOW - 2 * WEEK, lesson: true }, // 2 weeks ago
    ]
    const out = weeklyGrowth(items, NOW, 4)
    // cumulative totals rise: oldest bucket sees the 2-weeks-ago item, newest sees all 3
    expect(out[out.length - 1].total).toBe(3)
    expect(out[out.length - 1].lessons).toBe(2)
    expect(out[out.length - 1].total).toBeGreaterThanOrEqual(out[0].total)
  })

  it('folds items older than the window into the first bucket (real backlog)', () => {
    const items = [{ ts: NOW - 100 * WEEK, lesson: false }, { ts: NOW - 100 * WEEK, lesson: true }]
    const out = weeklyGrowth(items, NOW, 4)
    expect(out[0].total).toBe(2) // both counted from the start
    expect(out[3].total).toBe(2) // still 2 at the end (cumulative)
    expect(out[3].lessons).toBe(1)
  })

  it('counts future-dated (synced-peer) items in the newest bucket', () => {
    const out = weeklyGrowth([{ ts: NOW + 5 * WEEK, lesson: false }], NOW, 3)
    expect(out[2].total).toBe(1)
  })
})

describe('activityOp — provenance → operation label', () => {
  it('code → index, message → ingest, mneme/lesson → reflect, else write', () => {
    expect(activityOp({ source: 'code', kind: 'note' })).toBe('index')
    expect(activityOp({ source: 'claude', kind: 'message' })).toBe('ingest')
    expect(activityOp({ source: 'mneme', kind: 'fact' })).toBe('reflect')
    expect(activityOp({ kind: 'fact', lesson: true })).toBe('reflect')
    expect(activityOp({ kind: 'note' })).toBe('write')
  })
})
