import { describe, it, expect } from 'vitest'
import { focusOpacity, neighbours } from '../../../src/renderer/src/world/engine/interaction'
import { edge, minimal, rich } from './helpers'

describe('neighbours', () => {
  it('finds the other end and the edges of a building', () => {
    const n = neighbours(minimal(), 'b1')
    expect([...n.ids].sort()).toEqual(['b1', 'b2'])
    expect([...n.edgeIds]).toEqual(['e1'])
  })
  it('handles an edge id, an unrelated edge and an unknown id', () => {
    const n = neighbours(minimal(), 'e1')
    expect([...n.ids].sort()).toEqual(['b1', 'b2', 'e1'])
    expect([...n.edgeIds]).toEqual(['e1'])
    const doc = rich()
    doc.edges.push(edge('e9', 'b3', 'x1'))
    expect([...neighbours(doc, 'b2').edgeIds]).toEqual(['e1'])
    const none = neighbours(minimal(), 'zz')
    expect([...none.ids]).toEqual(['zz'])
    expect(none.edgeIds.size).toBe(0)
  })
})

describe('neighbours with a revealed proposal', () => {
  it('includes the proposal edges only when revealed', () => {
    const doc = rich()
    const n = neighbours(doc, 'pb1', { revealProposal: 'p1' })
    expect([...n.ids].sort()).toEqual(['b1', 'pb1'])
    expect([...n.edgeIds]).toEqual(['pe1'])
    expect(neighbours(doc, 'pb1').edgeIds.size).toBe(0)
    expect(neighbours(doc, 'pb1', { revealProposal: 'zzz' }).edgeIds.size).toBe(0)
  })
})

describe('focusOpacity', () => {
  it('caps focused tubes at 0.62', () => {
    expect(focusOpacity(1, true)).toBe(0.62)
    expect(focusOpacity(0.2, true)).toBeCloseTo(0.38)
  })
  it('dims what is out of focus', () => {
    expect(focusOpacity(1, false)).toBeCloseTo(0.06)
  })
})
