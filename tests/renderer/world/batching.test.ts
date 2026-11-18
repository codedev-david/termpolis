import { describe, expect, it } from 'vitest'
import { batchable, batchCapacity, batchRank, buildingNamesShown, fillKey, floorLabelsShown, groupBatches, packetKey, partDrawn, poolChanges, transparentOrder, type SortItem } from '../../../src/renderer/src/world/engine/batching'

describe('partDrawn', () => {
  it('draws floors from the floors tier in, and one block further out', () => {
    expect(partDrawn('floor', 'floors', false)).toBe(true)
    expect(partDrawn('block', 'floors', false)).toBe(false)
    expect(partDrawn('floor', 'buildings', false)).toBe(false)
    expect(partDrawn('block', 'buildings', false)).toBe(true)
    expect(partDrawn('block', 'districts', false)).toBe(true)
  })
  it('always draws an exploded building as its floors', () => {
    expect(partDrawn('floor', 'districts', true)).toBe(true)
    expect(partDrawn('block', 'districts', true)).toBe(false)
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
