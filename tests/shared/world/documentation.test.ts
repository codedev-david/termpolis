import { describe, expect, it } from 'vitest'
import {
  NOT_SEEN, SECTION_IDS, buildDocumentation,
  type DocBlock, type DocModel, type DocOptions, type DocSection
} from '../../../src/shared/world/documentation'
import { BUILD_STATUS_TEXT, CARD_HEADINGS, NOT_DESCRIBED, NO_WHY_YET, direction, edgeFromCode, runsIn, serviceNamesLine, sizeNote } from '../../../src/shared/world/cardFacts'
import { sanitizeWorld } from '../../../src/shared/world/exportSanitize'
import { validateWorld } from '../../../src/shared/world/validate'
import type { WorldDoc } from '../../../src/shared/world/types'
import {
  HOSTILE, LONG_NAME, describedWorld, designWorld, emptyWorld, hostileWorld, labelledWorld, linkedDesignWorld, unlabelledWorld
} from '../../fixtures/world/docWorlds'

const OPTS: DocOptions = { title: 'Termpolis', picture: false, generatedOn: '2026-11-21' }
const build = (doc: WorldDoc, opts: Partial<DocOptions> = {}): DocModel => buildDocumentation(doc, { ...OPTS, ...opts })

/** Every string the model holds: titles, paragraphs, claim texts and references, list items and table cells. */
function texts(model: DocModel): string[] {
  const out = [model.title, model.subtitle]
  const block = (b: DocBlock): void => {
    if (b.kind === 'p') out.push(b.text)
    else if (b.kind === 'claims') for (const c of b.items) out.push(c.text, ...c.refs)
    else if (b.kind === 'list') out.push(...b.items)
    else if (b.kind === 'table') out.push(...b.head, ...b.rows.flat())
  }
  const walk = (s: DocSection): void => {
    out.push(s.title)
    s.blocks.forEach(block)
    if (s.children) s.children.forEach(walk)
  }
  model.sections.forEach(walk)
  return out
}
const allText = (model: DocModel): string => texts(model).join('\n')
const sectionOf = (model: DocModel, id: string): DocSection => {
  const s = model.sections.find((x) => x.id === id)
  if (!s) throw new Error(`no section ${id}`)
  return s
}
const childOf = (s: DocSection, id: string): DocSection => {
  const c = (s.children ?? []).find((x) => x.id === id)
  if (!c) throw new Error(`no child ${id} in ${s.id}`)
  return c
}
const paragraphs = (s: DocSection): string[] => s.blocks.flatMap((b) => (b.kind === 'p' ? [b.text] : []))
const listOf = (s: DocSection): string[] => s.blocks.flatMap((b) => (b.kind === 'list' ? b.items : []))
const tableOf = (s: DocSection): { head: string[]; rows: string[][] } => {
  const t = s.blocks.find((b) => b.kind === 'table')
  if (!t || t.kind !== 'table') throw new Error(`no table in ${s.id}`)
  return t
}
/** A building's section: Areas > the district > the part. */
const partOf = (model: DocModel, doc: WorldDoc, id: string): DocSection => {
  const b = doc.buildings.find((x) => x.id === id) as WorldDoc['buildings'][number]
  return childOf(childOf(sectionOf(model, 'areas'), `area:${b.districtId}`), `part:${id}`)
}

const STATES = 'Statements marked *inferred* come from reading the code, *verified* from tests or a person, *observed* from the code itself.'
/** The building card's sections in the order cards.ts buildingCard prints them. */
const CARD_ORDER = [
  CARD_HEADINGS.whatItDoes, CARD_HEADINGS.inside, CARD_HEADINGS.whyBig, CARD_HEADINGS.technology, CARD_HEADINGS.whyBuilt,
  CARD_HEADINGS.serviceNames, CARD_HEADINGS.know, CARD_HEADINGS.comesIn, CARD_HEADINGS.goesOut
]
const FIXTURES: [string, () => WorldDoc][] = [
  ['labelled', labelledWorld], ['unlabelled', unlabelledWorld], ['design', designWorld], ['linked design', linkedDesignWorld],
  ['empty', emptyWorld], ['hostile', hostileWorld], ['60 parts and 600 lines', () => describedWorld(60, 600, 57, 590)]
]

