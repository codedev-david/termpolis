// Inspector cards as HTML strings. Every interpolated value is escaped (attributes too).
import type { Claim, Evidence, WorldDoc, WorldEdge } from '../../../../shared/world/types'
import { NOT_IN_DESIGN } from '../../../../shared/world/reconcile'
import { BUILD_STATUS_TEXT as STATUS, NO_WHY_YET, allBuildings, allEdges, edgeFromCode, nodeName, notInDesign, runsIn as runsInOf } from '../../../../shared/world/cardFacts'
import { edgeItems, edgeSummary } from '../../../../shared/world/edgeText'
import { escapeHtml as esc } from './html'

export { escapeHtml } from './html'

const section = (title: string, body: string): string => `<h4>${esc(title)}</h4>${body}`

/**
 * The claims as a list, each with its state and a button per piece of evidence (the evidence rides in the
 * attribute as escaped JSON, so a click needs nothing but the DOM). An inferred claim can be confirmed.
 * `start` numbers the claims of a part across its lists. None yet (the model has not described this part)
 * reads as such, not as a blank.
 */
/** What an evidence button carries: kind and ref, and a test's source (where its result came from). */
const evidenceOf = (e: Evidence): Evidence =>
  e.kind === 'test' && typeof e.excerpt === 'string' ? { kind: e.kind, ref: e.ref, excerpt: e.excerpt } : { kind: e.kind, ref: e.ref }

function claims(list: Claim[], itemId: string, start: number, empty = '<p class="muted">Not described yet.</p>'): string {
  if (list.length === 0) return empty
  const rows = list.map((c, i) => {
    const ev = c.evidence.map((e) => `<button class="ev" data-evidence="${esc(JSON.stringify(evidenceOf(e)))}">evidence</button>`).join(' ')
    const confirm = c.state === 'inferred' ? ` <button class="confirm" data-confirm="${esc(itemId)}|${start + i}">Confirm</button>` : ''
    return `<li class="claim" data-state="${esc(c.state)}"><span class="ctext">${esc(c.text)}</span> <span class="state">${esc(c.state)}</span>${ev ? ` ${ev}` : ''}${confirm}</li>`
  })
  return `<ul class="claims">${rows.join('')}</ul>`
}

/** "What we know": the facts found beyond the descriptions (tests, code, a person's confirmation), only when there are some. */
const known = (b: { id: string; how: Claim[]; why: Claim[]; claims: Claim[] }): string =>
  b.claims.length ? section('What we know', claims(b.claims, b.id, b.how.length + b.why.length)) : ''

/**
 * "Service names": what a part goes by while it runs. A building of the world has an Edit button (the
 * pane saves what is typed as an annotation); a planned building has no names to edit. Nothing when
 * there are none and none can be edited.
 */
function serviceNames(doc: WorldDoc, id: string): string {
  const names = doc.runtimeNames[id] ?? []
  const editable = doc.buildings.some((x) => x.id === id)
  if (names.length === 0 && !editable) return ''
  const list = names.length ? `<span class="rtnames">${esc(names.join(', '))}</span>` : '<span class="muted">None yet</span>'
  const edit = editable ? ` <button class="edit-names" data-runtime-edit="${esc(id)}" data-names="${esc(names.join(', '))}">Edit</button>` : ''
  const by = (doc.runtimeHandSet ?? []).includes(id) ? ' <span class="muted">edited by you</span>' : ''
  return section('Service names', `<p>${list}${by}${edit}</p>`)
}

function chips(doc: WorldDoc, techs: string[]): string {
  return techs.map((t) => `<span class="chip" data-tech="${esc(t)}" title="${esc(doc.glossary[t] ?? '')}">${esc(t)}</span>`).join('')
}

const nodeLink = (doc: WorldDoc, id: string): string => `<a class="lnk link-node" data-node="${esc(id)}">${esc(nodeName(doc, id))}</a>`
const edgeLink = (e: WorldEdge): string => `<a class="lnk link-edge" data-edge="${esc(e.id)}">${esc(edgeSummary(e.label))}</a>`
/** The small colour square of a line's cargo, as in the legend. */
const swatch = (doc: WorldDoc, e: WorldEdge): string => {
  const c = doc.cargo[e.cargo]
  return c ? `<span class="cargo" style="background:${esc(c.color)}"></span>` : ''
}

