// Lumopolis cards as plain text, for agents: the same facts the HTML card shows (renderer engine
// cards.ts), gathered by the same helpers (shared/world/cardFacts.ts, edgeText.ts), with each claim
// followed by its state in brackets and the evidence behind it on the next line.
import { NOT_IN_DESIGN } from '../../shared/world/reconcile'
import { BUILD_STATUS_TEXT, CARD_HEADINGS, serviceNamesLine, NO_WHY_YET, allBuildings, allEdges, direction, edgeFromCode, evidenceText, nodeName, notInDesign, runsIn, sizeNote } from '../../shared/world/cardFacts'
import { edgeItems, edgeSummary } from '../../shared/world/edgeText'
import type { Claim, WorldDoc, WorldEdge } from '../../shared/world/types'

const section = (title: string, lines: string[]): string[] => ['', `${title}:`, ...lines]

/** One line per claim, "text [state]", then its evidence. None reads as `empty`. */
function claimLines(list: Claim[], empty = 'Not described yet.'): string[] {
  if (list.length === 0) return [empty]
  return list.flatMap((c) => {
    const ev = c.evidence.map(evidenceText).join('; ')
    return [`- ${c.text} [${c.state}]`, ...(ev ? [`  evidence: ${ev}`] : [])]
  })
}

/** Facts found beyond the descriptions, only when there are some. */
const known = (claims: Claim[]): string[] => (claims.length ? section(CARD_HEADINGS.know, claimLines(claims)) : [])

const techLine = (doc: WorldDoc, techs: string[]): string[] =>
  techs.map((t) => (doc.glossary[t] ? `- ${t}: ${doc.glossary[t]}` : `- ${t}`))

function edgeLines(doc: WorldDoc, edges: WorldEdge[], dir: 'from' | 'to'): string[] {
  return edges.map((e) => `- ${edgeSummary(e.label)} (${e.id}) ${dir} ${nodeName(doc, e[dir])} (${e[dir]})`)
}

function buildingText(doc: WorldDoc, id: string): string {
  const b = allBuildings(doc).find((x) => x.id === id)
  if (!b) {
    const x = doc.externals.find((e) => e.id === id)
    return x ? [x.name, 'Outside the project', `${CARD_HEADINGS.whatItIs}: ${x.kind}${x.fog ? ' · not fully known' : ''}`].join('\n') : ''
  }
  const edges = allEdges(doc)
  const ins = edges.filter((e) => e.to === id)
  const outs = edges.filter((e) => e.from === id)
  const run = runsIn(doc, b)
  // An agent reads the floors in this text, so the note points there rather than at a double-click.
  const big = sizeNote(doc, b, 'listed')
  const names = serviceNamesLine(doc, id)
  const floors = b.floors.map((f) => `- ${f.name}${f.tech.length ? ` · ${f.tech.join(', ')}` : ''}`)
  const lines = [
    `${b.name}${b.nameState === 'inferred' ? ' (name suggested by AI)' : ''}`,
    ...(b.techLabel ? [b.techLabel] : []),
    `Status: ${BUILD_STATUS_TEXT[b.status]}${notInDesign(doc, id) ? `; ${NOT_IN_DESIGN}` : ''}`,
    ...(run.trim() ? [`Runs in: ${run}`] : []),
    ...section(CARD_HEADINGS.whatItDoes, claimLines(b.how)),
    ...(floors.length ? section(CARD_HEADINGS.inside, floors) : []),
    ...(big ? section(CARD_HEADINGS.whyBig, [big]) : []),
    ...(b.stack.length ? section(CARD_HEADINGS.technology, techLine(doc, b.stack)) : []),
    ...section(CARD_HEADINGS.whyBuilt, claimLines(b.why)),
    ...known(b.claims),
    ...(names ? section(CARD_HEADINGS.serviceNames, [names]) : []),
    ...(ins.length ? section(CARD_HEADINGS.comesIn, edgeLines(doc, ins, 'from')) : []),
    ...(outs.length ? section(CARD_HEADINGS.goesOut, edgeLines(doc, outs, 'to')) : [])
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
    `${nodeName(doc, e.from)} (${e.from}) -> ${nodeName(doc, e.to)} (${e.to})`,
    ...section(CARD_HEADINGS.direction, [direction(doc, e).text]),
    ...(items ? section(CARD_HEADINGS.carries, items.map((i) => `- ${i}`)) : title !== e.label.trim() ? [e.label] : []),
    ...section(CARD_HEADINGS.travels, [cargo ? cargo.label : e.cargo]),
    // A line no model described still says what the code shows.
    ...section(CARD_HEADINGS.howTravels, claimLines(e.how, edgeFromCode(doc, e))),
    ...(e.tech.length ? section(CARD_HEADINGS.technology, techLine(doc, e.tech)) : []),
    ...section(CARD_HEADINGS.whyDone, claimLines(e.why, NO_WHY_YET)),
    ...known(e.claims),
    ...(e.rate ? section(CARD_HEADINGS.howOften, [e.rate]) : [])
  ]
  return lines.join('\n')
}

/** The plain-text card for a building (built or planned), an outside part or a line; '' when `id` is none of them. */
export function cardText(doc: WorldDoc, id: string): string {
  return buildingText(doc, id) || edgeText(doc, id)
}