describe('the fixture worlds', () => {
  it.each(FIXTURES)('%s is a valid world', (_, make) => {
    const r = validateWorld(make())
    expect(r.ok ? [] : r.errors).toEqual([])
  })
  it('the generated world has exactly 60 parts and 600 lines, 57 and 590 of them described', () => {
    const doc = describedWorld(60, 600, 57, 590)
    expect([doc.buildings.length, doc.edges.length]).toEqual([60, 600])
    expect([doc.buildings.filter((b) => b.how.length).length, doc.edges.filter((e) => e.how.length).length]).toEqual([57, 590])
  })
})

describe('sections', () => {
  it('come in SECTION_IDS order, with Plan vs built only when a linked design exists', () => {
    expect(SECTION_IDS).toEqual(['title', 'coverage', 'overview', 'glance', 'runs', 'areas', 'connections', 'flows', 'outside', 'planVsBuilt', 'planned', 'glossary', 'notCovered'])
    const without = SECTION_IDS.filter((id) => id !== 'planVsBuilt')
    expect(build(labelledWorld()).sections.map((s) => s.id)).toEqual(without)
    expect(build(designWorld()).sections.map((s) => s.id)).toEqual(without)
    expect(build(emptyWorld()).sections.map((s) => s.id)).toEqual(without)
    expect(build(linkedDesignWorld()).sections.map((s) => s.id)).toEqual([...SECTION_IDS])
  })
  it('carry the spec headings', () => {
    expect(build(linkedDesignWorld()).sections.slice(1).map((s) => s.title)).toEqual([
      'Coverage', 'Overview', 'The city at a glance', 'How it runs', 'Areas', 'Connections', 'Main flows', 'Outside systems',
      'Plan vs built', 'Planned changes', 'Glossary', "What this document doesn't cover yet"
    ])
  })
})

describe('title block', () => {
  it('a code world is "How <Project> works", generated from the code, with the date, the commit and its dirty flag', () => {
    const m = build(labelledWorld())
    expect(m.title).toBe('How Termpolis works')
    expect(m.subtitle).toBe('Generated by Termpolis Lumopolis from the code')
    expect(m.design).toBe(false)
    const t = sectionOf(m, 'title')
    expect(t.title).toBe('How Termpolis works')
    expect(paragraphs(t)).toEqual([
      'Generated by Termpolis Lumopolis from the code', 'Project: Termpolis', 'Generated on 2026-11-21',
      'Commit a1b2c3d, with changes not yet committed'
    ])
    const clean = build(emptyWorld())
    expect(paragraphs(sectionOf(clean, 'title'))).toContain('Commit 9281177c')
  })
  it('a design world is "<Project>: application plan", generated from the design, with no commit', () => {
    const m = build(designWorld(), { title: 'Shop' })
    expect(m.title).toBe('Shop: application plan')
    expect(m.subtitle).toBe('Generated from the design')
    expect(m.design).toBe(true)
    expect(paragraphs(sectionOf(m, 'title'))).toEqual(['Generated from the design', 'Project: Shop', 'Generated on 2026-11-21'])
  })
  it('a blank title still names the project', () => {
    expect(build(emptyWorld(), { title: '  ' }).title).toBe('How this project works')
  })
})

describe('coverage', () => {
  it('says how many parts and lines are described, then what each state means', () => {
    const c = sectionOf(build(describedWorld(60, 600, 57, 590)), 'coverage')
    expect(paragraphs(c)).toEqual(['57 of 60 parts and 590 of 600 connections are described.', STATES])
  })
  it('a design world adds what *proposed* means', () => {
    const c = paragraphs(sectionOf(build(designWorld()), 'coverage'))
    expect(c.slice(0, 2)).toEqual(['2 of 2 parts and 1 of 1 connections are described.', STATES])
    expect(c[2]).toBe('Statements marked *proposed* come from the design.')
    expect(allText(build(labelledWorld()))).not.toContain('*proposed*')
  })
  it('reads the same on both sides of the 80% smart-Ask threshold: the document has no threshold of its own', () => {
    const below = build(describedWorld(60, 600, 47, 479)) // 78% of parts, 79.8% of lines
    const above = build(describedWorld(60, 600, 48, 480)) // exactly 80% of both
    expect(paragraphs(sectionOf(below, 'coverage'))[0]).toBe('47 of 60 parts and 479 of 600 connections are described.')
    expect(paragraphs(sectionOf(above, 'coverage'))[0]).toBe('48 of 60 parts and 480 of 600 connections are described.')
    const shape = (m: DocModel): string[] => m.sections.map((s) => `${s.id}:${s.title}`)
    expect(shape(below)).toEqual(shape(above))
    expect(listOf(sectionOf(below, 'notCovered'))).toHaveLength(13 + 121)
    expect(listOf(sectionOf(above, 'notCovered'))).toHaveLength(12 + 120)
  })
})

