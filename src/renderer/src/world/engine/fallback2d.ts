// The map without WebGL (or with the "2D map" switch on): a flat SVG of the city (hexagon districts,
// square buildings, lines for the connections) over a semantic list that screen readers walk.
// Every shape and list item carries data-kind (the viewer's selection kind: district, building or
// edge; an external counts as a building) and data-id, both escaped, so clicks are wired from them.
import type { WorldDoc } from '../../../../shared/world/types'
import { escapeHtml as esc } from './html'
import { edgeSummary } from '../../../../shared/world/edgeText'

const tag = (kind: 'district' | 'building' | 'edge', id: string): string => ` data-kind="${kind}" data-id="${esc(id)}"`
const item = (kind: 'district' | 'building' | 'edge', id: string): string => `${tag(kind, id)} tabindex="0"`

type Pt = [number, number]
const SIDE = 3
const HEX_R = 6
const MARGIN = 8
const n2 = (n: number): string => String(Math.round(n * 100) / 100)

/** The map: positions are the layout's x and z, drawn as x right and z down. */
function renderMap(doc: WorldDoc, title: string, label: (id: string) => string): string {
  let slot = 0
  const at = new Map<string, Pt>()
  const place = (id: string): Pt => {
    const p = doc.layout.positions[id]
    const pt: Pt = p ? [p[0], p[2]] : [(slot % 6) * 8, 14 + Math.floor(slot++ / 6) * 8]
    at.set(id, pt)
    return pt
  }
  for (const b of doc.buildings) place(b.id)
  for (const x of doc.externals) place(x.id)
  const hexes = doc.districts.map((d) => {
    const own = doc.layout.positions[d.id]
    const mine = doc.buildings.filter((b) => b.districtId === d.id).map((b) => at.get(b.id) as Pt)
    const c: Pt = own ? [own[0], own[2]] : mine.length ? [mine.reduce((s, p) => s + p[0], 0) / mine.length, mine.reduce((s, p) => s + p[1], 0) / mine.length] : [0, 0]
    return { d, c }
  })
  const xs = [...at.values(), ...hexes.map((h) => h.c)]
  const minX = Math.min(0, ...xs.map((p) => p[0])) - MARGIN
  const minZ = Math.min(0, ...xs.map((p) => p[1])) - MARGIN
  const maxX = Math.max(0, ...xs.map((p) => p[0])) + MARGIN
  const maxZ = Math.max(0, ...xs.map((p) => p[1])) + MARGIN
  const polys = hexes.map(({ d, c }) => {
    const pts = [0, 1, 2, 3, 4, 5].map((k) => `${n2(c[0] + HEX_R * Math.cos((k * Math.PI) / 3))},${n2(c[1] + HEX_R * Math.sin((k * Math.PI) / 3))}`).join(' ')
    return `<polygon${tag('district', d.id)} points="${pts}" fill="#1e2a38" stroke="#4fc1ff" stroke-width="0.3"><title>${esc(d.name)}</title></polygon>`
  }).join('')
  const lines = doc.edges.filter((e) => at.has(e.from) && at.has(e.to)).map((e) => {
    const a = at.get(e.from) as Pt
    const b = at.get(e.to) as Pt
    return `<line${tag('edge', e.id)} x1="${n2(a[0])}" y1="${n2(a[1])}" x2="${n2(b[0])}" y2="${n2(b[1])}" stroke="#9ca3af" stroke-width="0.5"><title>${esc(label(e.from))} to ${esc(label(e.to))}</title></line>`
  }).join('')
  const rect = (id: string, name: string, fill: string): string => {
    const p = at.get(id) as Pt
    return `<rect${tag('building', id)} x="${n2(p[0] - SIDE / 2)}" y="${n2(p[1] - SIDE / 2)}" width="${SIDE}" height="${SIDE}" fill="${fill}"><title>${esc(name)}</title></rect>`
  }
  const rects = doc.buildings.map((b) => rect(b.id, b.name, '#0078d4')).join('') + doc.externals.map((x) => rect(x.id, x.name, '#c586c0')).join('')
  return `<svg role="img" aria-label="Map of ${esc(title)}" viewBox="${n2(minX)} ${n2(minZ)} ${n2(maxX - minX)} ${n2(maxZ - minZ)}" style="width:100%;max-height:60vh">${polys}${lines}${rects}</svg>`
}

/** `title` is the project's display name (never its hashed key). */
export function renderFallback(doc: WorldDoc, title: string): string {
  const nameOf = new Map<string, string>()
  for (const b of doc.buildings) nameOf.set(b.id, b.name)
  for (const x of doc.externals) nameOf.set(x.id, x.name)
  const label = (id: string): string => nameOf.get(id) ?? id

  const districts = doc.districts.map((d) => {
    const items = doc.buildings.filter((b) => b.districtId === d.id)
      .map((b) => `<li${item('building', b.id)}>${esc(b.name)} <span>${esc(b.techLabel)} (${esc(b.status)})</span></li>`).join('')
    return `<li${item('district', d.id)}><h3>${esc(d.name)}</h3><p>${esc(d.subtitle)}</p><ul>${items}</ul></li>`
  }).join('')
  const externals = doc.externals.map((x) => `<li${item('building', x.id)}>${esc(x.name)} (${esc(x.kind)})</li>`).join('')
  const edges = doc.edges.map((e) => `<li${item('edge', e.id)}>${esc(label(e.from))} to ${esc(label(e.to))}: ${esc(edgeSummary(e.label))}</li>`).join('')
  return `<section class="world-fallback"><h2>${esc(title)}</h2>${renderMap(doc, title, label)}<ul class="world-fallback-list">${districts}</ul>`
    + `<h3>Outside</h3><ul>${externals}</ul><h3>Connections</h3><ul>${edges}</ul></section>`
}
