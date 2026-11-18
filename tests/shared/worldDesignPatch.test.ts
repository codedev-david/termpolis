import { describe, expect, it } from 'vitest'
import {
  applyDesignPatch, defaultPlacer, DESIGN_PROTOCOL, emptyDesignDoc, MAX_DESIGN_OPS, parseDesignReply, REMOVALS_ID, REMOVALS_TITLE,
  type DesignOp
} from '../../src/shared/world/designPatch'
import type { WorldDoc } from '../../src/shared/world/types'
import { validateWorld } from '../../src/shared/world/validate'

const KEY = 'design:abc'
const EVIDENCE = [{ kind: 'memory', ref: KEY }]

const BASE_OPS: DesignOp[] = [
  { op: 'addDistrict', id: 'core', name: 'Core' },
  { op: 'addDistrict', id: 'web', name: 'Web', subtitle: 'What people see' },
  { op: 'addBuilding', id: 'api', districtId: 'core', name: 'Orders API', techLabel: 'HTTP service', stack: ['Node', 'Node'], does: 'Takes orders.' },
  { op: 'addBuilding', id: 'db', districtId: 'core', name: 'Database' },
  { op: 'addBuilding', id: 'ui', districtId: 'web', name: 'Shop page' },
  { op: 'addEdge', from: 'ui', to: 'api', label: 'sends orders', cargo: 'orders' },
  { op: 'addEdge', from: 'api', to: 'db', label: 'stores orders' }
]

/** A small valid design: two districts, three buildings, two edges. */
function base(): WorldDoc {
  const r = applyDesignPatch(emptyDesignDoc(KEY, 5), BASE_OPS)
  expect(r.skipped).toEqual([])
  return r.doc
}

const valid = (doc: WorldDoc): void => {
  const v = validateWorld(doc)
  expect(v.ok ? [] : v.errors).toEqual([])
}

const building = (doc: WorldDoc, id: string) => doc.buildings.find((b) => b.id === id)

describe('DESIGN_PROTOCOL', () => {
  it('lists every op and keeps the plain-language rule', () => {
    expect(DESIGN_PROTOCOL).toContain('Keep it under 150 words.')
    expect(DESIGN_PROTOCOL).toContain('plain language')
    expect(DESIGN_PROTOCOL).toContain('design-patch')
    for (const op of ['addDistrict', 'addBuilding', 'addEdge', 'rename', 'remove', 'move', 'describe']) {
      expect(DESIGN_PROTOCOL).toContain(`"op":"${op}"`)
    }
  })
})

describe('emptyDesignDoc', () => {
  it('is a valid world with nothing in it', () => {
    const doc = emptyDesignDoc(KEY, 42)
    valid(doc)
    expect(doc).toMatchObject({ projectKey: KEY, generatedAt: 42, districts: [], buildings: [], edges: [], layers: { plan: [] } })
  })
})