describe('overview', () => {
  it('a code world states districts, counts, processes and the stack in the present tense', () => {
    const o = sectionOf(build(labelledWorld()), 'overview')
    expect(paragraphs(o)).toEqual([
      'Termpolis has 2 areas, 3 parts and 4 connections.',
      'It runs as 3 processes: Main process, Memory host, Spare worker.',
      'It is built with electron, ipc, sqlite.'
    ])
    expect(listOf(o)).toEqual(['Core: The app and its memory', 'Agents: Where the agents run'])
    expect(allText({ title: '', subtitle: '', design: false, sections: [o] })).not.toContain(' will ')
  })
  it('a design world speaks of the plan: what it will have, run as and be built with', () => {
    const o = paragraphs(sectionOf(build(designWorld(), { title: 'Shop' }), 'overview'))
    expect(o).toEqual(['Shop will have 1 area, 2 parts and 1 connection.', 'It will run as 1 process: Web page.', 'It will be built with react.'])
    for (const line of o) expect(line).toContain(' will ')
  })
  it('leaves out processes and the stack when there are none, and an area with no subtitle is its name', () => {
    expect(paragraphs(sectionOf(build(emptyWorld()), 'overview'))).toEqual(['Termpolis has 0 areas, 0 parts and 0 connections.'])
    expect(listOf(sectionOf(build(unlabelledWorld()), 'overview'))).toEqual(['src'])
  })
})

describe('the city at a glance', () => {
  it('holds the map, after the picture when one is asked for', () => {
    expect(sectionOf(build(labelledWorld()), 'glance').blocks).toEqual([{ kind: 'map' }])
    expect(sectionOf(build(labelledWorld(), { picture: true }), 'glance').blocks).toEqual([{ kind: 'picture' }, { kind: 'map' }])
  })
})

describe('how it runs', () => {
  it('lists each process by its label with the parts in it', () => {
    const r = sectionOf(build(labelledWorld()), 'runs')
    expect(paragraphs(r)).toEqual(['Each process and the parts that run in it.'])
    expect(listOf(r)).toEqual(['Main process: Desktop app, Agent runner', 'Memory host: Memory host', 'Spare worker'])
  })
  it('a design world lists its planned processes', () => {
    const r = sectionOf(build(designWorld()), 'runs')
    expect(paragraphs(r)).toEqual(['Each planned process and the parts that will run in it.'])
    expect(listOf(r)).toEqual(['Web page: Shop page, Basket'])
  })
  it('says so when there is no process', () => {
    expect(paragraphs(sectionOf(build(emptyWorld()), 'runs'))).toEqual(['The code shows no processes.'])
    expect(paragraphs(sectionOf(build({ ...emptyWorld(), projectKey: 'design:x' }), 'runs'))).toEqual(['The design names no processes.'])
  })
})

