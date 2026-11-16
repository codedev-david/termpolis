import { describe, it, expect } from 'vitest'
import { buildSceneModel, conduitStyle, DEFAULT_LAYERS, isMostlyInferred, lookOf } from '../../../src/renderer/src/world/engine/sceneModel'
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

  it('draws a mostly inferred building as fog, even when verified', () => {
    const b = building('f', { status: 'verified', how: [claim('a', 'inferred')], why: [claim('b', 'inferred')] })
    expect(lookFor(b)).toMatchObject({ look: 'fog', ring: false })
    expect(lookOf(building('g', { status: 'gap', how: [claim('a', 'inferred')], why: [] })).look).toBe('fog')
  })

  it('treats exactly half inferred as not mostly inferred, and no evidence as fog', () => {
    expect(isMostlyInferred(building('h', { how: [claim('a')], why: [claim('b', 'inferred')] }))).toBe(false)
    expect(isMostlyInferred(building('i', { how: [], why: [] }))).toBe(true)
    expect(isMostlyInferred(building('j', { how: [claim('a', 'observed', false)], why: [] }))).toBe(true)
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
    expect(withIt.conduits.find((c) => c.id === 'pe2')!.dashed).toBe(false)
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
    expect(m.districts.find((d) => d.id === 'd2')).toMatchObject({ pos: [0, 0, 0], radius: 6 })
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