describe('applyDesignPatch', () => {
  it('added items are proposed with design evidence', () => {
    const doc = base()
    valid(doc)
    const api = building(doc, 'api')
    expect(api).toMatchObject({
      districtId: 'core', name: 'Orders API', techLabel: 'HTTP service', process: '', floors: [], stack: ['Node'],
      status: 'proposed', members: [], why: [], how: [{ text: 'Takes orders.', state: 'proposed', evidence: EVIDENCE }]
    })
    expect(building(doc, 'db')).toMatchObject({ techLabel: '', stack: [], how: [], status: 'proposed' })
    expect(doc.glossary).toEqual({ Node: '' })
    expect(doc.districts.map((d) => [d.id, d.subtitle, d.members])).toEqual([['core', '', []], ['web', 'What people see', []]])
    expect(doc.districts.map((d) => d.hue)).toEqual([0, 138])
    const edge = doc.edges.find((e) => e.id === 'e-ui--api')
    expect(edge).toMatchObject({ from: 'ui', to: 'api', label: 'sends orders', cargo: 'orders', twoWay: false, rate: '', tech: [], why: [] })
    expect(edge?.how).toEqual([{ text: 'sends orders', state: 'proposed', evidence: EVIDENCE }])
    expect(doc.edges.find((e) => e.id === 'e-api--db')?.cargo).toBe('')
    expect(doc.cargo.orders).toMatchObject({ label: 'orders' })
    expect(Object.keys(doc.cargo)).toEqual(['orders'])
  })

  it('cites design:<key> evidence when the doc key has no design: prefix', () => {
    const r = applyDesignPatch(emptyDesignDoc('plain', 1), [
      { op: 'addDistrict', id: 'd', name: 'D' },
      { op: 'addBuilding', id: 'b', districtId: 'd', name: 'B', does: 'Things.' }
    ])
    expect(r.doc.buildings[0].how[0].evidence).toEqual([{ kind: 'memory', ref: 'design:plain' }])
  })

  it('reuses an existing cargo and glossary entry', () => {
    const doc = base()
    doc.glossary.Node = 'A JavaScript runtime'
    const r = applyDesignPatch(doc, [
      { op: 'addBuilding', id: 'worker', districtId: 'core', name: 'Worker', stack: ['Node'] },
      { op: 'addEdge', from: 'worker', to: 'db', label: 'reads', cargo: 'orders' }
    ])
    expect(r.applied).toBe(2)
    expect(r.doc.glossary.Node).toBe('A JavaScript runtime')
    expect(r.doc.cargo.orders).toEqual(doc.cargo.orders)
  })

  it('addBuilding into unknown district skipped with reason', () => {
    const doc = base()
    const op: DesignOp = { op: 'addBuilding', id: 'pay', districtId: 'nowhere', name: 'Payments' }
    const r = applyDesignPatch(doc, [op])
    expect(r.applied).toBe(0)
    expect(r.skipped).toEqual([{ op, reason: 'there is no district "nowhere"' }])
    expect(r.doc).toBe(doc)
  })

  it('remove building drops its edges', () => {
    const r = applyDesignPatch(base(), [{ op: 'remove', id: 'api' }])
    expect(r.applied).toBe(1)
    expect(r.doc.buildings.map((b) => b.id)).toEqual(['db', 'ui'])
    expect(r.doc.edges).toEqual([])
    expect(r.doc.layout.positions.api).toBeUndefined()
    valid(r.doc)
  })

  it('remove district drops its buildings and their edges', () => {
    const r = applyDesignPatch(base(), [{ op: 'remove', id: 'core' }])
    expect(r.doc.districts.map((d) => d.id)).toEqual(['web'])
    expect(r.doc.buildings.map((b) => b.id)).toEqual(['ui'])
    expect(r.doc.edges).toEqual([])
    expect(Object.keys(r.doc.layout.positions).sort()).toEqual(['ui', 'web'])
    valid(r.doc)
  })

  it('remove edge drops only that edge, and an unknown id is skipped', () => {
    const r = applyDesignPatch(base(), [{ op: 'remove', id: 'e-api--db' }, { op: 'remove', id: 'ghost' }])
    expect(r.applied).toBe(1)
    expect(r.doc.edges.map((e) => e.id)).toEqual(['e-ui--api'])
    expect(r.doc.buildings).toHaveLength(3)
    expect(r.skipped).toEqual([{ op: { op: 'remove', id: 'ghost' }, reason: 'there is nothing called "ghost"' }])
  })

  it('remove prunes tour steps and runtime names that pointed at removed parts', () => {
    const doc = base()
    doc.tours = [{ id: 't', title: 'Tour', steps: [{ ids: ['api'], caption: 'a' }, { ids: ['api', 'ui', 'e-ui--api'], caption: 'b' }] }]
    doc.runtimeNames = { api: ['orders-api'], ui: ['shop'] }
    valid(doc)
    const r = applyDesignPatch(doc, [{ op: 'remove', id: 'api' }])
    expect(r.doc.tours).toEqual([{ id: 't', title: 'Tour', steps: [{ ids: ['ui'], caption: 'b' }] }])
    expect(r.doc.runtimeNames).toEqual({ ui: ['shop'] })
    valid(r.doc)
  })

  it('rename keeps id and position', () => {
    const doc = base()
    const r = applyDesignPatch(doc, [{ op: 'rename', id: 'api', name: 'Checkout API' }, { op: 'rename', id: 'web', name: 'Storefront' }])
    expect(r.applied).toBe(2)
    expect(building(r.doc, 'api')).toMatchObject({ id: 'api', name: 'Checkout API' })
    expect(r.doc.districts.find((d) => d.id === 'web')?.name).toBe('Storefront')
    expect(r.doc.layout.positions).toEqual(doc.layout.positions)
  })

  it('describe sets a building claim or a district subtitle', () => {
    const r = applyDesignPatch(base(), [{ op: 'describe', id: 'db', does: 'Keeps orders.' }, { op: 'describe', id: 'core', does: 'The engine room' }])
    expect(r.applied).toBe(2)
    expect(building(r.doc, 'db')?.how).toEqual([{ text: 'Keeps orders.', state: 'proposed', evidence: EVIDENCE }])
    expect(r.doc.districts[0].subtitle).toBe('The engine room')
  })

  it('move places the building fresh in its new district; a move to the same district changes nothing', () => {
    const doc = base()
    const r = applyDesignPatch(doc, [{ op: 'move', id: 'db', districtId: 'web' }, { op: 'move', id: 'api', districtId: 'core' }])
    expect(r.applied).toBe(2)
    expect(building(r.doc, 'db')?.districtId).toBe('web')
    expect(r.doc.layout.positions.db).not.toEqual(doc.layout.positions.db)
    const web = r.doc.layout.positions.web
    const db = r.doc.layout.positions.db
    expect(Math.hypot(db[0] - web[0], db[2] - web[2])).toBeLessThan(20)
    expect(r.doc.layout.positions.api).toEqual(doc.layout.positions.api)
    valid(r.doc)
  })

  it('keeps every existing position and places new parts clear of them', () => {
    const doc = base()
    const r = applyDesignPatch(doc, [
      { op: 'addBuilding', id: 'cache', districtId: 'core', name: 'Cache' },
      { op: 'addDistrict', id: 'ops', name: 'Operations' }
    ])
    for (const [id, p] of Object.entries(doc.layout.positions)) expect(r.doc.layout.positions[id]).toEqual(p)
    const cache = r.doc.layout.positions.cache
    for (const id of ['api', 'db']) {
      const p = r.doc.layout.positions[id]
      expect(Math.hypot(p[0] - cache[0], p[2] - cache[2])).toBeGreaterThanOrEqual(6)
    }
    const ops = r.doc.layout.positions.ops
    for (const id of ['core', 'web']) {
      const p = r.doc.layout.positions[id]
      expect(Math.hypot(p[0] - ops[0], p[2] - ops[2])).toBeGreaterThanOrEqual(35)
    }
    valid(r.doc)
  })

  it('uses an injected placer for new positions, never for existing ones', () => {
    const doc = base()
    const seen: string[][] = []
    const r = applyDesignPatch(doc, [{ op: 'addBuilding', id: 'cache', districtId: 'core', name: 'Cache' }], (d) => {
      seen.push(Object.keys(d.layout.positions).sort())
      return { ...defaultPlacer(d), api: [999, 0, 999] }
    })
    expect(seen).toEqual([Object.keys(doc.layout.positions).sort()])
    expect(r.doc.layout.positions.api).toEqual(doc.layout.positions.api)
    expect(r.doc.layout.positions.cache).toBeDefined()
  })

  it('result always passes validateWorld', () => {
    const doc = base()
    const bad: unknown[] = [
      'nope', null, { op: 'explode', id: 'x' }, { op: 'addDistrict', id: 5, name: 'X' },
      { op: 'addDistrict', id: '-bad id', name: 'X' },
      { op: 'addDistrict', id: 'api', name: 'Dup' },
      { op: 'addBuilding', id: 'core', districtId: 'core', name: 'Dup' },
      { op: 'addBuilding', id: 'has space', districtId: 'core', name: 'X' },
      { op: 'addEdge', from: 'ui', to: 'core', label: 'to a district' },
      { op: 'addEdge', from: 'ghost', to: 'api', label: 'from nothing' },
      { op: 'addEdge', from: 'api', to: 'api', label: 'loop' },
      { op: 'addEdge', from: 'ui', to: 'api', label: 'again' },
      { op: 'rename', id: 'ghost', name: 'X' },
      { op: 'describe', id: 'e-ui--api', does: 'X' },
      { op: 'move', id: 'core', districtId: 'web' },
      { op: 'move', id: 'api', districtId: 'ghost' },
      { op: 'addBuilding', id: 'ok', districtId: 'web', name: 'Fine' }
    ]
    const r = applyDesignPatch(doc, bad as DesignOp[])
    valid(r.doc)
    expect(r.applied).toBe(1)
    expect(r.skipped.map((s) => s.reason)).toEqual([
      'not a change Lumopolis understands',
      'not a change Lumopolis understands',
      'not a change Lumopolis understands',
      'not a change Lumopolis understands',
      '"-bad id" is not a usable id',
      '"api" is already used',
      '"core" is already used',
      '"has space" is not a usable id',
      'there is no building "core"',
      'there is no building "ghost"',
      'a connection needs two different parts',
      'that connection already exists',
      'there is no district or building "ghost"',
      'there is no district or building "e-ui--api"',
      'there is no building "core"',
      'there is no district "ghost"'
    ])
    expect(r.skipped[0].op).toBe('nope')
  })

  it('a placer that leaves a building without a position applies nothing', () => {
    const doc = base()
    const ops: DesignOp[] = [{ op: 'addBuilding', id: 'cache', districtId: 'core', name: 'Cache' }, { op: 'remove', id: 'ghost' }]
    const r = applyDesignPatch(doc, ops, () => ({}))
    expect(r.doc).toBe(doc)
    expect(r.applied).toBe(0)
    expect(r.skipped).toEqual(ops.map((op) => ({ op, reason: 'the design would not be valid' })))
  })

  it('never changes the doc it was given', () => {
    const doc = base()
    const before = JSON.stringify(doc)
    applyDesignPatch(doc, [{ op: 'remove', id: 'core' }, { op: 'addDistrict', id: 'x', name: 'X' }])
    expect(JSON.stringify(doc)).toBe(before)
  })
})