function edgeList(doc: WorldDoc, edges: WorldEdge[], dir: 'from' | 'to'): string {
  const rows = edges.map((e) => `<li>${swatch(doc, e)}${edgeLink(e)} <span class="muted">${dir}</span> ${nodeLink(doc, e[dir])}</li>`)
  return `<ul>${rows.join('')}</ul>`
}

export function buildingCard(doc: WorldDoc, id: string): string {
  const b = allBuildings(doc).find((x) => x.id === id)
  if (!b) {
    const x = doc.externals.find((e) => e.id === id)
    return x ? `<h3>${esc(x.name)}</h3><span class="tag status-external">Outside the project</span>${section('What it is', `<p>${esc(x.kind)}${x.fog ? ' · not fully known' : ''}</p>`)}` : ''
  }
  const edges = allEdges(doc)
  const ins = edges.filter((e) => e.to === id)
  const outs = edges.filter((e) => e.from === id)
  // A part with no technology of its own is just its name: no dangling separator.
  const parts = b.floors.map((f) => `<li><b>${esc(f.name)}</b>${f.tech.length ? ` <span class="muted">· ${esc(f.tech.join(', '))}</span>` : ''}</li>`).join('')
  // A built building the project's linked design does not have.
  const tag = notInDesign(doc, id) ? ` <span class="tag">${esc(NOT_IN_DESIGN)}</span>` : ''
  // As the prototype's inspector: the name, its technology, a status pill, then the process box
  // (left out when the code shows no process for this part, rather than an empty "Runs in:").
  const runsIn = runsInOf(doc, b)
  const aiName = b.nameState === 'inferred' ? ' <span class="muted">(name suggested by AI)</span>' : ''
  return `<h3>${esc(b.name)}${aiName}</h3>${b.techLabel ? `<p class="muted">${esc(b.techLabel)}</p>` : ''}`
    + `<p class="status"><span class="tag status-${esc(b.status)}">${esc(STATUS[b.status])}</span>${tag}</p>`
    + (runsIn.trim() ? `<div class="proc">Runs in: <b>${esc(runsIn)}</b></div>` : '')
    + section('What it does', claims(b.how, b.id, 0))
    + (parts ? section('What\'s inside', `<ul>${parts}</ul>`) : '')
    + (b.stack.length ? section('Technology', `<div>${chips(doc, b.stack)}</div>`) : '')
    + section('Why it\'s built this way', claims(b.why, b.id, b.how.length))
    + serviceNames(doc, id)
    + known(b)
    + (ins.length ? section('What comes in', edgeList(doc, ins, 'from')) : '')
    + (outs.length ? section('What goes out', edgeList(doc, outs, 'to')) : '')
}

export function edgeCard(doc: WorldDoc, id: string): string {
  const e = allEdges(doc).find((x) => x.id === id)
  if (!e) return ''
  const cargo = doc.cargo[e.cargo]
  // The title is the line's short summary; the card lists what it carries in full.
  const title = edgeSummary(e.label)
  const items = edgeItems(e.label)
  const carries = items
    ? section('What it carries', `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`)
    : title !== e.label.trim() ? `<p>${esc(e.label)}</p>` : ''
  return `<h3>${esc(title)}</h3><p class="muted">${nodeLink(doc, e.from)} → ${nodeLink(doc, e.to)}${e.twoWay ? ' (both ways)' : ''}</p>`
    + carries
    + section('What travels', `<p>${swatch(doc, e)}${esc(cargo ? cargo.label : e.cargo)}</p>`)
    // A line no model described still says what the code shows.
    + section('How it travels', claims(e.how, e.id, 0, `<p>${esc(edgeFromCode(doc, e))}</p>`))
    + (e.tech.length ? section('Technology', `<div>${chips(doc, e.tech)}</div>`) : '')
    + section('Why it\'s done this way', claims(e.why, e.id, e.how.length, `<p class="muted">${NO_WHY_YET}</p>`))
    + known(e)
    + (e.rate ? section('How often', `<p>${esc(e.rate)}</p>`) : '')
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
