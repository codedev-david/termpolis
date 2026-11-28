// Inspector cards as HTML strings. Every interpolated value is escaped (attributes too).
import type { Claim, Evidence, Tour, WorldDoc, WorldEdge } from '../../../../shared/world/types'
import { NOT_IN_DESIGN } from '../../../../shared/world/reconcile'
import { AI_NAME, BUILD_STATUS_TEXT as STATUS, RUNS_IN_LABEL, CARD_HEADINGS, NO_WHY_YET, allBuildings, allEdges, direction, edgeFromCode, nodeName, notInDesign, evidenceText, serviceNames as serviceNamesOf, runsIn as runsInOf, sizeNote, type FloorsView } from '../../../../shared/world/cardFacts'
import { edgeItems, edgeSummary } from '../../../../shared/world/edgeText'
import { escapeHtml as esc } from './html'
import { safeColor } from '../../../../shared/world/safeColor'

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

/** `readOnly` (the exported page): no Confirm or Edit control, and each piece of evidence is plain text, not a button. */
export interface CardOptions { readOnly?: boolean }

function claims(list: Claim[], itemId: string, start: number, readOnly: boolean, empty = '<p class="muted">Not described yet.</p>'): string {
  if (list.length === 0) return empty
  const rows = list.map((c, i) => {
    const ev = c.evidence.map((e) => readOnly
      ? `<span class="ev-ref">${esc(evidenceText(e))}</span>`
      : `<button class="ev" data-evidence="${esc(JSON.stringify(evidenceOf(e)))}">evidence</button>`).join(' ')
    const confirm = c.state === 'inferred' && !readOnly ? ` <button class="confirm" data-confirm="${esc(itemId)}|${start + i}">Confirm</button>` : ''
    return `<li class="claim" data-state="${esc(c.state)}"><span class="ctext">${esc(c.text)}</span> <span class="state">${esc(c.state)}</span>${ev ? ` ${ev}` : ''}${confirm}</li>`
  })
  return `<ul class="claims">${rows.join('')}</ul>`
}

/** "What we know": the facts found beyond the descriptions (tests, code, a person's confirmation), only when there are some. */
const known = (b: { id: string; how: Claim[]; why: Claim[]; claims: Claim[] }, readOnly: boolean): string =>
  b.claims.length ? section(CARD_HEADINGS.know, claims(b.claims, b.id, b.how.length + b.why.length, readOnly)) : ''

/**
 * "Service names": what a part goes by while it runs. A building of the world has an Edit button (the
 * pane saves what is typed as an annotation); a planned building has no names to edit. Nothing when
 * there are none and none can be edited.
 */
function serviceNames(doc: WorldDoc, id: string, readOnly: boolean): string {
  const { names, handSet } = serviceNamesOf(doc, id)
  const editable = !readOnly && doc.buildings.some((x) => x.id === id)
  if (names.length === 0 && !editable) return '' // read-only: nothing to show when there are none
  const list = names.length ? `<span class="rtnames">${esc(names.join(', '))}</span>` : '<span class="muted">None yet</span>'
  const edit = editable ? ` <button class="edit-names" data-runtime-edit="${esc(id)}" data-names="${esc(names.join(', '))}">Edit</button>` : ''
  const by = handSet ? ' <span class="muted">edited by you</span>' : ''
  return section(CARD_HEADINGS.serviceNames, `<p>${list}${by}${edit}</p>`)
}

function chips(doc: WorldDoc, techs: string[]): string {
  return techs.map((t) => `<button type="button" class="chip" data-tech="${esc(t)}" title="${esc(doc.glossary[t] ?? '')}">${esc(t)}</button>`).join('')
}

// A chip and a link are buttons (they open a card in place, they go to no address), so Tab reaches each and Enter
// and Space press it (A11Y Y3); the card's CSS draws them as a pill and as dotted link text.
const nodeLink = (doc: WorldDoc, id: string): string => `<button type="button" class="lnk link-node" data-node="${esc(id)}">${esc(nodeName(doc, id))}</button>`
const edgeLink = (e: WorldEdge): string => `<button type="button" class="lnk link-edge" data-edge="${esc(e.id)}">${esc(edgeSummary(e.label))}</button>`
/** The small colour square of a line's cargo, as in the legend. Only a hex colour reaches the style attribute. */
const swatch = (doc: WorldDoc, e: WorldEdge): string => {
  const c = doc.cargo[e.cargo]
  return c ? `<span class="cargo" style="background:${safeColor(c.color)}"></span>` : ''
}

function edgeList(doc: WorldDoc, edges: WorldEdge[], dir: 'from' | 'to'): string {
  const rows = edges.map((e) => `<li>${swatch(doc, e)}${edgeLink(e)} <span class="muted">${dir}</span> ${nodeLink(doc, e[dir])}</li>`)
  return `<ul>${rows.join('')}</ul>`
}

