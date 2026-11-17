import { describe, expect, it } from 'vitest'
import { CARGO_COLORS, CARGO_LABELS, CARGO_OF_KIND, cargoColors, cargoLabel, cargoOf } from '../../src/main/world/cargoTypes'
import { THEMES } from '../../src/renderer/src/world/engine/themes'

// sRGB to linear, WCAG relative luminance and contrast, and CIE L*a*b* (D65) for the colour difference.
const rgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (h: string): number => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const lab = (h: string): number[] => {
  const [r, g, b] = rgb(h).map(lin)
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const X = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047)
  const Y = f(r * 0.2126 + g * 0.7152 + b * 0.0722)
  const Z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883)
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}
const deltaE = (a: string, b: string): number => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }

describe('world cargo types', () => {
  it('maps a line to a human cargo type by the first boundary it crosses, an import to code', () => {
    expect(cargoOf([])).toBe('code')
    expect(cargoOf(['env', 'ipc'])).toBe('settings')
    expect(cargoOf(['spawn'])).toBe('jobs')
    expect(cargoOf(['http-out'])).toBe('requests')
  })

  it('collapses every boundary kind into a few types, each with legend words', () => {
    const types = new Set(Object.values(CARGO_OF_KIND))
    expect(types.size).toBeLessThanOrEqual(8)
    for (const t of [...types, 'code']) expect(CARGO_LABELS[t]).toMatch(/^[A-Z]/)
  })

  it('words a code-derived key, and keeps a model-written key as it is', () => {
    expect(cargoLabel('settings')).toBe('Settings from the environment')
    expect(cargoLabel('code')).toBe('Code')
    expect(cargoLabel('orders')).toBe('orders')
    expect(cargoLabel('toString')).toBe('toString')
  })

  it('gives every code-derived cargo a colour of its own, clearly apart and legible on every theme', () => {
    const keys = [...new Set(Object.values(CARGO_OF_KIND)), 'code']
    for (const k of keys) expect(CARGO_COLORS[k]).toMatch(/^#[0-9a-f]{6}$/)
    const cols = keys.map((k) => CARGO_COLORS[k])
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) expect(deltaE(cols[i], cols[j]), `${keys[i]} vs ${keys[j]}`).toBeGreaterThanOrEqual(40)
    }
    // The old pinks ("Settings from the environment", "Jobs for other programs") were 7 apart.
    expect(deltaE(CARGO_COLORS.settings, CARGO_COLORS.jobs)).toBeGreaterThan(40)
    for (const t of Object.values(THEMES)) for (const c of cols) expect(contrast(c, t.background), `${c} on ${t.background}`).toBeGreaterThanOrEqual(4.5)
  })

  it('colours a world: known keys their own, other keys the unused colours first, then round again', () => {
    const one = cargoColors(['code', 'orders', 'settings'])
    expect(one).toEqual({ code: CARGO_COLORS.code, settings: CARGO_COLORS.settings, orders: CARGO_COLORS.messages })
    const words = Array.from({ length: 14 }, (_, i) => `w${String(i).padStart(2, '0')}`)
    const many = cargoColors(words)
    expect(new Set(words.slice(0, 12).map((w) => many[w])).size).toBe(12)
    expect(many.w12).toBe(many.w00)
    expect(many.w13).toBe(many.w01)
    // Model words in a world that also has every code-derived key: the extra colours, unused first.
    const full = cargoColors([...Object.keys(CARGO_COLORS), 'a', 'b'])
    expect(new Set(Object.values(full)).size).toBe(10)
    for (const w of ['a', 'b']) for (const k of Object.keys(CARGO_COLORS)) expect(deltaE(full[w], CARGO_COLORS[k])).toBeGreaterThan(20)
  })
})
