import { describe, expect, it } from 'vitest'
import { buildDocumentation, type DocModel, type DocOptions } from '../../../src/shared/world/documentation'
import { docMapSvg, renderDocumentation } from '../../../src/shared/world/documentationHtml'
import { escapeHtml } from '../../../src/shared/world/html'
import type { WorldDoc } from '../../../src/shared/world/types'
import {
  HOSTILE, describedWorld, designWorld, emptyWorld, hostileWorld, labelledWorld, linkedDesignWorld, unlabelledWorld
} from '../../fixtures/world/docWorlds'

const OPTS: DocOptions = { title: 'Termpolis', picture: false, generatedOn: '2026-11-21' }
const model = (doc: WorldDoc, opts: Partial<DocOptions> = {}): DocModel => buildDocumentation(doc, { ...OPTS, ...opts })
const render = (doc: WorldDoc, opts: Partial<DocOptions> = {}, png?: string): string => renderDocumentation(model(doc, opts), doc, png)
/** A one-pixel PNG as a data URL, the shape the 3D view's capture hands over. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const FIXTURES: [string, () => WorldDoc][] = [
  ['labelled', labelledWorld], ['unlabelled', unlabelledWorld], ['design', designWorld], ['linked design', linkedDesignWorld],
  ['empty', emptyWorld], ['hostile', hostileWorld], ['60 parts and 600 lines', () => describedWorld(60, 600, 57, 590)]
]
const count = (s: string, needle: string): number => s.split(needle).length - 1
/** The CSS of the page's one stylesheet, and the body of one of its at-rules (brace-matched). */
const css = (html: string): string => (/<style>([\s\S]*?)<\/style>/.exec(html) as RegExpExecArray)[1]
function atRule(text: string, head: string): string {
  const start = text.indexOf(head)
  if (start < 0) throw new Error(`no ${head}`)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  throw new Error(`unclosed ${head}`)
}

describe('renderDocumentation: the page', () => {
  const html = render(labelledWorld())
  it('is one standalone UTF-8 HTML document titled after the model', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<title>How Termpolis works</title>')
    expect(html).toContain('<h1>How Termpolis works</h1>')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })
  it('is light by default with a dark scheme under prefers-color-scheme', () => {
    const style = css(html)
    expect(style).toContain('@media (prefers-color-scheme: dark)')
    expect(style.indexOf(':root{')).toBeLessThan(style.indexOf('@media (prefers-color-scheme: dark)'))
  })
  it('prints cleanly, each area starting a new page', () => {
    expect(atRule(css(html), '@media print')).toMatch(/\.area\{[^}]*break-before: page/)
  })
  it('has a sticky contents column naming every section and every area', () => {
    expect(html).toMatch(/<nav class="toc" aria-label="Contents">/)
    expect(css(html)).toMatch(/\.toc\{[^}]*position: sticky/)
    const nav = (/<nav[\s\S]*?<\/nav>/.exec(html) as RegExpExecArray)[0]
    for (const t of ['Coverage', 'Overview', 'The city at a glance', 'How it runs', 'Areas', 'Connections', 'Main flows', 'Outside systems', 'Planned changes', 'Glossary', 'What this document doesn&#39;t cover yet', 'Core', 'Agents']) {
      expect(nav).toContain(`>${t}</a>`)
    }
    // Every link points at an element of the page.
    for (const m of nav.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${m[1]}"`)
  })
  it('marks each area for the print break and each part as a card', () => {
    expect(count(html, '<section class="area"')).toBe(2)
    expect(count(html, '<section class="part"')).toBe(3)
  })
  it('renders the coverage states as emphasis, claims with their state badge and evidence', () => {
    expect(html).toContain('Statements marked <em>inferred</em> come from reading the code, <em>verified</em> from tests or a person, <em>observed</em> from the code itself.')
    expect(html).toContain('<span class="badge badge-verified">verified</span> <span class="claim">Startup is covered by a test.</span>')
    expect(html).toContain('<code>test tests/main/startup.test.ts (report)</code>')
  })
  it('renders a tour as numbered steps and a table with its head', () => {
    expect(html).toContain('<ol class="steps"><li>The app talks to its memory. (Core, Desktop app → Memory host, Memory host)</li><li>That is all.</li></ol>')
    expect(html).toMatch(/<table><thead><tr><th>From<\/th><th>To<\/th>/)
  })
  it('a design world shows what proposed means and its proposed badges', () => {
    const d = render(designWorld(), { title: 'Shop' })
    expect(d).toContain('<title>Shop: application plan</title>')
    expect(d).toContain('Statements marked <em>proposed</em> come from the design.')
    expect(d).toContain('<span class="badge badge-proposed">proposed</span>')
  })
  it('a table with no rows says so instead of drawing an empty table', () => {
    const e = render(emptyWorld())
    expect(e).toContain('<p class="empty">Nothing recorded yet.</p>')
    expect(e).not.toContain('<table>')
  })
  it('carries the one link out, to termpolis.com', () => {
    expect(html).toContain('<a href="https://termpolis.com">termpolis.com</a>')
  })
  it('is a snapshot for stability', () => {
    expect(html).toMatchSnapshot()
  })
})