describe('areas', () => {
  it('one per district in the world order, titled by its name, with its subtitle', () => {
    const a = sectionOf(build(labelledWorld()), 'areas')
    expect((a.children ?? []).map((c) => [c.id, c.title])).toEqual([['area:d1', 'Core'], ['area:d2', 'Agents']])
    expect(paragraphs(childOf(a, 'area:d1'))).toEqual(['The app and its memory'])
    expect(paragraphs(childOf(sectionOf(build(unlabelledWorld()), 'areas'), 'area:d1'))).toEqual([])
    expect(paragraphs(sectionOf(build(emptyWorld()), 'areas'))).toEqual(['There are no areas yet.'])
  })
  it("each part follows the card's order under the card's headings", () => {
    for (const make of [labelledWorld, unlabelledWorld, designWorld, linkedDesignWorld, hostileWorld]) {
      const doc = make()
      const m = build(doc)
      for (const b of doc.buildings) {
        const titles = (partOf(m, doc, b.id).children ?? []).map((c) => c.title)
        expect(titles).toEqual(CARD_ORDER.filter((h) => titles.includes(h)))
      }
    }
    const doc = labelledWorld()
    const m = build(doc)
    expect((partOf(m, doc, 'b1').children ?? []).map((c) => c.title)).toEqual([
      'What it does', "What's inside", 'Why it is this big', 'Technology', "Why it's built this way", 'What we know', 'What comes in', 'What goes out'
    ])
    expect((partOf(m, doc, 'b2').children ?? []).map((c) => c.title)).toEqual([
      'What it does', "What's inside", 'Technology', "Why it's built this way", 'Service names', 'What comes in', 'What goes out'
    ])
    expect((partOf(m, doc, 'b1').children ?? []).map((c) => c.id)).toEqual([
      'part:b1:whatItDoes', 'part:b1:inside', 'part:b1:whyBig', 'part:b1:technology', 'part:b1:whyBuilt', 'part:b1:know', 'part:b1:comesIn', 'part:b1:goesOut'
    ])
  })
  it('opens each part with its name, technology, status and process, as the card does', () => {
    const doc = labelledWorld()
    const m = build(doc)
    const b1 = partOf(m, doc, 'b1')
    expect(b1.title).toBe('Desktop app')
    expect(paragraphs(b1)).toEqual(['Electron + React', 'Status: Built · not yet checked', 'Runs in: Main process'])
    const b3 = partOf(m, doc, 'b3')
    expect(b3.title).toBe('Agent runner (name suggested by AI)')
    expect(paragraphs(b3)).toEqual(['Status: Built · no test results yet', 'Runs in: Main process'])
    const plain = unlabelledWorld()
    expect(paragraphs(partOf(build(plain), plain, 'b2'))).toEqual(['Status: Built · not yet checked'])
  })
  it('tags a built part the linked design lacks', () => {
    const doc = linkedDesignWorld()
    expect(paragraphs(partOf(build(doc), doc, 'b3'))).toEqual(['Status: Built · not yet checked; not in the design', 'Runs in: API server'])
  })
  it('gives claims their state and evidence as references, and says "Not described yet." when there are none', () => {
    const doc = labelledWorld()
    const b1 = partOf(build(doc), doc, 'b1')
    expect(childOf(b1, 'part:b1:whatItDoes').blocks).toEqual([{
      kind: 'claims', items: [{ text: 'The main process opens the window and hosts terminals.', state: 'observed', refs: ['file src/main/index.ts'] }]
    }])
    expect(childOf(b1, 'part:b1:know').blocks).toEqual([{
      kind: 'claims', items: [
        { text: 'Startup is covered by a test.', state: 'verified', refs: ['test tests/main/startup.test.ts (report)'] },
        { text: 'The window opens maximised.', state: 'verified', refs: ['person David'] }
      ]
    }])
    const b3 = partOf(build(doc), doc, 'b3')
    expect(childOf(b3, 'part:b3:whyBuilt').blocks).toEqual([{ kind: 'p', text: NOT_DESCRIBED }])
    const plain = unlabelledWorld()
    expect(childOf(partOf(build(plain), plain, 'b1'), 'part:b1:whatItDoes').blocks).toEqual([{ kind: 'p', text: NOT_DESCRIBED }])
  })
  it("lists what's inside: floors with their technology and files, each capped with \"and N more\"", () => {
    const doc = labelledWorld()
    const m = build(doc)
    const files = Array.from({ length: 12 }, (_, i) => `src/main/shell/part${i}.ts`).join(', ')
    expect(listOf(childOf(partOf(m, doc, 'b1'), 'part:b1:inside'))).toEqual([`Window shell · electron: ${files} and 3 more`, 'Menus'])
    const b2 = listOf(childOf(partOf(m, doc, 'b2'), 'part:b2:inside'))
    expect(b2).toHaveLength(13)
    expect(b2[0]).toBe('Floor 1 · sqlite: src/main/memory/f0.ts')
    expect(b2[12]).toBe('and 1 more')
  })
  it('gives the size note, the technology with its glossary entry, and the service names', () => {
    const doc = labelledWorld()
    doc.glossary.ipc = ''
    const m = build(doc)
    expect(childOf(partOf(m, doc, 'b1'), 'part:b1:whyBig').blocks).toEqual([{ kind: 'p', text: sizeNote(doc, doc.buildings[0], 'listed') }])
    expect(sizeNote(doc, doc.buildings[0], 'listed')).toContain("Its floors are listed under What's inside.")
    expect(listOf(childOf(partOf(m, doc, 'b1'), 'part:b1:technology'))).toEqual(['electron: A framework for desktop apps.', 'ipc'])
    expect(childOf(partOf(m, doc, 'b2'), 'part:b2:serviceNames').blocks).toEqual([{ kind: 'p', text: 'memory-host, brain (edited by you)' }])
  })
  it('lists what comes in and goes out with each line and its direction sentence', () => {
    const doc = labelledWorld()
    const b1 = partOf(build(doc), doc, 'b1')
    expect(listOf(childOf(b1, 'part:b1:comesIn'))).toEqual([
      'Memory replies from Memory host: Both ways: Memory host reaches Desktop app, and Desktop app reaches Memory host.'
    ])
    expect(listOf(childOf(b1, 'part:b1:goesOut'))).toEqual([
      'Memory calls to Memory host: Both ways: Desktop app reaches Memory host, and Memory host reaches Desktop app.',
      'reads 1 setting +1 more to Agent runner: One way: Desktop app reaches Agent runner; the code shows no line from Agent runner back to Desktop app.'
    ])
  })
  it('a design world shows its parts as planned', () => {
    const doc = designWorld()
    const m = build(doc)
    expect(paragraphs(partOf(m, doc, 'b1'))).toEqual(['Status: Planned only', 'Runs in: Web page'])
    expect(listOf(childOf(partOf(m, doc, 'b1'), 'part:b1:goesOut'))).toEqual(['Adds items to Basket: One way (planned): Shop page reaches Basket.'])
  })
})

