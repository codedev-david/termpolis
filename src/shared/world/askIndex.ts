// The Ask index: one searchable entry per part of a world, ranked by keyword (BM25) and, when the page ships the
// embedding model, by meaning (int8 bge vectors) fused with reciprocal rank. The exported page rebuilds the keyword
// index in the browser from these same functions, so nothing here may touch Node (no fs, path or electron) and the
// tokenizer is the one function for indexing and querying. Pure and ES2020.
import type { Claim, WorldDoc } from './types'
import { NOT_DESCRIBED, direction, nodeName, sizeNote } from './cardFacts'

/** bge retrieval models expect this instruction prefix on QUERY text only; stored passages are embedded verbatim. */
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
/** Bumped whenever the entry text, the tokenizer or the packing changes, so a stored index is never read as a newer one. */
export const ASK_INDEX_VERSION = 1
/** What a part made only of test files scores, against an equal part of real code (tuned on the fixture world). */
export const TEST_RANK_FACTOR = 0.8
/** Whether a ranking with meaning fuses it with the keyword ranking; the Task 12 gate decides it. */
export const FUSE: boolean = true

export type AskKind = 'building' | 'line' | 'external' | 'term' | 'tour'
export interface AskEntry { id: string; kind: AskKind; name: string; first: string; text: string; test: boolean }

const MAX_MEMBERS = 20
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i

const said = (claims: Claim[]): string => claims.map((c) => c.text).join(' ')
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '')
const join = (parts: string[]): string => parts.filter((p) => p !== '').join(' ')

/** One entry per building, line, outside part, glossary term and tour of the built world (a proposal's parts are not searched). */
export function askEntries(doc: WorldDoc): AskEntry[] {
  const out: AskEntry[] = []
  const testIds = new Set<string>()
  for (const b of doc.buildings) {
    const test = b.members.length > 0 && b.members.every((m) => TEST_FILE.test(m))
    if (test) testIds.add(b.id)
    const district = doc.districts.find((d) => d.id === b.districtId)?.name ?? ''
    out.push({
      id: b.id, kind: 'building', name: b.name, first: b.how.length > 0 ? b.how[0].text : NOT_DESCRIBED, test,
      text: join([b.name, sizeNote(doc, b), said(b.how), said(b.why), join([b.techLabel, ...b.stack]), district, b.members.slice(0, MAX_MEMBERS).map(baseName).join(' ')])
    })
  }
  for (const x of doc.externals) {
    out.push({ id: x.id, kind: 'external', name: x.name, first: x.kind, test: false, text: join([x.name, x.kind]) })
  }
  for (const e of doc.edges) {
    const dir = direction(doc, e).text
    const cargo = doc.cargo[e.cargo]?.label ?? e.cargo
    const name = `${nodeName(doc, e.from)} → ${nodeName(doc, e.to)}`
    out.push({
      id: e.id, kind: 'line', name, first: dir, test: testIds.has(e.from) && testIds.has(e.to),
      text: join([name, dir, said(e.how), said(e.why), cargo, e.tech.join(' ')])
    })
  }
  for (const [term, meaning] of Object.entries(doc.glossary)) {
    out.push({ id: `tech:${term}`, kind: 'term', name: term, first: meaning, test: false, text: join([term, meaning]) })
  }
  for (const t of doc.tours) {
    out.push({
      id: t.id, kind: 'tour', name: t.title, first: t.steps.length > 0 ? t.steps[0].caption : '', test: false,
      text: join([t.title, ...t.steps.map((s) => s.caption)])
    })
  }
  return out
}

// ---------------- keyword ranking: BM25 ----------------
const STOP = new Set(('a an and are as at be by can do does for from has have how i in into is it its me my of on one or ' +
  'own so that the their them they this to up use what when where which who why will with without you your actually other ' +
  'part parts thing things app').split(' '))

/** Lower-case words (camelCase and punctuation split, a crude stem, a short English stopword list removed). */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1') || t)
}

export interface Bm25 { docs: number; avgLen: number; df: Record<string, number>; tf: Record<string, number>[]; len: number[] }

const K1 = 1.2
const B = 0.75

