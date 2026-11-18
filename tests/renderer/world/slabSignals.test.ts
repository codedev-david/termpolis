import { describe, expect, it } from 'vitest'
import { slabLook, slabSignals, type SignalBuilding } from '../../../src/renderer/src/world/engine/slabSignals'

const b = (id: string, extra: Partial<SignalBuilding> = {}): SignalBuilding => ({ id, look: 'solid', outline: false, heat: 0, ...extra })
const of = (pairs: Record<string, string>): Map<string, string> => new Map(Object.entries(pairs))

describe('slabSignals', () => {
  it('gives each slab, in order, its hottest building\'s heat', () => {
    const s = slabSignals(['d1', 'd2'], [b('a', { heat: 0.2 }), b('b', { heat: 0.9 }), b('c')], of({ a: 'd1', b: 'd1', c: 'd2' }))
    expect(s.map((x) => x.id)).toEqual(['d1', 'd2'])
    expect(s[0]).toMatchObject({ heat: 0.9, hot: true })
    expect(s[1]).toMatchObject({ heat: 0, hot: false })
  })
  it('outlines a slab when any building in it is changed or planned', () => {
    const s = slabSignals(['d1', 'd2', 'd3'], [b('a', { outline: true }), b('b'), b('c', { look: 'wire' }), b('d')], of({ a: 'd1', b: 'd1', c: 'd2', d: 'd3' }))
    expect(s.map((x) => x.outline)).toEqual([true, true, false])
  })
  it('fades or fogs a slab only when every building in it does', () => {
    const s = slabSignals(['d1', 'd2', 'd3', 'd4'], [
      b('a', { look: 'fading' }), b('b', { look: 'fading' }),
      b('c', { look: 'fading' }), b('d'),
      b('e', { look: 'fog' }), b('f', { look: 'fog' }),
      b('g', { look: 'fog' }), b('h', { look: 'amber' }),
    ], of({ a: 'd1', b: 'd1', c: 'd2', d: 'd2', e: 'd3', f: 'd3', g: 'd4', h: 'd4' }))
    expect(s.map((x) => [x.fading, x.fog])).toEqual([[true, false], [false, false], [false, true], [false, false]])
  })
  it('shows nothing on an empty district, and skips buildings outside every district', () => {
    const s = slabSignals(['d1'], [b('a', { heat: 1, look: 'fading', outline: true })], of({}))
    expect(s).toEqual([{ id: 'd1', heat: 0, hot: false, outline: false, fading: false, fog: false }])
  })
})

describe('slabLook', () => {
  const sig = { id: 'd', heat: 0, hot: false, outline: false, fading: false, fog: false }
  it('draws fading over fog, fog over solid', () => {
    expect(slabLook(sig)).toBe('solid')
    expect(slabLook({ ...sig, fog: true })).toBe('fog')
    expect(slabLook({ ...sig, fading: true, fog: true })).toBe('fading')
  })
})
