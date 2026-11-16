import { describe, expect, it } from 'vitest'
import { applyDesignPatch, emptyDesignDoc, type DesignOp } from '../../src/shared/world/designPatch'
import type { Building, WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'
import { layoutPlacer } from '../../src/main/world/designer'
import { LINKED_DESIGN_TITLE, PLAN_RING_GAP, overlayPlan } from '../../src/main/world/planOverlay'
import minDoc from '../shared/fixtures/world.min.json'

/** The minimal fixture: d1 "Core" at the origin with b1 "Desktop app" and b2 "Memory host", edge e1 b1 -> b2. */
function built(): WorldDoc {
  const doc = JSON.parse(JSON.stringify(minDoc)) as WorldDoc
  doc.layout.positions.d1 = [0, 0, 0]
  doc.layout.positions.d2 = [30, 0, 40]
  doc.districts.push({ id: 'd2', name: 'Empty', subtitle: '', hue: 1, members: [] })
  return doc
}

function design(ops: DesignOp[], at = 900): WorldDoc {
  const r = applyDesignPatch(emptyDesignDoc('design:p', at), ops, layoutPlacer)
  expect(r.skipped).toEqual([])
  return r.doc
}

const OPS: DesignOp[] = [
  { op: 'addDistrict', id: 'core', name: 'Core' },
  { op: 'addDistrict', id: 'ops', name: 'Operations' },
  { op: 'addBuilding', id: 'b1', districtId: 'core', name: 'Desktop', stack: ['Electron'] },
  { op: 'addBuilding', id: 'mem', districtId: 'core', name: 'Memory Host Service' },
  { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer', stack: ['SMTP'], does: 'sends mail' },
  { op: 'addBuilding', id: 'e1', districtId: 'ops', name: 'Alerts' },
  { op: 'addBuilding', id: 'cron', districtId: 'ops', name: 'Cron' },
  { op: 'addEdge', from: 'b1', to: 'mem', label: 'same as built' },
  { op: 'addEdge', from: 'mem', to: 'b1', label: 'reverse is new', cargo: 'jobs' },
  { op: 'addEdge', from: 'b1', to: 'mail', label: 'asks to send', cargo: 'mail' }
]

const bld = (doc: WorldDoc, id: string): Building => doc.layers.plan[0].buildings.find((b) => b.id === id) as Building

describe('overlayPlan', () => {
  it('lays the missing parts over the world as one linked proposal, placed by district or on the ring', () => {
    const doc = built()
    const out = overlayPlan(doc, design(OPS), null)
    expect(validateWorld(out).ok).toBe(true)
    expect(out.layers.plan).toHaveLength(1)
    const p = out.layers.plan[0]
    expect(p).toMatchObject({ id: 'design:p', title: LINKED_DESIGN_TITLE, summary: [] })
    expect(p.reconcile).toEqual({ matched: { b1: 'b1', mem: 'b2' }, missing: ['cron', 'e1', 'mail'], extra: [], planAt: 900 })
    // A missing plan id that is taken in the world gets a free one.
    expect(p.buildings.map((b) => b.id)).toEqual(['cron', 'e1-plan', 'mail'])
    expect(bld(out, 'mail')).toMatchObject({ districtId: 'd1', status: 'proposed', process: '' })
    expect(bld(out, 'cron').districtId).toBe('')
    // In "Core": near d1's centre, clear of b1 and b2. Outside: on the ring past the farthest district.
    const [mx, my, mz] = out.layout.positions.mail
    expect(my).toBe(0)
    expect(Math.hypot(mx, mz)).toBeLessThan(30)
    for (const id of ['cron', 'e1-plan']) {
      const [x, y, z] = out.layout.positions[id]
      expect(y).toBe(0)
      expect(Math.hypot(x, z)).toBeCloseTo(50 + PLAN_RING_GAP, 1)
    }
    // The built b1 -> b2 link is not drawn again; the reverse and the link to the missing part are.
    expect(p.edges.map((e) => [e.from, e.to, e.label])).toEqual([['b2', 'b1', 'reverse is new'], ['b1', 'mail', 'asks to send']])
    expect(out.cargo.mail).toBeDefined()
    expect(out.glossary.SMTP).toBe('')
    // The world itself is untouched.
    expect(out.buildings).toEqual(doc.buildings)
    expect(out.edges).toEqual(doc.edges)
    expect(doc.layers.plan).toEqual([])
  })

  it('keeps a previous overlay position, places a second part in the same district clear of the first, and lists extras', () => {
    const plan = design([
      { op: 'addDistrict', id: 'core', name: 'core' },
      { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' },
      { op: 'addBuilding', id: 'queue', districtId: 'core', name: 'Queue' }
    ])
    const first = overlayPlan(built(), plan, null)
    expect(first.layers.plan[0].reconcile?.extra).toEqual(['b1', 'b2'])
    const a = first.layout.positions.mail
    const b = first.layout.positions.queue
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThan(1)
    const previous: WorldDoc = JSON.parse(JSON.stringify(first))
    previous.layout.positions.mail = [7, 0, 7]
    const again = overlayPlan(built(), plan, previous)
    expect(again.layout.positions.mail).toEqual([7, 0, 7])
    expect(again.layout.positions.queue).toEqual(b)
    // A previous doc whose plan was not linked keeps nothing.
    previous.layers.plan[0].reconcile = undefined
    expect(overlayPlan(built(), plan, previous).layout.positions.mail).toEqual(a)
  })

  it('skips plan edges to unknown parts and keeps cargo and glossary the world already has', () => {
    const plan = design([
      { op: 'addDistrict', id: 'x', name: '---' },
      { op: 'addBuilding', id: 'n1', districtId: 'x', name: 'New', stack: ['electron'] },
      { op: 'addBuilding', id: 'b1', districtId: 'x', name: 'Desktop' },
      { op: 'addEdge', from: 'n1', to: 'b1', label: 'l', cargo: 'IPC' }
    ])
    plan.edges.push({ ...plan.edges[0], id: 'ghost', from: 'nowhere', to: 'n1' })
    const doc = built()
    doc.cargo.IPC = { shape: 'cube', color: '#123456', label: 'Existing' }
    const out = overlayPlan(doc, plan, null)
    expect(out.layers.plan[0].edges.map((e) => e.label)).toEqual(['l'])
    expect(out.cargo.IPC.label).toBe('Existing')
    expect(out.glossary.electron).toBe(doc.glossary.electron)
    expect(out.layers.plan[0].buildings[0].districtId).toBe('')
  })

  it('takes plan glossary entries and falls back to an empty definition', () => {
    const plan = design([{ op: 'addDistrict', id: 'x', name: 'X' }, { op: 'addBuilding', id: 'n1', districtId: 'x', name: 'New', stack: ['Kafka'] }])
    plan.glossary.Kafka = 'A message log'
    plan.buildings[0].floors = [{ name: 'f', tech: ['Redis'], members: [] }]
    const out = overlayPlan(built(), plan, null)
    expect(out.glossary.Kafka).toBe('A message log')
    expect(out.glossary.Redis).toBe('')
  })

  it('numbers taken ids, and drops an overlay that would not validate', () => {
    const plan = design([{ op: 'addDistrict', id: 'x', name: 'X' }, { op: 'addBuilding', id: 'e1', districtId: 'x', name: 'Z' }])
    const doc = built()
    doc.externals.push({ id: 'e1-plan', name: 'taken', kind: 'service', fog: false })
    doc.layout.positions['e1-plan'] = [100, 12, 0]
    expect(overlayPlan(doc, plan, null).layers.plan[0].buildings[0].id).toBe('e1-plan-2')

    const bad = design([
      { op: 'addDistrict', id: 'x', name: 'X' },
      { op: 'addBuilding', id: 'n1', districtId: 'x', name: 'New' },
      { op: 'addBuilding', id: 'b1', districtId: 'x', name: 'Desktop' },
      { op: 'addEdge', from: 'n1', to: 'b1', label: 'l', cargo: 'nope' }
    ])
    delete bad.cargo.nope
    const plain = built()
    expect(overlayPlan(plain, bad, null)).toBe(plain)
  })

  it('a world with no districts rings the missing parts around the origin', () => {
    const doc = built()
    doc.districts = []
    doc.buildings = []
    doc.edges = []
    doc.tours = []
    const out = overlayPlan(doc, design([{ op: 'addDistrict', id: 'x', name: 'X' }, { op: 'addBuilding', id: 'n1', districtId: 'x', name: 'New' }]), null)
    expect(out.layout.positions.n1).toEqual([-PLAN_RING_GAP, 0, 0])
  })
})
