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
    expect(p.reconcile).toEqual({ matched: { b1: 'b1', mem: 'b2' }, missing: ['cron', 'e1', 'mail'], extra: [], changed: [], planAt: 900 })
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

  it('maps the removals of the design to built ids, and outlines a matched part the build does not yet meet, on every overlay', () => {
    const plan = design([...OPS, { op: 'removePart', id: 'mem' }, { op: 'removePart', id: 'mail' }])
    const first = overlayPlan(built(), plan, null)
    // mem is matched to the built b2; mail is missing (nothing built to fade).
    expect(first.layers.plan[0].removes).toEqual(['b2'])
    // The design wants b1 on Electron: met by the fixture, so nothing is outlined.
    expect(first.layers.plan[0].reconcile?.changed).toEqual([])
    // Take Electron away and b1 is outlined, and still outlined on a recompile that changes nothing.
    const bare = built()
    bare.buildings[0].stack = []
    bare.buildings[0].floors = bare.buildings[0].floors.map((f) => ({ ...f, tech: [] }))
    const out = overlayPlan(bare, plan, first)
    expect(out.layers.plan[0].reconcile?.changed).toEqual(['b1'])
    expect(overlayPlan(bare, plan, out).layers.plan[0].reconcile?.changed).toEqual(['b1'])
    // Once the build names it, the part is done.
    const met = built()
    expect(overlayPlan(met, plan, out).layers.plan[0].reconcile?.changed).toEqual([])
    expect(overlayPlan(built(), design(OPS), null).layers.plan[0].removes).toBeUndefined()
    // A design proposal that takes nothing away adds nothing.
    const plain = design(OPS)
    plain.layers.plan.push({ id: 'x', title: 'X', summary: [], buildings: [], edges: [] })
    expect(overlayPlan(built(), plain, null).layers.plan[0].removes).toBeUndefined()
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

  /** The built world after a part was written: a copy of b2 under a new id and name, laid out at `pos`. */
  function withBuilt(doc: WorldDoc, id: string, name: string, districtId: string, pos: [number, number, number]): WorldDoc {
    const b = JSON.parse(JSON.stringify(doc.buildings[1])) as Building
    doc.buildings.push({ ...b, id, name, districtId, members: [`src/${id}.ts`], floors: [] })
    doc.layout.positions[id] = pos
    return doc
  }
  const ROUND4: DesignOp[] = [
    { op: 'addDistrict', id: 'core', name: 'Core' },
    { op: 'addDistrict', id: 'ops', name: 'Operations' },
    { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' },
    { op: 'addBuilding', id: 'cron', districtId: 'ops', name: 'Cron' }
  ]

  it('a part built from the design takes its wireframe\'s place, keeps it on later compiles, and leaves no wireframe behind', () => {
    const plan = design(ROUND4)
    const first = overlayPlan(built(), plan, null)
    const mailAt = first.layout.positions.mail
    const cronAt = first.layout.positions.cron
    expect(first.layers.plan[0].buildings.map((b) => b.id)).toEqual(['cron', 'mail'])
    // The code now has a Mailer, laid out somewhere else in Core: it stands where the wireframe stood.
    const second = overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-9, 0, 9]), plan, first)
    expect(second.layers.plan[0].reconcile?.matched).toEqual({ mail: 'src-mail' })
    expect(second.layout.positions['src-mail']).toEqual(mailAt)
    expect(second.layers.plan[0].buildings.map((b) => b.id)).toEqual(['cron'])
    // A ring wireframe's spot lies outside every district: the part built from it stands in its own district,
    // where the layout put it, and no wireframe is left (round 6 I1).
    expect(Math.hypot(cronAt[0] - 30, cronAt[2] - 40)).toBeGreaterThan(20)
    const third = overlayPlan(withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-9, 0, 9]), 'jobs-cron', 'Cron', 'd2', [33, 0, 41]), plan, second)
    expect(third.layout.positions['jobs-cron']).toEqual([33, 0, 41])
    expect(third.layers.plan[0].buildings).toEqual([])
    // A later recompile, whose layout put both elsewhere, does not move them.
    const fourth = overlayPlan(withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [4, 0, 4]), 'jobs-cron', 'Cron', 'd2', [31, 0, 39]), plan, third)
    expect(fourth.layout.positions['src-mail']).toEqual(mailAt)
    expect(fourth.layout.positions['jobs-cron']).toEqual([33, 0, 41])
    expect(validateWorld(fourth).ok).toBe(true)
    // A test joins the Mailer and its id changes with its files: the part still stands at the wireframe's spot.
    const renamed = overlayPlan(withBuilt(withBuilt(built(), 'src-mail-2', 'Mailer', 'd1', [4, 0, 4]), 'jobs-cron', 'Cron', 'd2', [31, 0, 39]), plan, fourth)
    expect(renamed.layers.plan[0].reconcile?.matched).toEqual({ cron: 'jobs-cron', mail: 'src-mail-2' })
    expect(renamed.layout.positions['src-mail-2']).toEqual(mailAt)
    // The part now matches a new building by id while the old one still stands: the new one takes its own spot.
    const both = withBuilt(withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [4, 0, 4]), 'jobs-cron', 'Cron', 'd2', [31, 0, 39]), 'mail', 'Post', 'd1', [-4, 0, -4])
    const byId = overlayPlan(both, plan, fourth)
    expect(byId.layers.plan[0].reconcile?.matched).toEqual({ cron: 'jobs-cron', mail: 'mail' })
    expect(byId.layout.positions.mail).toEqual([-4, 0, -4])
    expect(byId.layout.positions['src-mail']).toEqual([4, 0, 4])
    // A part that moved to another district takes its new district's spot.
    const moved = overlayPlan(withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd2', [24, 0, 36]), 'jobs-cron', 'Cron', 'd2', [31, 0, 39]), plan, fourth)
    expect(moved.layout.positions['src-mail']).toEqual([24, 0, 36])
    expect(moved.layout.positions['jobs-cron']).toEqual([33, 0, 41])
    // Re-layout (a previous layout with no positions) lays matched parts out like any other.
    const relaid: WorldDoc = JSON.parse(JSON.stringify(fourth))
    relaid.layout.positions = {}
    const fifth = overlayPlan(withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [4, 0, 4]), 'jobs-cron', 'Cron', 'd2', [31, 0, 39]), plan, relaid)
    expect(fifth.layout.positions['src-mail']).toEqual([4, 0, 4])
    expect(fifth.layout.positions['jobs-cron']).toEqual([31, 0, 39])
  })

  /** No two buildings of a district closer than the layout's sibling gap (6). */
  function noStacking(doc: WorldDoc): void {
    for (const a of doc.buildings) {
      for (const b of doc.buildings) {
        if (a.id >= b.id || a.districtId !== b.districtId) continue
        const [p, q] = [doc.layout.positions[a.id], doc.layout.positions[b.id]]
        expect(Math.hypot(p[0] - q[0], p[2] - q[2]), `${a.id} / ${b.id}`).toBeGreaterThanOrEqual(6)
      }
    }
  }

  it("a built part takes its wireframe's spot, or keeps it, only inside its own district's slab (round 6 I1)", () => {
    const plan = design(ROUND4)
    const first = overlayPlan(built(), plan, null)
    // The design puts Mailer in Core (d1), the code in d2: the d1 spot is outside d2, so the layout's spot stands.
    const elsewhere = overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd2', [24, 0, 36]), plan, first)
    expect(elsewhere.layers.plan[0].reconcile?.matched).toEqual({ mail: 'src-mail' })
    expect(elsewhere.layout.positions['src-mail']).toEqual([24, 0, 36])
    // A spot held from before that now lies off the slab (here set by hand) is dropped the same way.
    const second = overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-9, 0, 9]), plan, first)
    const stale: WorldDoc = JSON.parse(JSON.stringify(second))
    stale.layout.positions['src-mail'] = [25, 0, 0]
    expect(overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [4, 0, 4]), plan, stale).layout.positions['src-mail']).toEqual([4, 0, 4])
    // A built part in a district with no place gets none: the world is not overlaid at all.
    const lost = withBuilt(built(), 'src-mail', 'Mailer', 'nowhere', [-9, 0, 9])
    expect(overlayPlan(lost, plan, first).layout.positions['src-mail']).toEqual([-9, 0, 9])
  })

  it("a built part never stacks on a sibling the layout put on its wireframe's or its held spot (round 6 I2)", () => {
    const plan = design(ROUND4)
    const first = overlayPlan(built(), plan, null)
    const mailAt = first.layout.positions.mail
    // A new sibling lands where the wireframe stood: the built part keeps the layout's spot.
    const crowded = withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-12, 0, 9]), 'src-new', 'Queue', 'd1', mailAt)
    const second = overlayPlan(crowded, plan, first)
    expect(second.layers.plan[0].reconcile?.matched).toEqual({ mail: 'src-mail' })
    expect(second.layout.positions['src-mail']).toEqual([-12, 0, 9])
    expect(second.layout.positions['src-new']).toEqual(mailAt)
    noStacking(second)
    // The part took the spot; on the next compile a new sibling lands on it: the part moves to the layout's spot.
    const took = overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-9, 0, 9]), plan, first)
    expect(took.layout.positions['src-mail']).toEqual(mailAt)
    const later = overlayPlan(withBuilt(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [0, 0, -8]), 'src-new', 'Queue', 'd1', mailAt), plan, took)
    expect(later.layout.positions['src-mail']).toEqual([0, 0, -8])
    noStacking(later)
  })

  /** The world with a new district `id` (no previous compile had it) at `at`, holding the given buildings. */
  function withDistrict(doc: WorldDoc, id: string, at: [number, number, number]): WorldDoc {
    doc.districts.push({ id, name: id, subtitle: '', hue: 2, members: [] })
    doc.layout.positions[id] = at
    return doc
  }

  it('a part built from a ring wireframe whose district is new and holds only it: the district moves under the wireframe (round 7)', () => {
    const plan = design(ROUND4)
    const first = overlayPlan(built(), plan, null)
    const cronAt = first.layout.positions.cron
    expect(cronAt).toEqual([-70, 0, 0])
    // The code's new "jobs" folder becomes district d3, which the layout put on a free slot at [70, 0, 0].
    const fresh = withBuilt(withDistrict(built(), 'd3', [70, 0, 0]), 'jobs-cron', 'Cron', 'd3', [72, 0, 1])
    const second = overlayPlan(fresh, plan, first)
    expect(second.layers.plan[0].reconcile?.matched).toEqual({ cron: 'jobs-cron' })
    // The building rises where the wireframe stood, and its slab moves with it, so it stands on its own slab.
    expect(second.layout.positions['jobs-cron']).toEqual(cronAt)
    expect(second.layout.positions.d3).toEqual([-72, 0, -1])
    expect(second.layers.plan[0].buildings.map((b) => b.id)).toEqual(['mail'])
    expect(validateWorld(second).ok).toBe(true)
    // The next compile keeps the district where it now is (layoutWorld keeps a district's place): nothing moves.
    const kept = withBuilt(withDistrict(built(), 'd3', [-72, 0, -1]), 'jobs-cron', 'Cron', 'd3', [-70, 0, 0])
    const third = overlayPlan(kept, plan, second)
    expect(third.layout.positions.d3).toEqual([-72, 0, -1])
    expect(third.layout.positions['jobs-cron']).toEqual(cronAt)
  })

  it('a new district is moved only when it holds just the part and its slab would clear every other district (round 7)', () => {
    const plan = design(ROUND4)
    const first = overlayPlan(built(), plan, null)
    // A second building in the new district: the district stays where the layout put it.
    const two = withBuilt(withBuilt(withDistrict(built(), 'd3', [70, 0, 0]), 'jobs-cron', 'Cron', 'd3', [72, 0, 1]), 'jobs-q', 'Queue', 'd3', [66, 0, -3])
    const a = overlayPlan(two, plan, first)
    expect(a.layout.positions.d3).toEqual([70, 0, 0])
    expect(a.layout.positions['jobs-cron']).toEqual([72, 0, 1])
    // Another district near the wireframe's spot: the slab would crowd it, so it stays put too.
    const near = withDistrict(withBuilt(withDistrict(built(), 'd3', [70, 0, 0]), 'jobs-cron', 'Cron', 'd3', [72, 0, 1]), 'd4', [-80, 0, 10])
    const b = overlayPlan(near, plan, first)
    expect(b.layout.positions.d3).toEqual([70, 0, 0])
    expect(b.layout.positions['jobs-cron']).toEqual([72, 0, 1])
    // A district that stood before (d2, empty until now) never moves: other compiles placed it.
    const old = overlayPlan(withBuilt(built(), 'jobs-cron', 'Cron', 'd2', [33, 0, 41]), plan, first)
    expect(old.layout.positions.d2).toEqual([30, 0, 40])
    expect(old.layout.positions['jobs-cron']).toEqual([33, 0, 41])
  })

  it('spots come only from the same design: a project linked to another design holds none (round 6 M3)', () => {
    const plan = design(ROUND4)
    const first = overlayPlan(built(), plan, null)
    const relinked: WorldDoc = JSON.parse(JSON.stringify(first))
    relinked.layers.plan[0].id = 'design:other'
    expect(overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-9, 0, 9]), plan, relinked).layout.positions['src-mail']).toEqual([-9, 0, 9])
  })

  it('a planned part that matches a building already standing leaves that building where it is', () => {
    const first = overlayPlan(built(), design([{ op: 'addDistrict', id: 'core', name: 'Core' }, { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Mailer' }]), null)
    expect(first.layout.positions.mail).toBeDefined()
    // The design is edited so its part names the built Memory host: b2 stays put, the wireframe goes.
    const renamed = design([{ op: 'addDistrict', id: 'core', name: 'Core' }, { op: 'addBuilding', id: 'mail', districtId: 'core', name: 'Memory host' }])
    const next = overlayPlan(built(), renamed, first)
    expect(next.layers.plan[0].reconcile?.matched).toEqual({ mail: 'b2' })
    expect(next.layout.positions.b2).toEqual([6, 0, 0])
    expect(next.layers.plan[0].buildings).toEqual([])
    // A previous world whose design was not linked carries no spots either.
    const unlinked: WorldDoc = JSON.parse(JSON.stringify(first))
    unlinked.layers.plan[0].reconcile = undefined
    expect(overlayPlan(withBuilt(built(), 'src-mail', 'Mailer', 'd1', [-9, 0, 9]), design(ROUND4), unlinked).layout.positions['src-mail']).toEqual([-9, 0, 9])
  })
})
