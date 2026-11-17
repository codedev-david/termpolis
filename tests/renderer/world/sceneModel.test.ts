import { describe, it, expect } from 'vitest'
import { buildSceneModel, conduitStyle, DEFAULT_LAYERS, isMostlyInferred, lookOf } from '../../../src/renderer/src/world/engine/sceneModel'
import { NOT_IN_DESIGN } from '../../../src/shared/world/reconcile'
import { building, claim, edge, minimal, rich } from './helpers'

const lookFor = (b: ReturnType<typeof building>) => {
  const doc = minimal()
  doc.buildings = [b]
  return buildSceneModel(doc, DEFAULT_LAYERS).buildings[0]
}

describe('buildSceneModel', () => {
  it('maps status to look', () => {
    const m = buildSceneModel(rich(), DEFAULT_LAYERS)
    const by = (id: string) => m.buildings.find((b) => b.id === id)!
    expect(by('b2')).toMatchObject({ look: 'solid', ring: true })
    expect(by('b1')).toMatchObject({ look: 'solid', ring: false })
    expect(by('b3')).toMatchObject({ look: 'amber', ring: false })
    expect(by('b4')).toMatchObject({ look: 'wire', ring: false })
  })

  it('a fogged id is fog even when its claims are verified; others are untouched', () => {
    const m = buildSceneModel(rich(), DEFAULT_LAYERS, { fogged: new Set(['b2']) })
    expect(m.buildings.find((b) => b.id === 'b2')).toMatchObject({ look: 'fog', ring: false })
    expect(m.buildings.find((b) => b.id === 'b1')).toMatchObject({ look: 'solid' })
  })

  it('draws a mostly inferred building as fog, even when verified', () => {
    const b = building('f', { status: 'verified', how: [claim('a', 'inferred')], why: [claim('b', 'inferred')] })
    expect(lookFor(b)).toMatchObject({ look: 'fog', ring: false })
    expect(lookOf(building('g', { status: 'gap', how: [claim('a', 'inferred')], why: [] })).look).toBe('fog')
  })

  it('treats exactly half inferred as not mostly inferred, and no evidence as fog', () => {
    expect(isMostlyInferred(building('h', { how: [claim('a')], why: [claim('b', 'inferred')] }))).toBe(false)
    expect(isMostlyInferred(building('j2', { how: [claim('a', 'inferred'), claim('b', 'inferred')], why: [] }))).toBe(true)
    expect(isMostlyInferred(building('j', { how: [claim('a', 'observed', false)], why: [] }))).toBe(true)
  })

  it('draws a building with no claims (code-derived names only) as certain structure, not fog', () => {
    expect(isMostlyInferred(building('i', { how: [], why: [] }))).toBe(false)
    expect(lookOf(building('i2', { status: 'gap', how: [], why: [] }))).toEqual({ look: 'amber', ring: false })
    expect(lookOf(building('i3', { status: 'built', how: [], why: [] }))).toEqual({ look: 'solid', ring: false })
  })

  it('lets proposed win over fog', () => {
    expect(lookOf(building('k', { status: 'proposed', how: [], why: [] }))).toEqual({ look: 'wire', ring: false })
  })

  it('hides proposed buildings and their edges when planned is off', () => {
    const m = buildSceneModel(rich(), { ...DEFAULT_LAYERS, planned: false })
    expect(m.buildings.map((b) => b.id)).not.toContain('b4')
    expect(m.conduits.map((c) => c.id)).not.toContain('e2')
    expect(m.conduits.map((c) => c.id)).toContain('e1')
  })

  it('reveals a proposal as wire buildings and dashed conduits, and only then', () => {
    const doc = rich()
    const without = buildSceneModel(doc, DEFAULT_LAYERS)
    expect(without.buildings.map((b) => b.id)).not.toContain('pb1')
    expect(without.conduits.map((c) => c.id)).not.toContain('pe1')
    const withIt = buildSceneModel(doc, { ...DEFAULT_LAYERS, planned: false }, { revealProposal: 'p1' })
    expect(withIt.buildings.find((b) => b.id === 'pb1')).toMatchObject({ look: 'wire', ring: false })
    expect(withIt.conduits.find((c) => c.id === 'pe1')!.dashed).toBe(true)
    expect(withIt.conduits.find((c) => c.id === 'pe2')!.dashed).toBe(true)
  })

  it('ignores an unknown proposal id', () => {
    const m = buildSceneModel(rich(), DEFAULT_LAYERS, { revealProposal: 'zzz' })
    expect(m.buildings.map((b) => b.id)).not.toContain('pb1')
  })

  it('places things, shapes conduits and districts', () => {
    const m = buildSceneModel(rich(), { ...DEFAULT_LAYERS, processes: true })
    const e1 = m.conduits.find((c) => c.id === 'e1')!
    expect(e1.from).toEqual([0, 0, 0])
    expect(e1.to).toEqual([6, 0, 0])
    expect(e1.ctrl).toEqual([3, 6 * 0.22 + 4, 0])
    expect(e1).toMatchObject({ dashed: false, color: '#6aa9ff', cargo: 'memory', width: 0.1 })
    expect(m.buildings.find((b) => b.id === 'b1')).toMatchObject({ floors: 1, height: 3, processShell: 'main' })
    expect(m.orbs).toEqual([{ id: 'x1', pos: [16, 0, 14], fog: false }])
    const d1 = m.districts.find((d) => d.id === 'd1')!
    expect(d1).toMatchObject({ hue: 210, label: 'Core' })
    expect(d1.radius).toBeGreaterThanOrEqual(6)
    expect(m.districts.find((d) => d.id === 'd2')).toBeUndefined()
  })

  it('omits processShell by default and gives a building without floors one storey', () => {
    const b = lookFor(building('z', { floors: [] }))
    expect(b.floors).toBe(1)
    expect('processShell' in b).toBe(false)
  })

  it('wraps fallback positions onto new rows', () => {
    const doc = minimal()
    doc.layout.positions = {}
    doc.externals = []
    doc.buildings = Array.from({ length: 7 }, (_, i) => building(`n${i}`))
    const m = buildSceneModel(doc, DEFAULT_LAYERS)
    expect(m.buildings[6].pos).toEqual([0, 0, 22])
    expect(m.buildings[5].pos).toEqual([40, 0, 14])
  })

  it('skips an edge whose endpoint is unknown', () => {
    const doc = minimal()
    doc.edges.push(edge('ex', 'b1', 'ghost'))
    expect(buildSceneModel(doc, DEFAULT_LAYERS).conduits.map((c) => c.id)).toEqual(['e1'])
  })
})