describe('every card sentence appears verbatim', () => {
  it.each(FIXTURES)('%s', (_, make) => {
    const doc = make()
    const text = allText(build(doc))
    const expected: string[] = []
    for (const b of doc.buildings) {
      const note = sizeNote(doc, b, 'listed')
      if (note) expected.push(note)
      if (runsIn(doc, b).trim()) expected.push(runsIn(doc, b))
      expected.push(BUILD_STATUS_TEXT[b.status], ...[...b.how, ...b.why, ...b.claims].map((c) => c.text))
      const names = serviceNamesLine(doc, b.id)
      if (names !== null) expected.push(names)
    }
    for (const e of doc.edges) {
      expected.push(direction(doc, e).text)
      if (e.how.length === 0) expected.push(edgeFromCode(doc, e))
      if (e.why.length === 0) expected.push(NO_WHY_YET)
    }
    for (const s of expected) expect(text).toContain(s)
  })
})

describe('connections', () => {
  it('is a table of every line with every line-card field', () => {
    const doc = labelledWorld()
    const t = tableOf(sectionOf(build(doc), 'connections'))
    expect(t.head).toEqual(['From', 'To', 'What travels', 'How', 'Direction', 'Why', 'How often'])
    expect(t.rows).toHaveLength(doc.edges.length)
    expect(t.rows[0]).toEqual([
      'Desktop app', 'Memory host', 'Memory: Memory calls',
      'The app calls the memory host over a local socket. [observed] Technology: ipc What we know: Each call is answered within a second. [verified]',
      'Both ways: Desktop app reaches Memory host, and Memory host reaches Desktop app.',
      'Keeps the database out of the UI process. [inferred]', 'on demand'
    ])
    expect(t.rows[2]).toEqual([
      'Desktop app', 'Agent runner', 'env AGENT_HOME, ipc agent:start', edgeFromCode(doc, doc.edges[2]), direction(doc, doc.edges[2]).text, NO_WHY_YET, ''
    ])
    expect(t.rows[3][1]).toBe('Model API')
    expect(t.rows[3][4]).toBe('One way, with replies: Agent runner asks and Model API answers.')
  })
  it('one row per line on the 600-line world, and a line with no label or cargo travels nothing named', () => {
    expect(tableOf(sectionOf(build(describedWorld(60, 600, 57, 590)), 'connections')).rows).toHaveLength(600)
    const doc = unlabelledWorld()
    doc.edges[0].label = ''
    expect(tableOf(sectionOf(build(doc), 'connections')).rows[0][2]).toBe('')
    const imports = unlabelledWorld()
    expect(tableOf(sectionOf(build(imports), 'connections')).rows[0].slice(2, 4)).toEqual(['imports', 'From the code: main imports code from util.'])
  })
  it('a design line is not described from code', () => {
    const doc = designWorld()
    doc.edges[0].how = []
    expect(tableOf(sectionOf(build(doc), 'connections')).rows[0][3]).toBe(NOT_DESCRIBED)
  })
})

