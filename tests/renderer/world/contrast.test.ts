// Look spec §7: the palette tokens of all three palettes meet WCAG contrast. The ratio is WCAG 2's
// (L1 + 0.05) / (L2 + 0.05) on sRGB relative luminance, worked out here, apart from the engine.
//
// The halo model (§3.6): every label carries `0 0 1px #000, 0 0 2px <background>`. The 2px shadow in the
// background colour lies under every glyph's edge, so the colour right behind the text is the background's
// whatever is drawn further back (the brightest lit slab included). Ink on a slab with the halo is therefore
// ink on the background; the test checks the halo is built from the background, and that without it the
// brightest slab (the holo colour at full gain) would not reach 4.5:1, so the halo is what holds the ratio.
import { describe, expect, it } from 'vitest'
import { labelHalo, PALETTES, type HoloPalette } from '../../../src/renderer/src/world/engine/holoPalette'

const rgb = (hex: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) as RegExpExecArray
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}
const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** What lies right behind a label's glyphs on any backdrop: the halo's background-coloured 2px shadow. */
const behindLabel = (p: HoloPalette): string => {
  const halo = labelHalo(p)
  expect(halo).toContain('0 0 1px #000')
  expect(halo).toContain(`0 0 2px ${p.background}`)
  return p.background
}

describe('palette contrast (look spec §7)', () => {
  for (const [name, p] of Object.entries(PALETTES)) describe(name, () => {
    it('ink on background, and ink on the brightest slab with the halo, are 4.5:1 or more in every palette', () => {
      expect(ratio(p.ink, p.background)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(p.ink, behindLabel(p))).toBeGreaterThanOrEqual(4.5)
      expect(ratio(p.ink, p.holo)).toBeLessThan(4.5) // the bare slab: the halo is load-bearing
    })

    it('the focus ring and selection colour are 3:1 or more against the background in every palette', () => {
      expect(ratio(p.attention, p.background)).toBeGreaterThanOrEqual(3)
      expect(ratio(p.select, p.background)).toBeGreaterThanOrEqual(3)
    })
  })

  it('checks every palette', () => {
    expect(Object.keys(PALETTES)).toEqual(['holotable', 'blueprint', 'glass'])
  })
})
