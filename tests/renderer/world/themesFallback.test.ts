import { describe, it, expect } from 'vitest'
import { THEMES } from '../../../src/renderer/src/world/engine/themes'
import { renderFallback } from '../../../src/renderer/src/world/engine/fallback2d'
import { building, edge, rich } from './helpers'

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
    expect(renderFallback(doc, 'termpolis')).toContain('Memory host: reads 3 settings</button></li>')
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
    // Y1: each list item is a real button in a plain <li> (a role, Enter and Space, one Tab stop each), and no
    // item holds another one: a district's button is its heading's name, not the whole list of its parts.
    const items = Array.from(host.querySelectorAll('ul [data-id]'))
    expect(items.length).toBe(doc.districts.length + doc.buildings.length + doc.externals.length + doc.edges.length)
    for (const b of items) {
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('type')).toBe('button')
      expect(b.parentElement?.closest('[data-id]')).toBeNull()
      expect(b.querySelector('[data-id]')).toBeNull()
    }
    expect(host.querySelectorAll('[tabindex]')).toHaveLength(0)
    expect(host.querySelector('h3 > button[data-kind="district"][data-id="d1"]')?.textContent).toBe(doc.districts[0].name)
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

  it('frames the map round every shape and the origin, a margin out, also left of and above it', () => {
    const doc = rich()
    doc.layout.positions = { b1: [-30, 0, -40], b2: [50, 0, 60] }
    expect(renderFallback(doc, 'p')).toMatch(/viewBox="-38 -48 96 /)
  })

  it('shows the plan as the 3D map does: planned parts dashed, the chosen design and a drafted proposal added, taken-away parts faded (R05)', () => {
    const doc = rich()
    const host = document.createElement('div')
    const at = (html: string): HTMLElement => { host.innerHTML = html; return host }
    // The default is the planned layer on and no design: every part, b4 (proposed) dashed, no design part.
    at(renderFallback(doc, 'p'))
    expect(host.querySelector('rect[data-id="b4"]')?.getAttribute('fill')).toBe('none')
    expect(host.querySelector('rect[data-id="b4"]')?.getAttribute('stroke-dasharray')).toBe('0.6 0.4')
    expect(host.querySelector('rect[data-id="b1"]')?.getAttribute('fill')).toBe('#0078d4')
    expect(host.querySelector('[data-id="pb1"]')).toBeNull()
    expect(host.querySelector('button[data-id="b4"]')?.textContent).toContain('(proposed)')
    // The planned layer off: b4 and its connection e2 are left out.
    at(renderFallback(doc, 'p', { planned: false, proposal: 'p1' }))
    expect(host.querySelector('[data-id="b4"]')).toBeNull()
    expect(host.querySelector('[data-id="e2"]')).toBeNull()
    expect(host.querySelector('[data-id="pb1"]')).toBeNull() // the design shows only with the planned layer
    expect(host.querySelector('button[data-id="e1"]')).not.toBeNull()
    // The chosen design with the planned layer: its part not built yet is listed and drawn as proposed, its new
    // connection added; one with the id of a connection already in the world is not listed twice.
    doc.layers.plan[0].edges.push({ ...doc.edges[0] })
    doc.layers.plan[0].removes = ['b2']
    at(renderFallback(doc, 'p', { planned: true, proposal: 'p1' }))
    expect(host.querySelector('button[data-kind="building"][data-id="pb1"]')?.textContent).toContain('(proposed)')
    expect(host.querySelector('rect[data-id="pb1"]')?.getAttribute('fill')).toBe('none')
    expect(host.querySelectorAll('button[data-id="pe1"]')).toHaveLength(1)
    expect(host.querySelectorAll('button[data-id="e1"]')).toHaveLength(1)
    expect(host.querySelector('rect[data-id="b2"]')?.getAttribute('opacity')).toBe('0.4')
    expect(host.querySelector('rect[data-id="b1"]')?.hasAttribute('opacity')).toBe(false)
    // A drafted proposal shows whatever the layers say; chosen and drafted at once count once. A design part with a
    // world part's id keeps the world's part.
    doc.layers.plan[0].buildings.push(building('b1', { name: 'Imposter' }))
    at(renderFallback(doc, 'p', { planned: false, proposal: null, reveal: 'p1' }))
    expect(host.querySelector('button[data-id="pb1"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Imposter')
    at(renderFallback(doc, 'p', { planned: true, proposal: 'p1', reveal: 'p1' }))
    expect(host.querySelectorAll('button[data-id="pb1"]')).toHaveLength(1)
    // A proposal that is not in the world shows nothing more; a design part may stand for a planned part left out.
    at(renderFallback(doc, 'p', { planned: true, proposal: 'nope', reveal: 'gone' }))
    expect(host.querySelector('[data-id="pb1"]')).toBeNull()
    doc.layers.plan[0].buildings.push(building('b4', { name: 'Designed b4' }))
    doc.layers.plan[0].edges.push(edge('pe3', 'pb1', 'b4'))
    at(renderFallback(doc, 'p', { planned: false, proposal: null, reveal: 'p1' }))
    expect(host.querySelector('button[data-id="b4"]')?.textContent).toContain('Designed b4')
    expect(host.querySelector('button[data-id="pe3"]')).not.toBeNull()
    expect(host.querySelector('button[data-id="e2"]')).not.toBeNull() // b4 stands again, so its connection does
  })

  it('shows HTML in any name as text: parts, design parts, districts, connections, outside systems and the title (R27)', () => {
    const doc = rich()
    const evil = '<img src=x onerror="alert(1)">'
    doc.buildings[0].name = evil
    doc.buildings[0].techLabel = evil
    doc.districts[0].name = evil
    doc.districts[0].subtitle = evil
    doc.externals[0].name = evil
    doc.edges[0].label = evil
    doc.layers.plan[0].buildings[0].name = evil
    doc.layers.plan[0].buildings[0].id = evil
    doc.layers.plan[0].edges[0].to = evil
    const html = renderFallback(doc, evil, { planned: true, proposal: 'p1' })
    const host = document.createElement('div')
    host.innerHTML = html
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[onerror]')).toBeNull()
    expect(host.querySelector('h2')?.textContent).toBe(evil)
    expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe(`Map of ${evil}`)
    expect(host.querySelectorAll(`button[data-id="${CSS.escape(evil)}"]`)).toHaveLength(1)
    expect(host.textContent).toContain(evil)
  })

  it('draws an empty world as an empty map', () => {
    const doc = rich()
    doc.districts = []; doc.buildings = []; doc.externals = []; doc.edges = []
    expect(renderFallback(doc, 'p')).toContain('<svg role="img"')
  })
})