describe('removePart', () => {
  it('designPatch removePart adds the built id to removes; an unknown id is skipped and counted', () => {
    const r = applyDesignPatch(base(), [
      { op: 'removePart', id: 'api' }, { op: 'removePart', id: 'api' }, { op: 'removePart', id: 'ghost' }, { op: 'removePart', id: 'db' }
    ])
    expect(r.applied).toBe(3)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].reason).toBe('there is no building "ghost"')
    const p = r.doc.layers.plan.find((x) => x.id === REMOVALS_ID)
    expect(p).toMatchObject({ title: REMOVALS_TITLE, buildings: [], edges: [], removes: ['api', 'db'] })
    expect(r.doc.layers.plan).toHaveLength(1) // one removals proposal, reused
    expect(validateWorld(r.doc).ok).toBe(true)
    // Deleting a part drops it from removes too.
    const gone = applyDesignPatch(r.doc, [{ op: 'remove', id: 'api' }])
    expect(gone.doc.layers.plan[0].removes).toEqual(['db'])
    // A removals proposal stored without a list still takes the id.
    const bare = JSON.parse(JSON.stringify(r.doc)) as WorldDoc
    delete bare.layers.plan[0].removes
    expect(applyDesignPatch(bare, [{ op: 'removePart', id: 'ui' }]).doc.layers.plan[0].removes).toEqual(['ui'])
    // Other proposals without removes are left alone.
    const other = JSON.parse(JSON.stringify(gone.doc)) as WorldDoc
    other.layers.plan.push({ id: 'x', title: 'X', summary: [], buildings: [], edges: [] })
    expect(applyDesignPatch(other, [{ op: 'remove', id: 'db' }]).doc.layers.plan[1].removes).toBeUndefined()
  })

  it('is described in the protocol and parsed from a reply', () => {
    expect(DESIGN_PROTOCOL).toContain('removePart')
    expect(parseDesignReply('ok\n```design-patch\n[{"op":"removePart","id":"api"}]\n```').ops).toEqual([{ op: 'removePart', id: 'api' }])
  })
})

