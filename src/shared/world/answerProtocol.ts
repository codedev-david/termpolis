// Lumopolis ask protocol: the instructions appended to every question prompt, and the tolerant
// parser for the agent's answer. The parser never throws and never trusts ids: anything that is
// not in the WorldDoc is removed and counted in `dropped`.
import type { Evidence, WorldAction, WorldDoc } from './types'

/** Spec gap #101: an answer the evidence does not support says so, and its parts are drawn in fog. */
export const HONESTY_RULE = 'If the WORLD DATA and evidence do not support an answer (for example nothing records why something was built this way), say so plainly in your first sentence, do not guess, and add {"type":"fog","ids":[...]} for the parts you could not support.'

export const ANSWER_PROTOCOL = `Answer in plain language for someone who does not read code. Keep it under 150 words.
After your answer, add one fenced block tagged world-actions containing a JSON array of steps
that show your answer in the World. Allowed steps:
{"type":"focus","ids":[...]} {"type":"highlight","ids":[...]} {"type":"flow","edgeIds":[...]}
{"type":"openCard","id":"..."} {"type":"tour","steps":[{"ids":[...],"caption":"..."}]} {"type":"reset"}
Use only ids from the WORLD DATA. Cite evidence inline as [E<n>] using the labels in the WORLD DATA.
Put [A<n>] in your text where step n (1-based) should play.
${HONESTY_RULE}`

/** Reading pace of the reveal: each sentence stays on show this long per word, and never less than the minimum. */
export const REVEAL_MS_PER_WORD = 70
export const MIN_SENTENCE_MS = 600

/** How long a sentence is read before the next one appears; 0 with reduced motion. */
export const revealMs = (text: string, reducedMotion: boolean): number =>
  reducedMotion ? 0 : Math.max(MIN_SENTENCE_MS, text.split(/\s+/).filter(Boolean).length * REVEAL_MS_PER_WORD)

/** What stands between a sentence and the one before it: nothing (the first), a space, a line break or a blank line
 *  (a new paragraph), so an answer shown sentence by sentence keeps its paragraphs. */
export type SentenceSep = '' | ' ' | '\n' | '\n\n'

/** One sentence of the answer, the break in front of it, and the indexes (into `actions`) of the steps that play as
 *  it appears. */
export interface AnswerSentence { text: string; actions: number[]; sep: SentenceSep }

/** The break the whitespace in front of a sentence stands for (`first`: nothing goes before the first sentence). */
export function sepOf(lead: string, first: boolean): SentenceSep {
  if (first) return ''
  const breaks = (lead.match(/\n/g) ?? []).length
  return breaks >= 2 ? '\n\n' : breaks === 1 ? '\n' : ' '
}

/** The first `count` sentences, each after its own break (the first has none), so paragraphs survive. */
export const answerText = (sentences: AnswerSentence[], count: number): string =>
  sentences.slice(0, count).map((s) => s.sep + s.text).join('')

export interface WorldAnswer {
  text: string
  /** The text split on sentence ends, each with the steps its [A<n>] markers name (markers removed). */
  sentences: AnswerSentence[]
  actions: WorldAction[]; evidence: Evidence[]; dropped: number
  /** Ids from the answer's fog steps: the parts the evidence does not support. */
  unsupported: string[]
  /** True when the answer has text but no [E<n>] marker. */
  uncited: boolean
}

