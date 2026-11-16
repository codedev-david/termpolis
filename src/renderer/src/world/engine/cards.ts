// Inspector cards as HTML strings. Every interpolated value is escaped (attributes too).
import type { Building, Claim, WorldDoc, WorldEdge } from '../../../../shared/world/types'
import { NOT_IN_DESIGN } from '../../../../shared/world/reconcile'
import { escapeHtml as esc } from './html'

export { escapeHtml } from './html'

const STATUS: Record<Building['status'], string> = {
  verified: 'Built · tests pass', built: 'Built · not yet checked', gap: 'Built · no tests', proposed: 'Planned only',
}

const allBuildings = (doc: WorldDoc): Building[] => [...doc.buildings, ...doc.layers.plan.flatMap((p) => p.buildings)]
const allEdges = (doc: WorldDoc): WorldEdge[] => [...doc.edges, ...doc.layers.plan.flatMap((p) => p.edges)]

const section = (title: string, body: string): string => `<h4>${esc(title)}</h4>${body}`

function claims(list: Claim[]): string {
  return list.map((c) => c.state === 'inferred'
    ? `<p class="claim claim-inferred">${esc(c.text)} <span class="tag">inferred</span></p>`
    : `<p class="claim">${esc(c.text)}</p>`).join('')
}

function chips(doc: WorldDoc, techs: string[]): string {
  return techs.map((t) => `<span class="chip" data-tech="${esc(t)}" title="${esc(doc.glossary[t] ?? '')}">${esc(t)}</span>`).join('')
}

const nodeName = (doc: WorldDoc, id: string): string =>
  allBuildings(doc).find((b) => b.id === id)?.name ?? doc.externals.find((x) => x.id === id)?.name ?? id
const nodeLink = (doc: WorldDoc, id: string): string => `<a class="link-node" data-node="${esc(id)}">${esc(nodeName(doc, id))}</a>`
const edgeLink = (e: WorldEdge): string => `<a class="link-edge" data-edge="${esc(e.id)}">${esc(e.label)}</a>`

function edgeList(doc: WorldDoc, edges: WorldEdge[], dir: 'from' | 'to'): string {
  const rows = edges.map((e) => `<li>${edgeLink(e)} <span class="muted">${dir}</span> ${nodeLink(doc, e[dir])}</li>`)
  return `<ul>${rows.join('')}</ul>`
}

export function buildingCard(doc: WorldDoc, id: string): string {
  const b = allBuildings(doc).find((x) => x.id === id)
  if (!b) {
    const x = doc.externals.find((e) => e.id === id)
    return x ? `<h3>${esc(x.name)}</h3>${section('Outside', `<p>${esc(x.kind)}${x.fog ? ' · not fully known' : ''}</p>`)}` : ''
  }
  const edges = allEdges(doc)
  const ins = edges.filter((e) => e.to === id)
  const outs = edges.filter((e) => e.from === id)
  const proc = doc.processes[b.process]
  const parts = b.floors.map((f) => `<li><b>${esc(f.name)}</b> <span class="muted">· ${esc(f.tech.join(', '))}</span></li>`).join('')
  // A built building the project's linked design does not have.
  const unplanned = doc.layers.plan.some((p) => p.reconcile !== undefined && p.reconcile.extra.indexOf(id) >= 0)
  const tag = unplanned ? ` <span class="tag">${esc(NOT_IN_DESIGN)}</span>` : ''
  return `<h3>${esc(b.name)}</h3><p class="muted">${esc(b.techLabel)}</p>`
    + section('Status', `<p class="status status-${esc(b.status)}">${esc(STATUS[b.status])}${tag}</p>`)
    + section('Process', `<p>${esc(proc ? proc.label : b.process)}</p>`)
    + section('What it does', claims(b.how))
    + section('What\'s inside', `<ul>${parts}</ul>`)
    + section('Technology', `<div>${chips(doc, b.stack)}</div>`)
    + section('Why it\'s built this way', claims(b.why))
    + (ins.length ? section('What comes in', edgeList(doc, ins, 'from')) : '')
    + (outs.length ? section('What goes out', edgeList(doc, outs, 'to')) : '')
}

export function edgeCard(doc: WorldDoc, id: string): string {
  const e = allEdges(doc).find((x) => x.id === id)
  if (!e) return ''
  const cargo = doc.cargo[e.cargo]
  return `<h3>${esc(e.label)}</h3><p class="muted">${nodeLink(doc, e.from)} → ${nodeLink(doc, e.to)}${e.twoWay ? ' (both ways)' : ''}</p>`
    + section('What travels', `<p>${esc(cargo ? cargo.label : e.cargo)}</p>`)
    + section('How it travels', claims(e.how))
    + section('Technology', `<div>${chips(doc, e.tech)}</div>`)
    + section('Why it\'s done this way', claims(e.why))
    + section('How often', `<p>${esc(e.rate)}</p>`)
}

/** Ids of the buildings and edges that use a technology (a building's stack or floors, or an edge's tech list). */
export function usesTech(doc: WorldDoc, techId: string): string[] {
  const out: string[] = []
  for (const b of allBuildings(doc)) {
    if (b.stack.includes(techId) || b.floors.some((f) => f.tech.includes(techId))) out.push(b.id)
  }
  for (const e of allEdges(doc)) if (e.tech.includes(techId)) out.push(e.id)
  return out
}

export function techCard(doc: WorldDoc, techId: string): string {
  const used = new Set(usesTech(doc, techId))
  const nodes = allBuildings(doc).filter((b) => used.has(b.id))
  const edges = allEdges(doc).filter((e) => used.has(e.id))
  const nodeRows = nodes.map((b) => `<li>${nodeLink(doc, b.id)}</li>`).join('')
  const edgeRows = edges.map((e) => `<li>${edgeLink(e)} <span class="muted">${esc(nodeName(doc, e.from))} → ${esc(nodeName(doc, e.to))}</span></li>`).join('')
  return `<h3>${esc(techId)}</h3><p>${esc(doc.glossary[techId] ?? '')}</p>`
    + (nodes.length ? section('Used inside', `<ul>${nodeRows}</ul>`) : '')
    + (edges.length ? section('Carries these connections', `<ul>${edgeRows}</ul>`) : '')
}
