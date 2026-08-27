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

export interface Receipt { label: string; value: string; sub: string; spark?: number[] }

/** The four headline "receipt" tiles at the top of the dashboard. Sparklines come from
 *  the real weekly growth timeline (memories + lessons); the connection/token tiles have
 *  no honest per-tile time series, so they carry none rather than a faked one. */
export function dashboardReceipts(m: MemoryMetrics): Receipt[] {
  const t = m.store.timeline || []
  return [
    { label: 'Memories stored', value: compactNumber(m.store.total), sub: `${Object.keys(m.store.byType).length} types · ${Object.keys(m.store.bySource).length} sources`, spark: t.map((b) => b.total) },
    { label: 'Lessons learned', value: compactNumber(m.store.lessons), sub: 'distilled semantic + procedural', spark: t.map((b) => b.lessons) },
    { label: 'Connections mapped', value: compactNumber(m.graph.edges), sub: `${compactNumber(m.graph.nodes)} nodes · ${Object.keys(m.graph.byRelation).length} relation types` },
    { label: 'Tokens injected', value: compactNumber(m.ledger.tokensInjected), sub: `${m.ledger.injects} primer loads` },
  ]
}

/** The indexed CODE graph as its own receipt — the STRUCTURAL connections (caller->callee
 *  and reference edges) that code_callers / code_callees / code_impact ride on. These live
 *  in a separate store from the semantic memory graph, so they get their own tile rather
 *  than being folded into "Connections mapped" (which would conflate 12k structural edges
 *  with the semantic ones). Null until a repo is actually indexed — never a fake 0. */
