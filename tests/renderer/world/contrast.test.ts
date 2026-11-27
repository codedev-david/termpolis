// Look spec §7: the palette tokens of all three palettes meet WCAG contrast. The ratio is WCAG 2's
// (L1 + 0.05) / (L2 + 0.05) on sRGB relative luminance, worked out here, apart from the engine.
//
// The halo model (look spec §3.6: the halo is what keeps 4.5:1 against a lit slab). Every map label carries the
// renderer's --lw-halo text shadow, `0 0 1px #000, 0 0 2px <the theme's background>`: the 2px shadow in the
// background colour lies right under every glyph's edge, so the colour the ink is read against is that shadow's,
// whatever is drawn further back. The test reads the halo off the renderer's real label layer and stylesheet, takes
// its backdrop colour from that halo, and checks ink on it. It also finds the brightest slab the map can draw (the
// brightest plate colour over every district hue, folded, at full gain, or the holo edge colour, whichever is
// brighter) and checks ink on that bare slab is under 4.5:1: without the halo the labels would not hold the ratio.
import { describe, expect, it, vi } from 'vitest'
import { labelHalo, PALETTES, plateColor } from '../../../src/renderer/src/world/engine/holoPalette'
import { createThreeRenderer } from '../../../src/renderer/src/world/engine/threeRenderer'
import { THEMES, type ThemeName } from '../../../src/renderer/src/world/engine/themes'
import { DEFAULT_OPTS, withHarness } from './threeHarness'

vi.mock('three', async (orig) => ({ ...(await orig<typeof import('three')>()), WebGLRenderer: (await import('./threeHarness')).FakeWebGLRenderer }))
vi.mock('three/examples/jsm/postprocessing/EffectComposer.js', async () => ({ EffectComposer: (await import('./threeHarness')).FakeEffectComposer }))
vi.mock('three/examples/jsm/postprocessing/RenderPass.js', async () => ({ RenderPass: (await import('./threeHarness')).FakeRenderPass }))
vi.mock('three/examples/jsm/postprocessing/UnrealBloomPass.js', async () => ({ UnrealBloomPass: (await import('./threeHarness')).FakeUnrealBloomPass }))
vi.mock('three/examples/jsm/postprocessing/OutputPass.js', async () => ({ OutputPass: (await import('./threeHarness')).FakeOutputPass }))

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

/** The brightest colour a slab or plate can be drawn in: every district hue (0..359, folded), and the holo edge colour. */
const brightestSlab = (holo: string): string => {
  let best = holo
  for (let h = 0; h < 360; h++) if (luminance(plateColor(h)) > luminance(best)) best = plateColor(h)
  return best
}

const h = withHarness()

/** The halo the renderer puts on its label layer in `theme`, and the stylesheet it draws the labels with. */
function rendererHalo(theme: ThemeName): { halo: string; css: string } {
  const host = h.host
  const r = createThreeRenderer(host, DEFAULT_OPTS)
  r.setTheme(theme, THEMES[theme])
  const layer = host.querySelector('.lw-labels') as HTMLElement
  const halo = layer.style.getPropertyValue('--lw-halo')
  const css = (document.getElementById('lumopolis-world-style') as HTMLStyleElement).textContent ?? ''
  r.dispose()
  return { halo, css }
}

/** The backdrop colour a halo draws under the glyphs: its 2px shadow's colour. */
const haloBackdrop = (halo: string): string => (/0 0 2px (#[0-9a-f]{6})/i.exec(halo) as RegExpExecArray)[1]

describe('palette contrast (look spec §7)', () => {
  for (const [name, p] of Object.entries(PALETTES) as Array<[ThemeName, typeof PALETTES.holotable]>) describe(name, () => {
    it('every map label carries the halo, built from the theme background', () => {
      const { halo, css } = rendererHalo(name)
      expect(halo).toBe(labelHalo(p))
      expect(halo).toBe(`0 0 1px #000, 0 0 2px ${p.background}`)
      // Every label class draws its text shadow with the halo first.
      for (const cls of ['.lw-district', '.lw-district span', '.lw-district.lw-on-solid', '.lw-bldg', '.lw-floor', '.lw-edge', '.lw-proc']) {
        const at = css.indexOf(`\n${cls}{`)
        expect(at, cls).toBeGreaterThanOrEqual(0)
        expect(css.slice(at, css.indexOf('}', at)), cls).toContain('text-shadow:var(--lw-halo)')
      }
    })

    it('ink on background, and ink on the brightest slab with the halo, are 4.5:1 or more in every palette', () => {
      expect(ratio(p.ink, p.background)).toBeGreaterThanOrEqual(4.5)
      const slab = brightestSlab(p.holo)
      const backdrop = haloBackdrop(rendererHalo(name).halo) // what the halo draws right behind the glyphs on that slab
      expect(backdrop).not.toBe(slab)
      expect(luminance(slab)).toBeGreaterThan(luminance(p.holo) - 1e-12)
      expect(ratio(p.ink, slab)).toBeLessThan(4.5) // the bare slab: the halo is load-bearing
      expect(ratio(p.ink, backdrop)).toBeGreaterThanOrEqual(4.5)
    })

    it('the focus ring and selection colour are 3:1 or more against the background in every palette', () => {
      expect(ratio(p.attention, p.background)).toBeGreaterThanOrEqual(3)
      expect(ratio(p.select, p.background)).toBeGreaterThanOrEqual(3)
    })
  })

  it('the brightest slab is a plate colour, brighter than holo', () => {
    const slab = brightestSlab(PALETTES.holotable.holo)
    expect(slab).not.toBe(PALETTES.holotable.holo)
    expect(luminance(slab)).toBeGreaterThan(luminance(PALETTES.holotable.holo))
  })

  it('checks every palette', () => {
    expect(Object.keys(PALETTES)).toEqual(['holotable', 'blueprint', 'glass'])
  })
})
