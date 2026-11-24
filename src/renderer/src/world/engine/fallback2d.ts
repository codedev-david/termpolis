// The map without WebGL (or with the "2D map" switch on): a flat SVG of the city (hexagon districts,
// square buildings, lines for the connections) over a semantic list that screen readers walk.
// Every shape and list item carries data-kind (the viewer's selection kind: district, building or
// edge; an external counts as a building) and data-id, both escaped, so clicks are wired from them.
// The plan shows as on the 3D map (sceneModel's buildSceneModel): planned parts with the planned layer, and the parts
// of the chosen design (or of a drafted proposal) that are not built yet, dashed; the parts a proposal takes away fade.
import type { Building, WorldDoc } from '../../../../shared/world/types'
import { escapeHtml as esc } from './html'
import { edgeSummary } from '../../../../shared/world/edgeText'
import { placeOnMap, type MapPoint as Pt } from '../../../../shared/world/mapPlacement'

const tag = (kind: 'district' | 'building' | 'edge', id: string): string => ` data-kind="${kind}" data-id="${esc(id)}"`
const item = (kind: 'district' | 'building' | 'edge', id: string): string => `${tag(kind, id)} tabindex="0"`

const SIDE = 3
const HEX_R = 6
const MARGIN = 8
const n2 = (n: number): string => String(Math.round(n * 100) / 100)

/** What the 2D map shows of the plan: the 3D map's layer switches (LayerState) and a proposal an answer drafted. */
export interface FallbackPlan {
  /** The planned layer: parts not built yet (status proposed), and the chosen design's parts. */
  planned: boolean
  /** The linked design chosen with the planned layer (LayerState.proposal); null: none. */
  proposal: string | null
  /** A proposal an answer drafted, shown whatever the layers say. */
  reveal?: string
}
const NO_PLAN: FallbackPlan = { planned: true, proposal: null }

/**
 * The world as the 2D map shows it: without the planned layer the planned parts and their connections are left
 * out; the shown proposals' parts and connections that are not in the world are added, their parts as proposed.
 * Mirrors buildSceneModel: an item already in the world wins over a proposal's item with the same id.
 */
function withPlan(doc: WorldDoc, plan: FallbackPlan): { view: WorldDoc; removed: ReadonlySet<string> } {
  const chosen = plan.planned && plan.proposal !== null ? doc.layers.plan.filter((p) => p.id === plan.proposal) : []
  const drafted = plan.reveal === undefined ? undefined : doc.layers.plan.find((p) => p.id === plan.reveal)
  const shown = drafted && !chosen.includes(drafted) ? [...chosen, drafted] : chosen
  const buildings: Building[] = doc.buildings.filter((b) => plan.planned || b.status !== 'proposed')
  const known = new Set<string>([...buildings.map((b) => b.id), ...doc.externals.map((x) => x.id)])
  for (const b of shown.flatMap((p) => p.buildings)) {
    if (known.has(b.id)) continue
    known.add(b.id)
    buildings.push({ ...b, status: 'proposed' })
  }
  const hidden = new Set(doc.buildings.filter((b) => !known.has(b.id)).map((b) => b.id))
  const edgeIds = new Set(doc.edges.map((e) => e.id))
  const edges = [...doc.edges]
  for (const e of shown.flatMap((p) => p.edges)) {
    if (edgeIds.has(e.id)) continue
    edgeIds.add(e.id)
    edges.push(e)
  }
  // A connection to a part left out goes too (the 3D map has nowhere to draw it).
  const kept = edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to))
  return { view: { ...doc, buildings, edges: kept }, removed: new Set(shown.flatMap((p) => p.removes ?? [])) }
}

