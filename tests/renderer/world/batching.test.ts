import { describe, expect, it } from 'vitest'
import { batchable, batchCapacity, batchRank, buildingNamesShown, districtAt, districtsOf, endHeight, fillKey, floorLabelsShown, groupBatches, heldTier, packetKey, partDrawn, poolChanges, SLAB_INSET, SLAB_MIN_HEIGHT, slabSeams, slabsFor, tierPick, transparentOrder, type SortItem } from '../../../src/renderer/src/world/engine/batching'

describe('partDrawn', () => {
  it('draws floors from the floors tier in, and one block further out', () => {
    expect(partDrawn('floor', 'floors', false)).toBe(true)
    expect(partDrawn('block', 'floors', false)).toBe(false)
    expect(partDrawn('floor', 'buildings', false)).toBe(false)
    expect(partDrawn('block', 'buildings', false)).toBe(true)
  })
  it('draws an exploded building as its floors nearer in', () => {
    expect(partDrawn('floor', 'buildings', true)).toBe(true)
    expect(partDrawn('block', 'buildings', true)).toBe(false)
  })
  it('draws no building part at the districts tier: the district slabs stand for them', () => {
    for (const exploded of [false, true]) {
      expect(partDrawn('floor', 'districts', exploded)).toBe(false)
      expect(partDrawn('block', 'districts', exploded)).toBe(false)
    }
  })
})

const districts = [
  { id: 'd:a', pos: [0, 0, 0], radius: 10 },
  { id: 'd:b', pos: [15, 0, 0], radius: 10 },
  { id: 'd:empty', pos: [100, 0, 100], radius: 6 },
]
const buildings = [
  { id: 'b1', pos: [2, 0, 0], height: 6 },
  { id: 'b2', pos: [-3, 0, 1], height: 12 },
  { id: 'b3', pos: [9, 0, 0], height: 4 }, // inside both a and b: b is nearer
  { id: 'b4', pos: [50, 0, 50], height: 9 }, // outside every district
]

describe('district slabs', () => {
  it('finds the nearest district whose platform holds a point', () => {
    expect(districtAt([2, 0, 0], districts)).toBe('d:a')
    expect(districtAt([9, 0, 0], districts)).toBe('d:b')
    expect(districtAt([10, 0, 0], districts)).toBe('d:b')
    expect(districtAt([50, 0, 50], districts)).toBeNull()
    expect(districtAt([0, 0, 0], [])).toBeNull()
  })
  it('maps each building in a district to it, and leaves out the ones outside', () => {
    expect([...districtsOf(buildings, districts)]).toEqual([['b1', 'd:a'], ['b2', 'd:a'], ['b3', 'd:b']])
  })
  it('draws one slab per district footprint, as tall as its buildings on average', () => {
    const slabs = slabsFor(districts, buildings)
    expect(slabs.map((s) => s.id)).toEqual(['d:a', 'd:b', 'd:empty'])
    expect(slabs[0]).toEqual({ id: 'd:a', x: 0, y: 0, z: 0, radius: 10 * SLAB_INSET, height: 9 })
    expect(slabs[1]).toMatchObject({ x: 15, z: 0, height: 4 })
    expect(slabs[2]).toEqual({ id: 'd:empty', x: 100, y: 0, z: 100, radius: 6 * SLAB_INSET, height: SLAB_MIN_HEIGHT })
    expect(slabsFor([], buildings)).toEqual([])
  })
  it('keeps a slab at least one floor tall', () => {
    expect(slabsFor([districts[0]], [{ id: 'low', pos: [0, 0, 0], height: 1 }])[0].height).toBe(SLAB_MIN_HEIGHT)
  })
  it('draws a seam round a slab at every floor between its foot and its top', () => {
    expect(slabSeams(SLAB_MIN_HEIGHT)).toEqual([])
    expect(slabSeams(10)).toEqual([3, 6, 9])
    expect(slabSeams(9.2)).toEqual([3, 6]) // not one just under the top
  })
  it('ends a conduit on its district slab top at the districts tier, on the roof nearer in', () => {
    const of = new Map([['b1', 'd:a'], ['b9', 'd:gone']])
    const h = new Map([['d:a', 9]])
    expect(endHeight('b1', 6, 'districts', of, h)).toBe(9)
    expect(endHeight('b1', 6, 'buildings', of, h)).toBe(6)
    expect(endHeight('b1', 6, 'floors', of, h)).toBe(6)
    expect(endHeight('ext', 2, 'districts', of, h)).toBe(2) // an external: in no district
    expect(endHeight('b9', 5, 'districts', of, h)).toBe(5) // a district with no slab
    expect(endHeight(undefined, 3, 'districts', of, h)).toBe(3) // an end at no part
  })
})

describe('tierPick', () => {
  const of = new Map([['b1', 'd:a']])
  it('resolves a building to its district at the districts tier', () => {
    expect(tierPick({ kind: 'node', id: 'b1' }, 'districts', of)).toEqual({ kind: 'district', id: 'd:a' })
  })
  it('leaves lines, externals, misses and every nearer tier as they are', () => {
    expect(tierPick({ kind: 'edge', id: 'e1' }, 'districts', of)).toEqual({ kind: 'edge', id: 'e1' })
    expect(tierPick({ kind: 'node', id: 'ext' }, 'districts', of)).toEqual({ kind: 'node', id: 'ext' })
    expect(tierPick({ kind: 'district', id: 'd:a' }, 'districts', of)).toEqual({ kind: 'district', id: 'd:a' })
    expect(tierPick(null, 'districts', of)).toBeNull()
    expect(tierPick({ kind: 'node', id: 'b1' }, 'buildings', of)).toEqual({ kind: 'node', id: 'b1' })
    expect(tierPick({ kind: 'node', id: 'b1' }, 'floors', of)).toEqual({ kind: 'node', id: 'b1' })
  })
})

