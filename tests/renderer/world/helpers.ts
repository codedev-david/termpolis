import type { Building, Claim, WorldDoc, WorldEdge } from '../../../src/shared/world/types'
import minDoc from '../../shared/fixtures/world.min.json'

export const minimal = (): WorldDoc => JSON.parse(JSON.stringify(minDoc)) as WorldDoc

export const claim = (text: string, state: Claim['state'] = 'observed', withEvidence = true): Claim =>
  ({ text, state, evidence: withEvidence ? [{ kind: 'file', ref: 'a/b.ts' }] : [] })

export const building = (id: string, over: Partial<Building> = {}): Building => ({
  id, districtId: 'd1', name: id, techLabel: 'Node', process: 'main',
  floors: [{ name: 'F', tech: ['ipc'], members: [] }], stack: ['ipc'],
  how: [claim('does a thing')], why: [claim('because')], status: 'built', members: [], ...over,
})

export const edge = (id: string, from: string, to: string, over: Partial<WorldEdge> = {}): WorldEdge => ({
  id, from, to, cargo: 'memory', label: id, how: [claim('how')], tech: [], why: [], rate: 'on demand', twoWay: false, ...over,
})

/** The minimal fixture plus a gap building, a proposed building, an empty district and proposal p1. */
export const rich = (): WorldDoc => {
  const doc = minimal()
  doc.buildings.push(building('b3', { status: 'gap', districtId: 'd1' }))
  doc.buildings.push(building('b4', { status: 'proposed' }))
  doc.edges.push(edge('e2', 'b1', 'b4'))
  doc.edges.push(edge('e3', 'b3', 'x1', { rate: 'constant stream', cargo: 'nope' }))
  doc.districts.push({ id: 'd2', name: 'Empty', subtitle: 'Nothing here', hue: 10, members: [] })
  doc.layers.plan.push({
    id: 'p1', title: 'Plan', summary: [],
    buildings: [building('pb1', { status: 'built' })],
    edges: [edge('pe1', 'b1', 'pb1'), edge('pe2', 'b1', 'b2')],
  })
  return doc
}
