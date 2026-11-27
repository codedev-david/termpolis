// The Holotable palette (look spec §3.1): the tokens of each palette, the fold of a district's hue into the blue
// family, and the plate gain that keeps a big district from outshining the rest.
import { describe, expect, it } from 'vitest'
import { foldHue, hexNumber, hslHex, labelHalo, memberGain, PALETTES, plateColor, selectColor } from '../../../src/renderer/src/world/engine/holoPalette'
import { HEAT_COLOR } from '../../../src/renderer/src/world/engine/sceneModel'

describe('holoPalette', () => {
  it('holds the look spec §3.1 tokens for Holotable, with ice-white selection (D1)', () => {
    expect(PALETTES.holotable).toEqual({
      background: '#010409', holo: '#3fd0ff', ink: '#d6f3ff', muted: 'rgba(150,205,230,.55)', attention: '#ffae42',
      orb: '#7fdcff', heat: HEAT_COLOR, seal: '#4ade80', select: '#eafaff',
    })
    expect(selectColor).toBe('#eafaff')
    expect(Object.keys(PALETTES)).toEqual(['holotable', 'blueprint', 'glass'])
    for (const p of Object.values(PALETTES)) {
      expect(p.select).toBe(selectColor)
      expect(p.heat).toBe(HEAT_COLOR)
      for (const k of ['background', 'holo', 'ink', 'attention', 'orb', 'heat', 'seal', 'select'] as const) expect(p[k]).toMatch(/^#[0-9a-f]{6}$/)
      expect(p.muted).toMatch(/^rgba\(\d+,\d+,\d+,\.\d+\)$/)
    }
  })

  it('foldHue keeps every district in 186..224 degrees and keeps neighbours apart', () => {
    for (let h = -720; h <= 720; h += 0.5) {
      const f = foldHue(h)
      expect(f).toBeGreaterThanOrEqual(186)
      expect(f).toBeLessThan(224)
    }
    expect(foldHue(0)).toBe(186)
    expect(foldHue(100)).toBeCloseTo(186 + 37, 10)
    expect(foldHue(110)).toBeCloseTo(186 + ((110 * 0.37) % 38), 10)
    // The compiler gives district i the hue round(i * 137.508) mod 360 (compile.ts): folded, consecutive districts
    // stay at least 6 degrees apart, so neighbours on the table stay tellable apart.
    const hues = Array.from({ length: 64 }, (_, i) => Math.round((i * 137.508) % 360))
    for (let i = 1; i < hues.length; i++) expect(Math.abs(foldHue(hues[i]) - foldHue(hues[i - 1]))).toBeGreaterThanOrEqual(6)
  })

  it('memberGain is 1 up to 4 members and falls as 2.2/sqrt(n)', () => {
    for (const n of [0, 1, 2, 3, 4]) expect(memberGain(n)).toBe(1)
    for (const n of [5, 9, 16, 100, 10_000]) expect(memberGain(n)).toBeCloseTo(2.2 / Math.sqrt(n), 12)
    expect(memberGain(100)).toBeCloseTo(0.22, 12)
    for (let n = 5; n < 200; n++) expect(memberGain(n)).toBeLessThan(memberGain(n - 1))
  })

  it('colours a plate at saturation 0.9 and lightness 0.56 on the folded hue', () => {
    expect(hslHex(0, 1, 0.5)).toBe('#ff0000')
    expect(hslHex(120, 1, 0.5)).toBe('#00ff00')
    expect(hslHex(240, 1, 0.25)).toBe('#000080')
    expect(hslHex(200, 0, 1)).toBe('#ffffff')
    expect(hslHex(-120, 1, 0.5)).toBe('#0000ff')
    expect(plateColor(0)).toBe(hslHex(186, 0.9, 0.56))
    expect(plateColor(100)).toBe(hslHex(foldHue(100), 0.9, 0.56))
  })

  it('turns a token into a three.js colour number and builds the label halo from the background', () => {
    expect(hexNumber('#ffae42')).toBe(0xffae42)
    for (const p of Object.values(PALETTES)) expect(labelHalo(p)).toBe(`0 0 1px #000, 0 0 2px ${p.background}`)
  })
})
