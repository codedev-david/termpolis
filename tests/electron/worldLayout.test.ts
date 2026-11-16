import { describe, it, expect } from 'vitest'
import type { Grouping } from '../../src/main/world/group'
import {
  layoutWorld,
  districtRadius,
  spiralSpot,
  placeBuilding,
  DEFAULT_SEED,
  DISTRICT_SPACING,
  MIN_SIBLING_GAP,
} from '../../src/main/world/layout'

function grouping(spec: Record<string, string[]>): Grouping {
  return {
    districts: Object.entries(spec).map(([d, bs]) => ({ id: d, name: d, members: bs })),
    buildings: Object.entries(spec).flatMap(([d, bs]) =>
      bs.map((b) => ({ id: b, districtId: d, name: b, members: [], process: '', boundaries: [] })),
    ),
    edges: [],
  }
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2])

const SPEC = {
  'd-a': ['b-a1', 'b-a2', 'b-a3', 'b-a4'],
  'd-b': ['b-b1', 'b-b2'],
  'd-c': ['b-c1'],
  'd-d': ['b-d1', 'b-d2', 'b-d3'],
}

describe('layoutWorld', () => {
  it('first layout places districts on a hex ring and buildings inside their district radius', () => {
    const g = grouping(SPEC)
    const l = layoutWorld(g, null)
    expect(l.seed).toBe(DEFAULT_SEED)
    expect(l.positions['d-a']).toEqual([0, 0, 0])
    const ids = ['d-a', 'd-b', 'd-c', 'd-d']
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(dist(l.positions[ids[i]], l.positions[ids[j]])).toBeGreaterThanOrEqual(DISTRICT_SPACING - 0.01)
      }
    }
    // The ring around the first district is at exactly the spacing.
    expect(dist(l.positions['d-a'], l.positions['d-b'])).toBeCloseTo(DISTRICT_SPACING, 1)
    for (const d of g.districts) {
      const r = districtRadius(d.members.length)
      for (const b of d.members) {
        const p = l.positions[b]
        expect(p[1]).toBe(0)
        expect(dist(p, l.positions[d.id])).toBeLessThanOrEqual(r)
      }
      for (const a of d.members) for (const b of d.members) {
        if (a < b) expect(dist(l.positions[a], l.positions[b])).toBeGreaterThanOrEqual(MIN_SIBLING_GAP)
      }
    }
  })

  it('keeps every previous position unchanged', () => {
    const first = layoutWorld(grouping(SPEC), null)
    const bigger = grouping({ ...SPEC, 'd-a': [...SPEC['d-a'], 'b-a5'], 'd-e': ['b-e1'] })
    const next = layoutWorld(bigger, first)
    for (const [id, p] of Object.entries(first.positions)) expect(next.positions[id]).toEqual(p)
    expect(next.seed).toBe(first.seed)
  })

  it('a new building lands within its district, at least 6 units from siblings', () => {
    const first = layoutWorld(grouping(SPEC), null)
    const next = layoutWorld(grouping({ ...SPEC, 'd-a': [...SPEC['d-a'], 'b-a5', 'b-a6'] }), first)
    for (const id of ['b-a5', 'b-a6']) {
      const p = next.positions[id]
      expect(dist(p, next.positions['d-a'])).toBeLessThanOrEqual(districtRadius(6))
      for (const s of SPEC['d-a'].concat(['b-a5', 'b-a6'])) {
        if (s !== id) expect(dist(p, next.positions[s])).toBeGreaterThanOrEqual(MIN_SIBLING_GAP)
      }
    }
  })

  it('a new district takes the next free hex slot, skipping slots near kept centres', () => {
    const first = layoutWorld(grouping({ 'd-a': ['b-1'], 'd-b': ['b-2'] }), null)
    // Pretend d-b was removed and a new district appears: its slot is d-b's old slot (free again).
    const prev = { seed: first.seed, positions: { 'd-a': first.positions['d-a'], 'b-1': first.positions['b-1'] } }
    const next = layoutWorld(grouping({ 'd-a': ['b-1'], 'd-z': ['b-z'] }), prev)
    expect(next.positions['d-z']).toEqual(first.positions['d-b'])
    // A kept district parked on slot 1 pushes the new one to slot 2.
    const parked = { seed: 1, positions: { 'd-a': [0, 0, 0] as [number, number, number], 'd-k': first.positions['d-b'] } }
    const n2 = layoutWorld(grouping({ 'd-a': [], 'd-k': [], 'd-z': [] }), parked)
    expect(n2.positions['d-k']).toEqual(first.positions['d-b'])
    expect(dist(n2.positions['d-z'], first.positions['d-b'])).toBeGreaterThanOrEqual(35)
    expect(dist(n2.positions['d-z'], [0, 0, 0])).toBeGreaterThanOrEqual(35)
  })

  it('many districts fill later hex rings with exact spacing and no overlap', () => {
    const spec: Record<string, string[]> = {}
    for (let i = 0; i < 20; i++) spec[`d-${String(i).padStart(2, '0')}`] = []
    const l = layoutWorld(grouping(spec), null)
    const ids = Object.keys(spec)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(dist(l.positions[ids[i]], l.positions[ids[j]])).toBeGreaterThanOrEqual(DISTRICT_SPACING - 0.01)
      }
    }
  })

  it("a removed building's position is dropped", () => {
    const first = layoutWorld(grouping(SPEC), null)
    const next = layoutWorld(grouping({ ...SPEC, 'd-a': ['b-a1', 'b-a2'] }), first)
    expect(next.positions['b-a3']).toBeUndefined()
    expect(next.positions['b-a4']).toBeUndefined()
    expect(next.positions['b-a1']).toEqual(first.positions['b-a1'])
  })

  it('same seed + same input = deep-equal output', () => {
    const a = layoutWorld(grouping(SPEC), null, 42)
    const b = layoutWorld(grouping(SPEC), null, 42)
    expect(a).toEqual(b)
    expect(a.seed).toBe(42)
    expect(layoutWorld(grouping(SPEC), null, 43).positions['b-a1']).not.toEqual(a.positions['b-a1'])
    for (const p of Object.values(a.positions)) for (const v of p) expect(Math.round(v * 100) / 100).toBe(v)
  })

  it('relayout=true via previous=null with the old seed reproduces the first layout', () => {
    const first = layoutWorld(grouping(SPEC), null, 7)
    const again = layoutWorld(grouping(SPEC), null, first.seed)
    expect(again).toEqual(first)
  })

  it('previous.seed is reused when no seed is passed; an explicit seed wins', () => {
    const prev = { seed: 99, positions: {} }
    expect(layoutWorld(grouping(SPEC), prev).seed).toBe(99)
    expect(layoutWorld(grouping(SPEC), prev, 5).seed).toBe(5)
  })

  it('adding one building does not move or reshuffle others (also with previous)', () => {
    const first = layoutWorld(grouping(SPEC), null)
    const next = layoutWorld(grouping({ ...SPEC, 'd-c': ['b-c1', 'b-c2'] }), first)
    expect(next.positions['b-d2']).toEqual(first.positions['b-d2'])
  })

  it('a kept building in a brand-new district keeps its position', () => {
    const prev = { seed: 1, positions: { 'b-x': [500, 0, 500] as [number, number, number] } }
    const l = layoutWorld(grouping({ 'd-n': ['b-x', 'b-y'] }), prev)
    expect(l.positions['b-x']).toEqual([500, 0, 500])
    expect(dist(l.positions['b-y'], l.positions['d-n'])).toBeGreaterThan(0)
  })

  it('placeBuilding falls back to a clear spot when every spiral spot is taken', () => {
    const radius = districtRadius(3)
    const taken: [number, number][] = []
    for (let i = 0; i < 400; i++) taken.push(spiralSpot('b-f', 1, 0, 0, i))
    const p = placeBuilding('b-f', 1, 0, 0, radius, taken)
    for (const t of taken) expect(Math.hypot(p[0] - t[0], p[1] - t[1])).toBeGreaterThanOrEqual(MIN_SIBLING_GAP)
    // Deterministic.
    expect(placeBuilding('b-f', 1, 0, 0, radius, taken)).toEqual(p)
    // With nothing in the way the first spiral spot is used.
    expect(placeBuilding('b-f', 1, 0, 0, radius, [])).toEqual(spiralSpot('b-f', 1, 0, 0, 0))
  })
})
