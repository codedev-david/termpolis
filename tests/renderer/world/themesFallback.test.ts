import { describe, it, expect } from 'vitest'
import { THEMES } from '../../../src/renderer/src/world/engine/themes'
import { renderFallback } from '../../../src/renderer/src/world/engine/fallback2d'
import { rich } from './helpers'

describe('THEMES', () => {
  it('has three themes of plain colour data', () => {
    expect(Object.keys(THEMES)).toEqual(['neon', 'blueprint', 'glass'])
    for (const t of Object.values(THEMES)) {
      for (const k of ['background', 'district', 'conduit', 'glow', 'text'] as const) expect(t[k]).toMatch(/^#[0-9a-f]{6}$/)
      expect(t.fogDensity).toBeGreaterThan(0)
    }
  })
})

describe('renderFallback', () => {
  it('lists every district, building, external and connection, escaped', () => {
    const doc = rich()
    doc.districts[0].name = '<b>Core</b>'
    doc.edges.push({ ...doc.edges[0], id: 'e9', to: 'ghost', label: 'odd' })
    const html = renderFallback(doc)
    for (const d of doc.districts) expect(html).toContain(d.id === 'd1' ? '&lt;b&gt;Core&lt;/b&gt;' : d.name)
    for (const b of doc.buildings) expect(html).toContain(b.name)
    expect(html).toContain('Claude Code')
    expect(html).toContain('Desktop app to Memory host: Memory calls')
    expect(html).toContain('to ghost: odd')
    expect(html).not.toContain('<b>Core')
  })
})
