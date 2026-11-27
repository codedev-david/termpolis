import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createHoloStage } from '../../../src/renderer/src/world/engine/holoStage'
import { stageMarks, type StageMark } from '../../../src/renderer/src/world/engine/holoMarks'
import { PALETTES } from '../../../src/renderer/src/world/engine/holoPalette'
import type { SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'

// The stage alone, with three's own objects (it draws nothing itself): what the renderer's tests reach only through
// the tier table. The tiers' marks never pair a moving disc with no dust, so that pairing is checked here.

const P = PALETTES.holotable
const TABLE: Pick<SceneModel, 'districts' | 'orbs'> = {
  districts: [{ id: 'd', label: 'd', pos: [0, 0, 0], radius: 20, hue: 200, members: 3 }],
  orbs: [],
}
/** The marks at `tier`, with `change` made to the mark of each kind it names. */
const marksWith = (tier: 'high' | 'low' | 'flat', change: Partial<Record<StageMark['kind'], Record<string, unknown>>>): StageMark[] =>
  stageMarks(TABLE, P, tier).map((m) => ({ ...m, ...(change[m.kind] ?? {}) }) as StageMark)
const dot = new THREE.Texture()

describe('holoStage', () => {
  it('a stage whose disc turns keeps frames coming with no dust; the sweep only while working; nothing without a disc', () => {
    const s = createHoloStage(dot, stageMarks(TABLE, P, 'high'))
    // No world built yet: a moving disc mark with no dust has nothing to turn.
    s.fit(marksWith('flat', { disc: { moving: true } }), 'flat', null)
    expect(s.looping(true)).toBe(false)
    s.build(stageMarks(TABLE, P, 'high'), [20], 'high')
    expect(s.looping(false)).toBe(true)
    // Only the sweep moves: it loops while the world works, and not otherwise.
    s.fit(marksWith('flat', { discSweep: { moving: true } }), 'flat', null)
    expect(s.looping(false)).toBe(false)
    expect(s.looping(true)).toBe(true)
    s.tick(0.5, true, false)
    expect(s.motion()).toMatchObject({ discAngle: 0, dustDrift: 0 })
    expect(s.motion().sweep).toBeGreaterThan(0)
    // Nothing moves: it sleeps, working or not, and every clock rests at t = 0.
    s.fit(stageMarks(TABLE, P, 'flat'), 'flat', null)
    expect(s.looping(true)).toBe(false)
    s.tick(0.5, true, false)
    expect(s.motion()).toEqual({ dust: 0, discAngle: 0, sweep: 0, dustDrift: 0 })
    s.dispose()
  })

  it('the dust rises, wraps at its top, and stands at its first places again when it rests', () => {
    const s = createHoloStage(dot, stageMarks(TABLE, P, 'high'))
    s.build(stageMarks(TABLE, P, 'high'), [20], 'high')
    s.fit(stageMarks(TABLE, P, 'low'), 'low', null)
    const pos = (): number[] => Array.from(s.dust.geometry.getAttribute('position').array)
    const home = pos()
    s.tick(70, false, false) // past the top: every point drawn has started again from the floor
    expect(s.motion().dustDrift).toBeCloseTo(77, 6)
    const ys = pos().filter((_, i) => i % 3 === 1).slice(0, 600)
    for (const y of ys) expect(y).toBeLessThanOrEqual(58)
    expect(pos()).not.toEqual(home)
    // Resting twice changes nothing more.
    s.tick(0.1, false, true)
    expect(pos()).toEqual(home)
    s.tick(0.1, false, true)
    expect(pos()).toEqual(home)
    expect(s.motion().dustDrift).toBe(0)
    s.dispose()
  })
})