/** The map: positions are the layout's x and z, drawn as x right and z down, placed by the shared map placement. */
function renderMap(doc: WorldDoc, title: string, label: (id: string) => string, removed: ReadonlySet<string>): string {
  const placement = placeOnMap(doc)
  const at = placement.at
  const hexes = doc.districts.map((d, i) => ({ d, c: placement.districts[i] }))
  // A loop, not Math.min(...all): a big world's points are more arguments than a call can take.
  let [minX, minZ, maxX, maxZ] = [0, 0, 0, 0]
  for (const p of [...at.values(), ...placement.districts]) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minZ) minZ = p[1]
    if (p[1] > maxZ) maxZ = p[1]
  }
  minX -= MARGIN
  minZ -= MARGIN
  maxX += MARGIN
  maxZ += MARGIN
  const polys = hexes.map(({ d, c }) => {
    const pts = [0, 1, 2, 3, 4, 5].map((k) => `${n2(c[0] + HEX_R * Math.cos((k * Math.PI) / 3))},${n2(c[1] + HEX_R * Math.sin((k * Math.PI) / 3))}`).join(' ')
    return `<polygon${tag('district', d.id)} points="${pts}" fill="#1e2a38" stroke="#4fc1ff" stroke-width="0.3"><title>${esc(d.name)}</title></polygon>`
  }).join('')
  const lines = doc.edges.filter((e) => at.has(e.from) && at.has(e.to)).map((e) => {
    const a = at.get(e.from) as Pt
    const b = at.get(e.to) as Pt
    return `<line${tag('edge', e.id)} x1="${n2(a[0])}" y1="${n2(a[1])}" x2="${n2(b[0])}" y2="${n2(b[1])}" stroke="#9ca3af" stroke-width="0.5"><title>${esc(label(e.from))} to ${esc(label(e.to))}</title></line>`
  }).join('')
  const rect = (id: string, name: string, paint: string): string => {
    const p = at.get(id) as Pt
    const fade = removed.has(id) ? ' opacity="0.4"' : ''
    return `<rect${tag('building', id)} x="${n2(p[0] - SIDE / 2)}" y="${n2(p[1] - SIDE / 2)}" width="${SIDE}" height="${SIDE}" ${paint}${fade}><title>${esc(name)}</title></rect>`
  }
  // A planned part is not built yet: an outline, dashed, as the 3D map draws it as a wireframe.
  const partPaint = (b: Building): string => (b.status === 'proposed' ? 'fill="none" stroke="#0078d4" stroke-width="0.3" stroke-dasharray="0.6 0.4"' : 'fill="#0078d4"')
  const rects = doc.buildings.map((b) => rect(b.id, b.name, partPaint(b))).join('') + doc.externals.map((x) => rect(x.id, x.name, 'fill="#c586c0"')).join('')
  return `<svg role="img" aria-label="Map of ${esc(title)}" viewBox="${n2(minX)} ${n2(minZ)} ${n2(maxX - minX)} ${n2(maxZ - minZ)}" style="width:100%;max-height:60vh">${polys}${lines}${rects}</svg>`
}

/** `title` is the project's display name (never its hashed key); `plan`, what the map shows of the plan. */
export function renderFallback(world: WorldDoc, title: string, plan: FallbackPlan = NO_PLAN): string {
  const { view: doc, removed } = withPlan(world, plan)
  const nameOf = new Map<string, string>()
  for (const b of doc.buildings) nameOf.set(b.id, b.name)
  for (const x of doc.externals) nameOf.set(x.id, x.name)
  const label = (id: string): string => nameOf.get(id) ?? id

  // Each district's parts gathered in one pass, in the world's order (looking through every part per district is
  // quadratic: minutes for 50,000 one-file districts).
  const byDistrict = new Map<string, string[]>()
  for (const b of doc.buildings) {
    const li = `<li${item('building', b.id)}>${esc(b.name)} <span>${esc(b.techLabel)} (${esc(b.status)})</span></li>`
    const list = byDistrict.get(b.districtId)
    if (list) list.push(li)
    else byDistrict.set(b.districtId, [li])
  }
  const districts = doc.districts.map((d) => {
    const items = (byDistrict.get(d.id) ?? []).join('')
    return `<li${item('district', d.id)}><h3>${esc(d.name)}</h3><p>${esc(d.subtitle)}</p><ul>${items}</ul></li>`
  }).join('')
  const externals = doc.externals.map((x) => `<li${item('building', x.id)}>${esc(x.name)} (${esc(x.kind)})</li>`).join('')
  const edges = doc.edges.map((e) => `<li${item('edge', e.id)}>${esc(label(e.from))} to ${esc(label(e.to))}: ${esc(edgeSummary(e.label))}</li>`).join('')
  return `<section class="world-fallback"><h2>${esc(title)}</h2>${renderMap(doc, title, label, removed)}<ul class="world-fallback-list">${districts}</ul>`
    + `<h3>Outside</h3><ul>${externals}</ul><h3>Connections</h3><ul>${edges}</ul></section>`
}