describe('proposal reveal and edge cases', () => {
  it('draws a revealed proposal edge between two solid buildings dashed', () => {
    const m = buildSceneModel(rich(), DEFAULT_LAYERS, { revealProposal: 'p1' })
    expect(m.conduits.find((c) => c.id === 'pe2')!.dashed).toBe(true)
    expect(m.conduits.find((c) => c.id === 'e1')!.dashed).toBe(false)
  })

  it('skips proposal items whose id already exists; the doc item wins', () => {
    const doc = rich()
    doc.layers.plan[0].buildings.push(building('b2', { status: 'built', name: 'Impostor' }))
    doc.layers.plan[0].edges.push(edge('e1', 'b1', 'b2', { cargo: 'other' }))
    const m = buildSceneModel(doc, DEFAULT_LAYERS, { revealProposal: 'p1' })
    expect(m.buildings.filter((b) => b.id === 'b2')).toHaveLength(1)
    expect(m.buildings.find((b) => b.id === 'b2')).toMatchObject({ look: 'solid', ring: true })
    expect(m.conduits.filter((c) => c.id === 'e1')).toHaveLength(1)
    expect(m.conduits.find((c) => c.id === 'e1')).toMatchObject({ cargo: 'memory', dashed: false })
  })

  it('omits a district with no visible buildings', () => {
    const doc = minimal()
    doc.buildings[0].districtId = 'd9'
    doc.buildings[0].status = 'proposed'
    doc.districts.push({ id: 'd9', name: 'Hidden', subtitle: '', hue: 1, members: [] })
    const ids = (planned: boolean) => buildSceneModel(doc, { ...DEFAULT_LAYERS, planned }).districts.map((d) => d.id)
    expect(ids(true)).toContain('d9')
    expect(ids(false)).not.toContain('d9')
  })

  it('arcs a self-loop sideways', () => {
    const doc = minimal()
    doc.edges.push(edge('loop', 'b1', 'b1'))
    const c = buildSceneModel(doc, DEFAULT_LAYERS).conduits.find((x) => x.id === 'loop')!
    expect(c.ctrl).toEqual([3, 4, 0])
    expect(c.ctrl).not.toEqual(c.from)
  })

  it('classifies rates on word boundaries', () => {
    const w = (rate: string) => conduitStyle(minimal(), edge('a', 'b1', 'b2', { rate })).width
    expect(w('rarely')).toBe(0.1)
    expect(w('upstream traffic')).toBe(0.18)
    expect(w('at once')).toBe(0.18)
    expect(w('once')).toBe(0.1)
    expect(w('Streaming')).toBe(0.3)
    expect(w('every second')).toBe(0.3)
    expect(w('')).toBe(0.18)
  })
})

