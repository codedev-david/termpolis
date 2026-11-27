import { describe, it, expect } from 'vitest'
import * as engine from '../../../src/renderer/src/world/engine'
import { validateWorld } from '../../../src/shared/world/validate'

describe('engine public surface', () => {
  it('exports the viewer, cards, fallback and validator the bundle promises', () => {
    for (const name of ['createWorldViewer', 'hasWebGL', 'buildingCard', 'edgeCard', 'techCard', 'renderFallback', 'validateWorld'] as const) {
      expect(typeof engine[name]).toBe('function')
    }
    expect(engine.validateWorld).toBe(validateWorld)
    expect(Object.keys(engine.THEMES)).toEqual(['holotable', 'blueprint', 'glass'])
    expect(engine.DEFAULT_LAYERS.labels).toBe('jobs')
  })
})