const MAX_TOUR_STEPS = 12
const BLOCK_RE = /```world-actions[ \t]*\r?\n([\s\S]*?)```/g
const DANGLING_RE = /```world-actions[\s\S]*$/
const MARKER_RE = /\[E(\d+)\]/g
/** A bracket of several markers: "[E20, E21]", "[E20,E21]", "[E3–E5]" (also steps, "[A1, A2]"). */
const GROUP_RE = /\[\s*([AE]\d+(?:\s*(?:,|[-–—])\s*[AE]\d+)+)\s*\]/g
/** The most labels a range like "[E3–E5]" stands for; a longer one is left as written. */
const MAX_RANGE = 12

/** One "[E<n>]" per label a grouped citation names, so each becomes a chip; a mixed, reversed or too long group stays as written. */
export function splitGroups(text: string): string {
  return text.replace(GROUP_RE, (whole, inner: string) => {
    const letter = inner[0]
    const out: number[] = []
    for (const piece of inner.split(',')) {
      const m = /^\s*([AE])(\d+)\s*(?:[-–—]\s*([AE])(\d+)\s*)?$/.exec(piece)
      if (!m || m[1] !== letter || (m[3] !== undefined && m[3] !== letter)) return whole
      const lo = Number(m[2])
      const hi = m[4] === undefined ? lo : Number(m[4])
      if (hi < lo || hi - lo >= MAX_RANGE) return whole
      for (let n = lo; n <= hi; n++) out.push(n)
    }
    return out.map((n) => `[${letter}${n}]`).join(' ')
  })
}
const STEP_RE = /\[A(\d+)\]/g
// A sentence ends at . ! or ? before a space or the end; markers right after the end belong to it.
const SENTENCE_RE = /[\s\S]+?(?:[.!?]+(?:\s*\[[AE]\d+\])*(?=\s|$)|$)/g
// A sentence that ends in a numbered list marker at the start of a line: "Steps:\n1." or "\n2.".
const LIST_MARKER_END_RE = /(?:^|\n)[ \t]*\d+\.$/

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null

/** Keeps the ids found in `valid`; every other entry (unknown or not a string) counts as dropped. */
function keepIds(raw: unknown, valid: Set<string>, tally: { dropped: number }): string[] {
  const list = Array.isArray(raw) ? raw : []
  const kept: string[] = []
  for (const id of list) {
    if (typeof id === 'string' && valid.has(id)) kept.push(id)
    else tally.dropped++
  }
  return kept
}

function cleanAction(step: unknown, all: Set<string>, edges: Set<string>, tally: { dropped: number }): WorldAction | null {
  if (!isRec(step)) { tally.dropped++; return null }
  switch (step.type) {
    case 'reset': return { type: 'reset' }
    case 'focus':
    case 'highlight':
    case 'fog': {
      const ids = keepIds(step.ids, all, tally)
      if (ids.length === 0) { tally.dropped++; return null }
      return { type: step.type, ids }
    }
    case 'flow': {
      const edgeIds = keepIds(step.edgeIds, edges, tally)
      if (edgeIds.length === 0) { tally.dropped++; return null }
      return { type: 'flow', edgeIds }
    }
    case 'openCard': {
      if (typeof step.id === 'string' && all.has(step.id)) return { type: 'openCard', id: step.id }
      tally.dropped += 2 // the id and the step
      return null
    }
    case 'tour': {
      const rawSteps = Array.isArray(step.steps) ? step.steps : []
      if (rawSteps.length > MAX_TOUR_STEPS) tally.dropped += rawSteps.length - MAX_TOUR_STEPS
      const steps: { ids: string[]; caption: string }[] = []
      for (const s of rawSteps.slice(0, MAX_TOUR_STEPS)) {
        if (!isRec(s)) { tally.dropped++; continue }
        const ids = keepIds(s.ids, all, tally)
        if (ids.length === 0) { tally.dropped++; continue }
        steps.push({ ids, caption: typeof s.caption === 'string' ? s.caption : '' })
      }
      if (steps.length === 0) { tally.dropped++; return null }
      return { type: 'tour', steps }
    }
    default: // draftProposal (website demo only) and anything unknown
      tally.dropped++
      return null
  }
}

/** The valid steps, and where each of the model's raw steps went (its index among them, or -1 when dropped). */
interface Parsed { actions: WorldAction[]; slots: number[] }

function parseActions(json: string, doc: WorldDoc, tally: { dropped: number }): Parsed {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return { actions: [], slots: [] } }
  if (!Array.isArray(parsed)) return { actions: [], slots: [] }
  const edges = new Set(doc.edges.map(e => e.id))
  const all = new Set<string>([...doc.buildings.map(b => b.id), ...doc.districts.map(d => d.id), ...edges])
  const out: WorldAction[] = []
  const slots: number[] = []
  for (const step of parsed) {
    const action = cleanAction(step, all, edges, tally)
    slots.push(action ? out.push(action) - 1 : -1)
  }
  return { actions: out, slots }
}

/**
 * Splits `text` into sentences and attaches each [A<n>] step to the sentence its marker sits in. `n`
 * counts the model's raw steps: a marker for a dropped or missing step attaches nothing and is counted.
 * A step no marker names plays with the last sentence, so it is never lost.
 */
function sentencesOf(text: string, parsed: Parsed, tally: { dropped: number }): AnswerSentence[] {
  const out: AnswerSentence[] = []
  const placed = new Set<number>()
  const raws = text.match(SENTENCE_RE) ?? []
  for (let i = 0; i < raws.length; i++) {
    // A numbered list marker at a line start ("1.") ends no sentence: it opens the item that follows.
    if (i + 1 < raws.length && LIST_MARKER_END_RE.test(raws[i])) { raws[i + 1] = raws[i] + raws[i + 1]; continue }
    const raw = raws[i]
    const actions: number[] = []
    for (const m of raw.matchAll(STEP_RE)) {
      const slot = parsed.slots[Number(m[1]) - 1] ?? -1
      if (slot < 0) tally.dropped++
      else if (!placed.has(slot)) { placed.add(slot); actions.push(slot) }
    }
    const clean = raw.replace(/\s*\[A\d+\]/g, '').trim()
    const lead = (/^\s*/.exec(raw) as RegExpExecArray)[0]
    const sep = sepOf(lead, out.length === 0)
    // An indented line right after a line break keeps its indent, so a list item's continuation stays in the item.
    const indent = sep === '\n' && clean !== '' ? lead.slice(lead.lastIndexOf('\n') + 1) : ''
    if (clean !== '' || actions.length > 0) out.push({ text: indent + clean, actions, sep })
  }
  const rest = parsed.actions.map((_, i) => i).filter((i) => !placed.has(i))
  if (rest.length > 0) {
    if (out.length === 0) out.push({ text: '', actions: [], sep: '' })
    out[out.length - 1].actions.push(...rest)
  }
  return out
}

function collectEvidence(text: string, labels: Record<string, Evidence>): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const m of text.matchAll(MARKER_RE)) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    const hit = labels['E' + m[1]] ?? labels[m[1]]
    if (hit) out.push(hit)
  }
  return out
}

const isUncited = (text: string): boolean => text !== '' && !new RegExp(MARKER_RE.source).test(text)

/** Splits an agent answer into prose, validated world actions and the evidence it cites. Never throws. */
export function parseAnswer(raw: string, doc: WorldDoc, labels: Record<string, Evidence> = {}): WorldAnswer {
  const input = typeof raw === 'string' ? splitGroups(raw) : ''
  const marked = input.replace(BLOCK_RE, '').replace(DANGLING_RE, '').trim() // closed blocks, then a truncated opener
  const text = marked.replace(/\s*\[A\d+\]/g, '').trim()
  try {
    const blocks = [...input.matchAll(BLOCK_RE)]
    const tally = { dropped: 0 }
    const parsed = blocks.length > 0 ? parseActions(blocks[0][1], doc, tally) : { actions: [], slots: [] }
    const { actions } = parsed
    const sentences = sentencesOf(marked, parsed, tally)
    const unsupported = actions.flatMap((a) => (a.type === 'fog' ? a.ids : []))
    return { text, sentences, actions, evidence: collectEvidence(text, labels), dropped: tally.dropped, unsupported, uncited: isUncited(text) }
  } catch {
    return { text, sentences: text === '' ? [] : [{ text, actions: [], sep: '' }], actions: [], evidence: [], dropped: 0, unsupported: [], uncited: isUncited(text) }
  }
}