describe('renderDocumentation: every fixture world', () => {
  it.each(FIXTURES)('%s has no script and no external address but termpolis.com', (_, make) => {
    for (const png of [undefined, PNG]) {
      const out = render(make(), { picture: true }, png)
      expect(out).not.toMatch(/<script/i)
      expect(out.match(/[a-z][a-z0-9+.-]*:\/\//gi)).toEqual(['https://'])
      expect(out.match(/https?:\/\/[^"<\s]*/g)).toEqual(['https://termpolis.com'])
    }
  })
})

describe('renderDocumentation: escaping', () => {
  const doc = hostileWorld()
  const html = render(doc, { title: HOSTILE.script })
  it('renders no script, and the <script> names as text', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('<title>How &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; works</title>')
  })
  it('escapes quotes, ampersands and tags, and keeps unicode and emoji', () => {
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain('&quot;double&quot; &#39;single&#39; &amp; &lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain(HOSTILE.unicode)
    expect(html).toContain(HOSTILE.emoji)
  })
  it('escapes the names inside the map too', () => {
    const svg = docMapSvg(doc)
    expect(svg).not.toMatch(/<script/i)
    expect(svg).toContain(escapeHtml(HOSTILE.script))
    expect(svg).toContain(`<title>${escapeHtml(HOSTILE.long)}</title>`)
  })
})

describe('renderDocumentation: the city picture', () => {
  it('is included when the model asks for it and a PNG is given', () => {
    const html = render(labelledWorld(), { picture: true }, PNG)
    expect(html).toContain(`<img src="${PNG}" alt="The city as the 3D view showed it">`)
  })
  it('is absent when no PNG is given, or when the model leaves it out', () => {
    expect(render(labelledWorld(), { picture: true })).not.toContain('<img')
    expect(render(labelledWorld(), { picture: false }, PNG)).not.toContain('<img')
  })
  it('is dropped when the value is not a PNG data URL', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', `${PNG}" onerror="x`, 'data:image/png;base64,']) {
      const html = render(labelledWorld(), { picture: true }, bad)
      expect(html).not.toContain('<img')
      expect(html).not.toContain('onerror')
    }
  })
  it('the map is drawn either way', () => {
    expect(render(labelledWorld())).toContain('<svg class="lm-map"')
  })
})

describe('docMapSvg', () => {
  it('is deterministic', () => {
    for (const [, make] of FIXTURES) expect(docMapSvg(make())).toBe(docMapSvg(make()))
  })
  it.each(FIXTURES)('%s draws every district once as a <g data-id>', (_, make) => {
    const doc = make()
    const svg = docMapSvg(doc)
    expect(count(svg, '<g data-id=')).toBe(doc.districts.length)
    for (const d of doc.districts) expect(count(svg, `<g data-id="${escapeHtml(d.id)}"`)).toBe(1)
  })
  it('never puts a district id in an SVG id or url() reference', () => {
    const doc = labelledWorld()
    const odd = 'd1" id="x" fill="url(#y)'
    doc.districts[0].id = odd
    for (const b of doc.buildings) if (b.districtId === 'd1') b.districtId = odd
    const svg = docMapSvg(doc)
    expect(svg).toContain(`<g data-id="${escapeHtml(odd)}"`)
    expect(Array.from(svg.matchAll(/\sid="([^"]*)"/g), (m) => m[1])).toEqual(['lm-arrow'])
    expect(Array.from(svg.matchAll(/="url\(#([^)]*)\)"/g), (m) => m[1])).toEqual(['lm-arrow'])
  })
  it('puts each part inside its area\'s box', () => {
    const svg = docMapSvg(labelledWorld())
    const core = (/<g data-id="d1"[\s\S]*?<\/g>/.exec(svg) as RegExpExecArray)[0]
    expect(core).toContain('<title>Desktop app</title>')
    expect(core).toContain('<title>Memory host</title>')
    expect(core).not.toContain('<title>Agent runner</title>')
  })
  it('aggregates the lines between areas, with a count and an arrow each way, and counts the lines inside an area', () => {
    const svg = docMapSvg(labelledWorld())
    // e1 and e2 stay inside Core; e3 runs Core → Agents; e4 reaches an outside system and is not an area line.
    expect(count(svg, 'class="lm-line"')).toBe(1)
    expect(svg).toContain('marker-end="url(#lm-arrow)"')
    expect(svg).toContain('<title>1 connection from Core to Agents</title>')
    expect(svg).toContain('2 parts · 2 connections inside')
    expect(svg).toContain('1 part')
    const doc = labelledWorld()
    doc.edges.push({ ...doc.edges[2], id: 'e5', from: 'b3', to: 'b2' }, { ...doc.edges[2], id: 'e6', from: 'b3', to: 'b1' })
    const both = docMapSvg(doc)
    expect(count(both, 'class="lm-line"')).toBe(2)
    expect(both).toContain('<title>2 connections from Agents to Core</title>')
  })
  it('caps a crowded area\'s parts with "and N more", truncating long names with the full name kept', () => {
    const doc = describedWorld(30, 0, 0, 0)
    for (const b of doc.buildings) b.districtId = 'd0'
    doc.buildings[0].name = HOSTILE.long
    const svg = docMapSvg(doc)
    expect(svg).toContain('and 19 more')
    expect(svg).toMatch(/>Long name Long na[^<]*…<\/text>/)
    expect(svg).toContain(`<title>${HOSTILE.long}</title>`)
    expect(svg).toContain('No parts yet')
  })
  it('an empty world says it has no areas', () => {
    const svg = docMapSvg(emptyWorld())
    expect(svg).toContain('<svg class="lm-map"')
    expect(svg).toContain('No areas yet')
  })
  it('lays the areas out from the layout: a district\'s own position wins over its parts\' centre', () => {
    const doc = labelledWorld()
    const boxX = (svg: string, id: string): number => Number((new RegExp(`<g data-id="${id}"[^>]*><title>[^<]*</title><rect class="lm-box" x="([-0-9.]+)"`).exec(svg) as RegExpExecArray)[1])
    const order = (d: WorldDoc): number => boxX(docMapSvg(d), 'd2') - boxX(docMapSvg(d), 'd1')
    expect(order(doc)).toBeGreaterThan(0)
    doc.layout.positions.d2 = [-100, 0, 0]
    expect(order(doc)).toBeLessThan(0)
  })
  it('a part with no position takes the next fallback slot, as the 2D map places it', () => {
    const doc = labelledWorld()
    delete doc.layout.positions.b1
    delete doc.layout.positions.b2
    expect(() => docMapSvg(doc)).not.toThrow()
    expect(docMapSvg(doc)).toContain('<title>Desktop app</title>')
  })
  it('stays legible for 60 parts and 600 lines: one aggregated line per area pair and direction', () => {
    const doc = describedWorld(60, 600, 57, 590)
    const svg = docMapSvg(doc)
    const lines = count(svg, 'class="lm-line"')
    expect(lines).toBeGreaterThan(0)
    expect(lines).toBeLessThanOrEqual(6 * 5)
    expect(count(svg, 'class="lm-count"')).toBe(lines)
    expect(() => render(doc)).not.toThrow()
  })
  it('keeps every count off the area boxes and off the other counts, for 60 parts and 600 lines', () => {
    const svg = docMapSvg(describedWorld(60, 600, 57, 590))
    const rects = (head: string): number[][] =>
      Array.from(svg.matchAll(new RegExp(`${head} x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"`, 'g')), (m) => m.slice(1).map(Number))
    const boxes = rects('<rect class="lm-box"')
    const pills = rects('</title><rect')
    expect(boxes.length).toBe(6)
    expect(pills.length).toBe(count(svg, 'class="lm-count"'))
    const overlap = (a: number[], b: number[]): boolean => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
    for (const p of pills) expect(boxes.some((b) => overlap(p, b))).toBe(false)
    pills.forEach((p, i) => pills.slice(i + 1).forEach((q) => expect(overlap(p, q)).toBe(false)))
  })
  it('routes a line around an area box in its way', () => {
    const doc = describedWorld(3, 0, 0, 0)
    doc.districts = doc.districts.slice(0, 3)
    doc.buildings.forEach((b, i) => { b.districtId = `d${i}` })
    doc.edges = [{ id: 'e', from: 'b0', to: 'b2', cargo: '', label: '', how: [], tech: [], why: [], rate: '', twoWay: false, claims: [] }]
    const svg = docMapSvg(doc)
    const d = (/class="lm-line" d="M([-\d.]+) ([-\d.]+) Q([-\d.]+) ([-\d.]+) /.exec(svg) as RegExpExecArray).slice(1).map(Number)
    // The control point bows well away from the straight line through the middle box.
    expect(Math.abs(d[3] - d[1])).toBeGreaterThan(100)
  })
})