describe('conduitStyle', () => {
  const doc = rich()
  it('derives width from rate and colour from cargo', () => {
    expect(conduitStyle(doc, edge('a', 'b1', 'b2', { rate: 'constant stream' }))).toEqual({ width: 0.3, color: '#6aa9ff' })
    expect(conduitStyle(doc, edge('a', 'b1', 'b2', { rate: 'on demand' })).width).toBe(0.1)
    expect(conduitStyle(doc, edge('a', 'b1', 'b2', { rate: 'sometimes' })).width).toBe(0.18)
    expect(conduitStyle(doc, edge('a', 'b1', 'b2', { cargo: 'nope' })).color).toBe('#94a3b8')
  })
  it('accepts a live override', () => {
    const e = edge('a', 'b1', 'b2')
    expect(conduitStyle(doc, e, { width: 1, color: '#fff' })).toEqual({ width: 1, color: '#fff' })
    expect(conduitStyle(doc, e, {})).toEqual({ width: 0.1, color: '#6aa9ff' })
  })
})

/** The linked design chosen in the selector. */
const ON = { ...DEFAULT_LAYERS, proposal: 'design:p' }

describe('linked design overlay', () => {
  /** minimal() plus a linked design: plan "auth" matched b1, "mailer" is missing (drawn as pm), b2 is not in the design. */
  const linked = () => {
    const doc = minimal()
    doc.layout.positions.pm = [30, 0, 30]
    doc.layers.plan.push({
      id: 'design:p', title: 'Linked design', summary: [],
      buildings: [building('pm', { status: 'proposed', districtId: 'd1' })],
      edges: [edge('pe', 'b1', 'pm')],
      reconcile: { matched: { auth: 'b1' }, missing: ['mailer'], extra: ['b2'], changed: [], planAt: 1 }
    })
    return doc
  }

  it('sceneModel draws matched as solid at built pos, missing as wire', () => {
    const doc = linked()
    const m = buildSceneModel(doc, ON)
    const b1 = m.buildings.find((b) => b.id === 'b1')
    const pm = m.buildings.find((b) => b.id === 'pm')
    const b2 = m.buildings.find((b) => b.id === 'b2')
    expect(b1).toMatchObject({ pos: [0, 0, 0], look: 'solid' })
    expect(b1?.tag).toBeUndefined()
    expect(pm).toMatchObject({ pos: [30, 0, 30], look: 'wire', ring: false })
    expect(b2?.tag).toBe(NOT_IN_DESIGN)
    expect(m.conduits.find((c) => c.id === 'pe')).toMatchObject({ dashed: true, from: [0, 0, 0], to: [30, 0, 30] })
    // The district takes the planned building in.
    expect(m.districts[0].radius).toBeGreaterThan(20)
  })

  it('changed => solid with outline; removes => fading; new => wireframe; done => solid without outline', () => {
    const doc = linked()
    const rec = doc.layers.plan[0]
    rec.reconcile = { ...(rec.reconcile as NonNullable<typeof rec.reconcile>), changed: ['b1'] }
    rec.removes = ['b2']
    const m = buildSceneModel(doc, ON)
    const at = (id: string) => m.buildings.find((b) => b.id === id)
    expect(at('b1')).toMatchObject({ look: 'solid', outline: true })
    expect(at('b2')).toMatchObject({ look: 'fading', outline: false, ring: false })
    expect(at('pm')).toMatchObject({ look: 'wire', outline: false })
    // A fogged answer part stays fog even when it is being removed.
    const fog = buildSceneModel(doc, ON, { fogged: new Set(['b2']) })
    expect(fog.buildings.find((b) => b.id === 'b2')?.look).toBe('fog')
    // No proposal chosen: no wireframe, outline or fade.
    const none = buildSceneModel(doc, DEFAULT_LAYERS)
    expect(none.buildings.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(none.buildings.every((b) => !b.outline && b.look === 'solid')).toBe(true)
    // A reconcile stored before `changed` existed outlines nothing.
    delete (rec.reconcile as { changed?: string[] }).changed
    expect(buildSceneModel(doc, ON).buildings.every((b) => !b.outline)).toBe(true)
  })

  it('hides the linked design, and its tags, when planned is off', () => {
    const m = buildSceneModel(linked(), { ...ON, planned: false })
    expect(m.buildings.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(m.buildings.every((b) => b.tag === undefined)).toBe(true)
    expect(m.conduits.map((c) => c.id)).toEqual(['e1'])
  })

  it('draws the linked design once when it is also the revealed proposal, beside another revealed one', () => {
    const doc = linked()
    const once = buildSceneModel(doc, ON, { revealProposal: 'design:p' })
    expect(once.buildings.filter((b) => b.id === 'pm')).toHaveLength(1)
    expect(once.conduits.filter((c) => c.id === 'pe')).toHaveLength(1)
    doc.layers.plan.push({ id: 'p2', title: 'Other', summary: [], buildings: [building('q1', { status: 'proposed' })], edges: [] })
    const both = buildSceneModel(doc, ON, { revealProposal: 'p2' })
    expect(both.buildings.map((b) => b.id)).toEqual(['b1', 'b2', 'pm', 'q1'])
  })
})
