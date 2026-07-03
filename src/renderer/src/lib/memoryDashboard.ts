// Pure transforms for the Memory & Learning dashboard. All display logic lives here
// (fully unit-tested); the SettingsPane component is a thin render over these, so the
// "proof" numbers are deterministic and never computed inside JSX.

import type { MemoryMetrics } from '../types'

/** 1234 → "1.2k", 2_000_000 → "2M". Whole numbers stay whole. */
export function compactNumber(n: number): string {
  if (!isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

/** A 0..1 ratio → a clamped, rounded percent string. */
export function pct(n: number): string {
  return `${Math.round(Math.max(0, Math.min(1, n || 0)) * 100)}%`
}

export interface Receipt { label: string; value: string; sub: string }

/** The four headline "receipt" tiles at the top of the dashboard. */
export function dashboardReceipts(m: MemoryMetrics): Receipt[] {
  return [
    { label: 'Memories stored', value: compactNumber(m.store.total), sub: `${Object.keys(m.store.byType).length} types · ${Object.keys(m.store.bySource).length} sources` },
    { label: 'Lessons learned', value: compactNumber(m.store.lessons), sub: 'distilled semantic + procedural' },
    { label: 'Connections mapped', value: compactNumber(m.graph.edges), sub: `${compactNumber(m.graph.nodes)} nodes · ${Object.keys(m.graph.byRelation).length} relation types` },
    { label: 'Tokens injected', value: compactNumber(m.ledger.tokensInjected), sub: `${m.ledger.injects} primer loads` },
  ]
}

export interface CompRow { key: string; count: number; pct: number }

/** Sort a {name: count} map into descending rows with each row's fraction of the total. */
export function compositionRows(rec: Record<string, number>): CompRow[] {
  const total = Object.values(rec).reduce((a, b) => a + b, 0)
  return Object.entries(rec)
    .map(([key, count]) => ({ key, count, pct: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count)
}

export type SliStatus = 'good' | 'warn' | 'bad' | 'idle'
export interface Sli { label: string; value: string; status: SliStatus }

function gradeRate(r: number, hi: number, mid: number): SliStatus {
  return r >= hi ? 'good' : r >= mid ? 'warn' : 'bad'
}

/** Reliability service-level indicators. Reads "no data / idle" until the relevant
 *  events accrue, so a fresh brain never shows a fake 100%. */
export function reliabilityTiles(m: MemoryMetrics): Sli[] {
  const l = m.ledger
  return [
    { label: 'Recall fired', value: l.recalls > 0 ? pct(l.recallFiredRate) : 'no data', status: l.recalls > 0 ? gradeRate(l.recallFiredRate, 0.9, 0.6) : 'idle' },
    { label: 'Embedding model', value: l.recalls > 0 ? pct(l.embedAvailability) : 'no data', status: l.recalls > 0 ? gradeRate(l.embedAvailability, 0.99, 0.5) : 'idle' },
    { label: 'Write durability', value: l.writes > 0 ? pct(l.writeDurability) : 'no data', status: l.writes > 0 ? gradeRate(l.writeDurability, 0.999, 0.95) : 'idle' },
    { label: 'Avg recall latency', value: l.recalls > 0 ? `${Math.round(l.avgLatencyMs)}ms` : 'no data', status: l.recalls > 0 ? (l.avgLatencyMs < 50 ? 'good' : l.avgLatencyMs < 200 ? 'warn' : 'bad') : 'idle' },
  ]
}

export interface TeachRow { author: string; reader: string; count: number; cross: boolean }

/** Flatten the author→reader teaching matrix into rows (cross=true is real cross-agent reuse). */
export function teachingRows(matrix: Record<string, Record<string, number>>): TeachRow[] {
  const rows: TeachRow[] = []
  for (const [author, readers] of Object.entries(matrix || {})) {
    for (const [reader, count] of Object.entries(readers || {})) {
      rows.push({ author, reader, count, cross: author !== reader })
    }
  }
  return rows.sort((a, b) => b.count - a.count)
}

export interface CompetenceRow { domain: string; confidence: number; attempts: number; status: SliStatus }

/** Per-domain self-competence, strongest first, graded (>=0.85 good, >=0.75 warn, else bad). */
export function competenceRows(m: MemoryMetrics): CompetenceRow[] {
  return m.competence
    .map((c) => ({ domain: c.domain, confidence: c.confidence, attempts: c.attempts, status: (c.confidence >= 0.85 ? 'good' : c.confidence >= 0.75 ? 'warn' : 'bad') as SliStatus }))
    .sort((a, b) => b.confidence - a.confidence)
}

/** True when nothing has been stored yet — the dashboard shows an onboarding note. */
export function isBrainEmpty(m: MemoryMetrics): boolean {
  return m.store.total === 0
}
