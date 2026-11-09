// Router evaluation: the numbers. Pure.

import type { SeedLabel } from '../../src/shared/routerSeeds'
import type { Turn } from './transcripts'

export const LABELS: readonly SeedLabel[] = ['keep', 'haiku', 'sonnet', 'opus']
export type Tier = 'light' | 'medium' | 'heavy'

/** How much answering took, as a stand-in for how hard the prompt was. */
export const LIGHT_MAX_TOOLS = 2
export const LIGHT_MAX_OUT = 1500
export const HEAVY_MIN_TOOLS = 15
export const HEAVY_MIN_OUT = 12000

export function tierOf(t: Pick<Turn, 'toolCalls' | 'outTokens'>): Tier {
  if (t.toolCalls >= HEAVY_MIN_TOOLS || t.outTokens >= HEAVY_MIN_OUT) return 'heavy'
  if (t.toolCalls <= LIGHT_MAX_TOOLS && t.outTokens <= LIGHT_MAX_OUT) return 'light'
  return 'medium'
}

export interface Confusion {
  /** matrix[truth][pred] */
  matrix: Record<SeedLabel, Record<SeedLabel, number>>
  n: number
  correct: number
  accuracy: number
  /** Per truth label: share predicted right. */
  recall: Record<SeedLabel, number>
}

function zeros(): Record<SeedLabel, number> {
  return { keep: 0, haiku: 0, sonnet: 0, opus: 0 }
}

export function confusion(pairs: ReadonlyArray<readonly [SeedLabel, SeedLabel]>): Confusion {
  const matrix = { keep: zeros(), haiku: zeros(), sonnet: zeros(), opus: zeros() }
  let correct = 0
  for (const [t, p] of pairs) { matrix[t][p]++; if (t === p) correct++ }
  const recall = zeros()
  for (const t of LABELS) {
    const row = LABELS.reduce((s, p) => s + matrix[t][p], 0)
    recall[t] = row ? matrix[t][t] / row : 0
  }
  return { matrix, n: pairs.length, correct, accuracy: pairs.length ? correct / pairs.length : 0, recall }
}

const RANK: Partial<Record<SeedLabel, number>> = { haiku: 0, sonnet: 1, opus: 2 }

/** Of the pairs naming a model on both sides: picked weaker than needed (under), stronger (over). */
export function direction(pairs: ReadonlyArray<readonly [SeedLabel, SeedLabel]>): { n: number; under: number; over: number } {
  let n = 0, under = 0, over = 0
  for (const [t, p] of pairs) {
    const a = RANK[t], b = RANK[p]
    if (a === undefined || b === undefined) continue
    n++
    if (b < a) under++
    else if (b > a) over++
  }
  return { n, under, over }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

/** A small seeded generator, so the labelling sample is the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Up to `n` items spread evenly over the groups `key` gives, picked by a seeded shuffle. */
export function stratified<T>(items: readonly T[], key: (t: T) => string, n: number, seed = 1): T[] {
  const r = rng(seed)
  const groups = new Map<string, T[]>()
  for (const it of items) { const k = key(it); const g = groups.get(k); if (g) g.push(it); else groups.set(k, [it]) }
  for (const g of groups.values()) {
    for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [g[i], g[j]] = [g[j], g[i]] }
  }
  const out: T[] = []
  const lists = [...groups.values()]
  for (let i = 0; out.length < n && lists.some((g) => i < g.length); i++) {
    for (const g of lists) if (i < g.length && out.length < n) out.push(g[i])
  }
  return out
}

export function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  return [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n'
}

/** RFC 4180 rows as objects keyed by the header line. Tolerates a BOM and CRLF. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  const s = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row) }
  const [head, ...body] = rows
  if (!head) return []
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

export function asLabel(v: unknown): SeedLabel | null {
  const s = String(v ?? '').trim().toLowerCase()
  return (LABELS as readonly string[]).includes(s) ? (s as SeedLabel) : null
}
