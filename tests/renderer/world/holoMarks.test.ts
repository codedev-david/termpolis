// holoMarks: every mark the Holotable look draws is a data mark (from the scene model, so from doc fields) or one of
// the named stage marks of look spec §4.3, which vary only with the layout's extent, the tier and time.
import { describe, expect, it } from 'vitest'
import { DISC_MIN_RADIUS, DISC_SCALE, holoMarks, layoutExtent, STAGE_MARKS, TRACK_SEGMENTS, type StageMark } from '../../../src/renderer/src/world/engine/holoMarks'
import { foldHue, memberGain, PALETTES, plateColor } from '../../../src/renderer/src/world/engine/holoPalette'
import { buildSceneModel, DEFAULT_LAYERS, type SceneModel } from '../../../src/renderer/src/world/engine/sceneModel'
import { TIER_LOOK, type TierName } from '../../../src/renderer/src/world/engine/tierBudget'
import { bldg, conduit, district, orb } from './threeHarness'
import { rich } from './helpers'

const P = PALETTES.holotable

/** Two districts, a building of each look, a line each way and two orbs on the outside ring. */
function city(): SceneModel {
  return {
    districts: [district('a', [-20, 0, 0], 10, { hue: 0, members: 3 }), district('b', [30, 0, 10], 15, { hue: 137, members: 16 })],
    buildings: [
      bldg('s', [-20, 0, 0], { ring: true, heat: 0.5, processShell: 'main' }),
      bldg('g', [-22, 0, 2], { look: 'amber', outline: true }),
      bldg('w', [30, 0, 10], { look: 'wire', floors: 1, height: 3 }),
    ],
    conduits: [conduit('l', [-20, 9, 0], [30, 3, 10], { color: '#123456', dashed: true, width: 0.1 })],
    orbs: [orb('x', [60, 12, 0]), orb('y', [0, 12, -80], true)],
  }
}
const kinds = (marks: { kind: string }[]): string[] => marks.map((m) => m.kind)
const stageOf = <K extends StageMark['kind']>(stage: StageMark[], kind: K): Extract<StageMark, { kind: K }> =>
  stage.find((m) => m.kind === kind) as Extract<StageMark, { kind: K }>

