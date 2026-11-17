import { describe, it, expect } from 'vitest'
import { buildingCard, edgeCard, escapeHtml, techCard, usesTech } from '../../../src/renderer/src/world/engine/cards'
import { building, claim, edge, minimal, rich } from './helpers'

describe('escapeHtml', () => {
  it('escapes & < > " and the apostrophe', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('escapeHtml coercion', () => {
  it('coerces runtime non-strings without throwing', () => {
    expect(escapeHtml(5)).toBe('5')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(null)).toBe('')
  })
})

describe('cards', () => {
  it('buildingCard has every section and tags inferred claims', () => {
    const html = buildingCard(minimal(), 'b1')
    for (const s of ['class="tag status-', 'class="proc">Runs in:', 'What it does', 'inside', 'Technology', 'Why it', 'What goes out']) expect(html).toContain(s)
    expect(html).toContain('Main process')
    expect(html).toContain('claim claim-inferred')
    expect(html).toContain('<span class="tag">inferred</span>')
    expect(html).not.toContain('What comes in')
    expect(buildingCard(minimal(), 'b2')).toContain('What comes in')
    expect(html).toContain('title="A framework for building desktop apps with web technology."')
  })

  it('does not tag observed claims', () => {
    expect(buildingCard(minimal(), 'b2')).toContain('<p class="claim">Memories are stored')
  })

  it('escapes names, claims, ids, glossary and attributes', () => {
    const doc = minimal()
    const x = '<script>alert(1)</script>"\''
    doc.buildings[0].name = x
    doc.buildings[0].how = [claim(x), claim(x, 'inferred')]
    doc.buildings[0].floors[0].name = x
    doc.buildings[0].stack = [x]
    doc.glossary[x] = x
    doc.edges[0].label = x
    doc.edges[0].tech = [x]
    const out = [buildingCard(doc, 'b1'), buildingCard(doc, 'b2'), edgeCard(doc, 'e1'), techCard(doc, x)].join('')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('title="<')
  })

  it('shows an unknown process id, planned buildings and edges, and externals', () => {
    const doc = rich()
    doc.buildings[0].process = 'weird'
    expect(buildingCard(doc, 'b1')).toContain('Runs in: <b>weird</b>')
    expect(buildingCard(doc, 'pb1')).toContain('Built · not yet checked')
    expect(buildingCard(doc, 'b4')).toContain('Planned only')
    expect(buildingCard(doc, 'b3')).toContain('Built · no tests')
    expect(buildingCard(doc, 'b2')).toContain('Built · tests pass')
    expect(buildingCard(doc, 'x1')).toContain('agent')
    expect(buildingCard(doc, 'x1')).not.toContain('not fully known')
    doc.externals[0].fog = true
    expect(buildingCard(doc, 'x1')).toContain('not fully known')
    doc.buildings[0].stack = ['unlisted']
    expect(buildingCard(doc, 'b1')).toContain('title=""')
    expect(buildingCard(doc, 'nope')).toBe('')
    expect(edgeCard(doc, 'pe1')).toContain('pe1')
  })

  it('edgeCard has its sections, names ends, cargo label and two-way', () => {
    const html = edgeCard(minimal(), 'e1')
    for (const s of ['What travels', 'How it travels', 'Technology', 'Why it', 'How often']) expect(html).toContain(s)
    expect(html).toContain('Memory')
    expect(html).toContain('Desktop app')
    expect(html).toContain('(both ways)')
    expect(html).toContain('on demand')
    expect(edgeCard(minimal(), 'zz')).toBe('')
    const doc = rich()
    const e3 = edgeCard(doc, 'e3')
    expect(e3).toContain('nope')
    expect(e3).not.toContain('both ways')
    expect(e3).toContain('>Claude Code<')
    doc.edges.push(edge('e9', 'b1', 'ghost'))
    expect(edgeCard(doc, 'e9')).toContain('>ghost<')
  })

  it('edgeCard titles a line with its short summary and lists what it carries in full', () => {
    const doc = minimal()
    doc.edges[0].label = 'env TERMPOLIS_TEST_AGENTS, env TERMPOLIS_TEST_TIMING, ipc <pty:data>'
    const html = edgeCard(doc, 'e1')
    expect(html).toContain('<h3>reads 2 settings +1 more</h3>')
    expect(html).toContain('What it carries')
    expect(html).toContain('<li>env TERMPOLIS_TEST_AGENTS</li><li>env TERMPOLIS_TEST_TIMING</li><li>ipc &lt;pty:data&gt;</li>')
    // A long model label: the title is cut, the body keeps every word.
    const long = 'Sends every keystroke and resize event to the shell host process'
    doc.edges[0].label = long
    const card = edgeCard(doc, 'e1')
    expect(card).toContain('<h3>Sends every keystroke and…</h3>')
    expect(card).toContain(`<p>${long}</p>`)
    expect(card).not.toContain('What it carries')
    // A short one is only the title.
    doc.edges[0].label = 'Memory calls'
    expect(edgeCard(doc, 'e1').match(/Memory calls/g)).toHaveLength(1)
    // A link to the line shows its summary too.
    doc.edges[0].label = 'env A, env B'
    expect(techCard(doc, 'ipc')).toContain('>reads 2 settings</a>')
  })

  it('usesTech and techCard list buildings and edges', () => {
    const doc = minimal()
    expect(usesTech(doc, 'electron')).toEqual(['b1'])
    expect(usesTech(doc, 'ipc')).toEqual(['e1'])
    expect(usesTech(doc, 'sqlite')).toEqual(['b2'])
    doc.buildings[1].stack = []
    expect(usesTech(doc, 'sqlite')).toEqual(['b2'])
    expect(usesTech(doc, 'nothing')).toEqual([])
    const e = techCard(doc, 'ipc')
    expect(e).toContain('Carries these connections')
    expect(e).not.toContain('Used inside')
    expect(techCard(doc, 'electron')).toContain('Used inside')
    expect(techCard(doc, 'electron')).not.toContain('Carries')
    expect(techCard(doc, 'unknown')).toBe('<h3>unknown</h3><p></p>')
  })

  it('keeps a building with no claims or parts valid, leaving out the empty sections', () => {
    const doc = minimal()
    doc.buildings.push(building('e', { how: [], why: [], floors: [], stack: [], techLabel: '' }))
    const html = buildingCard(doc, 'e')
    expect(html).toContain('What it does')
    expect(html).toContain('<p class="muted">Not described yet.</p>')
    expect(html).not.toContain("What's inside")
    expect(html).not.toContain('Technology')
    expect(html).toMatch(/^<h3>[^<]*<\/h3><p class="status">/)
    expect(html).toContain('class="proc">Runs in:') // its process is known
    doc.buildings[doc.buildings.length - 1].process = ' '
    expect(buildingCard(doc, 'e')).not.toContain('Runs in') // no process: no empty box
  })

  it('lists a part with no technology by name alone, with no dangling separator', () => {
    const doc = minimal()
    doc.buildings[0].floors = [{ ...doc.buildings[0].floors[0], name: 'Bare', tech: [] }]
    const html = buildingCard(doc, 'b1')
    expect(html).toContain('<li><b>Bare</b></li>')
    expect(html).not.toContain('· </span>')
  })

  it('shows a status pill, cargo swatches on the lines and an external tag', () => {
    const doc = minimal()
    expect(buildingCard(doc, 'b2')).toContain('<span class="tag status-verified">Built · tests pass</span>')
    const color = doc.cargo[doc.edges[0].cargo].color
    expect(buildingCard(doc, 'b1')).toContain(`<span class="cargo" style="background:${color}"></span><a class="lnk link-edge"`)
    expect(edgeCard(doc, 'e1')).toContain(`<p><span class="cargo" style="background:${color}"></span>`)
    doc.edges[0].cargo = 'nothing-known'
    expect(edgeCard(doc, 'e1')).toContain('<p>nothing-known</p>')
    expect(buildingCard(rich(), 'x1')).toContain('<span class="tag status-external">Outside the project</span>')
  })

  it("leaves out an edge's empty technology and rate", () => {
    const doc = minimal()
    doc.edges[0].tech = []
    doc.edges[0].rate = ''
    const html = edgeCard(doc, 'e1')
    expect(html).not.toContain('Technology')
    expect(html).not.toContain('How often')
  })
})

describe('linked design tag', () => {
  it('tags a built building the linked design does not have', () => {
    const doc = minimal()
    expect(buildingCard(doc, 'b2')).not.toContain('not in the design')
    doc.layers.plan.push({ id: 'p0', title: 'Not linked', summary: [], buildings: [], edges: [] })
    doc.layers.plan.push({
      id: 'design:p', title: 'Linked design', summary: [], buildings: [], edges: [],
      reconcile: { matched: { auth: 'b1' }, missing: [], extra: ['b2'], planAt: 1 }
    })
    expect(buildingCard(doc, 'b2')).toContain('<span class="tag">not in the design</span>')
    expect(buildingCard(doc, 'b1')).not.toContain('not in the design')
  })
})
