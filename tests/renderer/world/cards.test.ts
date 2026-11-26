import { describe, it, expect } from 'vitest'
import { buildingCard, edgeCard, escapeHtml, techCard, tourCard, tourStopText, usesTech } from '../../../src/renderer/src/world/engine/cards'
import { CARD_HEADINGS } from '../../../src/shared/world/cardFacts'
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
    expect(html).toContain('<li class="claim" data-state="inferred">')
    expect(html).toContain('<span class="state">inferred</span>')
    expect(html).not.toContain('What comes in')
    expect(buildingCard(minimal(), 'b2')).toContain('What comes in')
    expect(html).toContain('title="A framework for building desktop apps with web technology."')
  })

  it('buildingCard shows service names with an Edit button; a planned building has none to edit', () => {
    const doc = minimal()
    expect(buildingCard(doc, 'b1')).toContain('<span class="muted">None yet</span>')
    expect(buildingCard(doc, 'b1')).toContain('data-runtime-edit="b1" data-names=""')
    doc.runtimeNames = { b1: ['orders-api', 'db'] }
    const html = buildingCard(doc, 'b1')
    expect(html).toContain('Service names')
    expect(html).toContain('<span class="rtnames">orders-api, db</span>')
    expect(html).toContain('data-names="orders-api, db"')
    expect(html).not.toContain('edited by you')
    doc.runtimeHandSet = ['b1']
    expect(buildingCard(doc, 'b1')).toContain('edited by you')
    const planned = { ...doc.buildings[0], id: 'p1' }
    doc.layers.plan = [{ id: 'x', title: 'X', summary: [], buildings: [planned], edges: [] }]
    expect(buildingCard(doc, 'p1')).not.toContain('Service names')
    doc.runtimeNames.p1 = ['svc']
    expect(buildingCard(doc, 'p1')).toContain('svc')
    expect(buildingCard(doc, 'p1')).not.toContain('data-runtime-edit')
  })

  it('makes every technology chip and every link to a part or line a button, so the keyboard reaches them (A11Y Y3)', () => {
    const doc = rich()
    const host = document.createElement('div')
    host.innerHTML = buildingCard(doc, 'b1') + edgeCard(doc, 'e1') + techCard(doc, doc.buildings[0].stack[0] ?? 'electron')
    const reach = Array.from(host.querySelectorAll('[data-tech], [data-node], [data-edge]'))
    expect(reach.length).toBeGreaterThan(2)
    for (const el of reach) {
      expect(el.tagName, el.outerHTML).toBe('BUTTON')
      expect(el.getAttribute('type')).toBe('button')
    }
    expect(host.querySelectorAll('a:not([href]), span[data-tech]')).toHaveLength(0)
  })

  it('does not tag observed claims', () => {
    expect(buildingCard(minimal(), 'b2')).toContain('<li class="claim" data-state="verified"><span class="ctext">Memories are stored')
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
    expect(buildingCard(doc, 'b3')).toContain('Built · no test results yet')
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
    expect(html).toContain('<h4>Direction</h4><p>Both ways: Desktop app reaches Memory host, and Memory host reaches Desktop app.</p>')
    expect(html).not.toContain('(both ways)')
    expect(html).toContain('on demand')
    expect(edgeCard(minimal(), 'zz')).toBe('')
    const doc = rich()
    const e3 = edgeCard(doc, 'e3')
    expect(e3).toContain('nope')
    expect(e3).toContain('<h4>Direction</h4><p>One way: b3 reaches Claude Code; the code shows no line from Claude Code back to b3.</p>')
    expect(e3).toContain('>Claude Code<')
    doc.edges.push(edge('e9', 'b1', 'ghost'))
    expect(edgeCard(doc, 'e9')).toContain('>ghost<')
  })

  it('edgeCard states the direction right under the ends, and links the line back when there is one', () => {
    const doc = minimal()
    doc.edges[0].twoWay = false
    doc.edges.push(edge('e<2>', 'b2', 'b1', { label: 'Replies' }))
    const html = edgeCard(doc, 'e1')
    expect(html).toContain('</p><h4>Direction</h4><p>Both ways: Desktop app reaches Memory host, and <button type="button" class="lnk link-edge" data-edge="e&lt;2&gt;">Memory host reaches Desktop app</button>.</p>')
    expect(html.indexOf('Direction')).toBeLessThan(html.indexOf('What travels'))
    doc.buildings[1].name = 'A <b>'
    expect(edgeCard(doc, 'e<2>')).toContain('<p>Both ways: A &lt;b&gt; reaches Desktop app, and <button type="button" class="lnk link-edge" data-edge="e1">Desktop app reaches A &lt;b&gt;</button>.</p>')
    doc.edges.push(edge('e5', 'b1', 'x1', { label: 'http-out api.example.com' }))
    expect(edgeCard(doc, 'e5')).toContain('<p>One way, with replies: Desktop app asks and Claude Code answers.</p>')
    expect(edgeCard(rich(), 'pe1')).toContain('<p>One way (planned): Desktop app reaches pb1.</p>')
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
    expect(techCard(doc, 'ipc')).toContain('>reads 2 settings</button>')
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

  it('shows a status pill and cargo swatches on the lines', () => {
    const doc = minimal()
    expect(buildingCard(doc, 'b2')).toContain('<span class="tag status-verified">Built · tests pass</span>')
    const color = doc.cargo[doc.edges[0].cargo].color
    expect(buildingCard(doc, 'b1')).toContain(`<span class="cargo" style="background:${color}"></span><button type="button" class="lnk link-edge"`)
    expect(edgeCard(doc, 'e1')).toContain(`<p><span class="cargo" style="background:${color}"></span>`)
    doc.edges[0].cargo = 'nothing-known'
    expect(edgeCard(doc, 'e1')).toContain('<p>nothing-known</p>')
  })

  it('a cargo colour that is not a plain hex colour never reaches the swatch style (E5)', () => {
    const doc = minimal()
    doc.cargo[doc.edges[0].cargo].color = 'red;display:none'
    const html = edgeCard(doc, 'e1')
    expect(html).toContain('<span class="cargo" style="background:#94a3b8"></span>')
    expect(html).not.toContain('display:none')
    expect(buildingCard(doc, 'b1')).not.toContain('red;')
  })

  it('tags an external building', () => {
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

describe('claim states, evidence and confirm', () => {
  it('each claim shows its state and an evidence button; only an inferred one has Confirm, numbered across how, why and known', () => {
    const doc = minimal()
    const b = doc.buildings[0]
    b.how = [claim('a', 'inferred')]
    b.why = [claim('b', 'observed')]
    b.claims = [claim('c', 'inferred')]
    const html = buildingCard(doc, b.id)
    expect(html).toContain(`<button class="ev" data-evidence="{&quot;kind&quot;:&quot;file&quot;,&quot;ref&quot;:&quot;a/b.ts&quot;}">evidence</button>`)
    expect(html).toContain(`data-confirm="${b.id}|0"`)
    expect(html).not.toContain(`data-confirm="${b.id}|1"`)
    expect(html).toContain(`data-confirm="${b.id}|2"`)
    expect(html).toContain('What we know')
  })

  it('a claim with no evidence has no evidence button, and a part with no extra claims has no What we know', () => {
    const doc = minimal()
    doc.buildings[0].how = [claim('plain', 'observed', false)]
    doc.buildings[0].why = []
    doc.buildings[0].claims = []
    const html = buildingCard(doc, doc.buildings[0].id)
    expect(html).not.toContain('class="ev"')
    expect(html).not.toContain('What we know')
  })

  it('a line shows its claims too, including a person confirmation', () => {
    const doc = minimal()
    doc.edges[0].claims = [{ text: 'Seen in code', state: 'observed', evidence: [{ kind: 'file', ref: 'src/a.ts:3' }] }, { text: 'Checked', state: 'verified', evidence: [{ kind: 'person', ref: 'confirmed in Lumopolis' }] }]
    const html = edgeCard(doc, doc.edges[0].id)
    expect(html).toContain('What we know')
    expect(html).toContain('Seen in code')
    expect(html).toContain('person')
  })

  it('an AI-named part says so, an observed name does not', () => {
    const doc = minimal()
    doc.buildings[0].nameState = 'inferred'
    expect(buildingCard(doc, doc.buildings[0].id)).toContain('(name suggested by AI)')
    doc.buildings[0].nameState = 'observed'
    expect(buildingCard(doc, doc.buildings[0].id)).not.toContain('name suggested by AI')
  })

  it('claim text, refs and states are escaped: an <img onerror> is text, not an element', () => {
    const doc = minimal()
    const evil = '<img src=x onerror=alert(1)>'
    doc.buildings[0].how = []
    doc.buildings[0].why = []
    doc.buildings[0].claims = [{ text: evil, state: 'inferred', evidence: [{ kind: 'file', ref: evil }] }]
    const host = document.createElement('div')
    host.innerHTML = buildingCard(doc, doc.buildings[0].id)
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain(evil)
    const ev = host.querySelector('button.ev') as HTMLElement
    expect(JSON.parse(ev.getAttribute('data-evidence') as string)).toEqual({ kind: 'file', ref: evil })
  })
})

describe('why a building is this big', () => {
  it("a big building's card says why after what is inside, escaped, and a small one says nothing", () => {
    const doc = minimal()
    const files = Array.from({ length: 30 }, (_, i) => `src/a/f${i}.ts`)
    const big = building('big', { members: files, growth: { start: 'family', seed: '<t>', folder: 'src/a', merged: 2, mergedFiles: 1, folded: 0, cap: 60 } })
    doc.buildings.push(big)
    const html = buildingCard(doc, 'big')
    expect(html).toContain('<h4>Why it is this big</h4><p>30 files. It started as the src/a folder&#39;s name family &quot;&lt;t&gt;&quot;. 2 name families and 1 single file were merged in because of dense imports.</p>')
    expect(html.indexOf('Why it is this big')).toBeGreaterThan(html.indexOf('What&#39;s inside'))
    expect(html.indexOf('Why it is this big')).toBeLessThan(html.indexOf('Technology'))
    expect(buildingCard(doc, 'b1')).not.toContain('Why it is this big')
  })

  it('names the double-click only where the card says it can open floors', () => {
    const doc = minimal()
    const files = Array.from({ length: 30 }, (_, i) => `src/a/f${i}.ts`)
    const floors = [{ name: 'a', tech: [], members: [] }, { name: 'b', tech: [], members: [] }]
    doc.buildings.push(building('big', { members: files, floors, growth: { start: 'folder', seed: 'src/a', merged: 0, mergedFiles: 0, folded: 0, cap: 60 } }))
    expect(buildingCard(doc, 'big', 'open3d')).toContain('<p>30 files. It started as the src/a folder. Double-click it to see its floors.</p>')
    expect(buildingCard(doc, 'big')).toContain('<p>30 files. It started as the src/a folder.</p>')
  })
})

describe('card headings', () => {
  it('every heading the HTML card prints is a CARD_HEADINGS value', () => {
    const doc = rich()
    doc.runtimeNames.b1 = ['svc']
    doc.buildings[0].claims = [claim('seen', 'observed')]
    doc.edges[0].claims = [claim('seen', 'observed')]
    doc.edges[0].rate = 'often'
    const known = Object.values(CARD_HEADINGS) as string[]
    const seen = new Set<string>()
    for (const id of [...doc.buildings.map((b) => b.id), ...doc.edges.map((e) => e.id), 'x1', 'pb1', 'pe1']) {
      const html = buildingCard(doc, id) || edgeCard(doc, id)
      for (const m of html.matchAll(/<h4>([^<]*)<\/h4>/g)) {
        const t = m[1].replace(/&#39;/g, "'")
        expect(known).toContain(t)
        seen.add(t)
      }
    }
    expect(seen.has(CARD_HEADINGS.serviceNames)).toBe(true)
    expect(seen.has(CARD_HEADINGS.whatItIs)).toBe(true)
  })
})

describe('read-only cards', () => {
  const RO = { readOnly: true }
  it('a read-only card has no Confirm or Edit and shows evidence as text', () => {
    const doc = minimal()
    const b = doc.buildings[0]
    b.how = [{ text: 'does it', state: 'inferred', evidence: [{ kind: 'file', ref: 'src/main/foo.ts' }] }]
    b.why = [claim('plain', 'observed', false)]
    b.claims = [claim('c', 'inferred')]
    doc.runtimeNames[b.id] = ['orders-api']
    const html = buildingCard(doc, b.id, 'none', RO)
    expect(html).not.toContain('data-confirm')
    expect(html).not.toContain('data-runtime-edit')
    expect(html).not.toContain('data-evidence')
    expect(html).toContain('<span class="ev-ref">file src/main/foo.ts</span>')
    expect(html).toContain('orders-api')
    expect(html).toContain('data-node=')
  })

  it('a read-only claim without evidence has no evidence text; service names are omitted when there are none', () => {
    const doc = minimal()
    const b = doc.buildings[0]
    b.how = [claim('plain', 'observed', false)]
    b.why = []
    delete doc.runtimeNames[b.id]
    const html = buildingCard(doc, b.id, 'none', RO)
    expect(html).not.toContain('ev-ref')
    expect(html).not.toContain('Service names')
    expect(buildingCard(doc, b.id)).toContain('None yet')
  })

  it('a test result keeps its source in the evidence button and in the read-only text', () => {
    const doc = minimal()
    doc.edges[0].claims = [{ text: 'Passed', state: 'observed', evidence: [{ kind: 'test', ref: 'a.test.ts', excerpt: 'CI' }] }]
    expect(edgeCard(doc, doc.edges[0].id)).toContain('&quot;excerpt&quot;:&quot;CI&quot;')
    expect(edgeCard(doc, doc.edges[0].id, RO)).toContain('<span class="ev-ref">test a.test.ts (CI)</span>')
  })

  it('a read-only line has no Confirm or evidence buttons', () => {
    const doc = minimal()
    doc.edges[0].claims = [{ text: 'Seen', state: 'inferred', evidence: [{ kind: 'file', ref: 'src/a.ts:3' }] }]
    const html = edgeCard(doc, doc.edges[0].id, RO)
    expect(html).not.toContain('data-confirm')
    expect(html).not.toContain('data-evidence')
    expect(html).toContain('<span class="ev-ref">file src/a.ts:3</span>')
  })
})

describe('tourCard', () => {
  it('is the tour title over its captions in order, escaped (the 2D map shows a tour this way)', () => {
    expect(tourCard({ id: 't', title: 'A <b>', steps: [{ ids: [], caption: 'one & two' }, { ids: ['x'], caption: 'three' }] }))
      .toBe('<h3>A &lt;b&gt;</h3><ol><li>one &amp; two</li><li>three</li></ol>')
  })
})

describe('tourStopText', () => {
  it('says which stop of how many, then the caption as written: a screen reader reads it as text, never as HTML (T5)', () => {
    expect(tourStopText({ n: 2, of: 3, caption: 'a <b> & c' })).toBe('Stop 2 of 3: a <b> & c')
  })
})