/** `floors` is how the reader can open the floors: only the 3D city opens them on a double-click. */
export function buildingCard(doc: WorldDoc, id: string, floors: FloorsView = 'none', opts: CardOptions = {}): string {
  const readOnly = opts.readOnly === true
  const b = allBuildings(doc).find((x) => x.id === id)
  if (!b) {
    const x = doc.externals.find((e) => e.id === id)
    return x ? `<h3>${esc(x.name)}</h3><span class="tag status-external">Outside the project</span>${section(CARD_HEADINGS.whatItIs, `<p>${esc(x.kind)}${x.fog ? ' · not fully known' : ''}</p>`)}` : ''
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
  const aiName = b.nameState === 'inferred' ? ` <span class="muted">${AI_NAME}</span>` : ''
  const big = sizeNote(doc, b, floors)
  return `<h3>${esc(b.name)}${aiName}</h3>${b.techLabel ? `<p class="muted">${esc(b.techLabel)}</p>` : ''}`
    + `<p class="status"><span class="tag status-${esc(b.status)}">${esc(STATUS[b.status])}</span>${tag}</p>`
    + (runsIn.trim() ? `<div class="proc">${esc(RUNS_IN_LABEL)} <b>${esc(runsIn)}</b></div>` : '')
    + section(CARD_HEADINGS.whatItDoes, claims(b.how, b.id, 0, readOnly))
    + (parts ? section(CARD_HEADINGS.inside, `<ul>${parts}</ul>`) : '')
    + (big ? section(CARD_HEADINGS.whyBig, `<p>${esc(big)}</p>`) : '')
    + (b.stack.length ? section(CARD_HEADINGS.technology, `<div>${chips(doc, b.stack)}</div>`) : '')
    + section(CARD_HEADINGS.whyBuilt, claims(b.why, b.id, b.how.length, readOnly))
    + serviceNames(doc, id, readOnly)
    + known(b, readOnly)
    + (ins.length ? section(CARD_HEADINGS.comesIn, edgeList(doc, ins, 'from')) : '')
    + (outs.length ? section(CARD_HEADINGS.goesOut, edgeList(doc, outs, 'to')) : '')
}

export function edgeCard(doc: WorldDoc, id: string, opts: CardOptions = {}): string {
  const readOnly = opts.readOnly === true
  const e = allEdges(doc).find((x) => x.id === id)
  if (!e) return ''
  const cargo = doc.cargo[e.cargo]
  // The title is the line's short summary; the card lists what it carries in full.
  const title = edgeSummary(e.label)
  const items = edgeItems(e.label)
  const carries = items
    ? section(CARD_HEADINGS.carries, `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`)
    : title !== e.label.trim() ? `<p>${esc(e.label)}</p>` : ''
  // Which way it runs, right under its ends; the half of the sentence about the line back opens that line.
  const d = direction(doc, e)
  const back = d.reverseId !== undefined ? `<button type="button" class="lnk link-edge" data-edge="${esc(d.reverseId)}">${esc(d.link)}</button>` : esc(d.link)
  return `<h3>${esc(title)}</h3><p class="muted">${nodeLink(doc, e.from)} → ${nodeLink(doc, e.to)}</p>`
    + section(CARD_HEADINGS.direction, `<p>${esc(d.before)}${back}${esc(d.after)}</p>`)
    + carries
    + section(CARD_HEADINGS.travels, `<p>${swatch(doc, e)}${esc(cargo ? cargo.label : e.cargo)}</p>`)
    // A line no model described still says what the code shows.
    + section(CARD_HEADINGS.howTravels, claims(e.how, e.id, 0, readOnly, `<p>${esc(edgeFromCode(doc, e))}</p>`))
    + (e.tech.length ? section(CARD_HEADINGS.technology, `<div>${chips(doc, e.tech)}</div>`) : '')
    + section(CARD_HEADINGS.whyDone, claims(e.why, e.id, e.how.length, readOnly, `<p class="muted">${NO_WHY_YET}</p>`))
    + known(e, readOnly)
    + (e.rate ? section(CARD_HEADINGS.howOften, `<p>${esc(e.rate)}</p>`) : '')
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
    + (nodes.length ? section(CARD_HEADINGS.usedInside, `<ul>${nodeRows}</ul>`) : '')
    + (edges.length ? section(CARD_HEADINGS.carriesConnections, `<ul>${edgeRows}</ul>`) : '')
}

/** A tour as a card, for the 2D map (the 3D city plays it instead): its title over its captions in order. */
export const tourCard = (t: Tour): string =>
  `<h3>${esc(t.title)}</h3><ol>${t.steps.map((s) => `<li>${esc(s.caption)}</li>`).join('')}</ol>`

/** A tour's stop as a screen reader hears it: its place among the stops on the map, and its caption (T5). */
export interface TourStop { n: number; of: number; caption: string }
// SIGNED OFF 2026-11-27 (signoff-decisions.md) (A11Y #55): the words a screen reader says at each tour stop.
export const tourStopText = (s: TourStop): string => `Stop ${s.n} of ${s.of}: ${s.caption}`
