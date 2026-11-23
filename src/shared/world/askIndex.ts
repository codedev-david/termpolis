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
/**
 * What a part made only of test files scores, against an equal part of real code. The fixture world has no part made
 * only of tests, so the quality gate cannot move it: it stays at 0.8.
 */
export const TEST_RANK_FACTOR = 0.8
/**
 * Whether a ranking with meaning fuses it with the keyword ranking. The quality gate (tests/electron/worldAskQuality)
 * measured top-3 on its 15 questions: smart 13, fused 13, keyword 12. Fused ties smart and never ranks below keyword,
 * so it stays on.
 */
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

/**
 * Lower-case words (camelCase and punctuation split, a crude stem, a short English stopword list removed). A word is a
 * run of letters, numbers and marks in any script, in one Unicode form (NFC), so a Hebrew, Arabic, Chinese or Cyrillic
 * name is a word and an accented name typed composed or decomposed is the same word. A single ASCII letter or digit is
 * no word, as before; emoji and symbols never are.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => /[\p{L}\p{N}]/u.test(t) && !/^[a-z0-9]$/.test(t) && !STOP.has(t))
    .map((t) => t.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1') || t)
}

/** A name or question as typed, for the exact-name match: one Unicode form, lower case, spaces trimmed and folded. */
const plainName = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

/** Rebuilt in memory from the texts, never JSON round-tripped: the null-prototype maps do not survive JSON. */
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
  vectors.forEach((row, i) => {
    if (row.length !== dim) throw new Error(`packInt8: ragged row ${i} (${row.length} values, expected ${dim})`)
    const v = row.map((x) => (Number.isFinite(x) ? x : 0)) // NaN and infinities count as 0
    const scale = v.reduce((m, x) => Math.max(m, Math.abs(x)), 0) / 127
    scales.push(scale)
    if (scale > 0) v.forEach((x, h) => { data[i * dim + h] = Math.max(-127, Math.min(127, Math.round(x / scale))) })
  })
  return { dim, scales, data }
}

/** The cosine of the query with every packed row (0 for a zero row, a zero query, or a query not `dim` wide). */
export function cosineScores(p: PackedVectors, q: Float32Array): number[] {
  if (q.length !== p.dim) return p.scales.map(() => 0)
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

/** nameFit's score for a question that is an entry's whole name (stopwords aside). */
export const WHOLE_NAME = 2

/**
 * How much of each entry's own name the question says, as a lead for rankAsk (0 for none):
 * - every word of the question is in the name: 1 plus the share of the name's words said, so WHOLE_NAME for the whole
 *   name. "memory" is half of "Memory host" (1.5) but a third of the line "Memory host → Embedder" (1.33), whose name
 *   is the two names it joins;
 * - the question says every word of the name among other words ("how does the token proxy work"): the share of the
 *   question's words the name fills, below 1, so a question wholly inside a name always fits it better;
 * - otherwise 0, as for a name with no words of its own (a stopword, one letter, punctuation), which every question
 *   would otherwise contain;
 * - except that a name with no letter or number at all (an emoji, an arrow) fits a question that is that whole name,
 *   as typed: WHOLE_NAME.
 */
export function nameFit(entries: AskEntry[], question: string): number[] {
  const asked = Array.from(new Set(tokenize(question)))
  const typed = plainName(question)
  return entries.map((e) => {
    // A name with no letter or number (an emoji, an arrow) has no words: only the whole name, as typed, fits it.
    if (!/[\p{L}\p{N}]/u.test(e.name)) return typed !== '' && plainName(e.name) === typed ? WHOLE_NAME : 0
    const name = new Set(tokenize(e.name))
    if (asked.length === 0 || name.size === 0) return 0
    if (asked.every((w) => name.has(w))) return 1 + asked.length / name.size
    const said = asked.filter((w) => name.has(w)).length
    return said === name.size ? said / asked.length : 0
  })
}

/** Which kind leads when two entries fit a question's name equally: the part itself before what mentions it. */
const KIND_LEAD: Record<AskKind, number> = { building: 0, external: 0, line: 1, term: 2, tour: 3 }

/**
 * The best parts for a question. A part made only of test files is scored at TEST_RANK_FACTOR. With meaning scores
 * of one per entry (and FUSE) the two rankings are fused; otherwise the keyword ranking stands alone, and a question no entry shares a
 * word with (empty, punctuation, only stopwords) answers nothing. With `named` (nameFit of the question), the entries
 * that fit the question's name best lead, a building or outside part before a line, a term and a tour, then in the
 * order the ranking gives them; the rest keep their place. A newcomer who types a name, or says one in a sentence,
 * gets that part first, above the lines that only repeat the name (both rankings like those short texts). A test part
 * leads only for its whole name: otherwise it keeps its demoted place, below any part that leads.
 */
export function rankAsk(entries: AskEntry[], scores: { smart?: number[]; keyword: number[]; named?: number[] }, limit = 5): AskHit[] {
  if (scores.keyword.length !== entries.length) {
    throw new Error(`rankAsk: ${scores.keyword.length} keyword scores for ${entries.length} entries`)
  }
  // Demotion lowers a score whatever its sign (a negative cosine times 0.8 would rise).
  const weigh = (s: number[]): number[] => s.map((x, i) => (entries[i].test ? x - Math.abs(x) * (1 - TEST_RANK_FACTOR) : x))
  const smart = scores.smart && scores.smart.length === entries.length ? scores.smart : undefined
  const named = scores.named
  if (named && named.length !== entries.length) {
    throw new Error(`rankAsk: ${named.length} name fits for ${entries.length} entries`)
  }
  const ranked = FUSE && smart
    ? rrf([order(weigh(smart), false), order(weigh(scores.keyword), true)])
    : order(weigh(scores.keyword), true)
  const lead = (named ?? []).map((x, i) => (entries[i].test && x < WHOLE_NAME ? 0 : x))
  const best = lead.reduce((m, x) => Math.max(m, x), 0)
  const leads = (i: number): boolean => best > 0 && lead[i] === best
  // A whole name leads even when no keyword finds it (an emoji name has no words); a partial fit never adds a part.
  const unranked = best >= WHOLE_NAME ? lead.map((_, i) => i).filter((i) => leads(i) && ranked.indexOf(i) < 0) : []
  const first = ranked.filter(leads).concat(unranked).sort((a, b) => KIND_LEAD[entries[a].kind] - KIND_LEAD[entries[b].kind])
  const ids = first.concat(ranked.filter((i) => !leads(i)))
  return ids.slice(0, limit).map((i) => ({ id: entries[i].id, kind: entries[i].kind, name: entries[i].name, first: entries[i].first }))
}
