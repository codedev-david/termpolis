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
import { forEachBufferLine } from './fileLines' // byte-safe JSONL reader (never a >512 MiB string; see fileLines.ts)

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
  //
  // THREE different questions, which one number used to answer badly. `embedAvailability` is a
  // LIFETIME average with no window and no decay, but the tile that showed it was labelled "whether
  // the local semantic model is up" — a present-tense STATUS. So a single nine-minute outage (49
  // failed recalls in one evening) pinned a healthy install at 44% indefinitely and painted the tile
  // red, while semantic recall was in fact working perfectly. A proof dashboard that cries wolf about
  // itself is worse than no dashboard. So: report the status and the history separately, and grade
  // only the status.
  embedUp: boolean | null // is the embedder up RIGHT NOW? (the last observation; null = never observed)
  embedRecentUp: number // semantic recalls within the recent window
  embedRecentTotal: number // size of that window (<= EMBED_RECENT_WINDOW)
  embedAvailability: number // LIFETIME fraction available — history, not status. Never graded.
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

/** How many recent embed observations the "recently" figure covers. Small enough that a fixed outage
 *  ages out instead of haunting the tile forever; big enough to be more than one data point. */
export const EMBED_RECENT_WINDOW = 20

/** Aggregate a list of metric events into the dashboard summary. Pure. */
export function summarizeMetrics(events: MetricEvent[], now: number): MetricsSummary {
  let recalls = 0, recallFired = 0, hitsSum = 0, topSum = 0
  const latencies: number[] = [] // per-recall ms — reported as a median, not a mean
  const byPath = { vector: 0, keyword: 0, cache: 0 }
  let embedTotal = 0, embedUp = 0
  const embedRecent: boolean[] = [] // trailing window, so a long-fixed outage decays out of the tile
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
        latencies.push(e.ms || 0)
        if (e.path === 'vector' || e.path === 'keyword' || e.path === 'cache') byPath[e.path]++
        break
      case 'embed':
        embedTotal++
        if (e.available) embedUp++
        embedRecent.push(!!e.available)
        if (embedRecent.length > EMBED_RECENT_WINDOW) embedRecent.shift()
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
  // Median latency, not mean — the very first recall of a session pays the one-time
  // embedding-model cold-load (~1s+), which would drag a mean into the "slow/red" band
  // and misrepresent steady-state performance. The median ignores that lone outlier.
  const sortedMs = latencies.slice().sort((a, b) => a - b)
  const medianLatencyMs = sortedMs.length === 0 ? 0
    : sortedMs.length % 2 === 1 ? sortedMs[(sortedMs.length - 1) / 2]
      : (sortedMs[sortedMs.length / 2 - 1] + sortedMs[sortedMs.length / 2]) / 2
  return {
    generatedTs: now,
    recalls,
    recallFiredRate: recalls > 0 ? recallFired / recalls : 0,
    avgHits: recalls > 0 ? hitsSum / recalls : 0,
    avgTopScore: recalls > 0 ? topSum / recalls : 0,
    avgLatencyMs: medianLatencyMs,
    byPath,
    // Status: the MOST RECENT observation. That, and only that, answers "is semantic recall working".
    embedUp: embedRecent.length > 0 ? embedRecent[embedRecent.length - 1] : null,
    embedRecentUp: embedRecent.filter(Boolean).length,
    embedRecentTotal: embedRecent.length,
    // History: kept, reported, never graded.
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
      // Stream from bytes — this ledger is append-only and NEVER rotated, so never decode the whole
      // file as one 'utf8' string (fatals V8 uncatchably past ~512 MiB; see fileLines.ts).
      forEachBufferLine(fs.readFileSync(filePath), (line) => {
        const t = line.trim()
        if (!t) return
        try {
          const ev = JSON.parse(t) as MetricEvent
          if (ev && typeof ev === 'object' && EVENT_KINDS.has((ev as { t?: string }).t as string)) events.push(ev)
        } catch {
          /* skip a corrupt line */
        }
      })
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