describe('main flows', () => {
  it('gives each tour as numbered steps with captions and the parts involved', () => {
    const f = sectionOf(build(labelledWorld()), 'flows')
    expect((f.children ?? []).map((c) => c.title)).toEqual(['First look'])
    expect(listOf(childOf(f, 'flow:t1'))).toEqual(['1. The app talks to its memory. (Core, Desktop app → Memory host, Memory host)', '2. That is all.'])
  })
  it('says so when there is no tour', () => {
    const f = sectionOf(build(emptyWorld()), 'flows')
    expect(paragraphs(f)).toEqual(['No tours are recorded yet.'])
    expect(f.children).toBeUndefined()
  })
})

describe('outside systems', () => {
  it('names each, its kind and the parts that reach it, marking fog ones "not seen in code"', () => {
    const t = tableOf(sectionOf(build(labelledWorld()), 'outside'))
    expect(t.head).toEqual(['Name', 'What it is', 'Reached by'])
    expect(t.rows).toEqual([['Model API (not seen in code)', 'provider', 'Agent runner'], ['Shared drive', 'files', '']])
  })
  it('names a part once however many lines it sends', () => {
    const doc = labelledWorld()
    doc.edges.push({ ...doc.edges[3], id: 'e5', label: 'http-out other.example.com' })
    expect(tableOf(sectionOf(build(doc), 'outside')).rows[0][2]).toBe('Agent runner')
  })
  it('says so when there is none', () => {
    expect(paragraphs(sectionOf(build(emptyWorld()), 'outside'))).toEqual(['No outside systems are recorded.'])
  })
})

describe('plan vs built', () => {
  it('lists matched, missing, extra and changed parts of the linked design', () => {
    const s = sectionOf(build(linkedDesignWorld()), 'planVsBuilt')
    expect((s.children ?? []).map((c) => [c.id, c.title])).toEqual([['reconcile:p1', 'Shop design']])
    expect(paragraphs(childOf(s, 'reconcile:p1'))).toEqual([
      'Matched: Orders, Billing',
      'Missing (planned, not built yet): Notifications',
      'Extra (built, not in the design): Legacy export',
      'Changed (built, still short of the design): Billing'
    ])
  })
  it('says "none" for an empty list', () => {
    const doc = linkedDesignWorld()
    const r = doc.layers.plan[0].reconcile as NonNullable<WorldDoc['layers']['plan'][number]['reconcile']>
    r.matched = {}
    r.changed = []
    const p = paragraphs(childOf(sectionOf(build(doc), 'planVsBuilt'), 'reconcile:p1'))
    expect(p[0]).toBe('Matched: none')
    expect(p[3]).toBe('Changed (built, still short of the design): none')
  })
})

describe('planned changes', () => {
  it("lists each proposal's title, summary and the parts it adds and removes", () => {
    const s = sectionOf(build(linkedDesignWorld()), 'planned')
    expect((s.children ?? []).map((c) => [c.id, c.title])).toEqual([['plan:p1', 'Shop design'], ['plan:p2', 'Retire the export']])
    expect(childOf(s, 'plan:p1').blocks).toEqual([
      { kind: 'claims', items: [{ text: 'The shop as designed.', state: 'proposed', refs: ['file src/a.ts'] }] },
      { kind: 'p', text: 'Adds: Notifications' }
    ])
    expect(childOf(s, 'plan:p2').blocks).toEqual([{ kind: 'p', text: 'Adds: Report builder' }, { kind: 'p', text: 'Removes: Legacy export' }])
  })
  it('says so when there is none', () => {
    const s = sectionOf(build(labelledWorld()), 'planned')
    expect(paragraphs(s)).toEqual(['No planned changes are recorded.'])
    expect(s.children).toBeUndefined()
  })
})

describe('glossary', () => {
  it('lists every term with its meaning, in alphabetical order', () => {
    const t = tableOf(sectionOf(build(labelledWorld()), 'glossary'))
    expect(t.head).toEqual(['Term', 'Meaning'])
    expect(t.rows).toEqual([['electron', 'A framework for desktop apps.'], ['ipc', 'How two programs talk.'], ['sqlite', 'A small database in one file.']])
  })
  it('says so when there is none', () => {
    expect(paragraphs(sectionOf(build(emptyWorld()), 'glossary'))).toEqual(['The world has no glossary yet.'])
  })
})