export function buildBm25(texts: string[]): Bm25 {
  const df: Record<string, number> = Object.create(null)
  const tf: Record<string, number>[] = []
  const len: number[] = []
  for (const text of texts) {
    const counts: Record<string, number> = Object.create(null)
    const tokens = tokenize(text)
    for (const t of tokens) counts[t] = (counts[t] ?? 0) + 1
    for (const t of Object.keys(counts)) df[t] = (df[t] ?? 0) + 1
    tf.push(counts)
    len.push(tokens.length)
  }
  const total = len.reduce((a, n) => a + n, 0)
  return { docs: texts.length, avgLen: texts.length > 0 ? total / texts.length : 0, df, tf, len }
}

/** One score per document (0 when no query word is in it). */
export function bm25Scores(ix: Bm25, query: string): number[] {
  const words = Array.from(new Set(tokenize(query)))
  return ix.tf.map((counts, i) => {
    let s = 0
    for (const w of words) {
      const f = counts[w]
      if (!f) continue
      const n = ix.df[w]
      s += Math.log(1 + (ix.docs - n + 0.5) / (n + 0.5)) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * ix.len[i] / ix.avgLen))
    }
    return s
  })
}

// ---------------- meaning ranking: int8 vectors ----------------
export interface PackedVectors { dim: number; scales: number[]; data: Int8Array }

/** One scale per row (largest absolute value over 127), then the row as int8. A zero row packs with scale 0. */
export function packInt8(vectors: number[][]): PackedVectors {
  const dim = vectors.length > 0 ? vectors[0].length : 0
  const scales: number[] = []
  const data = new Int8Array(vectors.length * dim)
  vectors.forEach((v, i) => {
    const scale = v.reduce((m, x) => Math.max(m, Math.abs(x)), 0) / 127
    scales.push(scale)
    if (scale > 0) v.forEach((x, h) => { data[i * dim + h] = Math.round(x / scale) })
  })
  return { dim, scales, data }
}

/** The cosine of the query with every packed row (0 for a zero row or a zero query). */
export function cosineScores(p: PackedVectors, q: Float32Array): number[] {
  let qNorm = 0
  for (let h = 0; h < p.dim; h++) qNorm += q[h] * q[h]
  return p.scales.map((_, i) => {
    let dot = 0
    let norm = 0
    for (let h = 0; h < p.dim; h++) {
      const x = p.data[i * p.dim + h]
      dot += x * q[h]
      norm += x * x
    }
    return norm === 0 || qNorm === 0 ? 0 : dot / Math.sqrt(norm * qNorm)
  })
}

/** Reciprocal rank fusion: each ranking lists ids best first; the result lists every id best first. */
export function rrf(rankings: number[][], k = 60): number[] {
  const score = new Map<number, number>()
  for (const ranking of rankings) ranking.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)))
  return Array.from(score.keys()).sort((a, b) => (score.get(b) as number) - (score.get(a) as number) || a - b)
}

// ---------------- the answer ----------------
export interface AskHit { id: string; kind: AskKind; name: string; first: string }

/** Ids by score, best first (ties keep their order); `positive` leaves out the ones with no score. */
const order = (scores: number[], positive: boolean): number[] =>
  scores.map((_, i) => i).filter((i) => !positive || scores[i] > 0).sort((a, b) => scores[b] - scores[a] || a - b)

/**
 * The best parts for a question. A part made only of test files is scored at TEST_RANK_FACTOR. With meaning scores
 * (and FUSE) the two rankings are fused; otherwise the keyword ranking stands alone, and a question no entry shares a
 * word with (empty, punctuation, only stopwords) answers nothing.
 */
export function rankAsk(entries: AskEntry[], scores: { smart?: number[]; keyword: number[] }, limit = 5): AskHit[] {
  const weigh = (s: number[]): number[] => s.map((x, i) => (entries[i].test ? x * TEST_RANK_FACTOR : x))
  const ids = FUSE && scores.smart
    ? rrf([order(weigh(scores.smart), false), order(weigh(scores.keyword), true)])
    : order(weigh(scores.keyword), true)
  return ids.slice(0, limit).map((i) => ({ id: entries[i].id, kind: entries[i].kind, name: entries[i].name, first: entries[i].first }))
}