describe('batchable', () => {
  it('batches only parts that are not exploded and whose look stays put', () => {
    expect(batchable(false, false)).toBe(true)
    expect(batchable(true, false)).toBe(false)
    expect(batchable(false, true)).toBe(false)
  })
})

describe('labels by tier', () => {
  it('shows floor labels for an exploded building, or a hovered or selected one up close', () => {
    expect(floorLabelsShown('districts', true, false)).toBe(true)
    expect(floorLabelsShown('floors', false, true)).toBe(true)
    expect(floorLabelsShown('floors', false, false)).toBe(false)
    expect(floorLabelsShown('buildings', false, true)).toBe(false)
  })
  it('shows only district names at the districts tier', () => {
    expect(buildingNamesShown('districts')).toBe(false)
    expect(buildingNamesShown('buildings')).toBe(true)
    expect(buildingNamesShown('floors')).toBe(true)
  })
  it('keeps the buildings up while a building or line is selected, however far out', () => {
    expect(heldTier('districts', true)).toBe('buildings')
    expect(heldTier('districts', false)).toBe('districts')
    expect(heldTier('buildings', true)).toBe('buildings')
    expect(heldTier('floors', true)).toBe('floors')
  })
})

describe('batch keys', () => {
  const fill = { color: 1, metalness: 0.5, roughness: 0.3, opacity: 0.88, lineOpacity: 1, depthWrite: true, fog: true }
  it('puts parts with the same look in one batch, and parts with another look in another', () => {
    expect(fillKey(fill)).toBe(fillKey({ ...fill }))
    expect(fillKey(fill)).not.toBe(fillKey({ ...fill, opacity: 0.1056 }))
    expect(fillKey(fill)).not.toBe(fillKey({ ...fill, depthWrite: false }))
    expect(fillKey(fill)).not.toBe(fillKey({ ...fill, lineOpacity: 0.12 }))
    expect(packetKey('a', 1, true)).not.toBe(packetKey('b', 1, true))
    expect(packetKey('a', 1, true)).toBe('packet|a|1|true')
  })
})

describe('groupBatches', () => {
  it('groups by key, far first within each batch', () => {
    const g = groupBatches([
      { key: 'a', depth: 1 }, { key: 'b', depth: 5 }, { key: 'a', depth: 9 }, { key: 'a', depth: 4 },
    ])
    expect([...g.keys()]).toEqual(['a', 'b'])
    expect(g.get('a')).toEqual([2, 3, 0])
    expect(g.get('b')).toEqual([1])
  })
  it('makes no batch from nothing', () => {
    expect(groupBatches([]).size).toBe(0)
  })
})

describe('poolChanges', () => {
  it('adds the keys it lacks and drops the ones no longer wanted', () => {
    expect(poolChanges(['a', 'b'], ['b', 'c'])).toEqual({ add: ['c'], drop: ['a'] })
    expect(poolChanges([], [])).toEqual({ add: [], drop: [] })
  })
})

describe('batchCapacity', () => {
  it('keeps the room it has while it is enough, else grows in powers of two from 16', () => {
    expect(batchCapacity(10, 32)).toBe(32)
    expect(batchCapacity(1, 0)).toBe(16)
    expect(batchCapacity(17, 0)).toBe(32)
    expect(batchCapacity(100, 32)).toBe(128)
  })
})

describe('batch draw order', () => {
  const item = (o: Partial<SortItem> & { rank?: number }): SortItem => ({ groupOrder: 0, renderOrder: 0, z: 0, id: 0, ...o, object: { userData: o.rank === undefined ? {} : { batchRank: o.rank } } })
  it('draws packets first, then boxes from the most opaque to the faintest', () => {
    expect(batchRank('packet', 1)).toBeLessThan(batchRank('fill', 0.88))
    expect(batchRank('fill', 0.88)).toBeLessThan(batchRank('fill', 0.1056))
  })
  it('keeps three.js order: group, render order, far first, then creation', () => {
    expect(transparentOrder(item({ groupOrder: 1 }), item({ groupOrder: 2 }))).toBeLessThan(0)
    expect(transparentOrder(item({ renderOrder: 3 }), item({ renderOrder: 1 }))).toBeGreaterThan(0)
    expect(transparentOrder(item({ z: 0.9 }), item({ z: 0.2 }))).toBeLessThan(0)
    expect(transparentOrder(item({ id: 4 }), item({ id: 7 }))).toBeLessThan(0)
  })
  it('orders batches at one point by rank before creation', () => {
    expect(transparentOrder(item({ id: 1, rank: 1.9 }), item({ id: 2, rank: 1.1 }))).toBeGreaterThan(0)
    expect(transparentOrder(item({ id: 1, rank: 1.1 }), item({ id: 2, rank: 1.1 }))).toBeLessThan(0)
    expect(transparentOrder(item({ id: 5, rank: 1 }), item({ id: 2 }))).toBeGreaterThan(0)
  })
})
