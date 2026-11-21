import { describe, expect, it } from 'vitest'
import { placeOnMap } from '../../../src/shared/world/mapPlacement'
import { renderFallback } from '../../../src/renderer/src/world/engine/fallback2d'
import type { WorldDoc } from '../../../src/shared/world/types'
import { describedWorld, hostileWorld, labelledWorld } from '../../fixtures/world/docWorlds'

describe('placeOnMap', () => {
  it('stands a part at its layout x and z', () => {
    const doc = labelledWorld()
    doc.layout.positions.b2 = [12, 99, -4]
    expect(placeOnMap(doc).at.get('b2')).toEqual([12, -4])
  })
  it('gives parts, then outside systems, with no position the next slot of a six-wide grid below the city', () => {
    const doc = describedWorld(8, 0, 0, 0)
    doc.layout.positions = {}
    doc.externals = [{ id: 'x1', name: 'Service', kind: 'service', fog: false }]
    const { at } = placeOnMap(doc)
    expect(at.get('b0')).toEqual([0, 14])
    expect(at.get('b5')).toEqual([40, 14])
    expect(at.get('b6')).toEqual([0, 22])
    expect(at.get('b7')).toEqual([8, 22])
    expect(at.get('x1')).toEqual([16, 22])
  })
  it('stands a district at its own position, else the centre of its parts, else the origin', () => {
    const doc = labelledWorld()
    doc.districts.push({ id: 'd3', name: 'Empty', subtitle: '', hue: 0, members: [], nameState: 'observed' })
    doc.layout.positions.b1 = [0, 0, 0]
    doc.layout.positions.b2 = [10, 0, 20]
    doc.layout.positions.d2 = [-5, 0, 7]
    expect(placeOnMap(doc).districts).toEqual([[5, 10], [-5, 7], [0, 0]])
  })
})

describe('the 2D map and the document map share one placement', () => {
  /** Where renderFallback drew each building (its square's centre) and each district (its hexagon's centre). */
  function drawn(doc: WorldDoc): { at: Map<string, [number, number]>; districts: [number, number][] } {
    const svg = renderFallback(doc, 'p')
    const at = new Map<string, [number, number]>()
    for (const m of svg.matchAll(/<rect data-kind="building" data-id="([^"]*)" x="([-0-9.]+)" y="([-0-9.]+)"/g)) {
      at.set(m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'), [Number(m[2]) + 1.5, Number(m[3]) + 1.5])
    }
    // A hexagon's first corner is its centre plus the radius (6) along x.
    const districts = Array.from(svg.matchAll(/<polygon data-kind="district" data-id="[^"]*" points="([-0-9.]+),([-0-9.]+)/g),
      (m) => [Number(m[1]) - 6, Number(m[2])] as [number, number])
    return { at, districts }
  }
  const round = (p: [number, number]): number[] => p.map((n) => Math.round(n * 100) / 100)
  it.each([
    ['labelled', labelledWorld],
    ['hostile', hostileWorld],
    ['unplaced', (): WorldDoc => { const d = labelledWorld(); d.layout.positions = { d2: [3, 0, 9] }; return d }]
  ])('%s: renderFallback draws every part and district where placeOnMap puts it', (_, make) => {
    const doc = make()
    const want = placeOnMap(doc)
    const got = drawn(doc)
    expect(got.at.size).toBe(want.at.size)
    for (const [id, p] of want.at) expect(round(got.at.get(id) as [number, number])).toEqual(round(p))
    expect(got.districts.map(round)).toEqual(want.districts.map(round))
  })
})
