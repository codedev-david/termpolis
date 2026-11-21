import { describe, expect, it } from 'vitest'
import { cardText } from '../../src/main/world/cardText'
import { labelWorld } from '../../src/main/world/label'
import { buildingCard, edgeCard } from '../../src/renderer/src/world/engine/cards'
import { CARD_HEADINGS } from '../../src/shared/world/cardFacts'
import { building, claim, edge, minimal, rich } from '../renderer/world/helpers'

/** The claim texts and states an HTML card shows, in order. */
function htmlClaims(html: string): string[] {
  return [...html.matchAll(/<li class="claim" data-state="([^"]+)"><span class="ctext">([^<]*)<\/span>/g)].map((m) => `${m[2]} [${m[1]}]`)
}

describe('cardText', () => {
  it('states every claim of the HTML card, each followed by its state', () => {
    const doc = rich()
    doc.buildings[0].how = [claim('does a thing', 'inferred'), claim('and another', 'verified')]
    doc.buildings[0].claims = [claim('seen in code', 'observed')]
    doc.edges[0].claims = [claim('edge fact', 'verified')]
    for (const id of [...doc.buildings.map((b) => b.id), ...doc.edges.map((e) => e.id), 'pb1', 'pe1']) {
      const html = buildingCard(doc, id) || edgeCard(doc, id)
      const text = cardText(doc, id)
      expect(text).not.toBe('')
      for (const c of htmlClaims(html)) expect(text).toContain(c)
    }
    expect(cardText(doc, 'b1')).toContain('- does a thing [inferred]')
    expect(cardText(doc, 'b1')).toContain('- and another [verified]')
    expect(cardText(doc, 'b1')).toContain('What we know:\n- seen in code [observed]\n  evidence: file a/b.ts')
  })

  it('says where a test result came from, in the text and the HTML card alike; other evidence shows no excerpt', () => {
    const doc = rich()
    doc.buildings[0].claims = [
      {
        text: 'Its 2 linked tests passed (agent transcript)',
        state: 'verified',
        evidence: [
          { kind: 'test', ref: 't/a.test.ts', excerpt: 'from an agent transcript' },
          { kind: 'commit', ref: 'abc123', excerpt: 'a long commit subject' }
        ]
      }
    ]
    const text = cardText(doc, 'b1')
    expect(text).toContain('- Its 2 linked tests passed (agent transcript) [verified]\n  evidence: test t/a.test.ts (from an agent transcript); commit abc123')
    expect(text).not.toContain('a long commit subject')
    const html = buildingCard(doc, 'b1')
    expect(html).toContain('data-evidence="{&quot;kind&quot;:&quot;test&quot;,&quot;ref&quot;:&quot;t/a.test.ts&quot;,&quot;excerpt&quot;:&quot;from an agent transcript&quot;}"')
    expect(html).toContain('data-evidence="{&quot;kind&quot;:&quot;commit&quot;,&quot;ref&quot;:&quot;abc123&quot;}"')
  })

  it('states the building facts the HTML card shows', () => {
    const doc = minimal()
    const text = cardText(doc, 'b1')
    const html = buildingCard(doc, 'b1')
    expect(html).toContain('Main process')
    expect(text).toContain('Runs in: Main process')
    expect(text).toContain('Status: Built')
    for (const f of doc.buildings[0].floors) expect(text).toContain(`- ${f.name}`)
    for (const t of doc.buildings[0].stack) expect(text).toContain(`- ${t}: ${doc.glossary[t]}`)
    expect(text).toContain('What goes out:')
    expect(text).not.toContain('What comes in')
    expect(cardText(doc, 'b2')).toContain('What comes in:')
  })

  it('covers the optional parts of a building: AI name, no tech label, blank process, not in design, bare floors', () => {
    const doc = rich()
    const b = doc.buildings[0]
    b.nameState = 'inferred'
    b.techLabel = ''
    b.process = ' '
    b.floors = [{ name: 'Bare', tech: [], members: [] }]
    b.stack = ['unlisted']
    b.how = []
    b.claims = []
    doc.layers.plan.push({ id: 'linked', title: 'Linked design', summary: [], buildings: [], edges: [], reconcile: { matched: {}, missing: [], extra: [b.id], changed: [], planAt: 1 } })
    const text = cardText(doc, b.id)
    expect(text.split('\n')[0]).toBe(`${b.name} (name suggested by AI)`)
    expect(text).toContain('; not in the design')
    expect(text).not.toContain('Runs in')
    expect(text).toContain("What's inside:\n- Bare")
    expect(text).toContain('- unlisted')
    expect(text).not.toContain('- unlisted:')
    expect(text).toContain('Not described yet.')
    expect(text).not.toContain('What we know')
    b.floors = []
    b.stack = []
    const bare = cardText(doc, b.id)
    expect(bare).not.toContain("What's inside")
    expect(bare).not.toContain('Technology')
  })

  it('a line no model described says, from the code, who reaches whom and through what, in the text and the HTML card alike (round 3 E)', () => {
    const doc = minimal()
    const e = doc.edges[0]
    Object.assign(e, { how: [], why: [], label: 'ipc world:get, env A, ipc world:ask', tech: ['ipc', 'env'] })
    const from = doc.buildings.find((b) => b.id === e.from)?.name as string
    const to = doc.buildings.find((b) => b.id === e.to)?.name as string
    const how = `From the code: ${from} reaches ${to} this way: it uses 2 message channels and reads 1 setting.`
    const why = 'Not described yet; the code alone does not say why.'
    for (const card of [cardText(doc, e.id), edgeCard(doc, e.id)]) {
      expect(card).toContain(how)
      expect(card).toContain(why)
    }
    e.label = 'port 5173'
    expect(cardText(doc, e.id)).toContain(`From the code: ${from} reaches ${to} this way: it connects on 1 port.`)
    e.label = 'env A, ipc b, port 1'
    expect(cardText(doc, e.id)).toContain('it reads 1 setting, uses 1 message channel and connects on 1 port.')
    // A line of imports alone, and one with a model's name but no description.
    Object.assign(e, { label: 'imports', tech: [] })
    expect(cardText(doc, e.id)).toContain(`From the code: ${from} imports code from ${to}.`)
    Object.assign(e, { label: 'Asks for the world', tech: ['ipc'] })
    expect(edgeCard(doc, e.id)).toContain(`From the code: ${from} reaches ${to} through ipc.`)
    Object.assign(e, { tech: [] })
    expect(cardText(doc, e.id)).toContain(`From the code: ${from} reaches ${to}.`)
    // A described line keeps its own words.
    e.how = [claim('Sends it over IPC', 'inferred')]
    expect(edgeCard(doc, e.id)).not.toContain('From the code')
  })

  it('a planned line no model described claims nothing from the code, which it has none of (round 5 M8)', () => {
    const doc = rich()
    const planned = doc.layers.plan[0].edges[0]
    Object.assign(planned, { how: [], why: [], label: 'ipc world:get', tech: ['ipc'] })
    for (const card of [cardText(doc, planned.id), edgeCard(doc, planned.id)]) {
      expect(card).not.toContain('From the code')
      expect(card).toContain('Not described yet.')
      expect(card).toContain('Not described yet; the code alone does not say why.')
    }
  })

  it('a design world\'s own line no model described claims nothing from the code either (round 6 M5)', () => {
    const doc = minimal()
    doc.projectKey = 'design:p'
    const e = doc.edges[0]
    Object.assign(e, { how: [], why: [], label: 'ipc world:get', tech: ['ipc'] })
    for (const card of [cardText(doc, e.id), edgeCard(doc, e.id)]) {
      expect(card).not.toContain('From the code')
      expect(card).toContain('Not described yet.')
    }
  })

  it('states outside parts, planned parts and nothing for an unknown id or a district', () => {
    const doc = rich()
    expect(cardText(doc, 'x1')).toContain('Outside the project')
    expect(cardText(doc, 'x1')).not.toContain('not fully known')
    doc.externals[0].fog = true
    expect(cardText(doc, 'x1')).toContain('not fully known')
    expect(cardText(doc, 'b4')).toContain('Planned only')
    expect(cardText(doc, 'nope')).toBe('')
    expect(cardText(doc, 'd1')).toBe('')
  })

  it('names the ends of a line and falls back to the id for a missing end, with evidence-free claims', () => {
    const doc = rich()
    doc.edges.push(edge('e9', 'b1', 'ghost', { how: [claim('no evidence', 'observed', false)] }))
    const text = cardText(doc, 'e9')
    expect(text).toContain('(b1) -> ghost (ghost)')
    expect(text).toContain('- no evidence [observed]\n')
    expect(text).not.toContain('evidence:')
    expect(cardText(doc, 'b1')).toContain('goes out')
    expect(cardText(doc, 'b1')).toContain('to ghost (ghost)')
  })

  it('states a line like the HTML card: summary title, items, long label, cargo, tech, rate and two ways', () => {
    const doc = minimal()
    const e = doc.edges[0]
    e.label = 'env A, env B, ipc <pty:data>'
    e.twoWay = true
    e.tech = ['ipc', 'unlisted']
    const items = cardText(doc, e.id)
    expect(items.split('\n')[0]).toBe('reads 2 settings +1 more')
    expect(items).toContain('What it carries:\n- env A\n- env B\n- ipc <pty:data>')
    expect(items).toContain('Desktop app (b1) -> Memory host (b2)\n\nDirection:\nBoth ways: Desktop app reaches Memory host, and Memory host reaches Desktop app.\n')
    expect(items).not.toContain('(both ways)')
    expect(items).toContain('- unlisted')
    expect(items).toContain('How often:\non demand')
    e.label = 'Sends every keystroke and resize event to the shell host process'
    const long = cardText(doc, e.id)
    expect(long).toContain(e.label)
    expect(long.split('\n')[0]).toBe('Sends every keystroke and…')
    e.label = 'Memory calls'
    e.rate = ''
    e.twoWay = false
    e.tech = []
    e.cargo = 'unknown-cargo'
    const plain = cardText(doc, e.id)
    expect(plain.match(/Memory calls/g)).toHaveLength(1)
    expect(plain).toContain('What travels:\nunknown-cargo')
    expect(plain).not.toContain('How often')
    expect(plain).not.toContain('Technology')
    expect(plain).toContain('Direction:\nOne way: Desktop app reaches Memory host; the code shows no line from Memory host back to Desktop app.')
  })

  it('states the same direction sentence as the HTML card: both ways, with replies and planned', () => {
    const doc = rich()
    doc.edges[0].twoWay = false
    doc.edges.push(edge('e8', 'b2', 'b1', { label: 'Replies' }))
    expect(cardText(doc, 'e1')).toContain('Direction:\nBoth ways: Desktop app reaches Memory host, and Memory host reaches Desktop app.')
    doc.edges.push(edge('e5', 'b1', 'x1', { label: 'http-out api.example.com' }))
    expect(cardText(doc, 'e5')).toContain('Direction:\nOne way, with replies: Desktop app asks and Claude Code answers.')
    expect(cardText(doc, 'pe1')).toContain('Direction:\nOne way (planned): Desktop app reaches pb1.')
  })

  it('states why a big building is this big, in the same words as the HTML card', () => {
    const doc = minimal()
    const files = Array.from({ length: 30 }, (_, i) => `src/a/f${i}.ts`)
    doc.buildings.push(building('big', { members: files, growth: { start: 'process', seed: 'ptyHost', merged: 0, mergedFiles: 0, reached: 26, inFolder: 0, folded: 3, cap: 60 } }))
    const note = '30 files. It started as the entry of the "ptyHost" process. 26 files imported only from inside it joined it. 3 other groups were folded in because Lumopolis shows at most 60 buildings per project.'
    expect(cardText(doc, 'big')).toContain(`Why it is this big:\n${note}`)
    expect(buildingCard(doc, 'big')).toContain('ptyHost')
    expect(cardText(doc, 'b1')).not.toContain('Why it is this big')
  })

  it('a building of thousands of files stops at 12 floors, and both cards say how many files share its "other" floor (G05)', async () => {
    const files = Array.from({ length: 2000 }, (_, i) => `src/huge/f${String(i).padStart(4, '0')}.ts`)
    const g = { districts: [{ id: 'd1', name: 'D', members: [] }], buildings: [{ id: 'huge', districtId: 'd1', name: 'huge', members: files, process: '', boundaries: [] }], edges: [] }
    const l = await labelWorld(g, { llm: null, cache: { get: async () => null, set: async () => undefined }, excerpt: async () => '' })
    const floors = l.buildings.huge.floors
    expect(floors).toHaveLength(12)
    expect(floors[11]).toMatchObject({ name: 'other', members: files.slice(11) })
    const doc = minimal()
    doc.buildings.push(building('huge', { members: files, floors, growth: { start: 'folder', seed: 'src/huge', merged: 0, mergedFiles: 0, folded: 0, cap: 60 } }))
    const note = '2000 files. It started as the src/huge folder. Its "other" floor holds 1989 files.'
    // An agent reads the floors in its own text; the 3D city opens them on a double-click.
    expect(cardText(doc, 'huge')).toContain(`Why it is this big:\n${note} Its floors are listed under What's inside.`)
    expect(buildingCard(doc, 'huge', 'open3d')).toContain(`<p>${note.replace(/"/g, '&quot;')} Double-click it to see its floors.</p>`)
  })

  it('a building built without any edges has no connection sections', () => {
    const doc = minimal()
    doc.buildings.push(building('lonely'))
    expect(cardText(doc, 'lonely')).not.toContain('What comes in')
    expect(cardText(doc, 'lonely')).not.toContain('What goes out')
  })

  it('cardText uses the HTML card headings', () => {
    const doc = rich()
    const text = cardText(doc, 'e1')
    expect(text).toContain(`${CARD_HEADINGS.whyDone}:`)
    expect(text).not.toContain('Why it is done this way')
  })

  it('cardText lists service names like the card', () => {
    const doc = rich()
    doc.runtimeNames.b1 = ['svc-a', 'svc-b']
    expect(cardText(doc, 'b1')).toContain(`${CARD_HEADINGS.serviceNames}:
svc-a, svc-b`)
    doc.runtimeHandSet = ['b1']
    expect(cardText(doc, 'b1')).toContain('svc-a, svc-b (edited by you)')
    expect(cardText(doc, 'b3')).not.toContain(CARD_HEADINGS.serviceNames)
  })
})