describe('parseDesignReply', () => {
  const block = (json: string): string => '```design-patch\n' + json + '\n```'

  it('splits the text from the ops', () => {
    const r = parseDesignReply('A shop with an API.\n' + block(JSON.stringify(BASE_OPS.slice(0, 2))))
    expect(r).toEqual({ text: 'A shop with an API.', ops: [BASE_OPS[0], BASE_OPS[1]], dropped: 0 })
  })

  it('tolerant cases (none, malformed, two blocks)', () => {
    expect(parseDesignReply('Just words.')).toEqual({ text: 'Just words.', ops: [], dropped: 0 })
    expect(parseDesignReply('Hi\n' + block('{nope'))).toEqual({ text: 'Hi', ops: [], dropped: 0 })
    const two = parseDesignReply('One\n' + block('[{"op":"remove","id":"a"}]') + '\nTwo\n' + block('[{"op":"remove","id":"b"}]'))
    expect(two).toEqual({ text: 'One\n\nTwo', ops: [{ op: 'remove', id: 'a' }], dropped: 0 })
  })

  it('drops a truncated block, non-string input and JSON that is not a list of ops', () => {
    expect(parseDesignReply('Hi ```design-patch\n[{"op":"remove"')).toEqual({ text: 'Hi', ops: [], dropped: 0 })
    expect(parseDesignReply(undefined as unknown as string)).toEqual({ text: '', ops: [], dropped: 0 })
    for (const json of ['42', 'null', '{"changes":[]}']) expect(parseDesignReply(block(json)).ops).toEqual([])
  })

  it('accepts an { ops: [...] } object', () => {
    expect(parseDesignReply(block('{"ops":[{"op":"remove","id":"a"}]}')).ops).toEqual([{ op: 'remove', id: 'a' }])
  })

  it('counts malformed ops and ops past the cap as dropped', () => {
    const many = Array.from({ length: MAX_DESIGN_OPS + 3 }, (_, i) => ({ op: 'remove', id: `x${i}` }))
    const r = parseDesignReply(block(JSON.stringify(['bad', { op: 'remove' }, ...many])))
    expect(r.ops).toHaveLength(MAX_DESIGN_OPS - 2)
    expect(r.dropped).toBe(2 + 5)
  })

  it('checks every op shape and trims or drops bad optional fields', () => {
    const long = 'n'.repeat(300)
    const raw = [
      { op: 'addDistrict', id: ' core ', name: ' Core ', subtitle: 7 },
      { op: 'addDistrict', id: 'x', name: '' },
      { op: 'addBuilding', id: 'b', districtId: 'core', name: long, techLabel: 3, stack: ['Node', 4, ''], does: 9, extra: true },
      { op: 'addBuilding', id: 'b', districtId: 'core', name: 'B', stack: 'Node' },
      { op: 'addBuilding', id: 'b', name: 'B' },
      { op: 'addEdge', from: 'a', to: 'b', label: 'x', cargo: 'c' },
      { op: 'addEdge', from: 'a', to: 'b', label: 'x', cargo: 5 },
      { op: 'addEdge', from: 'a', to: 'b' },
      { op: 'rename', id: 'a', name: 'A' },
      { op: 'rename', id: 'a' },
      { op: 'remove', id: '' },
      { op: 'move', id: 'a', districtId: 'd' },
      { op: 'move', id: 'a' },
      { op: 'describe', id: 'a', does: 'Does.' },
      { op: 'describe', id: 'a', does: '  ' }
    ]
    const r = parseDesignReply(block(JSON.stringify(raw)))
    expect(r.ops).toEqual([
      { op: 'addDistrict', id: 'core', name: 'Core' },
      { op: 'addBuilding', id: 'b', districtId: 'core', name: 'n'.repeat(120), stack: ['Node'] },
      { op: 'addBuilding', id: 'b', districtId: 'core', name: 'B' },
      { op: 'addEdge', from: 'a', to: 'b', label: 'x', cargo: 'c' },
      { op: 'addEdge', from: 'a', to: 'b', label: 'x' },
      { op: 'rename', id: 'a', name: 'A' },
      { op: 'move', id: 'a', districtId: 'd' },
      { op: 'describe', id: 'a', does: 'Does.' }
    ])
    expect(r.dropped).toBe(7)
  })
})

