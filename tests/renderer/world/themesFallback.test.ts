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
    const html = renderFallback(doc, 'termpolis')
    for (const d of doc.districts) expect(html).toContain(d.id === 'd1' ? '&lt;b&gt;Core&lt;/b&gt;' : d.name)
    for (const b of doc.buildings) expect(html).toContain(b.name)
    expect(html).toContain('Claude Code')
    expect(html).toContain('Desktop app to Memory host: Memory calls')
    expect(html).toContain('to ghost: odd')
    doc.edges[0].label = 'env A, env B, env C'
    expect(renderFallback(doc, 'termpolis')).toContain('Memory host: reads 3 settings</li>')
    expect(html).not.toContain('<b>Core')
  })

  it('tags every item with its selection kind and escaped id', () => {
    const doc = rich()
    doc.buildings[0].id = 'b"<1>'
    const html = renderFallback(doc, 'termpolis')
    expect(html).toContain('data-kind="district" data-id="d1"')
    expect(html).toContain('data-kind="building" data-id="b&quot;&lt;1&gt;"')
    expect(html).toContain(`data-kind="building" data-id="${doc.externals[0].id}"`)
    expect(html).toContain('data-kind="edge" data-id="e1"')
    const host = document.createElement('div')
    host.innerHTML = html
    const tagged = Array.from(host.querySelectorAll('ul [data-id]')).map((el) => `${el.getAttribute('data-kind')}:${el.getAttribute('data-id')}`)
    expect(tagged).toEqual([
      ...doc.districts.flatMap((d) => [`district:${d.id}`, ...doc.buildings.filter((b) => b.districtId === d.id).map((b) => `building:${b.id}`)]),
      ...doc.externals.map((x) => `building:${x.id}`),
      ...doc.edges.map((e) => `edge:${e.id}`),
    ])
  })

  it('draws a hexagon per district, a rect per building and a line per edge, and escapes names', () => {
    const doc = rich()
    doc.buildings[0].name = '<i>x</i>"'
    const html = renderFallback(doc, 'termpolis')
    expect(html).toContain('<h2>termpolis</h2>')
    expect(html).not.toContain(doc.projectKey)
    expect(html).toContain('<svg role="img" aria-label="Map of termpolis"')
    expect((html.match(/data-kind="district"/g) || []).length).toBe(doc.districts.length * 2) // polygon + list item
    expect((html.match(/<polygon data-kind="district"/g) || []).length).toBe(doc.districts.length)
    expect((html.match(/<rect data-kind="building"/g) || []).length).toBe(doc.buildings.length + doc.externals.length)
    expect((html.match(/<line data-kind="edge"/g) || []).length).toBe(doc.edges.length)
    expect(html).not.toContain('<i>x</i>')
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
    expect(html).toContain('<ul class="world-fallback-list">')
    const host = document.createElement('div')
    host.innerHTML = html
    for (const li of Array.from(host.querySelectorAll('li[data-id]'))) expect(li.getAttribute('tabindex')).toBe('0')
    expect(host.querySelector('svg [data-id="b1"]')?.getAttribute('data-kind')).toBe('building')
    expect(host.querySelector('svg')?.getAttribute('viewBox')).toMatch(/^-?[\d.]+( -?[\d.]+){3}$/)
  })

  it('puts shapes at the layout x and z, places parts and districts with no layout spot, and skips a line to an unknown end', () => {
    const doc = rich()
    doc.layout.positions = { b1: [10, 0, 20], d1: [12, 0, 22] }
    doc.edges.push({ ...doc.edges[0], id: 'e9', to: 'ghost' })
    const html = renderFallback(doc, 'p')
    expect(html).toContain('<rect data-kind="building" data-id="b1" x="8.5" y="18.5"')
    expect(html).toContain('<polygon data-kind="district" data-id="d1" points="18,22 ')
    expect(html).not.toContain('<line data-kind="edge" data-id="e9"')
    doc.layout.positions = {}
    doc.districts.push({ ...doc.districts[0], id: 'dEmpty', name: 'Empty' })
    for (const b of doc.buildings) b.districtId = 'd1'
    const host = document.createElement('div')
    host.innerHTML = renderFallback(doc, 'p')
    const poly = (id: string) => host.querySelector(`polygon[data-id="${id}"]`)?.getAttribute('points')
    expect(poly('dEmpty')).toBe('6,0 3,5.2 -3,5.2 -6,0 -3,-5.2 3,-5.2')
    expect(poly('d1')).not.toBe(poly('dEmpty'))
  })

  it('draws an empty world as an empty map', () => {
    const doc = rich()
    doc.districts = []; doc.buildings = []; doc.externals = []; doc.edges = []
    expect(renderFallback(doc, 'p')).toContain('<svg role="img"')
  })
})
