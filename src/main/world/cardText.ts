// Lumopolis cards as plain text, for agents: the same facts the HTML card shows (renderer engine
// cards.ts), gathered by the same helpers (shared/world/cardFacts.ts, edgeText.ts), with each claim
// followed by its state in brackets and the evidence behind it on the next line.
import { NOT_IN_DESIGN } from '../../shared/world/reconcile'
import { BUILD_STATUS_TEXT, allBuildings, allEdges, nodeName, notInDesign, runsIn } from '../../shared/world/cardFacts'
import { edgeItems, edgeSummary } from '../../shared/world/edgeText'
import type { Claim, WorldDoc, WorldEdge } from '../../shared/world/types'

const section = (title: string, lines: string[]): string[] => ['', `${title}:`, ...lines]

/** One line per claim, "text [state]", then its evidence. None reads as "Not described yet.". */
function claimLines(list: Claim[]): string[] {
  if (list.length === 0) return ['Not described yet.']
  return list.flatMap((c) => {
    const ev = c.evidence.map((e) => `${e.kind} ${e.ref}`).join('; ')
    return [`- ${c.text} [${c.state}]`, ...(ev ? [`  evidence: ${ev}`] : [])]
  })
}

/** Facts found beyond the descriptions, only when there are some. */
const known = (claims: Claim[]): string[] => (claims.length ? section('What we know', claimLines(claims)) : [])

const techLine = (doc: WorldDoc, techs: string[]): string[] =>
  techs.map((t) => (doc.glossary[t] ? `- ${t}: ${doc.glossary[t]}` : `- ${t}`))

function edgeLines(doc: WorldDoc, edges: WorldEdge[], dir: 'from' | 'to'): string[] {
  return edges.map((e) => `- ${edgeSummary(e.label)} (${e.id}) ${dir} ${nodeName(doc, e[dir])} (${e[dir]})`)
}

function buildingText(doc: WorldDoc, id: string): string {
  const b = allBuildings(doc).find((x) => x.id === id)
  if (!b) {
    const x = doc.externals.find((e) => e.id === id)
    return x ? [x.name, 'Outside the project', `What it is: ${x.kind}${x.fog ? ' · not fully known' : ''}`].join('\n') : ''
  }
  const edges = allEdges(doc)
  const ins = edges.filter((e) => e.to === id)
  const outs = edges.filter((e) => e.from === id)
  const run = runsIn(doc, b)
  const floors = b.floors.map((f) => `- ${f.name}${f.tech.length ? ` · ${f.tech.join(', ')}` : ''}`)
  const lines = [
    `${b.name}${b.nameState === 'inferred' ? ' (name suggested by AI)' : ''}`,
    ...(b.techLabel ? [b.techLabel] : []),
    `Status: ${BUILD_STATUS_TEXT[b.status]}${notInDesign(doc, id) ? `; ${NOT_IN_DESIGN}` : ''}`,
    ...(run.trim() ? [`Runs in: ${run}`] : []),
    ...section('What it does', claimLines(b.how)),
    ...(floors.length ? section("What's inside", floors) : []),
    ...(b.stack.length ? section('Technology', techLine(doc, b.stack)) : []),
    ...section("Why it's built this way", claimLines(b.why)),
    ...known(b.claims),
    ...(ins.length ? section('What comes in', edgeLines(doc, ins, 'from')) : []),
    ...(outs.length ? section('What goes out', edgeLines(doc, outs, 'to')) : [])
  ]
  return lines.join('\n')
}

function edgeText(doc: WorldDoc, id: string): string {
  const e = allEdges(doc).find((x) => x.id === id)
  if (!e) return ''
  const cargo = doc.cargo[e.cargo]
  const title = edgeSummary(e.label)
  const items = edgeItems(e.label)
  const lines = [
    title,
    `${nodeName(doc, e.from)} (${e.from}) -> ${nodeName(doc, e.to)} (${e.to})${e.twoWay ? ' (both ways)' : ''}`,
    ...(items ? section('What it carries', items.map((i) => `- ${i}`)) : title !== e.label.trim() ? [e.label] : []),
    ...section('What travels', [cargo ? cargo.label : e.cargo]),
    ...section('How it travels', claimLines(e.how)),
    ...(e.tech.length ? section('Technology', techLine(doc, e.tech)) : []),
    ...section('Why it is done this way', claimLines(e.why)),
    ...known(e.claims),
    ...(e.rate ? section('How often', [e.rate]) : [])
  ]
  return lines.join('\n')
}

/** The plain-text card for a building (built or planned), an outside part or a line; '' when `id` is none of them. */
export function cardText(doc: WorldDoc, id: string): string {
  return buildingText(doc, id) || edgeText(doc, id)
}