describe("what this document doesn't cover yet", () => {
  it('names every part and every line with no description, then what Lumopolis does not see', () => {
    const doc = describedWorld(60, 600, 57, 590)
    const s = sectionOf(build(doc), 'notCovered')
    expect(s.blocks.slice(0, 4)).toEqual([
      { kind: 'p', text: 'These parts are not described yet:' },
      { kind: 'list', items: ['Part 57', 'Part 58', 'Part 59'] },
      { kind: 'p', text: 'These connections are not described yet:' },
      { kind: 'list', items: doc.edges.slice(590).map((e) => `uses 1 message channel (${e.from.replace('b', 'Part ')} → ${e.to.replace('b', 'Part ')})`) }
    ])
    expect(paragraphs(s)[2]).toBe(NOT_SEEN)
    expect(NOT_SEEN).toContain('runtime behaviour')
    expect(NOT_SEEN).toContain('data contents')
  })
  it('lists only the lines when every part is described, and says so when everything is', () => {
    const lines = sectionOf(build(labelledWorld()), 'notCovered')
    expect(paragraphs(lines)[0]).toBe('These connections are not described yet:')
    const all = sectionOf(build(describedWorld(6, 6, 6, 6)), 'notCovered')
    expect(paragraphs(all)).toEqual(['Every part and connection is described.', NOT_SEEN])
    const parts = sectionOf(build(describedWorld(6, 0, 5, 0)), 'notCovered')
    expect(paragraphs(parts)).toEqual(['These parts are not described yet:', NOT_SEEN])
  })
})

describe('the empty world', () => {
  it('gives the title, coverage 0 of 0 and the not-covered text without throwing', () => {
    const m = build(emptyWorld())
    expect(m.title).toBe('How Termpolis works')
    expect(paragraphs(sectionOf(m, 'coverage'))[0]).toBe('0 of 0 parts and 0 of 0 connections are described.')
    expect(paragraphs(sectionOf(m, 'notCovered'))).toEqual(['The world has no parts or connections yet.', NOT_SEEN])
    expect(sectionOf(m, 'connections').blocks).toEqual([{ kind: 'table', head: ['From', 'To', 'What travels', 'How', 'Direction', 'Why', 'How often'], rows: [] }])
  })
})

describe('hostile names', () => {
  it('keeps markup, quotes, unicode, emoji and a 400-character name unchanged as text', () => {
    const doc = hostileWorld()
    const m = build(doc)
    const text = allText(m)
    for (const v of Object.values(HOSTILE)) expect(text).toContain(v)
    expect(LONG_NAME).toHaveLength(400)
    expect(partOf(m, doc, 'b2').title).toBe(LONG_NAME)
    expect(partOf(m, doc, 'b3').title).toBe(`${HOSTILE.emoji} (name suggested by AI)`)
    expect(childOf(sectionOf(m, 'areas'), 'area:d1').title).toBe(HOSTILE.script)
    expect(text).not.toContain('&lt;')
    expect(text).not.toContain('&amp;')
  })
})

describe('the model as data', () => {
  it.each(FIXTURES)('%s survives a JSON round trip and two builds are deep-equal', (_, make) => {
    const m = build(make(), { picture: true })
    expect(JSON.parse(JSON.stringify(m))).toStrictEqual(m)
    expect(build(make(), { picture: true })).toStrictEqual(m)
  })
  it('only reads the world', () => {
    const doc = linkedDesignWorld()
    const before = JSON.stringify(doc)
    build(doc)
    expect(JSON.stringify(doc)).toBe(before)
  })
  it('works on a sanitised world, and a sanitised design world still reads as planned', () => {
    const ctx = { root: 'C:/Users/dev/repos/termpolis', home: 'C:/Users/dev', userData: 'C:/Users/dev/AppData/Roaming/Termpolis' }
    const code = sanitizeWorld(labelledWorld(), ctx)
    expect(allText(build(code))).toContain('The main process opens the window and hosts terminals.')
    const design = sanitizeWorld(designWorld(), { ...ctx, root: null })
    expect(build(design).design).toBe(true)
    expect(allText(build(design))).toContain('One way (planned): Shop page reaches Basket.')
  })
})

describe('speed', () => {
  it('builds the 60-part, 600-line world in under a second (three under CI)', () => {
    const doc = describedWorld(60, 600, 57, 590)
    const limit = process.env.CI ? 3000 : 1000
    const t0 = performance.now()
    buildDocumentation(doc, OPTS)
    expect(performance.now() - t0).toBeLessThan(limit)
  })
})