describe('holoMarks', () => {
  it('the stage list is exactly STAGE_MARKS', () => {
    expect(STAGE_MARKS).toEqual(['disc', 'discSweep', 'track', 'beams', 'shafts', 'dust', 'vignetteGrain'])
    expect(kinds(holoMarks(city(), P).stage)).toEqual([...STAGE_MARKS])
    // Every tier draws only marks on the list; Flat leaves out the beams (look spec §5), and no orbs leave out the track.
    for (const tier of ['high', 'low', 'flat'] as const) {
      for (const scene of [city(), { ...city(), orbs: [] }, { districts: [], buildings: [], conduits: [], orbs: [] }]) {
        for (const k of kinds(holoMarks(scene, P, tier).stage)) expect(STAGE_MARKS).toContain(k)
      }
    }
    expect(kinds(holoMarks(city(), P, 'flat').stage)).toEqual(STAGE_MARKS.filter((k) => k !== 'beams'))
    expect(kinds(holoMarks({ ...city(), orbs: [] }, P).stage)).toEqual(STAGE_MARKS.filter((k) => k !== 'track'))
  })

  it('maps every district, building, line and orb of the scene to one data mark, in the scene order', () => {
    const s = city()
    const { data } = holoMarks(s, P)
    expect(data.map((m) => `${m.kind}:${m.id}`)).toEqual([
      'plate:a', 'plate:b', 'slab:s', 'slab:g', 'slab:w', 'conduit:l', 'orb:x', 'orb:y',
    ])
    expect(data[0]).toEqual({ kind: 'plate', id: 'a', pos: [-20, 0, 0], radius: 10, hue: foldHue(0), color: plateColor(0), gain: 1, members: 3 })
    expect(data[1]).toMatchObject({ kind: 'plate', id: 'b', hue: foldHue(137), color: plateColor(137), gain: memberGain(16), members: 16 })
    expect(data[2]).toEqual({
      kind: 'slab', id: 's', pos: [-20, 0, 0], floors: 3, height: 9, look: 'solid', color: P.holo, ring: P.seal, outline: false,
      heat: 0.5, heatColor: P.heat, processShell: 'main',
    })
    expect(data[3]).toMatchObject({ look: 'amber', color: P.attention, ring: null, outline: true, processShell: null })
    expect(data[4]).toMatchObject({ look: 'wire', floors: 1, height: 3, color: P.holo })
    expect(data[5]).toEqual({ kind: 'conduit', id: 'l', from: [-20, 9, 0], to: [30, 3, 10], ctrl: s.conduits[0].ctrl, width: 0.1, color: '#123456', dashed: true, cargo: 'memory' })
    expect(data[6]).toEqual({ kind: 'orb', id: 'x', pos: [60, 12, 0], fog: false, color: P.orb })
    expect(data[7]).toMatchObject({ id: 'y', fog: true })
  })

  it('cargo colours pass through unfolded', () => {
    const doc = rich()
    doc.cargo.memory.color = '#ff00aa' // a hue far outside the blue family
    const scene = buildSceneModel(doc, DEFAULT_LAYERS)
    const lines = holoMarks(scene, P).data.filter((m) => m.kind === 'conduit')
    expect(lines.length).toBe(scene.conduits.length)
    for (const l of lines) {
      const e = doc.edges.find((x) => x.id === l.id)
      if (e && doc.cargo[e.cargo]) expect(l).toMatchObject({ color: doc.cargo[e.cargo].color })
    }
    expect(lines.filter((l) => l.kind === 'conduit' && l.color === '#ff00aa').length).toBeGreaterThan(0)
    for (const name of ['holotable', 'blueprint', 'glass'] as const) {
      expect(holoMarks(scene, PALETTES[name]).data.filter((m) => m.kind === 'conduit')).toEqual(lines)
    }
  })

  it('measures the layout extent round the plates, and the orb ring from the table centre', () => {
    // Plates span x -30..45 and z -10..25: centre (7.5, 7.5); the farthest plate edge from it sets the reach.
    const e = layoutExtent(city())
    expect(e.center).toEqual([7.5, 7.5])
    expect(e.reach).toBeCloseTo(Math.max(Math.hypot(-27.5, -7.5) + 10, Math.hypot(22.5, 2.5) + 15), 10)
    expect(e.orbRing).toBe(80)
    expect(layoutExtent({ ...city(), orbs: [] }).orbRing).toBeNull()
    expect(layoutExtent({ districts: [], buildings: [], conduits: [], orbs: [] })).toEqual({ center: [0, 0], reach: 0, orbRing: null })
  })

  it('sizes the disc from the extent, puts the track on the orb ring and a beam to each plate', () => {
    const s = city()
    const e = layoutExtent(s)
    const { stage } = holoMarks(s, P)
    expect(stageOf(stage, 'disc')).toEqual({ kind: 'disc', center: e.center, radius: e.reach * DISC_SCALE, color: P.holo, arcColor: P.attention, moving: true })
    expect(stageOf(stage, 'discSweep')).toEqual({ kind: 'discSweep', center: e.center, radius: e.reach * DISC_SCALE, whileWorking: true, moving: true })
    expect(stageOf(stage, 'track')).toEqual({ kind: 'track', radius: 80, segments: TRACK_SEGMENTS, color: P.holo })
    expect(TRACK_SEGMENTS).toBe(256)
    expect(stageOf(stage, 'beams')).toEqual({ kind: 'beams', from: e.center, to: [[-20, 0], [30, 10]], color: P.holo })
    // An empty world still stands on a small disc.
    const empty = holoMarks({ districts: [], buildings: [], conduits: [], orbs: [] }, P).stage
    expect(stageOf(empty, 'disc').radius).toBe(DISC_MIN_RADIUS)
    expect(stageOf(empty, 'beams').to).toEqual([])
  })

  it('takes the shafts, dust, grain and motion of each tier from TIER_LOOK', () => {
    for (const tier of ['high', 'low', 'flat'] as TierName[]) {
      const t = TIER_LOOK[tier]
      const { stage } = holoMarks(city(), P, tier)
      expect(stageOf(stage, 'shafts')).toEqual({ kind: 'shafts', count: t.shafts })
      expect(stageOf(stage, 'dust')).toEqual({ kind: 'dust', count: t.dust, stars: true })
      expect(stageOf(stage, 'vignetteGrain')).toEqual({ kind: 'vignetteGrain', vignette: t.composer ? 0.5 : 0, grain: t.grain ? 0.03 : 0 })
      expect(stageOf(stage, 'disc').moving).toBe(t.discMoving)
      expect(stageOf(stage, 'discSweep').moving).toBe(t.scanLinesMoving)
      expect(stage.some((m) => m.kind === 'beams')).toBe(t.beams)
    }
    expect(holoMarks(city(), P).stage).toEqual(holoMarks(city(), P, 'high').stage)
  })
})
