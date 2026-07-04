// memoryTimeline.ts
//
// Pure time-series + activity helpers for the dashboard's "learning over time" chart
// and the live event ticker. Kept pure (clock injected) so every number is unit-tested
// with zero fs/electron — the same discipline as metricsLedger.summarizeMetrics.

const WEEK = 7 * 86_400_000

export interface TimeBucket {
  t: number // bucket end timestamp
  total: number // cumulative memories that existed as of this week
  lessons: number // cumulative distilled lessons (semantic + procedural)
}

/**
 * Cumulative store growth over the last `weeks` weeks — the honest "the brain grows"
 * curve. Each item contributes to its own week and every later one (cumulative).
 * Anything older than the window is folded into the first bucket so the curve starts
 * at the real backlog. Future-dated items (synced peers) count in the newest bucket.
 * Pure — `now` is injected.
 */
export function weeklyGrowth(items: Array<{ ts: number; lesson: boolean }>, now: number, weeks = 12): TimeBucket[] {
  const n = Math.max(1, weeks)
  const addedTotal = new Array(n).fill(0)
  const addedLessons = new Array(n).fill(0)
  for (const it of items) {
    const age = now - it.ts
    let idx: number
    if (age < 0) idx = n - 1 // future-dated → newest bucket
    else idx = n - 1 - Math.floor(age / WEEK)
    if (idx < 0) idx = 0 // older than window → fold into the first bucket
    addedTotal[idx]++
    if (it.lesson) addedLessons[idx]++
  }
  const out: TimeBucket[] = []
  let cum = 0
  let cumL = 0
  for (let i = 0; i < n; i++) {
    cum += addedTotal[i]
    cumL += addedLessons[i]
    out.push({ t: now - (n - 1 - i) * WEEK, total: cum, lessons: cumL })
  }
  return out
}

export type ActivityOp = 'index' | 'ingest' | 'reflect' | 'write' | 'recall' | 'link'

/** Map a memory's provenance to the operation that created it — so the ticker reads as
 *  real activity (code was indexed, transcripts ingested, lessons reflected). Pure. */
export function activityOp(input: { source?: string; kind?: string; lesson?: boolean }): ActivityOp {
  if (input.source === 'code') return 'index'
  if (input.lesson || input.source === 'mneme') return 'reflect'
  if (input.kind === 'message') return 'ingest'
  return 'write'
}
