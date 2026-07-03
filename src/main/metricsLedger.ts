// metricsLedger.ts
//
// The PROOF substrate for the memory/learning brain: an append-only, DEVICE-LOCAL
// JSONL ledger (memory-metrics.jsonl in userData) recording what the brain actually
// did — every recall, write, inject, feedback, reflection, cross-agent reuse, and
// embed-availability flip — so the dashboard can show honest, offline-computed
// numbers instead of a bare claim that "it learns".
//
// Persistence mirrors mnemeCompetence.ts: append one JSON line per event, replay on
// init. It lives in userData (device-local), NEVER in the synced CRDT shards —
// metrics are per-device observations, not shared truth, so syncing them would
// double-count across machines. Best-effort throughout: a persistence failure never
// breaks the operation being measured.
//
// The aggregation (summarizeMetrics) is PURE and injected the clock, so every number
// the dashboard shows is unit-testable with zero fs/electron.

import fs from 'node:fs'
import path from 'node:path'

export interface RecallEvent { t: 'recall'; ts: number; hits: number; topScore: number; path: 'vector' | 'keyword' | 'cache'; ms: number; agent?: string }
export interface InjectEvent { t: 'inject'; ts: number; tokens: number; agent?: string }
export interface WriteEvent { t: 'write'; ts: number; ok: boolean; memoryType?: string }
export interface FeedbackEvent { t: 'feedback'; ts: number; helpful: boolean }
export interface ReflectEvent { t: 'reflect'; ts: number; lessons: number }
export interface CrossRecallEvent { t: 'cross_recall'; ts: number; author: string; reader: string }
export interface EmbedEvent { t: 'embed'; ts: number; available: boolean }

export type MetricEvent =
  | RecallEvent
  | InjectEvent
  | WriteEvent
  | FeedbackEvent
  | ReflectEvent
  | CrossRecallEvent
  | EmbedEvent

const EVENT_KINDS = new Set(['recall', 'inject', 'write', 'feedback', 'reflect', 'cross_recall', 'embed'])

export interface MetricsSummary {
  generatedTs: number
  // recall
  recalls: number
  recallFiredRate: number // fraction of recalls that returned >=1 hit
  avgHits: number
  avgTopScore: number
  avgLatencyMs: number
  byPath: { vector: number; keyword: number; cache: number }
  // reliability
  embedAvailability: number // fraction of embed observations that were available (1 when none observed)
  writes: number
  writeDurability: number // fraction of writes confirmed persisted (1 when none observed)
  // economics
  injects: number
  tokensInjected: number
  reusedSolutions: number // count of memories the agent confirmed helpful
  tokensSavedEstimate: number // reusedSolutions * avg injected tokens/inject (a documented estimate)
  // feedback
  feedbackCount: number
  feedbackHelpfulRate: number
  // learning
  lessonsLearned: number
  // society
  crossAgentRecalls: number // reuse where author != reader (real cross-agent teaching)
  teachingMatrix: Record<string, Record<string, number>> // author -> reader -> count
}

/** Aggregate a list of metric events into the dashboard summary. Pure. */
export function summarizeMetrics(events: MetricEvent[], now: number): MetricsSummary {
  let recalls = 0, recallFired = 0, hitsSum = 0, topSum = 0, msSum = 0
  const byPath = { vector: 0, keyword: 0, cache: 0 }
  let embedTotal = 0, embedUp = 0
  let writes = 0, writesOk = 0
  let injects = 0, tokensInjected = 0
  let feedbackCount = 0, feedbackHelpful = 0
  let lessonsLearned = 0
  let crossAgentRecalls = 0
  const teachingMatrix: Record<string, Record<string, number>> = {}

  for (const e of events) {
    switch (e.t) {
      case 'recall':
        recalls++
        if (e.hits > 0) recallFired++
        hitsSum += e.hits || 0
        topSum += e.topScore || 0
        msSum += e.ms || 0
        if (e.path === 'vector' || e.path === 'keyword' || e.path === 'cache') byPath[e.path]++
        break
      case 'embed':
        embedTotal++
        if (e.available) embedUp++
        break
      case 'write':
        writes++
        if (e.ok) writesOk++
        break
      case 'inject':
        injects++
        tokensInjected += e.tokens || 0
        break
      case 'feedback':
        feedbackCount++
        if (e.helpful) feedbackHelpful++
        break
      case 'reflect':
        lessonsLearned += e.lessons || 0
        break
      case 'cross_recall': {
        const author = e.author || 'unknown'
        const reader = e.reader || 'unknown'
        if (!teachingMatrix[author]) teachingMatrix[author] = {}
        teachingMatrix[author][reader] = (teachingMatrix[author][reader] || 0) + 1
        if (author !== reader) crossAgentRecalls++
        break
      }
    }
  }

  const reusedSolutions = feedbackHelpful
  const avgInjectTokens = injects > 0 ? tokensInjected / injects : 0
  return {
    generatedTs: now,
    recalls,
    recallFiredRate: recalls > 0 ? recallFired / recalls : 0,
    avgHits: recalls > 0 ? hitsSum / recalls : 0,
    avgTopScore: recalls > 0 ? topSum / recalls : 0,
    avgLatencyMs: recalls > 0 ? msSum / recalls : 0,
    byPath,
    embedAvailability: embedTotal > 0 ? embedUp / embedTotal : 1,
    writes,
    writeDurability: writes > 0 ? writesOk / writes : 1,
    injects,
    tokensInjected,
    reusedSolutions,
    tokensSavedEstimate: Math.round(reusedSolutions * avgInjectTokens),
    feedbackCount,
    feedbackHelpfulRate: feedbackCount > 0 ? feedbackHelpful / feedbackCount : 0,
    lessonsLearned,
    crossAgentRecalls,
    teachingMatrix,
  }
}

// --- persistence (device-local, append-and-replay) ---

const MAX_EVENTS = 20_000 // cap the hot in-memory window; the file keeps the full log
let events: MetricEvent[] = []
let filePath: string | null = null

/** Load the metrics ledger from `dir` (device-local userData). Idempotent. */
export function initMetrics(dir: string): void {
  events = []
  filePath = path.join(dir, 'memory-metrics.jsonl')
  try {
    if (fs.existsSync(filePath)) {
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const ev = JSON.parse(t) as MetricEvent
          if (ev && typeof ev === 'object' && EVENT_KINDS.has((ev as { t?: string }).t as string)) events.push(ev)
        } catch {
          /* skip a corrupt line */
        }
      }
      if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS)
    }
  } catch {
    /* best effort — start empty if the ledger can't be read */
  }
}

/** Append one metric event (best-effort persist + hot-window push). */
export function recordMetric(ev: MetricEvent): void {
  if (!ev || !EVENT_KINDS.has(ev.t)) return
  events.push(ev)
  if (events.length > MAX_EVENTS) events.shift()
  if (filePath) {
    try {
      fs.appendFileSync(filePath, JSON.stringify(ev) + '\n')
    } catch {
      /* best effort — the in-memory event is still counted */
    }
  }
}

/** The dashboard summary over everything recorded this device. */
export function metricsSummary(now: number): MetricsSummary {
  return summarizeMetrics(events, now)
}

/** Number of events currently in the hot window (diagnostics). */
export function metricsEventCount(): number {
  return events.length
}

// --- test seam ---
export function _resetMetricsForTests(): void {
  events = []
  filePath = null
}
