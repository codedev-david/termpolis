// Lumopolis ask protocol: the instructions appended to every question prompt, and the tolerant
// parser for the agent's answer. The parser never throws and never trusts ids: anything that is
// not in the WorldDoc is removed and counted in `dropped`.
import type { Evidence, WorldAction, WorldDoc } from './types'

export const ANSWER_PROTOCOL = `Answer in plain language for someone who does not read code. Keep it under 150 words.
After your answer, add one fenced block tagged world-actions containing a JSON array of steps
that show your answer in the World. Allowed steps:
{"type":"focus","ids":[...]} {"type":"highlight","ids":[...]} {"type":"flow","edgeIds":[...]}
{"type":"openCard","id":"..."} {"type":"tour","steps":[{"ids":[...],"caption":"..."}]} {"type":"reset"}
Use only ids from the WORLD DATA. Cite evidence inline as [E<n>] using the labels in the WORLD DATA.`

export interface WorldAnswer { text: string; actions: WorldAction[]; evidence: Evidence[]; dropped: number }

const MAX_TOUR_STEPS = 12
const BLOCK_RE = /```world-actions[ \t]*\r?\n([\s\S]*?)```/g
const DANGLING_RE = /```world-actions[\s\S]*$/
const MARKER_RE = /\[E(\d+)\]/g

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
    case 'highlight': {
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

function parseActions(json: string, doc: WorldDoc, tally: { dropped: number }): WorldAction[] {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const edges = new Set(doc.edges.map(e => e.id))
  const all = new Set<string>([...doc.buildings.map(b => b.id), ...doc.districts.map(d => d.id), ...edges])
  const out: WorldAction[] = []
  for (const step of parsed) {
    const action = cleanAction(step, all, edges, tally)
    if (action) out.push(action)
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

/** Splits an agent answer into prose, validated world actions and the evidence it cites. Never throws. */
export function parseAnswer(raw: string, doc: WorldDoc, labels: Record<string, Evidence> = {}): WorldAnswer {
  const input = typeof raw === 'string' ? raw : ''
  const text = input.replace(BLOCK_RE, '').replace(DANGLING_RE, '').trim() // closed blocks, then a truncated opener
  try {
    const blocks = [...input.matchAll(BLOCK_RE)]
    const tally = { dropped: 0 }
    const actions = blocks.length > 0 ? parseActions(blocks[0][1], doc, tally) : []
    return { text, actions, evidence: collectEvidence(text, labels), dropped: tally.dropped }
  } catch {
    return { text, actions: [], evidence: [], dropped: 0 }
  }
}