export function codeGraphReceipt(m: MemoryMetrics): Receipt | null {
  const cg = m.codeGraph
  if (!cg || cg.edges <= 0) return null
  return {
    label: 'Code connections',
    value: compactNumber(cg.edges),
    sub: `${compactNumber(cg.symbols)} symbols · ${compactNumber(cg.files)} files indexed`,
  }
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
export interface Sli {
  label: string
  value: string
  status: SliStatus
  /** Context under the headline. Informational — never graded, never coloured, never a bar. */
  sub?: string
}

function gradeRate(r: number, hi: number, mid: number): SliStatus {
  return r >= hi ? 'good' : r >= mid ? 'warn' : 'bad'
}

/**
 * The embedding-model tile: STATUS on top, history underneath.
 *
 * It used to show one number — the lifetime fraction of recalls that ran semantic — under a label
 * promising "whether the local semantic model is up". Those are different questions, and it answered
 * the wrong one. A single nine-minute outage (49 consecutive failed recalls one evening) left a
 * perfectly healthy install reading 44% — under the 50% "bad" threshold, so the tile sat there RED
 * while semantic recall worked flawlessly. Worse, the lifetime average has no decay: it would never
 * have recovered.
 *
 * So the headline is now the last observation — up or down, right now, which is the question a user
 * is actually asking — and the historical rate rides underneath as ungraded context.
 */
export function embeddingTile(l: MemoryMetrics['ledger']): Sli {
  if (l.recalls === 0 || l.embedUp === null || l.embedUp === undefined) {
    return { label: 'Embedding model', value: 'no data', status: 'idle' }
  }
  const recent = l.embedRecentTotal > 0
    ? `${l.embedRecentUp} of last ${l.embedRecentTotal} recalls semantic`
    : undefined
  return l.embedUp
    ? { label: 'Embedding model', value: 'up', status: 'good', sub: recent }
    // Down is worth shouting about — but only when it is actually down NOW.
    : { label: 'Embedding model', value: 'down — keyword fallback', status: 'bad', sub: recent }
}

/** Reliability service-level indicators. Reads "no data / idle" until the relevant
 *  events accrue, so a fresh brain never shows a fake 100%. */
export function reliabilityTiles(m: MemoryMetrics): Sli[] {
  const l = m.ledger
  return [
    { label: 'Recall fired', value: l.recalls > 0 ? pct(l.recallFiredRate) : 'no data', status: l.recalls > 0 ? gradeRate(l.recallFiredRate, 0.9, 0.6) : 'idle' },
    embeddingTile(l),
    { label: 'Write durability', value: l.writes > 0 ? pct(l.writeDurability) : 'no data', status: l.writes > 0 ? gradeRate(l.writeDurability, 0.999, 0.95) : 'idle' },
    // Thresholds reflect the post-v1.26.0 architecture: a recall is a cross-process round-trip to the
    // memory utilityProcess PLUS a bge query-embed — whose honest warm floor is ~150 ms, not the
    // in-process function call the old 50/200 ms thresholds assumed. Warming the embedder at boot keeps
    // cold-start spikes out of the median; >600 ms is genuinely slow and still flagged.
    { label: 'Recall latency', value: l.recalls > 0 ? `${Math.round(l.avgLatencyMs)}ms` : 'no data', status: l.recalls > 0 ? (l.avgLatencyMs < 250 ? 'good' : l.avgLatencyMs < 600 ? 'warn' : 'bad') : 'idle' },
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

/** Below this many attempts a domain is too thin to grade: a lone success has a Wilson lower bound
 *  of ~0.21, which is honest math but not evidence the brain is BAD at the domain. Mirrors
 *  mnemeMeta's MIN_EVIDENCE so this tile agrees with assessDomain (which reads such a record
 *  'unproven', never 'caution'). */
const MIN_COMPETENCE_EVIDENCE = 3

/** Per-domain self-competence, strongest first. Graded on the Wilson bound (>=0.85 good, >=0.75
 *  warn, else bad) ONCE there is enough evidence; a thin record (<3 attempts) is 'idle' (unproven),
 *  never a red failure — so a single win does not paint an alarming bar labelled like a weakness. */
export function competenceRows(m: MemoryMetrics): CompetenceRow[] {
  return m.competence
    .map((c) => ({
      domain: c.domain,
      confidence: c.confidence,
      attempts: c.attempts,
      status: (c.attempts < MIN_COMPETENCE_EVIDENCE
        ? 'idle'
        : c.confidence >= 0.85
          ? 'good'
          : c.confidence >= 0.75
            ? 'warn'
            : 'bad') as SliStatus,
    }))
    .sort((a, b) => b.confidence - a.confidence)
}

/** F31: the last reload hit shard files it could not read. Everything in `store` is then a floor,
 *  not the truth, and the "your brain is empty" onboarding copy would be an outright lie — that is
 *  precisely how a 2.27 GB store spent a day presenting itself as a brand-new install with zero
 *  lessons. Checked BEFORE isBrainEmpty, and it suppresses it. */
export function hasUnreadableShards(m: MemoryMetrics): boolean {
  return (m.store.unreadableShards ?? 0) > 0
}

/** True when nothing has been stored yet — the dashboard shows an onboarding note. Never true
 *  while a shard failed to load: "empty" and "couldn't be read" are different facts. */
export function isBrainEmpty(m: MemoryMetrics): boolean {
  return m.store.total === 0 && !hasUnreadableShards(m)
}

/** SVG polyline + closed-area paths for a series in a `w`×`h` box (with `pad` inset).
 *  Used for both the tile sparklines and the learning-over-time area chart. Pure. */
export function svgLine(values: number[], w: number, h: number, pad = 0): { line: string; area: string; max: number } {
  const n = values.length
  if (n === 0) return { line: '', area: '', max: 0 }
  const max = Math.max(1, ...values)
  const min = Math.min(0, ...values)
  const span = max - min || 1
  const X = (i: number): number => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1))
  const Y = (v: number): number => h - pad - ((v - min) / span) * (h - 2 * pad)
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${X(n - 1).toFixed(1)} ${(h - pad).toFixed(1)} L${X(0).toFixed(1)} ${(h - pad).toFixed(1)} Z`
  return { line, area, max }
}

const KNOWN_SOURCE: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', code: 'Code index', mneme: 'Reflection', swarm: 'Swarm', unknown: 'Unknown',
}

/** Friendly display name for a memory's source/author. Known agents get proper names;
 *  raw terminal ids (UUID / long hex — how live-session writes are tagged) collapse to
 *  "session a35ab45…" so the dashboard never shows a bare machine id. Pure. */
export function sourceLabel(source: string): string {
  if (KNOWN_SOURCE[source]) return KNOWN_SOURCE[source]
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(source) || /^[0-9a-f]{12,}$/i.test(source)) return `session ${source.slice(0, 7)}…`
  return source
}

export interface PortabilityRow { model: string; label: string; wrote: number; cross: number }

/** Model portability: memories each source AUTHORED (real, from store composition) and
 *  how many of its lessons a DIFFERENT agent later reused (cross, from the teaching
 *  matrix — 0 until real cross-agent reuse happens). Strongest authors first. Pure. */
export function portabilityRows(bySource: Record<string, number>, teaching: Record<string, Record<string, number>>): PortabilityRow[] {
  const crossByAuthor: Record<string, number> = {}
  for (const [author, readers] of Object.entries(teaching || {})) {
    for (const [reader, n] of Object.entries(readers || {})) {
      if (author !== reader) crossByAuthor[author] = (crossByAuthor[author] || 0) + n
    }
  }
  return Object.entries(bySource)
    .map(([model, wrote]) => ({ model, label: sourceLabel(model), wrote, cross: crossByAuthor[model] || 0 }))
    .sort((a, b) => b.wrote - a.wrote)
    .slice(0, 8)
}

/** Cognitive-type → color, shared by the composition bars, the graph nodes and the
 *  legend so the five facets read identically everywhere. These are the dataviz-skill
 *  reference palette's validated categorical slots (dark mode), assigned so the three
 *  the eye must separate — episodic/semantic/entity — land on maximally-distinct hues
 *  (blue / violet / amber) and the two dominant graph types (episodic, entity) are a
 *  cool/warm pair. Validated: all pass lightness/chroma/contrast on the #12161f canvas;
 *  worst CVD pair 10.3 (floor band) — legal because every mark carries a label/legend. */
export const TYPE_COLOR: Record<string, string> = {
  episodic: '#3987e5', // blue — raw ingested transcript/code ("what happened")
  semantic: '#9085e9', // violet — distilled facts & decisions
  procedural: '#199e70', // aqua — how-to recipes (error → fix)
  entity: '#c98500', // amber — a canonical artifact (file, function, error)
  summary: '#008300', // green — a rollup of many memories
  untyped: '#64748b',
}
export const typeColor = (t: string): string => TYPE_COLOR[t] || '#3987e5'

/** Recent-activity op → accent color key (for the ticker). Aligned with TYPE_COLOR so
 *  index≈entity, ingest≈episodic, reflect≈semantic read consistently. Pure lookup. */
export const OP_COLOR: Record<string, string> = {
  index: '#c98500', ingest: '#3987e5', reflect: '#9085e9', write: '#199e70', recall: '#3987e5', link: '#008300',
}