describe('setRuntimeNames', () => {
  it('setRuntimeNames rejects bad names and keeps at most 10', () => {
    const doc = base()
    const names = Array.from({ length: 12 }, (_, i) => `svc-${i}`)
    const r = applyDesignPatch(doc, [
      { op: 'setRuntimeNames', id: 'api', names: ['orders.api', 'orders.api', 'db_1'] },
      { op: 'setRuntimeNames', id: 'db', names },
      { op: 'setRuntimeNames', id: 'ui', names: ['has space'] },
      { op: 'setRuntimeNames', id: 'ghost', names: ['x'] },
      { op: 'setRuntimeNames', id: 'ui', names: 'nope' as unknown as string[] }
    ])
    expect(r.doc.runtimeNames.api).toEqual(['orders.api', 'db_1'])
    expect(r.doc.runtimeNames.db).toEqual(names.slice(0, 10))
    expect(r.doc.runtimeNames.ui).toBeUndefined()
    expect(r.skipped.map((s) => s.reason)).toEqual(['"has space" is not a usable service name', 'there is no building "ghost"', 'not a change Lumopolis understands'])
    valid(r.doc)
    // An empty list clears; a non-string entry is dropped by the parser.
    const cleared = applyDesignPatch(r.doc, [{ op: 'setRuntimeNames', id: 'api', names: [] }])
    expect(cleared.doc.runtimeNames.api).toBeUndefined()
    expect(parseDesignReply('```design-patch\n[{"op":"setRuntimeNames","id":"api","names":["a",3,"b"]}]\n```').ops).toEqual([{ op: 'setRuntimeNames', id: 'api', names: ['a', 'b'] }])
    expect(DESIGN_PROTOCOL).toContain('setRuntimeNames')
  })
})
