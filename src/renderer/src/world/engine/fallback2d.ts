// Semantic list for browsers without WebGL: every district, its buildings, and the connections.
import type { WorldDoc } from '../../../../shared/world/types'
import { escapeHtml as esc } from './html'

export function renderFallback(doc: WorldDoc): string {
  const nameOf = new Map<string, string>()
  for (const b of doc.buildings) nameOf.set(b.id, b.name)
  for (const x of doc.externals) nameOf.set(x.id, x.name)
  const label = (id: string): string => nameOf.get(id) ?? id

  const districts = doc.districts.map((d) => {
    const items = doc.buildings.filter((b) => b.districtId === d.id)
      .map((b) => `<li>${esc(b.name)} <span>${esc(b.techLabel)} (${esc(b.status)})</span></li>`).join('')
    return `<li><h3>${esc(d.name)}</h3><p>${esc(d.subtitle)}</p><ul>${items}</ul></li>`
  }).join('')
  const externals = doc.externals.map((x) => `<li>${esc(x.name)} (${esc(x.kind)})</li>`).join('')
  const edges = doc.edges.map((e) => `<li>${esc(label(e.from))} to ${esc(label(e.to))}: ${esc(e.label)}</li>`).join('')
  return `<section class="world-fallback"><h2>${esc(doc.projectKey)}</h2><ul>${districts}</ul>`
    + `<h3>Outside</h3><ul>${externals}</ul><h3>Connections</h3><ul>${edges}</ul></section>`
}
