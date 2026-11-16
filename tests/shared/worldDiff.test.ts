import { describe, expect, it } from 'vitest'
import { diffSummary, diffWorlds, riseIds, RISE_CAP, type WorldDiff } from '../../src/shared/world/diff'
import type { Building, Proposal, WorldDoc } from '../../src/shared/world/types'
import minDoc from './fixtures/world.min.json'
import grownDoc from './fixtures/world.grown.json'
import { validateWorld } from '../../src/shared/world/validate'

const copy = (d: unknown): WorldDoc => JSON.parse(JSON.stringify(d)) as WorldDoc
const base = (): WorldDoc => copy(minDoc)
const bldg = (doc: WorldDoc, id: string, over: Partial<Building> = {}): Building =>
  ({ ...doc.buildings[0], id, name: id, ...over }) as Building

/** A linked design proposal (one carrying reconcile), as compile appends it. */
const linked = (matched: Record<string, string>, missing: string[]): Proposal =>
  ({ id: 'design:p1', title: 'Plan', summary: [], buildings: [], edges: [], reconcile: { matched, missing, extra: [], planAt: 1 } })

const empty: WorldDiff = { added: [], removed: [], changed: [], turnedSolid: [] }

describe('diffWorlds', () => {
  it('diff detects added/removed/changed/turnedSolid', () => {
    const prev = base()
    prev.buildings.push(bldg(prev, 'gone'), bldg(prev, 'same'), bldg(prev, 'floors'), bldg(prev, 'status'))
    prev.layers.plan.push(linked({ 'p-a': 'b1' }, ['p-pay', 'p-auth']))
    const next = base()
    next.buildings.push(
      bldg(next, 'same'),
      bldg(next, 'floors', { floors: [{ name: 'Other', tech: [], members: [] }] }),
      bldg(next, 'status', { status: 'gap' }),
      bldg(next, 'pay'), // new, and it fills the plan's missing p-pay
      bldg(next, 'new2'),
    )
    next.buildings[0] = { ...next.buildings[0], members: ['src/main/index.ts', 'src/main/extra.ts'] } // b1: members
    // p-pay was missing and is matched now; p-a was already matched; p-gone names no built building.
    next.layers.plan.push(linked({ 'p-a': 'b1', 'p-pay': 'pay', 'p-auth': 'nope' }, []))
    expect(diffWorlds(prev, next)).toEqual({
      added: ['pay', 'new2'],
      removed: ['gone'],
      changed: ['b1', 'floors', 'status'],
      turnedSolid: ['pay'],
    })
  })

  it('a building already there that a plan part now matches turns solid without being added', () => {
    const prev = base()
    prev.layers.plan.push(linked({}, ['p-mem']))
    const next = base()
    next.layers.plan.push(linked({ 'p-mem': 'b2' }, []))
    expect(diffWorlds(prev, next)).toEqual({ ...empty, turnedSolid: ['b2'] })
  })

  it('nothing turns solid without a linked design on either side', () => {
    const plain: Proposal = { id: 'p', title: 'P', summary: [], buildings: [], edges: [] }
    const prev = base()
    prev.layers.plan.push(plain)
    const next = base()
    next.layers.plan.push(linked({ 'p-mem': 'b2' }, []))
    expect(diffWorlds(prev, next).turnedSolid).toEqual([])
    const prev2 = base()
    prev2.layers.plan.push(linked({}, ['p-mem']))
    expect(diffWorlds(prev2, base()).turnedSolid).toEqual([])
  })

  it('null prev → everything added', () => {
    const next = base()
    next.layers.plan.push(linked({ 'p-mem': 'b2' }, []))
    expect(diffWorlds(null, next)).toEqual({ ...empty, added: ['b1', 'b2'] })
  })

  it('the same world gives an empty diff (member order counts; only buildings are compared)', () => {
    const next = base()
    next.edges = []
    next.districts[0].name = 'Renamed'
    expect(diffWorlds(base(), next)).toEqual(empty)
    const reordered = base()
    reordered.buildings[0].members = ['b', 'a']
    const prev = base()
    prev.buildings[0].members = ['a', 'b']
    expect(diffWorlds(prev, reordered).changed).toEqual(['b1'])
  })

  it('fixture B is fixture A plus two buildings', () => {
    const a = validateWorld(minDoc)
    const b = validateWorld(grownDoc)
    expect(a.ok && b.ok).toBe(true)
    expect(diffWorlds(copy(minDoc), copy(grownDoc))).toEqual({ ...empty, added: ['b3', 'b4'] })
  })
})

describe('riseIds', () => {
  it('is the unique union of added and turnedSolid, capped at 20', () => {
    expect(riseIds({ ...empty, added: ['a', 'b'], turnedSolid: ['b', 'c'], changed: ['z'] })).toEqual(['a', 'b', 'c'])
    const many = Array.from({ length: 30 }, (_, i) => `n${i}`)
    const ids = riseIds({ ...empty, added: many })
    expect(RISE_CAP).toBe(20)
    expect(ids).toEqual(many.slice(0, 20))
  })
})

describe('diffSummary', () => {
  it('reads like the brief', () => {
    expect(diffSummary({ ...empty, added: ['a', 'b'], turnedSolid: ['b', 'c'], changed: ['x', 'y'] })).toBe('+3 parts, 2 changed')
    expect(diffSummary({ ...empty, added: ['a', 'b'] })).toBe('+2 parts')
  })

  it('leaves out what is zero and never starts with a comma', () => {
    expect(diffSummary(empty)).toBe('')
    expect(diffSummary({ ...empty, changed: ['x'] })).toBe('1 changed')
    expect(diffSummary({ ...empty, removed: ['x', 'y'] })).toBe('2 removed')
    expect(diffSummary({ ...empty, changed: ['x'], removed: ['y'] })).toBe('1 changed, 1 removed')
    expect(diffSummary({ added: ['a'], removed: ['y'], changed: ['x'], turnedSolid: [] })).toBe('+1 part, 1 changed, 1 removed')
    expect(diffSummary({ ...empty, turnedSolid: ['t'] })).toBe('+1 part')
  })
})
